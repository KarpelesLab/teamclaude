import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const HOUR = 3600_000;

// An upstream that accepts only the tokens in `live` and 401s everything else —
// exactly how Anthropic answers an access token that was revoked before its
// clock expiry (something else refreshed the same token family). Records the
// bearer token presented on every hit so a test can prove WHICH credential was
// retried.
function revokingUpstream(live) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (!live.has(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has been revoked' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await res.text();
  return res.status;
}

// The core recovery: a token that upstream considers revoked is indistinguishable
// from a valid one by expiry alone, so only the 401 itself can trigger a refresh.
test('401 forces a token refresh and retries the same account', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set(['fresh']));
  const upstreamPort = await listen(upstream);

  let refreshes = 0;
  const am = new AccountManager(
    // expiresAt is an hour out: the clock says this token is fine, upstream says otherwise.
    [{ name: 'a', type: 'oauth', accessToken: 'revoked', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
    { refreshFn: async () => { refreshes++; return { accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + HOUR }; } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await post(proxyPort), 200);          // client never sees the 401
    assert.equal(refreshes, 1);                        // forced despite a future expiresAt
    assert.deepEqual(seen, ['revoked', 'fresh']);      // retried with the NEW token
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When the refresh token is dead too (the whole family was revoked), there is
// nothing to recover on this account — it must drop out of rotation and the
// request must be served by another account rather than failing.
test('401 with a rejected refresh errors the account and fails over', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set(['b-token']));
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'revoked', refreshToken: 'dead', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accessToken: 'b-token', refreshToken: 'r', expiresAt: Date.now() + HOUR },
    ],
    0.98,
    {
      refreshFn: async () => {
        const err = new Error('Token refresh failed (400): invalid_grant');
        err.status = 400;                              // a genuine auth rejection, not a blip
        throw err;
      },
    },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await post(proxyPort), 200);          // served by the healthy account
    assert.deepEqual(seen, ['revoked', 'b-token']);
    assert.equal(am.accounts[0].status, 'error');      // dropped from rotation until re-login
    assert.equal(am.accounts[1].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression: the retry must be bounded. An upstream that 401s even a
// freshly-minted token must surface the 401, not loop refreshing forever.
test('persistent 401 terminates instead of looping', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set());   // nothing is ever accepted
  const upstreamPort = await listen(upstream);

  let refreshes = 0;
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
    { refreshFn: async () => { refreshes++; return { accessToken: `t${refreshes}`, refreshToken: 'r', expiresAt: Date.now() + HOUR }; } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await post(proxyPort), 401);          // surfaced, not hung
    assert.equal(refreshes, 1);                        // one re-auth per account per request
    assert.equal(seen.length, 2);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// An API-key account has no refresh token, so a 401 is a bad key — retrying it
// would just burn a round trip. It must pass straight through.
test('401 on an api-key account is not retried', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set());
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([{ name: 'k', type: 'api_key', apiKey: 'sk-bad' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await post(proxyPort), 401);
    assert.equal(seen.length, 1);                      // no retry
  } finally {
    proxy.close();
    upstream.close();
  }
});
