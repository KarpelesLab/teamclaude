import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, hasBackendQuota, fetchBackendQuota } from '../src/backend-quota.js';

// Moonshot Open Platform (pay-as-you-go): the balance endpoint is the whole
// reading — `{ code, scode, status, data: { available_balance, cash_balance,
// voucher_balance } }`. The currency follows the region: .ai bills USD, .cn
// bills CNY. A negative cash balance is a deficit in collection.

const AI = 'https://api.moonshot.ai/anthropic';
const CN = 'https://api.moonshot.cn/anthropic';
const BALANCE = { code: 0, scode: '0x0', status: true, data: { available_balance: 12.34, cash_balance: 12.34, voucher_balance: 0 } };
const okFetch = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('moonshot is found by host on both regional origins', () => {
  assert.ok(providerFor(AI));
  assert.ok(providerFor(CN));
  assert.equal(hasBackendQuota({ upstream: AI, type: 'apikey' }), true);
  assert.equal(providerFor('https://api.moonshot.ai.example.com/'), null, 'a look-alike host is not moonshot');
});

test('the balance endpoint is called on the upstream origin, with a bearer', async () => {
  let seen = null;
  await fetchBackendQuota({ upstream: AI, credential: 'mk' }, {
    fetchImpl: async (url, opts) => { seen = { url, auth: opts.headers.Authorization }; return okFetch(BALANCE)(); },
  });
  assert.equal(seen.url, 'https://api.moonshot.ai/v1/users/me/balance');
  assert.equal(seen.auth, 'Bearer mk');
});

test('the balance reads as money, in the region’s currency', async () => {
  const usd = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch(BALANCE) });
  assert.equal(usd.label, 'Balance');
  assert.equal(usd.text, '$12.34');
  assert.equal(usd.utilization, null);
  const cny = await fetchBackendQuota({ upstream: CN, credential: 'mk' }, { fetchImpl: okFetch(BALANCE) });
  assert.equal(cny.text, '¥12.34');
});

test('a negative cash balance is called out as a deficit', async () => {
  const body = { ...BALANCE, data: { ...BALANCE.data, cash_balance: -0.5 } };
  const r = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '$12.34 · $0.50 in deficit');
});

test('a negative amount leads with the minus, not the symbol', async () => {
  const body = { ...BALANCE, data: { ...BALANCE.data, available_balance: -3 } };
  const r = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch(body) });
  assert.equal(r.text, '-$3.00');
});

test('a refused or shapeless reply is unrecognized, never a reading', async () => {
  const refused = { code: 5, scode: 'auth', status: false, data: {} };
  const r = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch(refused) });
  assert.deepEqual(r, { error: 'unrecognized response' });
  const junk = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch({ code: 0, status: true, data: {} }) });
  assert.deepEqual(junk, { error: 'unrecognized response' });
  // Number(null) is 0: a null balance must not read as an empty account.
  const nulled = await fetchBackendQuota({ upstream: AI, credential: 'mk' }, { fetchImpl: okFetch({ code: 0, status: true, data: { available_balance: null } }) });
  assert.deepEqual(nulled, { error: 'unrecognized response' });
});
