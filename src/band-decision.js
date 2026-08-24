// The band decision, as a pure function of a snapshot.
//
// Which accounts are worth spending is a decision; narrowing the candidate list
// is an action. Splitting them means the decision can be driven directly with
// constructed inputs, including inputs a live fleet cannot easily be put into
// (every window unreported, a reset already passed, one account at a different
// priority), and it means the instant is an argument rather than something read
// from the clock partway through.
//
// `decideBand` reads no clock, no account object and no configuration: `now`
// arrives in the snapshot. Two calls with the same snapshot return the same
// decision forever.
//
// ABSENCE IS A VARIANT, NEVER A COERCED null. An account whose window is
// unreported is not an account with zero pressure and not an account with
// infinite pressure; it is an account nothing is known about, and the band
// keeps it in so that using it is how its quota gets discovered. Writing that
// as `null` puts the burden on every consumer to remember which of the three it
// meant, and the one that forgets is the one that ranks an unknown account
// last. `reason` is part of the contract for the same purpose: a caller that
// wants to log or branch on why a band did nothing reads a value, not a
// sentence.
//
// ABSENT IS NOT ONE STATE, AND THE REASONS DO NOT RANK ALIKE. Three of the four
// mean nothing is known about the account, and those rank first, because being
// used is how the missing reading is obtained. `no-reset` is different in kind:
// the utilization IS known and only the clock is missing. Ranking that first
// puts an account known to be nearly spent ahead of one known to be holding
// quota that expires within the hour, which is the feature's own goal running
// backwards. Ranking an unknown account last and ranking a known-bad account
// first are the same error in opposite directions, and this module has to avoid
// both.

// The longest a weekly window can be, which is what makes an unknown reset
// rankable at all: a real window resets at most this far out, so scoring an
// account with no clock as though its window were the furthest it could be
// gives a LOWER BOUND on its true pressure. Bounding rather than guessing is
// what keeps the rank sound — the account can only turn out to be worth more
// than this, never less, so it can never be preferred over a measured account
// on the strength of a number nobody reported. Not a tuning constant: it is the
// definition of the window.
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 3600;

/**
 * Why an account has no comparable pressure. Each names a distinct upstream
 * state rather than a failure: `no-utilization` is a bucket nobody has reported,
 * `no-reset` is one reported without its window, `utilization-not-finite` is a
 * value that arrived malformed, and `expiry-routing-off` is the operator having
 * said not to rank on expiring quota at all.
 *
 * @typedef {'no-utilization' | 'no-reset' | 'utilization-not-finite'
 *         | 'expiry-routing-off'} AbsentReason
 */

/**
 * `lowerBound` is carried by `no-reset` alone, and is the least this account's
 * pressure can turn out to be once its window is reported. The other three
 * reasons have no utilization to bound anything with, so they carry none and
 * rank as pure discovery.
 *
 * @typedef {{ kind: 'known', value: number }
 *         | { kind: 'absent', reason: AbsentReason, lowerBound?: number }} Pressure
 */

/**
 * One account as the decision sees it. Deliberately not an account object: the
 * decision layer cannot reach anything it was not handed.
 *
 * `utilization` is the governing weekly bucket's fraction spent and `resetAt`
 * is that same bucket's reset instant in epoch milliseconds. Both come from the
 * ONE bucket the caller resolved, never one bucket's usage against another's
 * clock.
 *
 * @typedef {{
 *   index: number,
 *   priority: number,
 *   utilization: number | null,
 *   resetAt: number | null,
 * }} BandAccount
 */

/**
 * @typedef {{
 *   now: number,
 *   enabled: boolean,
 *   tolerance: number,
 *   accounts: BandAccount[],
 * }} BandSnapshot
 */

/**
 * Why the band kept everything it was given. `disabled` and `single-candidate`
 * are structural; `no-known-pressure` is the cold-start state, and it is the
 * reason the mechanism is off until a signal exists rather than guessing from a
 * default.
 *
 * @typedef {'disabled' | 'single-candidate' | 'no-known-pressure'} PassthroughReason
 */

/**
 * @typedef {{ kind: 'passthrough', reason: PassthroughReason }
 *         | { kind: 'banded', keep: number[], floor: number }} BandDecision
 */

/**
 * Exhaustiveness, enforced at runtime as well as by eye. Catches a snapshot
 * that arrived from somewhere carrying a variant nothing here handles, which on
 * a plain-JS codebase is the only check there is.
 *
 * @param {never} value
 * @param {string} context
 * @returns {never}
 */
