import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { refreshAccessToken } from '../src/oauth.js';
import { refreshCodexToken } from '../src/codex-auth.js';
import { ROUTING_FAILED } from '../src/account-routing.js';

// An account whose token is already expiring, so ensureTokenFresh always tries.
function mgr(refreshFn, extra = {}) {
  return new AccountManager([{
    name: 'a', type: 'oauth',
    accessToken: 'at-old', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000, ...extra,
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

// The renewal's failure belongs to the token that was sent, as above: what a
// client of the imported token is told must not be the old token's reason.
for (const [label, error] of [['rejected', () => authError(400)], ['failing for now', () => Object.assign(new Error('socket hang up'), { status: 500 })]]) {
  test(`a refresh of the OLD token ${label} leaves no failure on tokens imported mid-refresh`, async () => {
    const d = deferred();
    const m = mgr(async () => d.promise);
    const inflight = m.ensureTokenFresh(0);
    m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() + 3600_000 });
    d.reject(error());
    await inflight;
    assert.strictEqual(m.accounts[0]._lastRefreshFailure, null, 'the reason a client of the imported token would be given');
  });
}

// A failure that leaves a hold is the exception: the hold governs the imported
// tokens too, so the reason for that is the failure's.
test('a 429 on the OLD token\'s refresh is kept as the reason for tokens imported mid-refresh, which it holds too', async () => {
  const d = deferred();
  let calls = 0;
  const m = mgr(async () => { calls++; return d.promise; });
  const inflight = m.ensureTokenFresh(0);
  m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() - 1000 });
  d.reject(Object.assign(new Error('Token refresh failed (429)'), { status: 429, retryAfterMs: 60_000 }));
  await inflight;
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1, 'the imported token waits out the hold');
  assert.strictEqual(m.accounts[0]._lastRefreshFailure?.status, 429);
});

test('a routing failure of the OLD token\'s refresh is kept as the reason for tokens imported mid-refresh, which its cooldown holds too', async () => {
  const d = deferred();
  const m = mgr(async () => d.promise, { routing: 'http://127.0.0.1:9' });
  const inflight = m.ensureTokenFresh(0);
  m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() - 1000 });
  d.reject(Object.assign(new Error('routing proxy down'), { code: ROUTING_FAILED }));
  await inflight;
  assert.strictEqual(m.isRoutingDown(0), true, 'the account sits out its cooldown');
  assert.match(m.accounts[0]._lastRefreshFailure?.reason ?? '', /routing proxy down/);
});

test('new tokens clear the reason a renewal of the old ones failed', async () => {
  const m = mgr(async () => { const e = new Error('socket hang up'); e.status = 500; throw e; });
  await m.ensureTokenFresh(0);
  assert.ok(m.accounts[0]._lastRefreshFailure);
  m.updateAccountTokens(0, { accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() + 3600_000 });
  assert.strictEqual(m.accounts[0]._lastRefreshFailure, null);
});

test('a refresh failure of the token the account still holds is kept as the reason', async () => {
  const m = mgr(async () => { const e = new Error('socket hang up'); e.status = 500; throw e; });
  await m.ensureTokenFresh(0);
  assert.match(m.accounts[0]._lastRefreshFailure?.reason ?? '', /socket hang up/);
});

