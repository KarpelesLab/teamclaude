/** Resolve a subscription's quota capacity relative to a Claude Pro account. */
export function quotaTier(account) {
  const rateLimitTier = account.rateLimitTier || null;
  const seatTier = account.seatTier || null;
  const normalizedRate = String(rateLimitTier || '').toLowerCase();
  const normalizedSeat = String(seatTier || '').toLowerCase();

  let weight = null;
  if (normalizedRate.includes('20x') || normalizedRate.includes('x20') || normalizedSeat === 'team_tier_2') {
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

function standardBucket(limit, remaining, resetAt, source) {
  if (limit == null || remaining == null || Number(limit) <= 0) return null;
  const value = bucket(1 - Number(remaining) / Number(limit), resetAt, source);
  return value && { ...value, limit: Number(limit), remainingAmount: Number(remaining) };
}

function accountBuckets(quota) {
  const shared = bucket(quota.unified7d, quota.unified7dReset, 'unified7d');
  const buckets = {
    fiveHour: bucket(quota.unified5h, quota.unified5hReset, 'unified5h'),
    weeklyShared: shared,
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
    if (weight == null || value == null) continue;
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

/** Build the quota payload shared by the control endpoint and status clients. */
export function buildQuotaSummary(accounts) {
  const summaries = accounts
    .map(account => ({
      name: account.name,
      type: account.type,
      disabled: !!account.disabled,
      status: account.status,
      tier: quotaTier(account),
      buckets: accountBuckets(account.quota || {}),
    }));
  return {
    accounts: summaries,
    aggregate: Object.fromEntries(BUCKETS.map(key => [key, aggregateBucket(summaries, key)])),
    unknownTiers: summaries
      .filter(account => account.type === 'oauth' && account.tier.weight == null)
      .map(account => ({
        name: account.name,
        rateLimitTier: account.tier.rateLimitTier,
        seatTier: account.tier.seatTier,
      })),
  };
}
