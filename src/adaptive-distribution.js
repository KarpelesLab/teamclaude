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
// Nothing here is configured per account. Both quantities that would otherwise
// be operator-set constants — how big an account's window is (its plan tier)
// and how much concurrency it tolerates — are LEARNED from traffic, so the
// fleet re-tunes itself as plans change, as upstream's limits move, and as the
// week progresses. See CapacityLearner and ConcurrencyLearner below.

// One EWMA step. `alpha` is the weight of the new sample.
function ewma(prev, sample, alpha) {
  return prev == null ? sample : prev * (1 - alpha) + sample * alpha;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export const ADAPTIVE_DEFAULTS = {
  // ── Plan-tier learning ────────────────────────────────────────────────────
  // Weight of each new tokens-per-window sample. Deliberately slow: capacity is
  // a property of the plan, so a single odd request (a huge cache write, a
  // probe landing between two spends) must move it very little.
  capacityAlpha: 0.2,
  // The smallest utilization move that yields a usable sample. Below this the
  // quotient is dominated by the reading's own rounding — upstream reports
  // utilization to a few decimals — and would inject noise, not signal.
  minDeltaU: 0.002,
  // A sample is only meaningful if the tokens and the utilization move cover
  // the same work. Past this the reading is treated as a fresh baseline
  // instead: an idle gap, a restart, or a window reset sat in between.
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
 * Learns each account's weekly-window size in tokens — its plan tier — by
 * watching how far one unit of spend moves that window's utilization.
 *
 * A Max 20x and a Pro account both report utilization as a 0-1 fraction, so the
 * fraction alone says nothing about how much work is left behind it: 10% of a
 * 20x window is many times 10% of a Pro one. Dividing the tokens actually
 * served by the utilization those tokens consumed recovers the missing scale,
 * in the only unit that matters here — how much work the window still holds.
 *
 * Kept per (account, weekly bucket) because the buckets are separately sized:
 * an account's Fable weekly is not its shared weekly, and one cannot be used to
 * predict the other.
 */
export class CapacityLearner {
  constructor(opts = {}) {
    this.opts = { ...ADAPTIVE_DEFAULTS, ...opts };
    // "index:bucket" -> { capacity, burnRate, lastU, lastAt, pendingTokens }
    this.state = new Map();
  }

  _slot(index, bucket) {
    const key = `${index}:${bucket}`;
    let s = this.state.get(key);
    if (!s) {
      s = {
        capacity: null, burnRate: null, lastU: null, lastAt: null, pendingTokens: 0,
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

  /**
   * Count tokens spent on an account's bucket, pending the next utilization
   * reading that will price them. Only the tokens that actually meter are
   * counted: a cache READ is billed at a fraction upstream does not publish, so
   * including it would make the same work look like more spend on a
   * cache-heavy session than a cold one and bias the learned capacity by how
   * the client happened to use its cache.
   */
  recordTokens(index, bucket, usage) {
    if (!usage) return;
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const metered = n(usage.input_tokens) + n(usage.output_tokens)
      + n(usage.cache_creation_input_tokens);
    if (metered > 0) this._slot(index, bucket).pendingTokens += metered;
  }

  /**
   * Price the pending tokens against a fresh utilization reading.
   *
   * Three readings are rejected rather than learned from, because each would
   * teach the wrong number:
   *   - a DROP in utilization is a window reset, not negative spend;
   *   - a move smaller than `minDeltaU` is within the reading's own resolution;
   *   - a gap longer than `maxSampleAgeMs` means the tokens and the move are
   *     not measuring the same interval (an idle stretch, or a restart).
   * All three still re-baseline, so the next interval starts clean.
   */
  observeUtilization(index, bucket, utilization, now = Date.now()) {
    if (!Number.isFinite(utilization)) return;
    const s = this._slot(index, bucket);
    const { lastU, lastAt, pendingTokens } = s;
    // `restart` also reopens the burn window: it is only used where continuity
    // is broken (a reset, a stale gap), and measuring across that break would
    // price a window's worth of drop, or an idle stretch, as this account's
    // rate.
    const rebaseline = (restart) => {
      s.lastU = utilization;
      s.lastAt = now;
      s.pendingTokens = 0;
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
    if (deltaU === 0) return rebaseline(false);
    if (deltaU >= this.opts.minDeltaU && pendingTokens > 0) {
      // Tokens the whole window holds, if this rate held across all of it.
      s.capacity = ewma(s.capacity, pendingTokens / deltaU, this.opts.capacityAlpha);
    }
    rebaseline(false);
  }

  /** Learned window size in tokens, or null while it is still unknown. */
  capacity(index, bucket) {
    return this.state.get(`${index}:${bucket}`)?.capacity ?? null;
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
}

/**
 * Score one candidate account. Higher wins. Returns the components too, so the
 * status surface and the tests can state WHY an account was chosen rather than
 * just that it was.
 *
 * @param {object} c
 *   index, utilization (0-1 or null), threshold, capacity (tokens or null),
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

  // Remaining credit. With a learned capacity this is absolute (tokens), which
  // is what makes the comparison fair across plan tiers: 10% of a 20x window
  // outranks 40% of a Pro one, as it should. Without it, the fraction is the
  // best available stand-in and the comparison degrades to the same-tier case.
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
