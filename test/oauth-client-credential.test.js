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
