/** Resolve a subscription's quota capacity relative to a Claude Pro account. */
export function quotaTier(account) {
  const rateLimitTier = account.rateLimitTier || null;
  const seatTier = account.seatTier || null;
  const normalizedRate = String(rateLimitTier || '').toLowerCase();
  const normalizedSeat = String(seatTier || '').toLowerCase();

  let weight = null;
  // Ultra is the plan Max 20x was renamed to, at the same weekly limit
  // (Anthropic, 2026-10-30). The tier string an Ultra account reports has not
  // been seen yet; existing accounts still read `default_claude_max_20x`.
  if (normalizedRate.includes('20x') || normalizedRate.includes('x20') || normalizedRate.includes('ultra')
      || normalizedSeat === 'team_tier_2') {
    weight = 20;
  } else if (normalizedRate.includes('5x') || normalizedRate.includes('x5') || normalizedSeat === 'team_tier_1') {
    weight = 5;
  } else if (normalizedSeat === 'team_standard'
      || normalizedRate === 'default_claude_ai'
      || account.organizationType === 'claude_pro'
      || account.hasClaudePro === true) {
    weight = 1;
  }

  return { rateLimitTier, seatTier, weight };
}

const BUCKETS = ['fiveHour', 'weeklyShared', 'weeklySonnet', 'weeklyFable'];

function clean(value) {
  return Math.round(value * 1e12) / 1e12;
}

function bucket(utilization, resetAt, source) {
  if (utilization == null) return null;
  const used = Number(utilization);
  if (!Number.isFinite(used)) return null;
  return {
    utilization: used,
    remaining: clean(Math.max(0, 1 - used)),
    resetAt: resetAt ?? null,
    source,
  };
}

// A third-party backend window (src/backend-quota.js) fills in where no
// unified field exists. An expired one is skipped, the same way
// refreshExpiredQuotas drops a stale unified reading.
//
// `observedAt` is when the probe took the reading (#510). A failed probe keeps
// the last good reading rather than blanking it, and a window with no reset
// never expires, so without its age a consumer cannot tell a fresh value from
// one that is hours old.
function backendWindow(/** @type {any} */ window, /** @type {string} */ source, /** @type {unknown} */ at) {
  if (!window || typeof window !== 'object') return null;
  if (window.resetAt != null && window.resetAt <= Date.now()) return null;
  const value = bucket(window.utilization, window.resetAt, source);
  return value && { ...value, observedAt: typeof at === 'number' && Number.isFinite(at) ? at : null };
}

function standardBucket(limit, remaining, resetAt, source) {
  if (limit == null || remaining == null || Number(limit) <= 0) return null;
  const value = bucket(1 - Number(remaining) / Number(limit), resetAt, source);
  return value && { ...value, limit: Number(limit), remainingAmount: Number(remaining) };
}

function accountBuckets(quota) {
  const shared = bucket(quota.unified7d, quota.unified7dReset, 'unified7d');
  const backend = quota.backend?.windows ?? null;
  const backendAt = quota.backend?.at;
  /** @type {Record<string, any>} */
  const buckets = {
    fiveHour: bucket(quota.unified5h, quota.unified5hReset, 'unified5h') ?? backendWindow(backend?.fiveHour, 'backendFiveHour', backendAt),
    weeklyShared: shared ?? backendWindow(backend?.weekly, 'backendWeekly', backendAt),
    weeklySonnet: bucket(
      quota.unified7dSonnet ?? quota.unified7d,
      quota.unified7dSonnet != null ? quota.unified7dSonnetReset : quota.unified7dReset,
      quota.unified7dSonnet != null ? 'unified7dSonnet' : 'unified7d',
    ),
    weeklyFable: bucket(
      quota.unified7dFable ?? quota.unified7d,
      quota.unified7dFable != null ? quota.unified7dFableReset : quota.unified7dReset,
      quota.unified7dFable != null ? 'unified7dFable' : 'unified7d',
    ),
  };
  // A monthly window exists only on third-party backends; like tokens and
  // requests, the key appears only when there is a reading.
  const monthly = backendWindow(backend?.monthly, 'backendMonthly', backendAt);
  if (monthly) buckets.monthly = monthly;
  const tokens = standardBucket(quota.tokensLimit, quota.tokensRemaining, quota.resetsAt, 'tokens');
  const requests = standardBucket(quota.requestsLimit, quota.requestsRemaining, quota.resetsAt, 'requests');
  if (tokens) buckets.tokens = tokens;
  if (requests) buckets.requests = requests;
  return buckets;
}

