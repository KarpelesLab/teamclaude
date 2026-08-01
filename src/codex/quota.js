// Codex quota, read from the x-codex-* headers that ride along on every
// response.
//
// This is what makes rotation predictive for codex accounts rather than
// reactive: without it the proxy only learns an account is spent by getting a
// 429, so the first request after exhaustion always fails before failing over.
// Anthropic accounts get the same treatment from anthropic-ratelimit-*.
//
// A live response carries:
//   x-codex-primary-used-percent: 0
//   x-codex-primary-window-minutes: 10080
//   x-codex-primary-reset-after-seconds: 604709
//   x-codex-primary-reset-at: 1786201952
//   x-codex-secondary-...            (same shape; zeroed when inactive)
//   x-codex-plan-type: plus

export const CODEX_HEADER_PREFIX = 'x-codex-';

// A window at or under this length is treated as the session bucket, anything
// longer as the weekly one. Buckets are classified by DURATION rather than by
// the primary/secondary naming: which slot carries which window varies by plan
// (the observed `plus` account reports its 7-day limit as primary and leaves
// secondary inactive), so keying off the name would silently mis-file a bucket
// on a plan that orders them the other way.
const SESSION_WINDOW_MAX_MINUTES = 24 * 60;

function num(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a bucket's reset time to a ms timestamp.
 *
 * Prefers the absolute `reset-at` and falls back to the relative
 * `reset-after-seconds`. Both are reported, but the relative one is only
 * meaningful against the moment the response arrived.
 */
function resolveReset(resetAt, resetAfterSeconds, now) {
  const at = num(resetAt);
  if (at !== null && at > 0) return at * 1000;
  const after = num(resetAfterSeconds);
  if (after !== null && after > 0) return now + after * 1000;
  return null;
}

function readBucket(headers, slot, now) {
  const windowMinutes = num(headers[`${CODEX_HEADER_PREFIX}${slot}-window-minutes`]);
  // A zero/absent window means the plan does not have this bucket. Recording a
  // 0% utilization for it would look like abundant headroom on a limit that
  // does not exist.
  if (windowMinutes === null || windowMinutes <= 0) return null;

  const usedPercent = num(headers[`${CODEX_HEADER_PREFIX}${slot}-used-percent`]);
  if (usedPercent === null) return null;

  return {
    // Kept as a fraction to match the Anthropic side. It can exceed 1 in
    // overage, which _isNearQuota reads as "past the threshold" either way.
    utilization: usedPercent / 100,
    windowMinutes,
    resetAt: resolveReset(
      headers[`${CODEX_HEADER_PREFIX}${slot}-reset-at`],
      headers[`${CODEX_HEADER_PREFIX}${slot}-reset-after-seconds`],
      now,
    ),
  };
}

/**
 * Parse x-codex-* headers into the same quota shape the Anthropic path
 * produces.
 *
 * Deliberately reuses unified5h/unified7d rather than introducing codex-specific
 * fields: selection, the switch threshold, status rendering and state
 * persistence all already read those, so codex accounts stay peers in one fleet
 * instead of needing a parallel code path.
 *
 * @returns {{unified5h?: number, unified5hReset?: number,
 *            unified7d?: number, unified7dReset?: number,
 *            planType?: string}} only the fields the headers actually reported
 */
export function parseCodexQuota(headers, now = Date.now()) {
  const out = {};
  if (!headers) return out;

  for (const slot of ['primary', 'secondary']) {
    const bucket = readBucket(headers, slot, now);
    if (!bucket) continue;

    const isSession = bucket.windowMinutes <= SESSION_WINDOW_MAX_MINUTES;
    const utilKey = isSession ? 'unified5h' : 'unified7d';
    const resetKey = isSession ? 'unified5hReset' : 'unified7dReset';

    // Two active windows can land in the same class (e.g. a plan reporting both
    // a 1-hour and a 5-hour limit). Keep the more exhausted one — it is the one
    // that will actually stop the account.
    if (out[utilKey] === undefined || bucket.utilization > out[utilKey]) {
      out[utilKey] = bucket.utilization;
      if (bucket.resetAt !== null) out[resetKey] = bucket.resetAt;
    }
  }

  const plan = headers[`${CODEX_HEADER_PREFIX}plan-type`];
  if (plan) out.planType = String(plan);

  return out;
}

/**
 * Is a codex bucket spent, judged from the headers on a 429?
 *
 * The Anthropic path distinguishes a durable quota rejection from a transient
 * throttle via anthropic-ratelimit-*-status. Codex reports no such status, so
 * exhaustion has to be inferred from utilization: at 100% the limit is spent
 * and retrying the same account before its reset is futile.
 */
export function isCodexQuotaExhausted(headers, now = Date.now()) {
  const quota = parseCodexQuota(headers, now);
  return (quota.unified5h ?? 0) >= 1 || (quota.unified7d ?? 0) >= 1;
}

/**
 * Seconds until the earliest reported bucket reset, for use as a hold window
 * when a codex account is exhausted. Null when nothing is known.
 */
export function codexResetAfterSeconds(headers, now = Date.now()) {
  const quota = parseCodexQuota(headers, now);
  const resets = [quota.unified5hReset, quota.unified7dReset].filter(v => typeof v === 'number' && v > now);
  if (resets.length === 0) return null;
  return Math.ceil((Math.min(...resets) - now) / 1000);
}
