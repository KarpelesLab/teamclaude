// Adaptive session distribution (the third `distributeSessions` mode).
//
// The even mode spreads new sessions by active-session count alone, which
// treats every account as interchangeable. Two things make that wrong once a
// fleet is mixed:
//
//   - Accounts are on different plans. An even split sends a Pro account the
//     same share as a Max 20x, so the small one hits its weekly wall days
//     before the big one is half spent.
//   - Spreading evenly FRAGMENTS the weekly windows. Five accounts each left at
//     60% at reset is five windows' worth of credit thrown away, where four
//     spent accounts and one at 0% is the same work with the headroom kept
//     where it can still be used.
//
// So this mode does the opposite of even: it concentrates new sessions on the
// account with the LEAST remaining weekly credit, to finish that window off —
// but tapers its share away as it approaches the switch threshold, so it is
// spent down to the wall and never into it, and backs off when the account is
// congested, so concentrating never costs response time.
//
// Plan size comes from the authoritative OAuth profile tier. The two dynamic
// quantities — burn rate and tolerated concurrency — are learned from traffic,
// so the fleet responds to current behavior without guessing the subscription.
// See BurnRateLearner and ConcurrencyLearner below.

// One EWMA step. `alpha` is the weight of the new sample.
function ewma(prev, sample, alpha) {
  return prev == null ? sample : prev * (1 - alpha) + sample * alpha;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export const ADAPTIVE_DEFAULTS = {
  // A burn sample cannot span an idle gap or a window reset.
  maxSampleAgeMs: 15 * 60_000,

  // ── Reserve (the taper's width) ───────────────────────────────────────────
  // The reserve is not a fixed percentage. It is how much of the window this
  // account would spend in the next `lookaheadMs` at its OWN observed burn
  // rate — so a fast-burning account is given a wide margin and an idle one is
  // allowed to run much closer to the threshold before it is tapered off.
  lookaheadMs: 30 * 60_000,
  burnAlpha: 0.3,
  // The wall-clock window a burn-rate sample is measured over.
  //
  // Not per-reading, which is what makes this necessary. Readings arrive when
  // RESPONSES do, so under concurrency a dozen land within a few milliseconds
  // of each other, each carrying the utilization that a dozen parallel requests
  // moved. Dividing that delta by the milliseconds between two adjacent
  // readings measures the arrival burst, not the rate — observed at 0.157
  // utilization/second against a fleet of 27 sessions, which would drain a
  // weekly window in six seconds, and which pinned every reserve at its
  // ceiling. Anchoring the sample to a real interval makes concurrency
  // contribute to the numerator (more spend) instead of the denominator.
  //
  // Five minutes: long enough that arrival bursts average out, short enough
  // that the 30-minute projection is still extrapolating from something recent.
  burnWindowMs: 5 * 60_000,
  minReserve: 0.01, // never taper over a window narrower than 1%
  maxReserve: 0.20, // nor hold back more than 20% of the window in reserve
  // Utilization/ms assumed before anything has been observed. Sits mid-range so
  // a cold start neither refuses to taper nor holds a fifth of the window back.
  // ≈ 5% of a window per hour.
  initialBurnRate: 0.05 / 3600_000,

  // ── Concurrency learning ──────────────────────────────────────────────────
  // Where an account's tolerated concurrency starts before anything is known.
  initialConcCap: 6,
  minConcCap: 1,
  maxConcCap: 64,
  // AIMD: back off hard on a throttle, creep up on sustained success.
  concBackoff: 0.5,   // weight of the (reduced) observed load on a throttle
  concBackoffTo: 0.75, // fraction of the throttling load we retreat to
  concGrowth: 0.05,   // weight of the +1 probe when running at the cap

  // ── Scoring ───────────────────────────────────────────────────────────────
  // Ceiling on the burn-down preference. Without it the 1/remaining shape grows
  // as fast as the taper shrinks and the two cancel, leaving no protection at
  // the wall at all — the cap is what lets the taper win there.
  maxBurnBoost: 4,
};

/**
 * Learns how quickly each account is consuming each weekly window. Plan size
 * is deliberately not inferred here: AccountManager reads the subscription
 * tier supplied by the OAuth profile and uses quota headers only for current
 * utilization/reset state.
 */
export class BurnRateLearner {
  constructor(opts = {}) {
    this.opts = { ...ADAPTIVE_DEFAULTS, ...opts };
    // "index:bucket" -> burn-rate observation state
    this.state = new Map();
  }

  _slot(index, bucket) {
    const key = `${index}:${bucket}`;
    let s = this.state.get(key);
    if (!s) {
      s = {
        burnRate: null, lastU: null, lastAt: null,
        // The open burn-rate measurement window: where utilization stood when
        // it opened, and when. Deliberately independent of lastU/lastAt, which
        // move on every reading — this pair holds still until the window is
        // wide enough to divide by.
        burnAnchorU: null, burnAnchorAt: null,
      };
      this.state.set(key, s);
    }
    return s;
  }

  /** Observe a fresh utilization reading for one specific quota window. */
  observeUtilization(index, bucket, utilization, now = Date.now()) {
    if (!Number.isFinite(utilization)) return;
    const s = this._slot(index, bucket);
    const { lastU, lastAt } = s;
    // `restart` also reopens the burn window: it is only used where continuity
    // is broken (a reset, a stale gap), and measuring across that break would
    // price a window's worth of drop, or an idle stretch, as this account's
    // rate.
    const rebaseline = (restart) => {
      s.lastU = utilization;
      s.lastAt = now;
      if (restart || s.burnAnchorAt == null) {
        s.burnAnchorU = utilization;
        s.burnAnchorAt = now;
      }
    };
    if (lastU == null || lastAt == null) return rebaseline(true);

    const deltaU = utilization - lastU;
    const elapsed = now - lastAt;
    // A DROP is a window reset; a long gap means the tokens and the move are
    // not the same interval. A FLAT reading is neither — it is an account that
    // simply spent nothing, which the burn window below should count, so it is
    // no longer lumped in with the two discontinuities.
    if (deltaU < 0 || elapsed > this.opts.maxSampleAgeMs) return rebaseline(true);

    // Burn rate over a real elapsed interval rather than per reading. Left open
    // until the window is wide enough, so every reading inside it contributes
    // to how far utilization moved and none of them shortens the clock it is
    // divided by. A flat stretch is a legitimate sample of ~0, which is what
    // lets an idle account earn a narrow reserve and run nearer its threshold.
    const burnElapsed = now - s.burnAnchorAt;
    if (burnElapsed >= this.opts.burnWindowMs) {
      const moved = utilization - s.burnAnchorU;
      if (moved >= 0) s.burnRate = ewma(s.burnRate, moved / burnElapsed, this.opts.burnAlpha);
      s.burnAnchorU = utilization;
      s.burnAnchorAt = now;
    }
    rebaseline(false);
  }

  /** Learned utilization-per-ms, falling back to the cold-start assumption. */
  burnRate(index, bucket) {
    return this.state.get(`${index}:${bucket}`)?.burnRate ?? this.opts.initialBurnRate;
  }

  /**
   * How much headroom to hold back from the threshold for this bucket, as a
   * fraction of the window: what the account would spend over `lookaheadMs` at
   * its own observed rate, bounded so neither an idle account nor a runaway one
   * produces a degenerate taper.
   */
  reserve(index, bucket) {
    const projected = this.burnRate(index, bucket) * this.opts.lookaheadMs;
    return clamp(projected, this.opts.minReserve, this.opts.maxReserve);
  }

  /** Forget an account's learning (config reload dropped or replaced it). */
  forget(index) {
    for (const key of [...this.state.keys()]) {
      if (key.startsWith(`${index}:`)) this.state.delete(key);
    }
  }

  /** Follow an account-list reindexing without attaching learning to a new
   * credential. `remap` returns the new index, or null for a removed account. */
  remapAccounts(remap) {
    const next = new Map();
    for (const [key, value] of this.state) {
      const colon = key.indexOf(':');
      const mapped = remap(Number(key.slice(0, colon)));
      if (mapped != null) next.set(`${mapped}:${key.slice(colon + 1)}`, value);
    }
    this.state = next;
  }

  /** Serializable per-account state for the existing identity-keyed state file. */
  export(index) {
    const result = {};
    for (const [key, value] of this.state) {
      const prefix = `${index}:`;
      if (key.startsWith(prefix)) result[key.slice(prefix.length)] = { ...value };
    }
    return result;
  }

  restore(index, saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [bucket, value] of Object.entries(saved)) {
      if (!bucket || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const clean = {};
      for (const field of ['burnRate', 'lastU', 'lastAt', 'burnAnchorU', 'burnAnchorAt']) {
        clean[field] = Number.isFinite(value[field]) ? value[field] : null;
      }
      this.state.set(`${index}:${bucket}`, clean);
    }
  }
}

/**
 * Learns how much concurrency each account actually tolerates before upstream
 * starts throttling it.
 *
 * This is the response-speed half of the score. Concentrating sessions to burn
 * a window down is only free while the account keeps up; past that, each extra
 * session buys queueing rather than throughput. How many that is, is not a
 * constant — it varies by plan and by what upstream is doing right now — so it
 * is learned the way a congestion controller learns it: retreat sharply below
 * the load that just throttled, and creep back up while running at the cap
 * without trouble.
 */
export class ConcurrencyLearner {
  constructor(opts = {}) {
    this.opts = { ...ADAPTIVE_DEFAULTS, ...opts };
    this.caps = new Map(); // index -> learned cap
  }

  cap(index) {
    return this.caps.get(index) ?? this.opts.initialConcCap;
  }

  /** Upstream throttled this account while `load` requests were on it. */
  noteThrottled(index, load) {
    if (!Number.isFinite(load) || load <= 0) return;
    const cap = this.cap(index);
    const target = load * this.opts.concBackoffTo;
    // Never upward. The throttling load can exceed the current cap — the ramp
    // admits above it during a switch window, and the cap starts at a guess —
    // and easing toward that load would read upstream refusing the account as
    // permission to send it more, which is precisely backwards.
    const next = Math.min(cap, ewma(cap, target, this.opts.concBackoff));
    this.caps.set(index, clamp(next, this.opts.minConcCap, this.opts.maxConcCap));
  }

  /**
   * A request completed cleanly at `load`. Only a load at or above the current
   * cap teaches anything: finishing one request while three are allowed is not
   * evidence that four would have been fine.
   */
  noteSuccess(index, load) {
    if (!Number.isFinite(load) || load <= 0) return;
    const cap = this.cap(index);
    if (load < cap) return;
    const next = ewma(cap, load + 1, this.opts.concGrowth);
    this.caps.set(index, clamp(next, this.opts.minConcCap, this.opts.maxConcCap));
  }

  forget(index) {
    this.caps.delete(index);
  }

  /** Keep learned caps with their credential when account indexes shift. */
  remapAccounts(remap) {
    const next = new Map();
    for (const [index, cap] of this.caps) {
      const mapped = remap(index);
      if (mapped != null) next.set(mapped, cap);
    }
    this.caps = next;
  }

  export(index) {
    return this.caps.has(index) ? this.caps.get(index) : null;
  }

  restore(index, cap) {
    if (!Number.isFinite(cap)) return;
    this.caps.set(index, clamp(cap, this.opts.minConcCap, this.opts.maxConcCap));
  }
}

/**
 * Score one candidate account. Higher wins. Returns the components too, so the
 * status surface and the tests can state WHY an account was chosen rather than
 * just that it was.
 *
 * @param {object} c
 *   index, utilization (0-1 or null), threshold, capacity (relative plan
 *   weight or null),
 *   reserve (fraction), load (active sessions + in-flight), concCap,
 *   maxRemaining (the largest `remaining` among the candidates)
 */
export function scoreCandidate(c, opts = ADAPTIVE_DEFAULTS) {
  // Fractional headroom to the point where this bucket rotates the account out.
  // An unknown utilization is treated as an empty window: an account nothing is
  // known about must not be picked FIRST under a rule that prefers the most
  // spent account, or every cold start would pile onto whichever account
  // happens to be unmeasured.
  const u = Number.isFinite(c.utilization) ? c.utilization : 0;
  const head = Math.max(0, c.threshold - u);

  // Remaining credit. A profile-derived capacity weight makes the comparison
  // fair across plan tiers: 10% of a 20x window outranks 40% of a Pro one, as
  // it should. With an unknown tier, the fraction is the safe stand-in.
  const remaining = c.capacity != null ? c.capacity * head : head;

  // Burn-down: prefer the account with the LEAST left, to finish its window
  // rather than leave every account part-spent at reset. Expressed relative to
  // the largest candidate so it carries no units and needs no scale constant.
  // Capped, because the taper below has to be able to overpower it at the wall.
  const maxRemaining = c.maxRemaining > 0 ? c.maxRemaining : 0;
  const burn = maxRemaining > 0 && remaining > 0
    ? Math.min(opts.maxBurnBoost, maxRemaining / remaining)
    : opts.maxBurnBoost;

  // Taper: hand the share back as the account nears its threshold, reaching 0
  // exactly at it. This is what makes it "spend down to the wall, never into
  // it" — without it the burn term would drive every session onto the account
  // closest to being exhausted right up until it 429s.
  //
  // SQUARED, and that is load-bearing rather than a tuning preference. The burn
  // term rises as 1/headroom until it hits its cap, so a linear taper falls at
  // exactly the rate burn rises and the two cancel: the account would keep its
  // lead until it was already deep inside the reserve, which is far too late to
  // start handing work back. Squaring makes the taper win the race — the share
  // decays smoothly across the whole reserve instead of holding flat and then
  // dropping off a cliff — and drives the product to zero at the threshold
  // regardless of where the burn cap sits.
  const ratio = c.reserve > 0 ? clamp(head / c.reserve, 0, 1) : (head > 0 ? 1 : 0);
  const taper = ratio * ratio;

  // Speed: the account's share decays as it fills up with work, so
  // concentrating for quota reasons can never push it past the point where the
  // next session would just queue.
  const concCap = c.concCap > 0 ? c.concCap : 1;
  const speed = concCap / (concCap + Math.max(0, c.load));

  return { score: burn * taper * speed, burn, taper, speed, head, remaining };
}