// No caller leaves out the access token today, but the signature allows it,
// and the listener writes what it is handed onto the account's config row.
test('a token update writes what it carries: a field left out keeps the account\'s own', () => {
  const m = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 4_000_000_000_000 }], 0.98);
  const written = [];
  m.onTokenRefresh((_i, tokens) => written.push(tokens));
  const a = m.accounts[0];
  m.updateAccountTokens(0, { refreshToken: 'rt-2' });
  assert.strictEqual(a.credential, 'at-1');
  assert.strictEqual(a.refreshToken, 'rt-2');
  assert.strictEqual(a.expiresAt, 4_000_000_000_000);
  assert.deepStrictEqual(written.at(-1), { accessToken: 'at-1', refreshToken: 'rt-2', expiresAt: 4_000_000_000_000 });
  m.updateAccountTokens(0, { expiresAt: 4_100_000_000_000 });
  assert.strictEqual(a.credential, 'at-1');
  assert.strictEqual(a.expiresAt, 4_100_000_000_000, 'an expiry alone moves the expiry');
  m.updateAccountTokens(0, { expiresAt: 0 });
  assert.strictEqual(a.expiresAt, 4_100_000_000_000, 'an expiry of 0 is none, as makeAccount reads it, and alone carries nothing');
  // A new access token with no expiry has none known, never the one it replaces.
  m.updateAccountTokens(0, { accessToken: 'at-3' });
  assert.strictEqual(a.credential, 'at-3');
  assert.ok(!a.expiresAt, `kept the replaced token's expiry: ${a.expiresAt}`);
  assert.strictEqual(a.refreshToken, 'rt-2');
  assert.deepStrictEqual(written.at(-1), { accessToken: 'at-3', refreshToken: 'rt-2', expiresAt: undefined });
});

test('an unchanged token is refreshed normally (the guard only fires on a swap)', async () => {
  const m = mgr(async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 }));
  await m.ensureTokenFresh(0);
  assert.strictEqual(m.accounts[0].refreshToken, 'rt-new');
  assert.strictEqual(m.accounts[0].credential, 'at-new');
});

