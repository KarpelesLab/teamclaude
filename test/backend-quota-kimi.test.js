import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, hasBackendQuota, fetchBackendQuota } from '../src/backend-quota.js';

// Kimi for Coding (Moonshot): one usages endpoint carries ratio pools under
// `usages` and legacy counters beside them (`usage` the weekly one, `limits[]`
// the rate-limit ones, numbers as strings). The ratio pools lag behind an
// active session — a zero ratio beside a moved counter with the same reset is
// a placeholder, and the counter wins.

const COM = 'https://api.kimi.com/coding';
const AI = 'https://api.kimi.ai/coding';
const H = 3600_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SESSION_RESET = now + 2 * H + 10 * 60_000 + 30_000;
const WEEK_RESET = now + 3 * 24 * H + 4 * H + 30_000;
const MONTH_RESET = now + 22 * 24 * H + 30_000;

// The live shape (2026-10-04): both ratios at 0 while the counters read
// 52/100 and 12/100, the two reset clocks ~1s apart.
const STUCK = {
  usage: { limit: '100', used: '12', remaining: '88', resetTime: iso(WEEK_RESET) },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '52', remaining: '48', resetTime: iso(SESSION_RESET) } }],
  usages: {
    limit_5h: { used_ratio: 0, reset_time: iso(SESSION_RESET - 1071) },
    limit_7d: { used_ratio: 0, reset_time: iso(WEEK_RESET - 1071) },
  },
};
const okFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('kimi is found by host on both the china and international origins', () => {
  assert.ok(providerFor(COM));
  assert.ok(providerFor(AI));
  assert.equal(hasBackendQuota({ upstream: COM, type: 'apikey' }), true);
  assert.equal(providerFor('https://api.kimi.com.cn/'), null, 'a look-alike host is not kimi');
});

test('the usages endpoint is called beside the configured upstream path, with a bearer', async () => {
  let seen = null;
  await fetchBackendQuota({ upstream: COM, credential: 'kk' }, {
    fetchImpl: async (url, opts) => { seen = { url, headers: opts.headers }; return okFetch(STUCK)(); },
  });
  assert.equal(seen.url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(seen.headers.Authorization, 'Bearer kk');
});

test('ratio pools land in windows and one reading', async () => {
  const body = {
    usages: {
      limit_5h: { used_ratio: 0.1, reset_time: iso(SESSION_RESET) },
      limit_7d: { used_ratio: 0.42, reset_time: iso(WEEK_RESET) },
      limit_month_total: { used_ratio: 0.0121, reset_time: iso(MONTH_RESET) },
    },
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.label, 'Plan');
  assert.equal(r.text, '5h 10% (resets 2h10m) · week 42% (resets 3d4h) · month 1% (resets 22d)');
  assert.equal(r.utilization, 0.42);
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 0.1, resetAt: SESSION_RESET },
    weekly: { utilization: 0.42, resetAt: WEEK_RESET },
    monthly: { utilization: 0.0121, resetAt: MONTH_RESET },
  });
});

test('a zero ratio beside a moved counter with the same reset is a placeholder — the counter wins', async () => {
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(STUCK) });
  assert.equal(r.text, '5h 52% (resets 2h10m) · week 12% (resets 3d4h)');
  assert.equal(r.utilization, 0.52);
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 0.52, resetAt: SESSION_RESET },
    weekly: { utilization: 0.12, resetAt: WEEK_RESET },
  });
});

test('the counter fallback stays off when a monthly pool says the ratios are real', async () => {
  const body = {
    ...STUCK,
    usages: { ...STUCK.usages, limit_month_total: { used_ratio: 0.0121, reset_time: iso(MONTH_RESET) } },
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '5h 0% (resets 2h10m) · week 0% (resets 3d4h) · month 1% (resets 22d)');
  assert.equal(r.windows.fiveHour.utilization, 0);
  assert.equal(r.windows.weekly.utilization, 0);
  assert.equal(r.windows.monthly.utilization, 0.0121);
});

test('the counter fallback needs the same reset within two seconds', async () => {
  const body = {
    ...STUCK,
    usages: {
      limit_5h: { used_ratio: 0, reset_time: iso(SESSION_RESET - 5000) },
      limit_7d: { used_ratio: 0, reset_time: iso(WEEK_RESET - 5000) },
    },
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '5h 0% (resets 2h10m) · week 0% (resets 3d4h)');
  assert.equal(r.utilization, 0);
});

