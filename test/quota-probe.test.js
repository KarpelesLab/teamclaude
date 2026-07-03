import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageBucket, findScopedWeeklyLimit } from '../src/oauth.js';
import { AccountManager, isFableModel, parseRequestModel } from '../src/account-manager.js';
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

// ── findScopedWeeklyLimit ─────────────────────────────────────

test('findScopedWeeklyLimit pulls a per-model weekly bucket from limits[]', () => {
  // Shape mirrors the real /api/oauth/usage payload: model-scoped weekly quota
  // lives in limits[] (the legacy seven_day_<model> top-level keys read null).
  const data = { limits: [
    { kind: 'session', group: 'session', percent: 47, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 8, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100,
      resets_at: '2026-07-03T17:00:00Z', scope: { model: { display_name: 'Fable' } } },
  ]};
  const b = normalizeUsageBucket(findScopedWeeklyLimit(data, /fable/i));
  assert.equal(b.utilization, 1);
  assert.equal(b.resetAt, Date.parse('2026-07-03T17:00:00Z'));

  assert.equal(findScopedWeeklyLimit(data, /sonnet/i), null);   // no Sonnet-scoped entry
  assert.equal(findScopedWeeklyLimit({}, /fable/i), null);      // no limits[] at all
  assert.equal(findScopedWeeklyLimit({ limits: [] }, /fable/i), null);
});

// ── applyUsageData ────────────────────────────────────────────

test('applyUsageData populates 5h/7d/sonnet/fable without counting a request', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: 111 },
    sevenDay: { utilization: 0.4, resetAt: 222 },
    sevenDaySonnet: { utilization: 0.6, resetAt: 333 },
    sevenDayFable: { utilization: 0.5, resetAt: 444 },
  });
  const a = am.accounts[0];
  assert.equal(a.quota.unified5h, 0.2);
  assert.equal(a.quota.unified7d, 0.4);
  assert.equal(a.quota.unified7dSonnet, 0.6);
  assert.equal(a.quota.unified7dSonnetReset, 333);
  assert.equal(a.quota.unified7dFable, 0.5);
  assert.equal(a.quota.unified7dFableReset, 444);
  assert.equal(a.usage.totalRequests, 0);   // a probe is not real traffic
  assert.equal(a.probing, false);            // learned the weekly window…
  assert.equal(a.requalify, true);           // …so re-evaluate selection
});

test('sonnet + fable quota survive the persistence round-trip', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am1.applyUsageData(0, {
    sevenDaySonnet: { utilization: 0.7, resetAt: 999 },
    sevenDayFable: { utilization: 0.3, resetAt: 888 },
  });
  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  assert.equal(am2.accounts[0].quota.unified7dSonnet, 0.7);
  assert.equal(am2.accounts[0].quota.unified7dSonnetReset, 999);
  assert.equal(am2.accounts[0].quota.unified7dFable, 0.3);
  assert.equal(am2.accounts[0].quota.unified7dFableReset, 888);
});

// ── updateQuota: Fable weekly from response headers ───────────

test('updateQuota records the Fable weekly bucket from the 7d_oi header', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-utilization': '0.56',
    'anthropic-ratelimit-unified-7d-reset': '1783098000',
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',   // Fable, in overage
    'anthropic-ratelimit-unified-7d_oi-reset': '1783098000',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.56);
  assert.equal(q.unified7dFable, 1.01);                        // stored as a 0-1 fraction, can exceed 1
  assert.equal(q.unified7dFableReset, 1783098000 * 1000);      // seconds → ms
});

// ── model-aware selection: Fable exhaustion is model-scoped ───

test('isFableModel / parseRequestModel', () => {
  assert.equal(isFableModel('claude-fable-5'), true);
  assert.equal(isFableModel('claude-opus-4-8'), false);
  assert.equal(isFableModel(null), false);
  assert.equal(parseRequestModel(Buffer.from('{"model":"claude-fable-5","max_tokens":1}')), 'claude-fable-5');
  assert.equal(parseRequestModel('{ "model" : "claude-opus-4-8" }'), 'claude-opus-4-8');
  assert.equal(parseRequestModel('{"max_tokens":1}'), null);
  assert.equal(parseRequestModel(null), null);
});

test('a Fable-exhausted account is skipped for Fable but used for other models', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  // Account a: Fable weekly spent (from a prior 429's 7d_oi header); everything else fine.
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 3600_000) / 1000)),
  });
  am.currentIndex = 0;

  // A Fable request must NOT land on the exhausted account…
  const forFable = am.getActiveAccount(null, 'claude-fable-5');
  assert.equal(forFable.name, 'b');

  // …but a non-Fable request still uses it (its Fable cap is irrelevant).
  am.currentIndex = 0;
  const forOpus = am.getActiveAccount(null, 'claude-opus-4-8');
  assert.equal(forOpus.name, 'a');

  // No model context → behaves as before (account a is available).
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount().name, 'a');
});

test('all accounts Fable-exhausted → no account for a Fable request', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const reset = String(Math.floor((Date.now() + 3600_000) / 1000));
  for (const i of [0, 1]) am.updateQuota(i, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
    'anthropic-ratelimit-unified-7d_oi-reset': reset,
  });
  // Probe is throttled off by default here, so a Fable request finds nothing…
  assert.equal(am.getActiveAccount(null, 'claude-fable-5'), null);
  // …while an Opus request is unaffected.
  assert.ok(am.getActiveAccount(null, 'claude-opus-4-8'));
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