// #315: a third-party backend's credential must never be sent to Anthropic's
// token endpoint. The prober and warmer already skip `upstream` accounts; the
// send path and the 401 retry go through here and did not.
test('an account with a third-party upstream is never refreshed against Anthropic', async () => {
  let calls = 0;
  const m = new AccountManager([{
    name: 'glm', type: 'oauth', upstream: 'https://glm.example/anthropic',
    accessToken: 'third-party-key', refreshToken: 'rt-third-party', expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn: async () => { calls++; return { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 1e6 }; } });
  await m.ensureTokenFresh(0);
  await m.ensureTokenFresh(0, true);
  assert.strictEqual(calls, 0, 'the refresh token was not sent anywhere');
  assert.strictEqual(m.accounts[0].credential, 'third-party-key', 'the credential is untouched');
});

// Whether a refresh token is dead is the token endpoint's answer, not the
// status alone: whatever stands in front of the endpoint (a firewall, a proxy,
// a CDN) can answer a 403 of its own, and a token taken for dead is not sent
// again until a new one arrives, while credential sync, told through
// onAccountError, empties the row holding it. These drive the real refresh
// functions against a local token endpoint.

/** A token endpoint answering every request with `status` and `body`, as `type`. */
async function tokenEndpoint(status, body, type) {
  const srv = http.createServer((req, res) => { req.resume(); res.writeHead(status, { 'content-type': type }); res.end(body); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}/token`, close: () => srv.close() };
}

/** Two refreshes of an expiring account against one answer: the account, the refreshes sent, the errors reported. */
async function refreshAgainst([status, body, type = 'application/json'], { provider = undefined } = {}) {
  const endpoint = await tokenEndpoint(status, body, type);
  let calls = 0;
  const via = (fn) => (rt, _endpoint, routing, opts) => { calls++; return fn(rt, endpoint.url, routing, opts); };
  const m = new AccountManager([{
    name: 'a', type: 'oauth', ...(provider ? { provider, accountId: 'acct-a' } : {}),
    accessToken: 'at-old', refreshToken: 'rt-a', expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn: via(refreshAccessToken), codexRefreshFn: via(refreshCodexToken) });
  let errors = 0;
  m.onAccountError(() => { errors++; });
  let heldUntil = null;
  try {
    await m.ensureTokenFresh(0);
    // A kept 4xx leaves a short hold (as a 429 does). It is noted and lapsed
    // here, so the second call shows whether the token itself is sent again.
    heldUntil = m.accounts[0]._refreshHeldUntil;
    m.accounts[0]._refreshHeldUntil = null;
    await m.ensureTokenFresh(0);
  } finally {
    endpoint.close();
  }
  return { account: m.accounts[0], calls, errors, heldUntil };
}

function assertKept({ account, calls, errors, heldUntil }, status, what) {
  assert.strictEqual(account.status, 'active', what);
  assert.strictEqual(account._deadRefreshToken, null, what);
  assert.strictEqual(account.refreshToken, 'rt-a', what);
  assert.strictEqual(errors, 0, `credential sync is not told the token is dead: ${what}`);
  assert.ok(heldUntil > Date.now(), `the endpoint is not asked again at once: ${what}`);
  assert.strictEqual(calls, 2, `the token is tried again once that hold has passed: ${what}`);
  assert.strictEqual(account._lastRefreshFailure?.status, status, `the failure is kept as the reason: ${what}`);
}

test('a 400, 401 or 403 that is not an OAuth answer does not mark the refresh token dead', async () => {
  for (const answer of [
    [403, '<html><body>Access denied</body></html>', 'text/html'],
    [401, '', 'text/plain'],
    [400, 'Bad Request', 'text/plain'],
    [403, '{"error":'],
  ]) {
    assertKept(await refreshAgainst(answer), answer[0], `${answer[0]} ${answer[1]}`);
  }
});

// About the client or the request, which are the same for every account, so
// marking each account's token dead would empty every row in the store at once;
// or a code that proves nothing. A bare access_denied counts only as a hold
// (account_on_hold, see refresh-account-on-hold.test.js). Flat, as RFC 6749
// writes them, or nested as an Anthropic API error.
test('an OAuth error other than invalid_grant does not mark the refresh token dead', async () => {
  for (const [status, body] of [
    [401, { error: 'invalid_client', error_description: 'not the token' }],
    [400, { error: 'unauthorized_client' }], [400, { error: 'invalid_request' }],
    [400, { error: 'unsupported_grant_type' }], [400, { error: 'some_new_code' }], [403, { error: 'access_denied' }],
    [403, { type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }],
    [401, { type: 'error', error: { type: 'invalid_client', message: 'not the token' } }],
  ]) {
    assertKept(await refreshAgainst([status, JSON.stringify(body)]), status, `${status} ${JSON.stringify(body)}`);
  }
});

// The same code nested as an Anthropic API error, where Claude Code's own
// refresh reads it (`error.type`). Which shape upstream sends is not verified.
test('invalid_grant nested as an Anthropic API error marks the refresh token dead too, and it is sent once', async () => {
  for (const status of [400, 401, 403]) {
    const { account, calls, errors } = await refreshAgainst([status, JSON.stringify({ type: 'error', error: { type: 'invalid_grant', message: 'Refresh token not found or invalid' } })]);
    assert.strictEqual(account.status, 'error', String(status));
    assert.strictEqual(account.errorReason.code, 'refresh_rejected', String(status));
    assert.strictEqual(account._deadRefreshToken, 'rt-a', String(status));
    assert.strictEqual(errors, 1, String(status));
    assert.strictEqual(calls, 1, String(status));
  }
});

test('the token endpoint\'s invalid_grant still marks the refresh token dead, and it is sent once', async () => {
  for (const status of [400, 401, 403]) {
    const { account, calls, errors } = await refreshAgainst([status, JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })]);
    assert.strictEqual(account.status, 'error', String(status));
    assert.strictEqual(account.errorReason.code, 'refresh_rejected', String(status));
    assert.strictEqual(account._deadRefreshToken, 'rt-a', String(status));
    assert.strictEqual(errors, 1, String(status));
    assert.strictEqual(calls, 1, String(status));
  }
});

// The Codex refresh does not parse its answer's body, so its error says nothing
// about the grant, and its status decides, as it did before.
test('a Codex refresh rejected with a 400, 401 or 403 still marks the refresh token dead', async () => {
  for (const status of [400, 401, 403]) {
    const { account, calls, errors } = await refreshAgainst([status, JSON.stringify({ error: 'invalid_grant' })], { provider: 'codex' });
    assert.strictEqual(account.status, 'error', String(status));
    assert.strictEqual(account._deadRefreshToken, 'rt-a', String(status));
    assert.strictEqual(errors, 1, String(status));
    assert.strictEqual(calls, 1, String(status));
  }
});

// The hold a kept 4xx leaves is the refresh token's, compared by value as the
// dead-token guard is: whatever answered had that token in front of it. A
// different refresh token is tried at once, however it reached the account:
// through updateAccountTokens (a reload, which is how a `teamclaude login` or
// `import` in another process arrives, and credential sync adopting a renewal
// another install stored), or written onto the account by the TUI's import.

/** A page in front of the token endpoint answering 403, once `gate` resolves. */
async function pageEndpoint(gate = Promise.resolve()) {
  const srv = http.createServer(async (req, res) => {
    req.resume();
    await gate;
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body>Access denied</body></html>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}/token`, close: () => srv.close() };
}

/**
 * An expiring account whose refresh token `rt-a` is answered by that page, as
 * is every token in `paged`; any other is renewed. `sent` is every token sent.
 */
async function keptFor(paged = ['rt-a'], gate = undefined) {
  const page = await pageEndpoint(gate);
  const sent = [];
  const m = new AccountManager([{
    name: 'a', type: 'oauth', accessToken: 'at-old', refreshToken: 'rt-a', expiresAt: Date.now() - 1000,
  }], 0.98, {
    refreshFn: async (rt, _endpoint, routing, opts) => {
      sent.push(rt);
      if (paged.includes(rt)) return refreshAccessToken(rt, page.url, routing, opts);
      return { accessToken: `at-${rt}`, refreshToken: `${rt}-next`, expiresAt: Date.now() + 3600_000 };
    },
  });
  return { m, sent, close: page.close };
}

test('a kept 403 holds the refresh token it was sent with, forced or not, and a new one is tried at once', async () => {
  const installs = {
    'a reload or a token from the store (updateAccountTokens)': (m, expiresAt) => m.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt }),
    'the TUI import, which writes the account itself': (m, expiresAt) => Object.assign(m.accounts[0], { credential: 'at-new', refreshToken: 'rt-new', expiresAt }),
  };
  for (const [how, install] of Object.entries(installs)) {
    // An expired access token, which the request path renews; or a live one
    // upstream answered 401, which forces the renewal.
    for (const force of [false, true]) {
      const f = await keptFor();
      try {
        await f.m.ensureTokenFresh(0);
        await f.m.ensureTokenFresh(0);
        await f.m.ensureTokenFresh(0, true);
        assert.deepStrictEqual(f.sent, ['rt-a'], `the kept token is not sent again inside its hold: ${how}`);
        install(f.m, force ? Date.now() + 3600_000 : Date.now() - 1000);
        await f.m.ensureTokenFresh(0, force);
        assert.deepStrictEqual(f.sent, ['rt-a', 'rt-new'], `${how}, force=${force}`);
        assert.strictEqual(f.m.accounts[0].credential, 'at-rt-new', `${how}, force=${force}`);
      } finally {
        f.close();
      }
    }
  }
});

