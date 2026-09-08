import { test } from 'node:test';
import assert from 'node:assert';
import { AccountManager } from '../src/account-manager.js';

// An account whose token is already expiring, so ensureTokenFresh always tries.
function mgr(refreshFn) {
  return new AccountManager([{
    name: 'a', type: 'oauth',
    accessToken: 'at-old', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn });
}

function authError(status = 400) {
  const e = new Error(`Token refresh failed (${status}): {"error":"invalid_grant"}`);
  e.status = status;
  return e;
}

test('a rejected refresh token is not re-sent (no OAuth flood)', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw authError(400); });
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1);
  assert.strictEqual(m.accounts[0].status, 'error');
  // warmer/prober keep calling this for every account regardless of availability
  for (let i = 0; i < 25; i++) await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1, 'dead token must be sent exactly once, not once per call');
});

test('force=true does not bypass the dead-token guard', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw authError(401); });
  await m.ensureTokenFresh(0);
  await m.ensureTokenFresh(0, true);
  assert.strictEqual(calls, 1, 'a known-dead token stays dead even under force');
});

test('a TRANSIENT failure is not guarded — it retries', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; const e = new Error('socket hang up'); e.status = 500; throw e; });
  await m.ensureTokenFresh(0);
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 2, 'network/5xx must keep retrying (token may still be good)');
  assert.notStrictEqual(m.accounts[0].status, 'error', 'transient failure must not sideline the account');
});

test('guard lifts automatically when a NEW refresh token arrives (re-login)', async () => {
  let calls = 0;
  const m = mgr(async (rt) => {
    calls++;
    if (rt === 'rt-dead') throw authError(400);
    return { accessToken: 'at-new', refreshToken: 'rt-fresh2', expiresAt: Date.now() + 3600_000 };
  });
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1);
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1, 'still guarded while the token is unchanged');

  // re-login / config reload hands the account a fresh token
  m.updateAccountTokens(0, { accessToken: 'at-x', refreshToken: 'rt-fresh', expiresAt: Date.now() - 1000 });
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 2, 'a different refresh token must be attempted');
  assert.strictEqual(m.accounts[0].status, 'active');
});

test('re-enabling a disabled account clears the guard (operator escape hatch)', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw authError(403); });
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1);
  m.setDisabled(0, true);
  m.setDisabled(0, false);
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 2, 'explicit re-enable means "try again"');
});

test('a successful refresh clears any stale guard', async () => {
  let mode = 'fail';
  let calls = 0;
  const m = mgr(async () => {
    calls++;
    if (mode === 'fail') throw authError(400);
    return { accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() - 1000 };
  });
  await m.ensureTokenFresh(0);            // dead → guard armed on 'rt-dead'
  m.accounts[0].refreshToken = 'rt-other'; // a different token arrives
  mode = 'ok';
  await m.ensureTokenFresh(0);            // succeeds → guard cleared
  assert.strictEqual(m.accounts[0]._deadRefreshToken, null);
  const before = calls;
  await m.ensureTokenFresh(0);            // token still expiring → tries again freely
  assert.strictEqual(calls, before + 1, 'no lingering guard after a success');
});

// A re-import can supply a NEW access token with the SAME dead refresh token
// (updateAccountTokens resets status to 'active'). The guard still blocks the
// refresh, so the account must read as errored again or the access token's 401
// would be relayed to the client instead of rotating.
test('a re-imported access token with the same dead refresh token reads as errored, not retried', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw authError(400); });
  await m.ensureTokenFresh(0);
  assert.strictEqual(m.accounts[0].status, 'error');

  m.updateAccountTokens(0, { accessToken: 'at-reimported', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 });
  assert.strictEqual(m.accounts[0].status, 'active', 'updateAccountTokens clears the error state');

  await m.ensureTokenFresh(0, true);      // the 401 path forces a refresh
  assert.strictEqual(calls, 1, 'the dead token is still not re-sent');
  assert.strictEqual(m.accounts[0].status, 'error', 'but the account is sidelined so the request rotates');
});

test('the dead-token field is part of the account record from construction', () => {
  const m = mgr(async () => { throw authError(400); });
  assert.ok('_deadRefreshToken' in m.accounts[0]);
  assert.strictEqual(m.accounts[0]._deadRefreshToken, null);
});

// A config reload or `teamclaude import` can install new tokens WHILE a refresh
// of the old ones is awaiting upstream. The outcome of that call belongs to the
// token that was sent, not to whatever the account holds when it lands.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('an invalid_grant for the OLD token does not mark a token imported mid-refresh dead', async () => {
  const d = deferred();
  const m = mgr(async () => d.promise);
  const inflight = m.ensureTokenFresh(0);

  // Import lands while the refresh is in flight and hands over a valid token.
  m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() + 3600_000 });
  d.reject(authError(400));
  await inflight;

  const a = m.accounts[0];
  assert.strictEqual(a._deadRefreshToken, 'rt-dead', 'the token that was SENT is the dead one');
  assert.strictEqual(a.refreshToken, 'rt-imported');
  assert.strictEqual(a.status, 'active', 'the account must not be locked out — its live token was never rejected');
  assert.strictEqual(a.credential, 'at-imported');
});

test('a successful refresh of the OLD token does not overwrite tokens imported mid-refresh', async () => {
  const d = deferred();
  let persisted = 0;
  const m = mgr(async () => d.promise);
  m.onTokenRefresh(() => { persisted++; });
  const inflight = m.ensureTokenFresh(0);

  m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: 4_000_000_000_000 });
  const persistedByImport = persisted;
  d.resolve({ accessToken: 'at-stale', refreshToken: 'rt-stale', expiresAt: Date.now() + 3600_000 });
  await inflight;

  const a = m.accounts[0];
  assert.strictEqual(a.refreshToken, 'rt-imported', 'the stale result is discarded');
  assert.strictEqual(a.credential, 'at-imported');
  assert.strictEqual(a.expiresAt, 4_000_000_000_000);
  assert.strictEqual(persisted, persistedByImport, 'nothing stale is persisted to config');
  assert.strictEqual(a._refreshPromise, null, 'the coalescing slot is released');
});

test('an unchanged token is refreshed normally (the guard only fires on a swap)', async () => {
  const m = mgr(async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 }));
  await m.ensureTokenFresh(0);
  assert.strictEqual(m.accounts[0].refreshToken, 'rt-new');
  assert.strictEqual(m.accounts[0].credential, 'at-new');
});