test('an invalid ratio cannot suppress usable legacy counters', async () => {
  const body = {
    usage: STUCK.usage,
    usages: { limit_7d: { used_ratio: -0.5 } },
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, 'week 12% (resets 3d4h)');
  assert.deepEqual(r.windows, { weekly: { utilization: 0.12, resetAt: WEEK_RESET } });
});

test('a null ratio is no pool at all — the counters answer', async () => {
  // Number(null) is 0: a null ratio must not read as a real zero.
  const body = {
    ...STUCK,
    usages: { limit_5h: { used_ratio: null, reset_time: null }, limit_7d: { used_ratio: '' } },
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '5h 52% (resets 2h10m) · week 12% (resets 3d4h)');
  assert.equal(r.utilization, 0.52);
});

test('the five-hour counter is matched by window length, whatever unit the reply uses', async () => {
  const body = {
    ...STUCK,
    limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: STUCK.limits[0].detail }],
  };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.windows.fiveHour.utilization, 0.52);
});

test('a monthly-only reply does not invent session or weekly windows', async () => {
  const body = { usages: { limit_month_total: { used_ratio: 1.05, reset_time: iso(MONTH_RESET) } } };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, 'month 100% (resets 22d)');
  assert.equal(r.utilization, 1);
  assert.deepEqual(r.windows, { monthly: { utilization: 1, resetAt: MONTH_RESET } });
});

test('the counter fallback stays off when the weekly counter cannot be parsed', async () => {
  // The weekly legacy counter gates either fallback; a reply where it has
  // neither used nor remaining leaves the zero ratios trusted.
  const body = { ...STUCK, usage: { limit: '100' } };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '5h 0% (resets 2h10m) · week 0% (resets 3d4h)');
  assert.equal(r.utilization, 0);
});

test('a counter that cannot be parsed is no reading at all', async () => {
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch({ usage: { limit: '100' } }) });
  assert.deepEqual(r, { error: 'unrecognized response' });
});

test('every subset of the three pools reads as exactly those windows', async () => {
  const pool = {
    limit_5h: { used_ratio: 0.1, reset_time: iso(SESSION_RESET) },
    limit_7d: { used_ratio: 0.42, reset_time: iso(WEEK_RESET) },
    limit_month_total: { used_ratio: 0.05, reset_time: iso(MONTH_RESET) },
  };
  const cases = [
    [['limit_5h', 'limit_7d', 'limit_month_total'], ['fiveHour', 'weekly', 'monthly']],
    [['limit_5h', 'limit_month_total'], ['fiveHour', 'monthly']],
    [['limit_5h', 'limit_7d'], ['fiveHour', 'weekly']],
    [['limit_7d', 'limit_month_total'], ['weekly', 'monthly']],
    [['limit_5h'], ['fiveHour']],
    [['limit_7d'], ['weekly']],
    [['limit_month_total'], ['monthly']],
  ];
  for (const [named, expected] of cases) {
    // The legacy counters ride along in every case: they must not add a
    // window the pools left out.
    const body = { usage: STUCK.usage, limits: STUCK.limits, usages: Object.fromEntries(named.map(k => [k, pool[k]])) };
    const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
    assert.deepEqual(Object.keys(r.windows).sort(), [...expected].sort(), `pools ${named.join('+')}`);
  }
  // An empty pool set names no window at all: the counters beside it do not
  // turn it back into the legacy format.
  const none = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch({ usage: STUCK.usage, limits: STUCK.limits, usages: {} }) });
  assert.deepEqual(none, { error: 'unrecognized response' });
});

test('a reply with no pools at all reads its windows from the legacy counters', async () => {
  const body = { usage: STUCK.usage, limits: STUCK.limits };
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch(body) });
  assert.deepEqual(r.windows, {
    fiveHour: { utilization: 0.52, resetAt: SESSION_RESET },
    weekly: { utilization: 0.12, resetAt: WEEK_RESET },
  });
});

test('an HTTP failure is reported as such, never as a reading', async () => {
  const r = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch({}, 401) });
  assert.deepEqual(r, { error: 'HTTP 401' });
  const junk = await fetchBackendQuota({ upstream: COM, credential: 'kk' }, { fetchImpl: okFetch({ nope: 1 }) });
  assert.deepEqual(junk, { error: 'unrecognized response' });
});