function aggregateBucket(accounts, key) {
  let capacityWeight = 0;
  let usedWeight = 0;
  let remainingWeight = 0;
  let knownAccounts = 0;
  let nextResetAt = null;
  for (const account of accounts) {
    const weight = account.tier.weight;
    const value = account.buckets[key];
    // A backend reading never joins the fleet aggregates: its units are the
    // provider's own, whatever tier the config claims for the account.
    if (weight == null || value == null || String(value.source).startsWith('backend')) continue;
    const boundedUtilization = Math.max(0, Math.min(1, value.utilization));
    capacityWeight += weight;
    usedWeight += weight * boundedUtilization;
    remainingWeight += weight * (1 - boundedUtilization);
    knownAccounts++;
    if (value.resetAt != null && (nextResetAt == null || value.resetAt < nextResetAt)) {
      nextResetAt = value.resetAt;
    }
  }
  if (knownAccounts === 0) return null;
  return {
    capacityWeight: clean(capacityWeight),
    usedWeight: clean(usedWeight),
    remainingWeight: clean(remainingWeight),
    utilization: clean(usedWeight / capacityWeight),
    remaining: clean(remainingWeight / capacityWeight),
    knownAccounts,
    nextResetAt,
  };
}

// The weighted capacity the fiveHour aggregate leaves out because the window
// does not apply to it: an account with a tier weight whose plan meters no
// 5-hour window (an Ultra plan once Anthropic lifts it) and holds no reading.
// A Codex plan with no 5-hour window is never counted: a Codex account has no
// Claude tier, so its weight is null and it is in neither the aggregate nor
// this count.
// One still holding a reading from before the change is counted in the
// aggregate instead, since that reading still gates it. Without this a
// consumer cannot tell "the fleet's session quota is nearly spent" from "most
// of the fleet has no session quota".
function fiveHourExempt(/** @type {any[]} */ summaries, /** @type {Record<string, any>|null} */ aggregate) {
  if (aggregate == null) return null;
  let exemptAccounts = 0;
  let exemptWeight = 0;
  for (const account of summaries) {
    if (account.tier.weight == null || account.buckets.fiveHour != null || account.sessionWindow !== false) continue;
    exemptAccounts++;
    exemptWeight += account.tier.weight;
  }
  return { ...aggregate, exemptAccounts, exemptWeight: clean(exemptWeight) };
}

/** Build the quota payload shared by the control endpoint and status clients. */
export function buildQuotaSummary(accounts) {
  const summaries = accounts
    .map(account => ({
      name: account.name,
      type: account.type,
      disabled: !!account.disabled,
      status: account.status,
      tier: quotaTier(account),
      // Whether the plan meters a 5-hour window: false when a reading said it
      // does not, null before one has said (see noteSessionWindow in
      // account-manager.js). Tells "no limit" from "not reported" where
      // `buckets.fiveHour` is null for both.
      sessionWindow: typeof account.quota?.sessionWindowStated === 'boolean' ? account.quota.sessionWindowStated : null,
      buckets: accountBuckets(account.quota || {}),
    }));
  /** @type {Record<string, Record<string, any>|null>} */
  const aggregate = Object.fromEntries(BUCKETS.map(key => [key, aggregateBucket(summaries, key)]));
  aggregate.fiveHour = fiveHourExempt(summaries, aggregate.fiveHour);
  return {
    accounts: summaries,
    aggregate,
    unknownTiers: summaries
      .filter(account => account.type === 'oauth' && account.tier.weight == null)
      .map(account => ({
        name: account.name,
        rateLimitTier: account.tier.rateLimitTier,
        seatTier: account.tier.seatTier,
      })),
  };
}
