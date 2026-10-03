import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, hasBackendQuota, fetchBackendQuota } from '../src/backend-quota.js';

// NanoGPT subscription: daily and weekly token windows as used-fractions, plus
// the gateway's own advice on whether the next request bills the balance.

const NANO = 'https://api.nano-gpt.com/api';
const H = 3600_000;
const now = Date.now();
const win = (percentUsed, resetIn, extra = {}) => ({ used: 1, remaining: 1, percentUsed, resetAt: now + resetIn + 30_000, degraded: false, ...extra });
const ACTIVE = {
  active: true, state: 'active', limits: {},
  dailyInputTokens: win(0.12, 5 * H + 10 * 60_000),
  weeklyInputTokens: win(0.37, 3 * 24 * H + 4 * H),
  dailyImages: null, period: { currentPeriodEnd: '2026-10-30T00:00:00Z' },
  routing: { recommendedMode: 'subscription', reason: 'quota available', subscriptionQuotaAvailable: true, paidSpendPolicyAllowsBalance: true },
};
const okFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const read = (body) => fetchBackendQuota({ upstream: NANO, credential: 'nk' }, { fetchImpl: okFetch(body) });

test('nano-gpt is found by host, with the usage path beside the /api the messages endpoint lives under', async () => {
  assert.ok(providerFor(NANO));
  assert.equal(hasBackendQuota({ upstream: NANO, type: 'oauth' }), true);
  assert.equal(providerFor('https://api.nano-gpt.com.example.net/api'), null, 'a look-alike host is not nano-gpt');
  let seen = null;
  await fetchBackendQuota({ upstream: NANO, credential: 'nk' }, {
    fetchImpl: async (url, opts) => { seen = { url, auth: opts.headers.Authorization }; return okFetch(ACTIVE)(); },
  });
  assert.equal(seen.url, 'https://api.nano-gpt.com/api/subscription/v1/usage');
  assert.equal(seen.auth, 'Bearer nk');
});

test('both windows land in one reading, the bar the fuller of the two', async () => {
  const r = await read(ACTIVE);
  assert.equal(r.label, 'Plan');
  assert.equal(r.text, 'day 12% (resets 5h10m) · week 37% (resets 3d4h)');
  assert.equal(r.utilization, 0.37);
});

test('a subscription that has run out says it is now billing the balance', async () => {
  const spent = { ...ACTIVE, dailyInputTokens: win(1.04, H), routing: { recommendedMode: 'paygo', paidSpendPolicyAllowsBalance: true } };
  const r = await read(spent);
  assert.match(r.text, /day 104% \(resets 1h\)/);
  assert.match(r.text, /· billing balance$/);
  assert.equal(r.utilization, 1, 'the bar is clamped, the text is not');
  // Spend policy forbids the balance: it stops instead, and the text says so.
  const blocked = { ...spent, routing: { recommendedMode: 'paygo', paidSpendPolicyAllowsBalance: false } };
  assert.match((await read(blocked)).text, /· balance not allowed$/);
  const unavailable = { ...spent, routing: { recommendedMode: 'unavailable' } };
  assert.match((await read(unavailable)).text, /· unavailable$/);
});

test('a degraded window is marked as approximate, and grace is named', async () => {
  const r = await read({ ...ACTIVE, state: 'grace', dailyInputTokens: win(0.5, H, { degraded: true }) });
  assert.match(r.text, /^~day 50% \(resets 1h\) · week 37%.*· grace period$/);
});

test('an inactive subscription is reported as that, with no bar', async () => {
  const r = await read({ active: false, state: 'inactive' });
  assert.deepEqual({ text: r.text, utilization: r.utilization }, { text: 'subscription inactive', utilization: null });
});

test('a token-based trial reports its single window', async () => {
  const r = await read({ active: true, state: 'active', dailyInputTokens: null, weeklyInputTokens: null, tokens: win(0.2, 2 * H), usageUnits: 'tokens' });
  assert.equal(r.text, 'trial 20% (resets 2h)');
});

test('a reply that is not a usage document, or has no window, is unrecognized rather than guessed at', async () => {
  for (const body of [{}, { error: 'nope' }, { active: true, dailyInputTokens: null, weeklyInputTokens: null }, null]) {
    assert.deepEqual(await read(body), { error: 'unrecognized response' }, JSON.stringify(body));
  }
});

test('an HTTP failure is reported as such', async () => {
  assert.deepEqual(await fetchBackendQuota({ upstream: NANO, credential: 'nk' }, { fetchImpl: okFetch({}, 401) }), { error: 'HTTP 401' });
});
