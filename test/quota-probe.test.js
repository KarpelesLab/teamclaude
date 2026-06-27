import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageBucket } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 3600_000, ...extra };
}

// ── normalizeUsageBucket ──────────────────────────────────────

test('normalizeUsageBucket converts OAuth usage percentages to 0-1', () => {
  assert.equal(normalizeUsageBucket({ used_percentage: 42 }).utilization, 0.42);
  assert.equal(normalizeUsageBucket({ utilization: 1 }).utilization, 0.01);
  assert.equal(normalizeUsageBucket({ utilization: 2 }).utilization, 0.02);
  assert.equal(normalizeUsageBucket({ utilization: 100 }).utilization, 1);
  assert.equal(normalizeUsageBucket({ used_percentage: '30' }).utilization, 0.3);
  assert.equal(normalizeUsageBucket({ used_percentage: 1 }).utilization, 0.01);
  assert.equal(normalizeUsageBucket({ used_percentage: '1' }).utilization, 0.01);
  assert.equal(normalizeUsageBucket({ usedPercentage: '1' }).utilization, 0.01);
  assert.equal(normalizeUsageBucket({ utilization: '1' }).utilization, 0.01);
  assert.equal(normalizeUsageBucket(null), null);
  assert.equal(normalizeUsageBucket({}).utilization, null);
});

test('normalizeUsageBucket normalizes resets to ms epoch', () => {
  assert.equal(normalizeUsageBucket({ resets_at: 1700000000 }).resetAt, 1700000000000);     // seconds → ms
  assert.equal(normalizeUsageBucket({ resets_at: 1700000000000 }).resetAt, 1700000000000);  // already ms
  assert.equal(normalizeUsageBucket({ resets_at: '2026-01-01T00:00:00Z' }).resetAt, Date.parse('2026-01-01T00:00:00Z'));
});

// ── applyUsageData ────────────────────────────────────────────

test('applyUsageData populates 5h/7d/sonnet without counting a request', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: 111 },
    sevenDay: { utilization: 0.4, resetAt: 222 },
    sevenDaySonnet: { utilization: 0.6, resetAt: 333 },
  });
  const a = am.accounts[0];
  assert.equal(a.quota.unified5h, 0.2);
  assert.equal(a.quota.unified7d, 0.4);
  assert.equal(a.quota.unified7dSonnet, 0.6);
  assert.equal(a.quota.unified7dSonnetReset, 333);
  assert.equal(a.usage.totalRequests, 0);   // a probe is not real traffic
  assert.equal(a.probing, false);            // learned the weekly window…
  assert.equal(a.requalify, true);           // …so re-evaluate selection
});

test('sonnet quota survives the persistence round-trip', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am1.applyUsageData(0, { sevenDaySonnet: { utilization: 0.7, resetAt: 999 } });
  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  assert.equal(am2.accounts[0].quota.unified7dSonnet, 0.7);
  assert.equal(am2.accounts[0].quota.unified7dSonnetReset, 999);
});

// ── Prober ────────────────────────────────────────────────────

test('prober probes oauth accounts and applies the usage data', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  let calls = 0;
  const probeFn = async () => { calls++; return { fiveHour: { utilization: 0.1, resetAt: 1000 }, sevenDay: { utilization: 0.2, resetAt: 2000 } }; };
  const prober = new Prober(am, { intervalMs: 0, probeFn, log: () => {} });
  await prober.probeAll();
  assert.equal(calls, 1);
  assert.equal(am.accounts[0].quota.unified5h, 0.1);
  assert.equal(am.accounts[0].quota.unified7d, 0.2);
});

test('prober skips API-key accounts', async () => {
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  let calls = 0;
  const prober = new Prober(am, { intervalMs: 0, probeFn: async () => { calls++; return {}; }, log: () => {} });
  await prober.probeAll();
  assert.equal(calls, 0);
});

test('prober retries once on a 401', async () => {
  const am = new AccountManager([oauth('a')], 0.98); // no refreshToken → ensureTokenFresh is a no-op
  let calls = 0;
  const probeFn = async () => {
    calls++;
    if (calls === 1) return { error: 'HTTP 401', status: 401 };
    return { sevenDay: { utilization: 0.3, resetAt: 5000 } };
  };
  const prober = new Prober(am, { intervalMs: 0, probeFn, log: () => {} });
  await prober.probeAll();
  assert.equal(calls, 2);
  assert.equal(am.accounts[0].quota.unified7d, 0.3);
});