export function assertNever(value, context) {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * The expiring-quota pressure of one account: headroom per second remaining in
 * its governing window. Higher means more quota that is closer to expiring, so
 * more worth spending now.
 *
 * @param {BandAccount} account
 * @param {number} now
 * @returns {Pressure}
 */
export function pressureOf(account, now) {
  if (account.utilization == null) return { kind: 'absent', reason: 'no-utilization' };
  // Rejected before anything below reads the number, and before the reset is
  // even considered. Clamping a non-finite utilization would turn it into 0,
  // which reads as a completely unspent window: the strongest score there is,
  // invented out of a malformed value. Ordered ahead of the reset check so that
  // `no-reset` means "the utilization is known and the clock is not" and only
  // that, which is the whole basis on which it is rankable below.
  if (!Number.isFinite(account.utilization)) {
    return { kind: 'absent', reason: 'utilization-not-finite' };
  }
  const spendable = spendableFraction(account.utilization);
  if (!account.resetAt) {
    return { kind: 'absent', reason: 'no-reset', lowerBound: spendable / WEEKLY_WINDOW_SECONDS };
  }
  const seconds = (account.resetAt - now) / 1000;
  // A window whose reset has passed has no remaining time to spread headroom
  // over. That is a known pressure of zero rather than an absence: the account
  // is known to be worth nothing to spend for expiry reasons, which is a
  // different claim from knowing nothing about it.
  if (seconds <= 0) return { kind: 'known', value: 0 };
  const value = spendable / seconds;
  return Number.isFinite(value)
    ? { kind: 'known', value }
    : { kind: 'absent', reason: 'utilization-not-finite' };
}

/** How much of a window is left to spend, from the fraction already spent.
 * Clamped at both ends: above 1 is real overage and leaves nothing, below 0 is
 * not a smaller number but more headroom than the window has. Shared by the
 * measured pressure and the unknown-reset bound so the two cannot come to
 * different answers about what an account is holding. */
function spendableFraction(utilization) {
  return 1 - Math.min(1, Math.max(0, utilization));
}

/**
 * A pressure as a sort key, ascending. Lower sorts first, so the caller's
 * comparison chain reads the same way for this term as for priority and reset.
 *
 * DISCOVERY sorts first, and this is the one place that decision lives. An
 * account whose governing bucket nobody has reported must be used, because being
 * used is how its quota becomes known; ranking it last would make the unknown
 * permanent. It mirrors the pre-existing `-Infinity` an unknown reset already
 * sorts at in `_pickBestAvailable`. `expiry-routing-off` sorts there too, and
 * must: every account carries that same reason when the knob is off, so the term
 * is constant across the fleet and therefore inert. Give it anything derived
 * from an account and the off switch stops being an off switch.
 *
 * A BOUNDED absence sorts by its bound instead. `no-reset` knows the
 * utilization and only lacks the clock, so it is ranked by the least its
 * pressure can turn out to be. Ranking it as discovery instead put an account
 * known to be 95% spent ahead of one known to be holding 95% of its window with
 * an hour left, and nothing downstream could recover: `-Infinity` wins outright,
 * so the reset tiebreak that would have sorted it correctly is never reached.
 *
 * @param {Pressure} pressure
 * @returns {number}
 */
export function pressureRank(pressure) {
  switch (pressure.kind) {
    case 'known': return -pressure.value;
    case 'absent': return pressure.lowerBound == null ? -Infinity : -pressure.lowerBound;
    default: return assertNever(pressure, 'pressureRank');
  }
}

/**
 * The accounts worth spending, as a decision. Pure.
 *
 * Only the best priority tier is banded. Priority is the operator's explicit
 * order and has to keep winning: a high-pressure low-priority fallback must not
 * band out the tier the operator preferred. Lower tiers pass through unfiltered,
 * since they are only reached when the top tier is empty, which banding cannot
 * cause because the maximum always qualifies.
 *
 * @param {BandSnapshot} snapshot
 * @returns {BandDecision}
 */
export function decideBand(snapshot) {
  const { accounts, now, tolerance, enabled } = snapshot;
  if (!enabled) return { kind: 'passthrough', reason: 'disabled' };
  if (accounts.length <= 1) return { kind: 'passthrough', reason: 'single-candidate' };

  const top = Math.min(...accounts.map(a => a.priority));
  const tier = accounts.filter(a => a.priority === top);
  const pressures = tier.map(a => pressureOf(a, now));
  const known = pressures.filter(p => p.kind === 'known').map(p => p.value);
  // Nothing to rank on. Every account in the tier is unknown, so there is no
  // maximum to measure a floor against and no basis for preferring any of them.
  if (!known.length) return { kind: 'passthrough', reason: 'no-known-pressure' };

  const maxKnown = Math.max(...known);
  // A tolerance that is not a positive finite number cannot define a floor, and
  // one BELOW 1 asks for accounts strictly better than the best there is. Both
  // empty the tier, which contradicts the invariant this function documents two
  // paragraphs up. Clamping the floor at the maximum makes "the maximum always
  // qualifies" true by construction rather than by trusting the knob: at any
  // tolerance >= 1 the clamp is inert and the ratio is unchanged. `setExpiryRouting`
  // clamps the config too, but this function is exported and takes a plain
  // number, so the precondition holds here rather than upstream of here.
  const ratio = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1;
  const floor = Math.min(maxKnown, maxKnown / ratio);

  const keep = [];
  tier.forEach((account, i) => {
    const pressure = pressures[i];
    switch (pressure.kind) {
      // An unknown account stays in: using it is how its quota is discovered,
      // and banding it out would make the unknown permanent.
      case 'absent': keep.push(account.index); break;
      case 'known': if (pressure.value >= floor) keep.push(account.index); break;
      default: assertNever(pressure, 'decideBand');
    }
  });
  // Surviving members of the top tier first, then every lower tier untouched.
  // The order is part of the contract, not an accident of the loop: callers
  // break ties by taking the first acceptable candidate, so emitting these in
  // the snapshot's order instead would silently re-rank a mixed-priority fleet.
  for (const account of accounts) {
    if (account.priority !== top) keep.push(account.index);
  }
  return { kind: 'banded', keep, floor };
}
