import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener } from '../src/server.js';

// /api/oauth/* is the CLIENT's identity and control plane — "who am I", file
// transfers, and whatever Claude Code adds next — not inference. Injecting a
// rotated fleet token there makes Claude Code believe it IS that account: the
// cached profile is overwritten with a stranger's identity, the Chrome extension
// refuses to pair, and Remote Control binds to the wrong account.
//
// The account manager here throws from getActiveAccount, so any test that passes
// proves the relay never even consulted the fleet for that path.

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function echoAuthUpstream() {
  const seen = [];
  return listen((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).then(r => ({ ...r, seen }));
}

async function through(listener, path, headers = {}) {
  const { server: proxy, port } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, text: await res.text() };
  } finally {
    proxy.close();
  }
}

const refusingManager = {
  accounts: [],
  getActiveAccount() { throw new Error('must not rotate an /api/oauth/* request'); },
};

for (const path of [
  '/api/oauth/profile',
  '/api/oauth/usage',
  '/api/oauth/claude_cli/roles',
  '/api/oauth/files/abc',
  '/api/oauth/file_upload',
]) {
  test(`${path} keeps the client's own credential`, async () => {
    const { server: upstream, port, seen } = await echoAuthUpstream();
    try {
      const listener = createProxyRequestListener({
        accountManager: refusingManager, upstream: `http://127.0.0.1:${port}`,
      });
      const { status } = await through(listener, path, { authorization: 'Bearer client-own-token' });
      assert.equal(status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, 'Bearer client-own-token',
        'the client credential must reach upstream unchanged');
    } finally {
      upstream.close();
    }
  });
}

