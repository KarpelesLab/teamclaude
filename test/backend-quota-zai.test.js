import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, hasBackendQuota, fetchBackendQuota } from '../src/backend-quota.js';

// Z.ai GLM Coding Plan: two token windows (5-hour and weekly) published as
// used-percentages at a monitor path, behind the raw key rather than a bearer.

const ZAI = 'https://api.z.ai/api/anthropic';
const CN = 'https://open.bigmodel.cn/api/anthropic';
const H = 3600_000;
const now = Date.now();
const LIMITS = {
  code: 200, message: 'ok',
  data: {
    level: 'pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, total: 1000, nextResetTime: now + 2 * H + 10 * 60_000 + 30_000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 37, total: 5000, nextResetTime: now + 3 * 24 * H + 4 * H + 30_000 },
      { type: 'TIME_LIMIT', currentValue: 3, usage: 12, percentage: 4, usageDetails: [{ modelCode: 'search-prime', usage: 12 }] },
    ],
  },
};
const okFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('z.ai is found by host on both the international and mainland origins', () => {
  assert.ok(providerFor(ZAI));
  assert.ok(providerFor(CN));
  assert.equal(hasBackendQuota({ upstream: ZAI, type: 'oauth' }), true);
  assert.equal(providerFor('https://api.z.ai.example.com/'), null, 'a look-alike host is not z.ai');
});

test('the monitor is called on the upstream origin with the raw key, not a bearer', async () => {
  const seen = [];
  await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, {
    fetchImpl: async (url, opts) => { seen.push({ url: String(url), headers: opts.headers }); return okFetch(LIMITS)(); },
  });
  const monitor = seen.find(c => c.url.includes('quota/limit'));
  assert.equal(monitor.url, 'https://api.z.ai/api/monitor/usage/quota/limit');
  assert.equal(monitor.headers.Authorization, 'zk');
  assert.equal(monitor.headers['Accept-Language'], 'en-US,en');
  assert.equal(monitor.headers.Accept, 'application/json');
});

test('both windows land in one reading: the bar is the fuller one, the text names each with its reset', async () => {
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: okFetch(LIMITS) });
  assert.equal(r.label, 'Plan');
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h)');
  assert.equal(r.utilization, 0.37);
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 0.12, resetAt: LIMITS.data.limits[0].nextResetTime },
    weekly: { utilization: 0.37, resetAt: LIMITS.data.limits[1].nextResetTime },
  });
  assert.ok(r.at > 0);
});

test('the MCP monthly row is not a token window and is left out; a reply with no window is unrecognized', async () => {
  const onlyMcp = { data: { limits: [LIMITS.data.limits[2]] } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: okFetch(onlyMcp) });
  assert.deepEqual(r, { error: 'unrecognized response' });
  const r2 = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: okFetch({ code: 401, message: 'no' }) });
  assert.deepEqual(r2, { error: 'unrecognized response' });
});

test('a percentage past 100 or below 0 is clamped, and a missing reset drops only the countdown', async () => {
  const odd = { data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 130 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: -5, nextResetTime: 0 },
  ] } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: okFetch(odd) });
  assert.equal(r.text, '5h 100% · week 0%');
  assert.equal(r.utilization, 1);
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 1, resetAt: null },
    weekly: { utilization: 0, resetAt: null },
  });
});

test('an HTTP failure is reported as such, never as a reading', async () => {
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: okFetch({}, 401) });
  assert.deepEqual(r, { error: 'HTTP 401' });
});

// The console's account report: undocumented, but it answers on both the
// global and the mainland host (the mainland one on www., not open.). A
// subscription account simply reads zero.
const BALANCE = { success: true, data: { availableBalance: 5.5, balance: 5.5, rechargeAmount: 0, giveAmount: 0, totalSpendAmount: 0 } };
const routedFetch = (quotaBody, balanceBody, seen = []) => async (url, opts) => {
  if (String(url).includes('query-customer-account-report')) {
    seen.push({ url: String(url), auth: opts?.headers?.Authorization });
    return okFetch(balanceBody)();
  }
  return okFetch(quotaBody)();
};

