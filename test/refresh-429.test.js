import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { refreshAccessToken } from '../src/oauth.js';

// A 429 from the token endpoint is the endpoint asking to be left alone. A forward
// with an expired token asks for a refresh, its 401 forces another, and the retry
// a third: measured at 3 token-endpoint calls per client request, Retry-After or
// not. The account holds its refreshes for the Retry-After, or a short default.

async function tokenServer(status, headers = {}) {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end('{"error":{"type":"rate_limit_error"}}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, endpoint: `http://127.0.0.1:${srv.address().port}/token`, hits: () => hits };
}

function mgr(refreshFn) {
  return new AccountManager([{
    name: 'a', type: 'oauth',
    accessToken: 'at-old', refreshToken: 'rt-a', expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn });
}

function rateLimited(retryAfterMs) {
  const e = new Error('Token refresh failed (429): {"error":{"type":"rate_limit_error"}}');
  e.status = 429;
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
  return e;
}

test('refreshAccessToken reports a 429 with its Retry-After, in seconds or as a date, and is not retried', async () => {
  for (const [header, expected] of [['120', 120_000], [new Date(Date.now() + 60_000).toUTCString(), 60_000], [undefined, undefined], ['soon', undefined]]) {
    const { srv, endpoint, hits } = await tokenServer(429, header === undefined ? {} : { 'retry-after': header });
    try {
      const err = await refreshAccessToken('r', endpoint).catch((e) => e);
      assert.strictEqual(err.status, 429);
      if (expected === undefined) assert.strictEqual(err.retryAfterMs, undefined, `${header}`);
      else assert.ok(Math.abs(err.retryAfterMs - expected) < 2000, `${header} -> ${err.retryAfterMs}`);
      assert.strictEqual(hits(), 1, 'a 429 is not retried inside the call');
    } finally {
      srv.close();
    }
  }
});

test('after a 429 the account holds its refreshes for the Retry-After, forced or not', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw rateLimited(120_000); });
  await m.ensureTokenFresh(0);
  // What one client request does next: its 401 forces a refresh, and so does the retry.
  await m.ensureTokenFresh(0, true);
  await m.ensureTokenFresh(0, true);
  for (let i = 0; i < 10; i++) await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1, 'one call to the token endpoint, not one per attempt');
  assert.notStrictEqual(m.accounts[0].status, 'error', 'a 429 is not an auth rejection');
  assert.strictEqual(m.accounts[0].credential, 'at-old', 'the account keeps its token');
});

test('a 429 without Retry-After still holds the refreshes for a while', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw rateLimited(undefined); });
  await m.ensureTokenFresh(0);
  await m.ensureTokenFresh(0, true);
  await m.ensureTokenFresh(0, true);
  assert.strictEqual(calls, 1);
});

test('the hold lifts once the Retry-After has passed, and a success clears it', async () => {
  let calls = 0;
  let fail = true;
  const m = mgr(async () => {
    calls++;
    if (fail) throw rateLimited(50);
    return { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 };
  });
  await m.ensureTokenFresh(0);
  await new Promise((r) => setTimeout(r, 80));
  fail = false;
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 2);
  assert.strictEqual(m.accounts[0].credential, 'at-new');
});
