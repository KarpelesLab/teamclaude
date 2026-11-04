// Burn-rate forecast: at the rate the BurnRateLearner has learned for one
// account and one weekly window, when does the account reach its switch
// threshold, compared with when the window resets (#475)?
//
// A read-out of a value the learner already keeps in every distribution mode.
// It changes no routing decision: the adaptive mode reads the same rate as a
// reserve, and that path is untouched.
//
// `null` means "no answer", never "never": the learner has no rate yet, the
// account is already at or above its threshold, the window has no fresh
// reading, the rate is zero (an idle account reaches nothing), or the reach
// time lies past the horizon below.

const HOUR_MS = 60 * 60 * 1000;

/**
 * How far ahead a reach time is reported. The learner's rate decays toward
 * zero on an idle account but never reaches it, so the division below can give
 * a time centuries out, or past the largest valid Date (a rate of 1e-89 an
 * hour gives about 1e93 ms). A weekly window resets within seven days, so
 * nothing past two weeks can come before a reset, and none of it is an answer.
 */
export const FORECAST_HORIZON_MS = 14 * 24 * HOUR_MS;

/**
 * @typedef {{
 *   ratePerHour: number|null,
 *   threshold: number,
 *   reachesThresholdAt: number|null,
 *   resetAt: number|null,
 * }} ForecastView
 */

/**
 * One window's forecast. Times are ms epoch, the unit of the quota's own
 * `*Reset` fields. `reachesThresholdAt` is reported even when it lies past
 * `resetAt`: the reader decides what that means (the status text says nothing,
 * because a window that resets first is the good case).
 *
 * The projection starts at `seenAt`, when the utilization was read, not at
 * `now`: a reading hours old would otherwise forecast the same distance on
 * every status read and never count down. So a stale reading can yield a
 * `reachesThresholdAt` in the past, which the status text does not show.
 *
 * @param {{ utilization: number|null|undefined, threshold: number, ratePerMs: number|null|undefined, resetAt: number|null|undefined, seenAt?: number|null, now: number }} input
 * @returns {ForecastView}
 */
export function forecastWindow({ utilization, threshold, ratePerMs, resetAt, seenAt = null, now }) {
  const reset = Number.isFinite(resetAt) && /** @type {number} */ (resetAt) > now ? /** @type {number} */ (resetAt) : null;
  const rate = Number.isFinite(ratePerMs) && /** @type {number} */ (ratePerMs) >= 0 ? /** @type {number} */ (ratePerMs) : null;
  /** @type {ForecastView} */
  const out = { ratePerHour: rate == null ? null : rate * HOUR_MS, threshold, reachesThresholdAt: null, resetAt: reset };
  if (rate == null || rate <= 0 || !Number.isFinite(utilization) || !Number.isFinite(threshold)) return out;
  // A reset that has passed leaves a reading from the old window: the
  // distance to the threshold it implies is no longer true.
  if (Number.isFinite(resetAt) && /** @type {number} */ (resetAt) <= now) return out;
  const left = threshold - /** @type {number} */ (utilization);
  if (left <= 0) return out;
  const from = Number.isFinite(seenAt) && /** @type {number} */ (seenAt) <= now ? /** @type {number} */ (seenAt) : now;
  const at = Math.round(from + left / rate);
  if (at - now > FORECAST_HORIZON_MS) return out;
  out.reachesThresholdAt = at;
  return out;
}
