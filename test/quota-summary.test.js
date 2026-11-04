import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, tier = {}) {
  return { name, type: 'oauth', accessToken: `token-${name}`, ...tier };
}

test('AccountManager exposes a quota summary for status clients', () => {
  const am = new AccountManager([], 0.98);

  assert.equal(typeof am.getQuotaSummary, 'function');
});

test('quota summary classifies supported subscription and Team seat tiers', () => {
  const am = new AccountManager([
    oauth('pro', { rateLimitTier: 'default_claude_ai', organizationType: 'claude_pro' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_x5' }),
    oauth('max-20', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('team-standard', { rateLimitTier: 'default_raven', seatTier: 'team_standard' }),
    oauth('team-tier-1', { rateLimitTier: 'default_raven', seatTier: 'team_tier_1' }),
    oauth('team-tier-2', { rateLimitTier: 'default_raven', seatTier: 'team_tier_2' }),
    oauth('future-tier', { rateLimitTier: 'default_heron', seatTier: 'team_tier_9' }),
  ], 0.98);

  const summary = am.getQuotaSummary();
  assert.deepEqual(
    summary.accounts?.map(account => [account.name, account.tier.weight]),
    [
      ['pro', 1],
      ['max-5', 5],
      ['max-20', 20],
      ['team-standard', 1],
      ['team-tier-1', 5],
      ['team-tier-2', 20],
      ['future-tier', null],
    ],
  );
  assert.deepEqual(summary.unknownTiers, [{
    name: 'future-tier',
    rateLimitTier: 'default_heron',
    seatTier: 'team_tier_9',
  }]);
});

// Max 20x is now called Ultra, at the same weekly limit (Anthropic, 2026-10-30).
// The tier string an Ultra account reports has not been seen yet: one that
// names the plan weighs what Max 20x does, and the 20x strings keep matching.
test('an Ultra rate-limit tier weighs what Max 20x does', () => {
  const am = new AccountManager([
    oauth('ultra', { rateLimitTier: 'default_claude_ultra' }),
    oauth('ultra-upper', { rateLimitTier: 'DEFAULT_CLAUDE_ULTRA' }),
    oauth('max-20', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_5x' }),
  ], 0.98);
  const summary = am.getQuotaSummary();
  assert.deepEqual(summary.accounts.map(account => [account.name, account.tier.weight]),
    [['ultra', 20], ['ultra-upper', 20], ['max-20', 20], ['max-5', 5]]);
  assert.deepEqual(summary.unknownTiers, []);
});

// An Ultra account whose 5-hour limit is gone has no session reading: it still
// counts towards the weekly aggregates, and the five-hour one describes only
// the accounts that meter that window.
test('an account with no five-hour window joins the weekly aggregates only', () => {
  const am = new AccountManager([
    oauth('ultra', { rateLimitTier: 'default_claude_ultra' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_5x' }),
  ], 0.98);
  const reset = Date.now() + 86_400_000;
  Object.assign(am.accounts[0].quota, { unified7d: 0.5, unified7dReset: reset, sessionWindowStated: false });
  Object.assign(am.accounts[1].quota, { unified5h: 0.4, unified5hReset: reset, unified7d: 0.2, unified7dReset: reset });

  const summary = am.getQuotaSummary();
  assert.equal(summary.accounts[0].buckets.fiveHour, null);
  assert.equal(summary.aggregate.fiveHour.knownAccounts, 1);
  assert.equal(summary.aggregate.fiveHour.capacityWeight, 5);
  assert.equal(summary.aggregate.weeklyShared.knownAccounts, 2);
  assert.equal(summary.aggregate.weeklyShared.capacityWeight, 25);
  assert.equal(summary.aggregate.weeklyShared.usedWeight, 11);
});

// A status-line client reads this endpoint alone. `fiveHour: null` on an
// account reads the same whether it meters no session window or has not
// reported yet, and a fiveHour aggregate over the metered minority reads as
// the fleet's session quota. Each row says which, and the aggregate counts the
// capacity it leaves out because the window does not apply to it.
test('the summary says which accounts meter no five-hour window and how much capacity that leaves out', () => {
  const am = new AccountManager([
    oauth('ultra-1', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('ultra-2', { rateLimitTier: 'default_claude_ultra' }),
    oauth('pro', { rateLimitTier: 'default_claude_ai' }),
    oauth('fresh', { rateLimitTier: 'default_claude_max_5x' }),
    oauth('stale', { rateLimitTier: 'default_claude_max_5x' }),
  ], 0.98);
  const reset = Date.now() + 86_400_000;
  for (const i of [0, 1]) Object.assign(am.accounts[i].quota, { unified7d: 0.3, unified7dReset: reset, sessionWindowStated: false });
  Object.assign(am.accounts[2].quota, { unified5h: 0.95, unified5hReset: reset, unified7d: 0.5, unified7dReset: reset, sessionWindowStated: true });
  // Flagged by a response, its reading from before the change still there:
  // it still gates, so it still counts in the aggregate and is not exempt.
  Object.assign(am.accounts[4].quota, { unified5h: 0.5, unified5hReset: reset, unified7d: 0.1, unified7dReset: reset, sessionWindowStated: false });

  const summary = am.getQuotaSummary();
  assert.deepEqual(summary.accounts.map(a => [a.name, a.sessionWindow]),
    [['ultra-1', false], ['ultra-2', false], ['pro', true], ['fresh', null], ['stale', false]]);
  const five = summary.aggregate.fiveHour;
  assert.equal(five.knownAccounts, 2);
  assert.equal(five.capacityWeight, 6);
  assert.equal(five.exemptAccounts, 2);
  assert.equal(five.exemptWeight, 40);

  // The weekly aggregates have no such field: every subscription meters a
  // weekly window or says nothing.
  assert.equal('exemptAccounts' in summary.aggregate.weeklyShared, false);

  // With no metered reading at all the aggregate stays null, as it always
  // was; the rows say why.
  const only = new AccountManager([oauth('u', { rateLimitTier: 'default_claude_ultra' })], 0.98);
  Object.assign(only.accounts[0].quota, { unified7d: 0.3, unified7dReset: reset, sessionWindowStated: false });
  const s = only.getQuotaSummary();
  assert.equal(s.aggregate.fiveHour, null);
  assert.equal(s.accounts[0].sessionWindow, false);
});

test('quota summary returns per-account buckets and tier-weighted fleet totals', () => {
  const am = new AccountManager([
    oauth('pro', { rateLimitTier: 'default_claude_ai' }),
    oauth('max-5', { rateLimitTier: 'default_claude_max_5x' }),
    oauth('unknown', { rateLimitTier: 'default_heron' }),
  ], 0.98);
  const resetPro = Date.now() + 3_600_000;
  const resetMax = Date.now() + 7_200_000;
  Object.assign(am.accounts[0].quota, {
    unified5h: 0.2, unified5hReset: resetPro,
    unified7d: 0.4, unified7dReset: resetPro,
    unified7dSonnet: 0.6, unified7dSonnetReset: resetMax,
  });
  Object.assign(am.accounts[1].quota, {
    unified5h: 0.8, unified5hReset: resetMax,
    unified7d: 0.2, unified7dReset: resetMax,
    unified7dFable: 0.5, unified7dFableReset: resetPro,
  });
  Object.assign(am.accounts[2].quota, {
    unified5h: 0, unified5hReset: resetPro,
    unified7d: 0, unified7dReset: resetPro,
  });

  const summary = am.getQuotaSummary();
  assert.deepEqual(summary.accounts[0].buckets, {
    fiveHour: { utilization: 0.2, remaining: 0.8, resetAt: resetPro, source: 'unified5h' },
    weeklyShared: { utilization: 0.4, remaining: 0.6, resetAt: resetPro, source: 'unified7d' },
    weeklySonnet: { utilization: 0.6, remaining: 0.4, resetAt: resetMax, source: 'unified7dSonnet' },
    weeklyFable: { utilization: 0.4, remaining: 0.6, resetAt: resetPro, source: 'unified7d' },
  });
  assert.deepEqual(summary.accounts[1].buckets.weeklySonnet, {
    utilization: 0.2, remaining: 0.8, resetAt: resetMax, source: 'unified7d',
  });

  assert.deepEqual(summary.aggregate.fiveHour, {
    capacityWeight: 6,
    usedWeight: 4.2,
    remainingWeight: 1.8,
    utilization: 0.7,
    remaining: 0.3,
    knownAccounts: 2,
    nextResetAt: resetPro,
    exemptAccounts: 0,
    exemptWeight: 0,
  });
  assert.deepEqual(summary.aggregate.weeklyShared, {
    capacityWeight: 6,
    usedWeight: 1.4,
    remainingWeight: 4.6,
    utilization: 0.233333333333,
    remaining: 0.766666666667,
    knownAccounts: 2,
    nextResetAt: resetPro,
  });
  assert.deepEqual(summary.aggregate.weeklySonnet, {
    capacityWeight: 6,
    usedWeight: 1.6,
    remainingWeight: 4.4,
    utilization: 0.266666666667,
    remaining: 0.733333333333,
    knownAccounts: 2,
    nextResetAt: resetMax,
  });
  assert.deepEqual(summary.aggregate.weeklyFable, {
    capacityWeight: 6,
    usedWeight: 2.9,
    remainingWeight: 3.1,
    utilization: 0.483333333333,
    remaining: 0.516666666667,
    knownAccounts: 2,
    nextResetAt: resetPro,
  });
});

test('quota summary keeps API-key limits per account without mixing their units into subscription aggregates', () => {
  const am = new AccountManager([
    oauth('subscription', { rateLimitTier: 'default_claude_ai' }),
    { name: 'api', type: 'apikey', apiKey: 'sk-test' },
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.5, unified7d: 0.25 });
  Object.assign(am.accounts[1].quota, {
    tokensLimit: 1000, tokensRemaining: 250,
    requestsLimit: 100, requestsRemaining: 40,
    resetsAt: 1_900_000_000_000,
  });

  const summary = am.getQuotaSummary();
  const api = summary.accounts.find(account => account.name === 'api');
  assert.ok(api);
  assert.deepEqual(api.buckets.tokens, {
    utilization: 0.75, remaining: 0.25, resetAt: 1_900_000_000_000, source: 'tokens',
    limit: 1000, remainingAmount: 250,
  });
  assert.deepEqual(api.buckets.requests, {
    utilization: 0.6, remaining: 0.4, resetAt: 1_900_000_000_000, source: 'requests',
    limit: 100, remainingAmount: 40,
  });
  assert.equal(summary.aggregate.fiveHour.capacityWeight, 1);
  assert.deepEqual(summary.unknownTiers, []);
});

test('quota summary does not report an expired cached window', () => {
  const am = new AccountManager([oauth('pro', { rateLimitTier: 'default_claude_ai' })], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified5hReset: Date.now() - 1 });

  const summary = am.getQuotaSummary();

  assert.equal(summary.accounts[0].buckets.fiveHour, null);
  assert.equal(summary.aggregate.fiveHour, null);
});

test('backend windows fill the buckets no unified field covers', () => {
  const am = new AccountManager([{ name: 'kimi', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  const fiveReset = Date.now() + 3_600_000;
  const weekReset = Date.now() + 3 * 86_400_000;
  const monthReset = Date.now() + 22 * 86_400_000;
  const at = Date.now() - 4 * 3_600_000;
  Object.assign(am.accounts[0].quota, {
    backend: {
      label: 'Plan', text: '5h 52% · week 12%', utilization: 0.52, at,
      windows: {
        fiveHour: { utilization: 0.52, resetAt: fiveReset },
        weekly: { utilization: 0.12, resetAt: weekReset },
        monthly: { utilization: 0.05, resetAt: monthReset },
      },
    },
  });

  const summary = am.getQuotaSummary();
  const buckets = summary.accounts[0].buckets;
  assert.deepEqual(buckets.fiveHour, { utilization: 0.52, remaining: 0.48, resetAt: fiveReset, source: 'backendFiveHour', observedAt: at });
  assert.deepEqual(buckets.weeklyShared, { utilization: 0.12, remaining: 0.88, resetAt: weekReset, source: 'backendWeekly', observedAt: at });
  assert.deepEqual(buckets.monthly, { utilization: 0.05, remaining: 0.95, resetAt: monthReset, source: 'backendMonthly', observedAt: at });
  assert.equal(buckets.weeklySonnet, null, 'a backend account has no family split');
  assert.equal(summary.aggregate.monthly, undefined, 'backend windows never join the aggregates');
});

// #510: a probe that keeps failing leaves the last good reading in place, and
// a window with no reset never expires. The bucket states when it was read, so
// the consumer can decide what "too old" means.
test('a backend bucket states the age of its reading, and survives a failed probe with it', () => {
  const am = new AccountManager([{ name: 'zai', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  const at = Date.now() - 6 * 3_600_000;
  am.applyBackendQuota(0, { label: 'Plan', text: '5h 40%', utilization: 0.4, at, windows: { fiveHour: { utilization: 0.4, resetAt: null } } });
  am.applyBackendQuota(0, { error: 'HTTP 503' });

  const five = am.getQuotaSummary().accounts[0].buckets.fiveHour;
  assert.equal(five.utilization, 0.4, 'the failed probe cleared nothing');
  assert.equal(five.resetAt, null, 'and with no reset the window never expires');
  assert.equal(five.observedAt, at, 'so its age is what says how much it is worth');
});

test('a unified bucket carries no observedAt: the key is the backend reading\'s own', () => {
  const am = new AccountManager([oauth('pro', { rateLimitTier: 'default_claude_ai' })], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified5hReset: Date.now() + 3_600_000 });
  assert.equal('observedAt' in am.getQuotaSummary().accounts[0].buckets.fiveHour, false);
});

test('a backend bucket never moves the aggregate, even with a tier configured', () => {
  const am = new AccountManager([{ name: 'kimi', type: 'apikey', apiKey: 'sk-test', rateLimitTier: 'default_claude_ai' }], 0.98);
  Object.assign(am.accounts[0].quota, {
    backend: {
      label: 'Plan', text: '5h 52%', utilization: 0.52, at: Date.now(),
      windows: { fiveHour: { utilization: 0.52, resetAt: Date.now() + 3_600_000 } },
    },
  });

  const summary = am.getQuotaSummary();
  assert.equal(summary.accounts[0].tier.weight, 1, 'the configured tier is read');
  assert.equal(summary.aggregate.fiveHour, null, 'but a backend source is not aggregated');
});

test('a unified reading outranks a backend window', () => {
  const am = new AccountManager([oauth('pro', { rateLimitTier: 'default_claude_ai' })], 0.98);
  const unifiedReset = Date.now() + 3_600_000;
  const backendReset = Date.now() + 7_200_000;
  Object.assign(am.accounts[0].quota, {
    unified5h: 0.9, unified5hReset: unifiedReset,
    backend: { label: 'Plan', text: '5h 52%', utilization: 0.52, at: Date.now(), windows: { fiveHour: { utilization: 0.52, resetAt: backendReset } } },
  });

  const summary = am.getQuotaSummary();

  assert.deepEqual(summary.accounts[0].buckets.fiveHour, {
    utilization: 0.9, remaining: 0.1, resetAt: unifiedReset, source: 'unified5h',
  });
});

test('an expired backend window is not reported', () => {
  const am = new AccountManager([{ name: 'kimi', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  Object.assign(am.accounts[0].quota, {
    backend: {
      label: 'Plan', text: '5h 52% · week 12%', utilization: 0.52, at: Date.now(),
      windows: {
        fiveHour: { utilization: 0.52, resetAt: Date.now() - 1 },
        weekly: { utilization: 0.12, resetAt: Date.now() + 86_400_000 },
      },
    },
  });

  const summary = am.getQuotaSummary();
  assert.equal(summary.accounts[0].buckets.fiveHour, null);
  assert.equal(summary.accounts[0].buckets.weeklyShared.utilization, 0.12);
});

test('a balance-only backend reading adds no buckets', () => {
  const am = new AccountManager([{ name: 'deepseek', type: 'apikey', apiKey: 'sk-test' }], 0.98);
  Object.assign(am.accounts[0].quota, {
    backend: { label: 'Balance', text: '$25.81', utilization: null, at: Date.now() },
  });

  const summary = am.getQuotaSummary();
  const buckets = summary.accounts[0].buckets;
  assert.equal(buckets.fiveHour, null);
  assert.equal(buckets.monthly, undefined, 'a monthly key appears only with a monthly window');
});