test('a non-zero balance rides beside the plan windows, on the raw key', async () => {
  const seen = [];
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch(LIMITS, BALANCE, seen) });
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h) · balance $5.50');
  assert.equal(r.utilization, 0.37);
  assert.deepEqual(seen, [{ url: 'https://api.z.ai/api/biz/account/query-customer-account-report', auth: 'zk' }]);
});

test('a zero balance adds nothing to a plan reading', async () => {
  const zero = { success: true, data: { availableBalance: 0, balance: 0 } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch(LIMITS, zero) });
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h)');
});

test('a reply with no window falls back to a non-zero balance only', async () => {
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch({ code: 401, message: 'no' }, BALANCE) });
  assert.equal(r.label, 'Balance');
  assert.equal(r.text, '$5.50');
  assert.equal(r.utilization, null);
  const zero = { success: true, data: { availableBalance: 0, balance: 0 } };
  const r2 = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch({ code: 401, message: 'no' }, zero) });
  assert.deepEqual(r2, { error: 'unrecognized response' }, 'a zero balance is what a healthy plan account reads — it would mask an outage');
});

test('a null availableBalance falls back to balance, not to zero', async () => {
  const body = { success: true, data: { availableBalance: null, balance: 3.25 } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch({ code: 401, message: 'no' }, body) });
  assert.equal(r.text, '$3.25');
});

test('a negative amount leads with the minus, not the symbol', async () => {
  const body = { success: true, data: { availableBalance: -3, balance: -3 } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch({ code: 401, message: 'no' }, body) });
  assert.equal(r.text, '-$3.00');
});

test('the mainland plan reads its balance from the console host, in yuan', async () => {
  const seen = [];
  const r = await fetchBackendQuota({ upstream: CN, credential: 'zk' }, { fetchImpl: routedFetch({ code: 401, message: 'no' }, BALANCE, seen) });
  assert.equal(r.text, '¥5.50');
  assert.deepEqual(seen, [{ url: 'https://www.bigmodel.cn/api/biz/account/query-customer-account-report', auth: 'zk' }]);
});

test('a failed balance lookup never breaks the plan reading', async () => {
  const failing = async (url) => {
    if (String(url).includes('query-customer-account-report')) throw new Error('ECONNRESET');
    return okFetch(LIMITS)();
  };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: failing });
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h)');
  assert.equal(r.utilization, 0.37);
});

test('a balance reply that is not ok is ignored, whatever the body says', async () => {
  const fiveHundred = async (url) => String(url).includes('query-customer-account-report')
    ? okFetch({ success: true, data: { availableBalance: 9 } }, 500)()
    : okFetch(LIMITS)();
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: fiveHundred });
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h)');
});

test('a negative balance rides beside the plan windows too', async () => {
  const debt = { success: true, data: { availableBalance: -3, balance: -3 } };
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: routedFetch(LIMITS, debt) });
  assert.equal(r.text, '5h 12% (resets 2h10m) · week 37% (resets 3d4h) · balance -$3.00');
});

test('an HTTP failure on the monitor is an error, whatever the balance says', async () => {
  // A stored plan reading must survive a monitor outage; a balance — even a
  // non-zero one — says nothing about whether the plan windows moved.
  const notFound = async (url) => String(url).includes('query-customer-account-report')
    ? okFetch(BALANCE)()
    : okFetch({}, 404)();
  const r = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: notFound });
  assert.deepEqual(r, { error: 'HTTP 404' });
  const zero = { success: true, data: { availableBalance: 0, balance: 0 } };
  const fiveHundred = async (url) => String(url).includes('query-customer-account-report')
    ? okFetch(zero)()
    : okFetch({}, 500)();
  const r2 = await fetchBackendQuota({ upstream: ZAI, credential: 'zk' }, { fetchImpl: fiveHundred });
  assert.deepEqual(r2, { error: 'HTTP 500' });
});

test('DeepSeek still authenticates with a bearer — the header override is per provider', async () => {
  let auth = null;
  await fetchBackendQuota({ upstream: 'https://api.deepseek.com/anthropic', credential: 'k' }, {
    fetchImpl: async (url, opts) => { auth = opts.headers.Authorization; return okFetch({ balance_infos: [{ currency: 'USD', total_balance: '1' }] })(); },
  });
  assert.equal(auth, 'Bearer k');
});
