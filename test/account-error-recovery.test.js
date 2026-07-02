import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { refreshAccessToken } from '../src/oauth.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
// expiresAt within the 5-minute "expiring soon" window so ensureTokenFresh refreshes.
function expiring(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 1000 };
}

// ── per-request failover (getActiveAccount exclude) ─────────────────────────

test('getActiveAccount(exclude) fails over to another account', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const first = am.getActiveAccount();
  const second = am.getActiveAccount(new Set([first.index]));
  assert.ok(second);
  assert.notEqual(second.index, first.index);
});

test('getActiveAccount returns null when every account is excluded', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getActiveAccount(new Set([0, 1])), null);
});

test('excluding an account for one request never changes its persistent status', () => {
  // A transport failover must not sideline the account it skipped.
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.getActiveAccount(new Set([0]));
  assert.equal(am.accounts[0].status, 'active');
});

// ── getActiveAccountFresh: block-refresh an already-expired token ───────────

test('getActiveAccountFresh refreshes an ALREADY-expired token before returning', async () => {
  // Rotating onto an account that sat idle past its token lifetime must not hand
  // back a dead token — the selector blocks on a refresh first.
  let calls = 0;
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 'STALE', refreshToken: 'r', expiresAt: Date.now() - 1000 }],
    0.98,
    { refreshFn: async () => { calls++; return { accessToken: 'FRESH', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }; } },
  );
  const acc = await am.getActiveAccountFresh();
  assert.equal(acc.credential, 'FRESH', 'expired token was refreshed before use');
  assert.equal(calls, 1, 'exactly one blocking refresh');
});

test('getActiveAccountFresh does NOT block-refresh a still-valid token', async () => {
  // A merely "expiring soon" (still valid) token is left for the caller's
  // opportunistic background refresh — selection must not block on it.
  let calls = 0;
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 'GOOD', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
    { refreshFn: async () => { calls++; return { accessToken: 'FRESH', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }; } },
  );
  const acc = await am.getActiveAccountFresh();
  assert.equal(acc.credential, 'GOOD', 'valid token used as-is');
  assert.equal(calls, 0, 'no blocking refresh for a valid token');
});

// ── refresh-failure classification (the wrongly-errored bug) ────────────────

test('ensureTokenFresh marks error only on a genuine auth rejection', async () => {
  for (const status of [400, 401, 403]) {
    const am = new AccountManager([expiring('a')], 0.98, {
      refreshFn: async () => { throw Object.assign(new Error(`refresh ${status}`), { status }); },
    });
    await am.ensureTokenFresh(0);
    assert.equal(am.accounts[0].status, 'error', `status ${status} should sideline`);
  }
});

test('ensureTokenFresh does NOT sideline on a transient refresh failure', async () => {
  // Network error (no .status) and an exhausted-retries 5xx must both be treated
  // as transient — the account stays healthy and is retried next request.
  for (const err of [
    Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('refresh 503'), { status: 503 }),
  ]) {
    const am = new AccountManager([expiring('a')], 0.98, { refreshFn: async () => { throw err; } });
    await am.ensureTokenFresh(0);
    assert.equal(am.accounts[0].status, 'active');
  }
});

test('ensureTokenFresh applies refreshed tokens on success', async () => {
  const am = new AccountManager([expiring('a')], 0.98, {
    refreshFn: async () => ({ accessToken: 'NEW', refreshToken: 'NEWR', expiresAt: Date.now() + 3600_000 }),
  });
  await am.ensureTokenFresh(0);
  assert.equal(am.accounts[0].credential, 'NEW');
  assert.equal(am.accounts[0].status, 'active');
});

// ── refreshAccessToken surfaces the HTTP status ─────────────────────────────

test('refreshAccessToken attaches the HTTP status to a rejection error', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"invalid_grant"}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}/token`;
  try {
    await assert.rejects(refreshAccessToken('r', endpoint), (e) => {
      assert.equal(e.status, 400);
      return true;
    });
  } finally {
    srv.close();
  }
});