// The counterpart: inference still rotates. Without this the test above would
// also pass if someone relayed *everything* with the client's credential.
test('an inference request still gets the account token injected', async () => {
  const { server: upstream, port, seen } = await echoAuthUpstream();
  try {
    const am = new AccountManager([
      { name: 'a', type: 'oauth', accessToken: 'fleet-token', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    ], 0.98);
    const listener = createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${port}` });
    await through(listener, '/v1/messages', { authorization: 'Bearer client-own-token' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer fleet-token',
      'inference must use the rotated fleet account, not the client credential');
  } finally {
    upstream.close();
  }
});

// ── the same endpoints, spelled with percent-encoding ────────────────────────
//
// The path is forwarded verbatim — this proxy rewrites nothing on the wire — so
// a prefix test on the raw string and the endpoint that actually resolves it
// can disagree. `/%61pi/oauth/profile` and `/api/oauth%2fprofile` are the
// profile endpoint to the server that answers them, and neither one starts with
// `/api/oauth/`. Classified on the decoded path, they take the same relay as the
// literal spelling.
//
// The account manager here holds a real fleet token rather than throwing, so the
// assertion is on WHICH credential arrived: a request that fell through to
// rotation reaches upstream with the fleet token, and that is what must not
// happen.

// http.request, not fetch: the raw path is the whole point of these cases and
// has to reach the listener exactly as written.
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function fleetManager() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'fleet-token', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
}

for (const path of [
  '/%61pi/oauth/profile',
  '/api/oauth%2fprofile',
  '/api/oauth%2Fprofile',
  '/%76%31/code/sessions/abc/worker/events/stream',
]) {
  test(`${path} keeps the client's own credential`, async () => {
    const { server: upstream, port, seen } = await echoAuthUpstream();
    const listener = createProxyRequestListener({ accountManager: fleetManager(), upstream: `http://127.0.0.1:${port}` });
    const { server: proxy, port: proxyPort } = await listen(listener);
    try {
      assert.equal(await rawGet(proxyPort, path, { authorization: 'Bearer client-own-token' }), 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, 'Bearer client-own-token',
        'a fleet token was attached to the client identity plane');
      assert.equal(seen[0].url, path, 'the path must be forwarded exactly as sent');
    } finally {
      proxy.closeAllConnections?.(); proxy.close();
      upstream.close();
    }
  });
}

// Decoding is one level deep, matching what the receiving server applies to the
// target it routes on. `/api/oauth%252fprofile` resolves to a literal segment
// under `/api/`, not to the identity plane, so it rotates like any other path —
// widening the relay to cover it would relay requests nobody asked to relay.
test('a double-encoded separator is not the identity plane and still rotates', async () => {
  const { server: upstream, port, seen } = await echoAuthUpstream();
  const listener = createProxyRequestListener({ accountManager: fleetManager(), upstream: `http://127.0.0.1:${port}` });
  const { server: proxy, port: proxyPort } = await listen(listener);
  try {
    assert.equal(await rawGet(proxyPort, '/api/oauth%252fprofile', { authorization: 'Bearer client-own-token' }), 200);
    assert.equal(seen[0].authorization, 'Bearer fleet-token');
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.close();
  }
});

// ── the same endpoints, spelled with a backslash ─────────────────────────────
//
// A backslash is a separator to the WHATWG URL parser for http(s), so the
// `new URL()` that builds the outgoing target folds it HERE, in this process,
// before the request is sent. `/api\oauth\profile` therefore always arrives at
// the identity plane, while a prefix test on the raw string reads one segment
// and sees nothing of the sort.
//
// That is also why `onWire` differs per spelling below, and the difference is
// the point: a folded backslash is rewritten by our own URL construction, while
// percent-encoding survives untouched and is resolved by the receiving server.

for (const [path, onWire] of [
  ['/api\\oauth\\profile', '/api/oauth/profile'],
  ['/api/oauth\\profile', '/api/oauth/profile'],
  ['/v1\\code/sessions/abc/worker/events/stream', '/v1/code/sessions/abc/worker/events/stream'],
  ['/%61pi%5coauth/profile', '/%61pi%5coauth/profile'],
]) {
  test(`${path} keeps the client's own credential`, async () => {
    const { server: upstream, port, seen } = await echoAuthUpstream();
    const listener = createProxyRequestListener({ accountManager: fleetManager(), upstream: `http://127.0.0.1:${port}` });
    const { server: proxy, port: proxyPort } = await listen(listener);
    try {
      assert.equal(await rawGet(proxyPort, path, { authorization: 'Bearer client-own-token' }), 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, 'Bearer client-own-token',
        'a fleet token was attached to the client identity plane');
      assert.equal(seen[0].url, onWire, 'the request went out on a path this test did not predict');
    } finally {
      proxy.closeAllConnections?.(); proxy.close();
      upstream.close();
    }
  });
}

// ── the same endpoints, reached under a /tc-acct/ pin ────────────────────────
//
// A pinned session sends EVERY request under the prefix: claude-env.js and
// index.js both emit `ANTHROPIC_BASE_URL=http://localhost:<port>/tc-acct/<acct>`,
// so `/api/oauth/*` and `/v1/code/*` arrive carrying it too. This is ordinary
// traffic from a supported configuration, not a probe.
//
// The prefix is stripped before forwarding, so the identity plane is exactly
// where these leave for — while a prefix test run before the strip sees
// `/tc-acct/...` and matches nothing. A pinned account's token is a rotated
// token like any other: the pin chooses which account serves INFERENCE, and no
// version of it should put a fleet identity on the client's own control plane.

for (const [path, onWire] of [
  ['/tc-acct/a/api/oauth/profile', '/api/oauth/profile'],
  ['/tc-acct/a/api/oauth/file_upload', '/api/oauth/file_upload'],
  ['/tc-acct/a/v1/code/sessions/abc/worker/events/stream', '/v1/code/sessions/abc/worker/events/stream'],
  ['/tc-acct/a/%61pi/oauth/profile', '/%61pi/oauth/profile'],
]) {
  test(`${path} keeps the client's own credential`, async () => {
    const { server: upstream, port, seen } = await echoAuthUpstream();
    const listener = createProxyRequestListener({ accountManager: fleetManager(), upstream: `http://127.0.0.1:${port}` });
    const { server: proxy, port: proxyPort } = await listen(listener);
    try {
      assert.equal(await rawGet(proxyPort, path, { authorization: 'Bearer client-own-token' }), 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorization, 'Bearer client-own-token',
        'the pinned account\'s token was attached to the client identity plane');
      assert.equal(seen[0].url, onWire, 'the pin prefix must be stripped and nothing else changed');
    } finally {
      proxy.closeAllConnections?.(); proxy.close();
      upstream.close();
    }
  });
}
