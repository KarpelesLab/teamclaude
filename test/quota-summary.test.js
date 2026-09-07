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
