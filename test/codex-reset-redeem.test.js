import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  creditRows,
  spendableCredit,
  fetchCodexResetCredits,
  consumeCodexResetCredit,
  CODEX_RESET_CREDITS_URL,
} from '../src/codex-usage.js';

const account = { credential: 'tok', accountId: 'acct-1' };

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

test('credit rows are found under the usual keys or as a bare array', () => {
  assert.deepEqual(creditRows([{ id: 'a' }, null, 'x']), [{ id: 'a' }]);
  assert.deepEqual(creditRows({ credits: [{ id: 'b' }] }), [{ id: 'b' }]);
  assert.deepEqual(creditRows({ other: 1, rate_limit_reset_credits: [{ id: 'c' }] }), [{ id: 'c' }]);
  assert.deepEqual(creditRows({ whatever: [{ id: 'd' }] }), [{ id: 'd' }]);
  assert.deepEqual(creditRows({ count: 2 }), []);
  assert.deepEqual(creditRows(null), []);
});

test('the first available, plan-supported credit is chosen; redeemed and unsupported ones are skipped', () => {
  const rows = [
    { id: 'RateLimitResetCredit_used', status: 'redeemed' },
    { id: 'RateLimitResetCredit_nope', status: 'available', supported: false },
    { id: 'RateLimitResetCredit_ok', status: 'available' },
    { id: 'RateLimitResetCredit_later', status: 'available' },
  ];
  assert.equal(spendableCredit(rows)?.id, 'RateLimitResetCredit_ok');
  assert.equal(spendableCredit([{ id: 'x', status: 'expired' }]), null);
  // A row that states no status at all is taken at face value.
  assert.equal(spendableCredit([{ credit_id: 'y' }])?.id, 'y');
});

test('listing sends the Codex identity headers and returns the rows', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: { credits: [{ id: 'c1', status: 'available' }] } }));
  const res = await fetchCodexResetCredits(account, { fetchImpl });
  assert.equal(calls[0].url, CODEX_RESET_CREDITS_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.deepEqual(res.rows, [{ id: 'c1', status: 'available' }]);
});

test('listing reports an HTTP failure with its status, and refuses without an identity', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 401 }));
  assert.deepEqual(await fetchCodexResetCredits(account, { fetchImpl }), { error: 'HTTP 401', status: 401 });
  assert.equal((await fetchCodexResetCredits({ credential: 'tok' }, { fetchImpl })).error, 'missing Codex account identity');
});

test('consuming posts the credit id with the idempotency key and reads the reply', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    body: { code: 'reset', credit: { id: 'c1', status: 'redeemed' }, windows_reset: 1 },
  }));
  const res = await consumeCodexResetCredit(account, 'c1', 'req-123', { fetchImpl });
  assert.equal(calls[0].url, `${CODEX_RESET_CREDITS_URL}/consume`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { credit_id: 'c1', redeem_request_id: 'req-123' });
  assert.equal(res.code, 'reset');
  assert.equal(res.windowsReset, 1);
  assert.equal(res.credit.status, 'redeemed');
});

test('a refused consume comes back as an error with the upstream detail, never as a success', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { detail: 'credit already redeemed' } }));
  const res = await consumeCodexResetCredit(account, 'c1', 'req-123', { fetchImpl });
  assert.equal(res.error, 'HTTP 400: credit already redeemed');
  assert.equal(res.status, 400);
});