test('a token installed while the kept refresh was out is not held by it', async () => {
  let release;
  const f = await keptFor(['rt-a'], new Promise((resolve) => { release = resolve; }));
  try {
    const inflight = f.m.ensureTokenFresh(0);
    f.m.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() - 1000 });
    release();
    await inflight;
    await f.m.ensureTokenFresh(0);
    assert.deepStrictEqual(f.sent, ['rt-a', 'rt-new']);
    assert.strictEqual(f.m.accounts[0].credential, 'at-rt-new');
  } finally {
    f.close();
  }
});

// The hold is armed for the token that was sent, whatever the account holds
// when the answer lands: should that token come back (a reload of an older
// entry, say), it is still not sent again inside its 30 s. Unless the token
// the account moved on to was kept in its turn: an account has one kept hold
// at a time, and that one replaces it.
test('a token kept while the account moved on to another is still held, should it come back', async () => {
  let release;
  const f = await keptFor(['rt-a'], new Promise((resolve) => { release = resolve; }));
  try {
    const inflight = f.m.ensureTokenFresh(0);
    f.m.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 });
    release();
    await inflight;
    f.m.updateAccountTokens(0, { accessToken: 'at-old-again', refreshToken: 'rt-a', expiresAt: Date.now() - 1000 });
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0, true);
    assert.deepStrictEqual(f.sent, ['rt-a']);
  } finally {
    f.close();
  }
});

