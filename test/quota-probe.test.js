import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageBucket, findScopedWeeklyLimit, normalizeUsagePayload } from '../src/oauth.js';
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

// ── normalizeUsagePayload: what a probe can conclude ──────────

// Shape copied from a real Max payload: the account has a Fable cap it has not
// touched (percent 0, no window started) and no Sonnet cap at all.
const USAGE_PAYLOAD = {
  five_hour: { utilization: 15, resets_at: '2026-09-02T13:59:59Z' },
  seven_day: { utilization: 6, resets_at: '2026-09-04T03:59:59Z' },
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 15, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 6, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null,
      scope: { model: { id: null, display_name: 'Fable' } } },
  ],
};

test('a listed-but-unused family reads as zero with no window', () => {
  const u = normalizeUsagePayload(USAGE_PAYLOAD);
  assert.equal(u.sevenDayFable.utilization, 0);
  assert.equal(u.sevenDayFable.resetAt, null);   // the window has not started
  assert.equal(u.sevenDaySonnet, null);          // this account has no Sonnet cap
  assert.equal(u.scopedWeeklyListed, true);      // …and upstream said so explicitly
});

test('Sonnet is read from the enumeration too, not only the legacy key', () => {
  const u = normalizeUsagePayload({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 40, resets_at: '2026-09-04T03:59:59Z',
      scope: { model: { display_name: 'Sonnet' } } },
  ]});
  assert.equal(u.sevenDaySonnet.utilization, 0.4);
  // The legacy top-level key still wins where a plan still reports it.
  assert.equal(normalizeUsagePayload({ seven_day_sonnet: { utilization: 70 }, limits: [] }).sevenDaySonnet.utilization, 0.7);
});

test('a payload with no enumeration concludes nothing about families', () => {
  const u = normalizeUsagePayload({ five_hour: { utilization: 3 } });
  assert.equal(u.sevenDayFable, null);
  assert.equal(u.sevenDaySonnet, null);
  assert.equal(u.scopedWeeklyListed, false);
});

// ── applyUsageData: the probe revalidates family buckets ──────

// Put an account in the state #167 described: a spent family reading whose own
// reset is days out, so nothing expires it and selection refuses the family.
function sealFable(am, { utilization = 0.99 } = {}) {
  const q = am.accounts[0].quota;
  q.unified7dFable = utilization;
  q.unified7dFableReset = Date.now() + 7 * 24 * 3600_000;
  q.unified7dFableSeenAt = Date.now() - 60_000;
  return q;
}

test('a probe that reports the family available breaks the seal', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = sealFable(am);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5'), null);   // refusing Fable

  am.applyUsageData(0, normalizeUsagePayload(USAGE_PAYLOAD));

  assert.equal(q.unified7dFable, 0);
  // The stale reset went with it: it was the shared weekly window, copied in by
  // the header path, and keeping it would misdate the bar and misrank selection.
  assert.equal(q.unified7dFableReset, null);
  assert.ok(q.unified7dFableSeenAt > Date.now() - 5000);             // freshly confirmed
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'a');
});

test('a family missing from an enumeration is cleared, not kept', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = sealFable(am);
  // Upstream listed this account's scoped weekly caps and Fable was not among
  // them — the cap is gone, so the family falls back to the shared weekly gate.
  am.applyUsageData(0, normalizeUsagePayload({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 6, scope: null },
  ]}));
  assert.equal(q.unified7dFable, null);
  assert.equal(q.unified7dFableReset, null);
  assert.equal(q.unified7dFableSeenAt, null);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'a');
});

test('a payload that enumerates nothing leaves the reading alone', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = sealFable(am);
  const reset = q.unified7dFableReset;
  // No enumeration: the family is missing because we cannot see it, not because
  // upstream says it is gone. Clearing here would drop a real cap and overspend.
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 3 } }));
  assert.equal(q.unified7dFable, 0.99);
  assert.equal(q.unified7dFableReset, reset);
  // The staleness floor still frees it later; that path is unchanged.
});

test('a failed probe is not evidence', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = sealFable(am);
  am.applyUsageData(0, { error: 'HTTP 503', status: 503 });
  assert.equal(q.unified7dFable, 0.99);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5'), null);
});

test('a probe that reports the family still spent keeps it spent', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = sealFable(am);
  const at = Date.parse('2026-09-04T10:00:00Z');
  am.applyUsageData(0, normalizeUsagePayload({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 99, resets_at: '2026-09-04T10:00:00Z',
      scope: { model: { display_name: 'Fable' } } },
  ]}));
  assert.equal(q.unified7dFable, 0.99);
  assert.equal(q.unified7dFableReset, at);        // now dated by its OWN window
  assert.equal(am.getActiveAccount(null, 'claude-fable-5'), null);
});

// ── updateQuota: Fable weekly from response headers ───────────

test('updateQuota records the Fable weekly bucket from the 7d_oi header', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const reset = Math.floor((Date.now() + 3600_000) / 1000);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-utilization': '0.56',
    'anthropic-ratelimit-unified-7d-reset': String(reset),
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',   // Fable, in overage
    'anthropic-ratelimit-unified-7d_oi-reset': String(reset),
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.56);
  assert.equal(q.unified7dFable, 1.01);                        // stored as a 0-1 fraction, can exceed 1
  assert.equal(q.unified7dFableReset, reset * 1000);           // seconds → ms
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
test('prober status records account probe results', async () => {
  const am = new AccountManager([oauth('a'), { name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const prober = new Prober(am, {
    intervalMs: 300_000,
    probeFn: async () => ({ sevenDay: { utilization: 0.3, resetAt: 5000 } }),
    log: () => {},
  });

  await prober.probeAll();
  const status = prober.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.intervalSeconds, 300);
  assert.equal(status.accounts[0].name, 'a');
  assert.equal(status.accounts[0].status, 'ok');
  assert.equal(typeof status.accounts[0].lastProbedAt, 'string');
  assert.equal(status.accounts[1].status, 'not-applicable');
});

test('prober refreshes expired token before probing', async () => {
  const am = new AccountManager(
    [oauth('a', { refreshToken: 'refresh', expiresAt: Date.now() - 1000 })],
    0.98,
    { refreshFn: async () => ({ accessToken: 'fresh', refreshToken: 'refresh2', expiresAt: Date.now() + 3600_000 }) },
  );
  let token = null;
  const prober = new Prober(am, {
    intervalMs: 0,
    probeFn: async credential => {
      token = credential;
      return { sevenDay: { utilization: 0.3, resetAt: 5000 } };
    },
    log: () => {},
  });

  await prober.probeAll();
  assert.equal(token, 'fresh');
});