// As for the dead-token guard, a new access token alone is not a new token to
// try: the refresh token that was kept is the same one.
test('a re-import of the kept refresh token with a new access token does not lift its hold', async () => {
  const f = await keptFor();
  try {
    await f.m.ensureTokenFresh(0);
    f.m.updateAccountTokens(0, { accessToken: 'at-reimported', refreshToken: 'rt-a', expiresAt: Date.now() - 1000 });
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0, true);
    assert.deepStrictEqual(f.sent, ['rt-a']);
  } finally {
    f.close();
  }
});

// The renewal a 401 forces is held the same way when it is the one kept.
test('a kept 403 to a forced renewal holds that refresh token, forced or not', async () => {
  const f = await keptFor();
  try {
    f.m.accounts[0].expiresAt = Date.now() + 3600_000; // live by the clock; upstream answered 401
    await f.m.ensureTokenFresh(0, true);
    await f.m.ensureTokenFresh(0, true);
    f.m.accounts[0].expiresAt = Date.now() - 1000;
    await f.m.ensureTokenFresh(0);
    assert.deepStrictEqual(f.sent, ['rt-a']);
  } finally {
    f.close();
  }
});

// A renewal that succeeds inside the hold, of a token the hold was not about,
// ends it: what the account holds next is tried as any token would be.
test('a renewal of a new token inside a kept hold ends the hold, so the token after it is tried at once', async () => {
  const f = await keptFor();
  try {
    await f.m.ensureTokenFresh(0);
    f.m.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() - 1000 });
    await f.m.ensureTokenFresh(0);
    assert.strictEqual(f.m.accounts[0].credential, 'at-rt-new', 'rt-new renewed inside the hold');
    f.m.updateAccountTokens(0, { accessToken: 'at-third', refreshToken: 'rt-third', expiresAt: Date.now() - 1000 });
    await f.m.ensureTokenFresh(0);
    assert.deepStrictEqual(f.sent, ['rt-a', 'rt-new', 'rt-third']);
  } finally {
    f.close();
  }
});

test('a new token the page answers too is held in its turn', async () => {
  const f = await keptFor(['rt-a', 'rt-new']);
  try {
    await f.m.ensureTokenFresh(0);
    f.m.updateAccountTokens(0, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() - 1000 });
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0, true);
    assert.deepStrictEqual(f.sent, ['rt-a', 'rt-new']);
    assert.strictEqual(f.m.accounts[0].status, 'active');
  } finally {
    f.close();
  }
});

test('the kept token is sent again once its 30 s hold has passed, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T00:00:00Z') });
  const f = await keptFor();
  try {
    await f.m.ensureTokenFresh(0);
    t.mock.timers.tick(29_999);
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0, true);
    assert.deepStrictEqual(f.sent, ['rt-a'], 'one millisecond short is still held');
    t.mock.timers.tick(1);
    await f.m.ensureTokenFresh(0);
    assert.deepStrictEqual(f.sent, ['rt-a', 'rt-a']);
    // Kept again, it is held again, for 30 s from that answer.
    await f.m.ensureTokenFresh(0);
    await f.m.ensureTokenFresh(0, true);
    assert.deepStrictEqual(f.sent, ['rt-a', 'rt-a'], 'the second answer arms the hold again');
  } finally {
    f.close();
  }
});
