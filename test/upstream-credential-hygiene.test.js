import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// What travels upstream on each path, credential-wise. The proxy replaces the
// client's credential with a fleet account's on the inference path, and relays
// the client's OWN bearer on the identity-bound paths; on neither must a
// credential that belongs to someone else leak through. A per-account
// `upstream` can be a third-party host, so "someone else" includes the client's
// Anthropic OAuth token and the operator's proxy key.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// An upstream that records the request headers it received.
function recordingUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

async function withProxy(accounts, fn) {
  const { server: upstream, seen } = recordingUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await fn(port, seen);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('an API-key account replaces the client credential; the client bearer does not reach upstream', async () => {
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'tc-proxy-key',
        // Claude Code sends its own OAuth bearer alongside; the proxy must
        // swap it for the account's credential, not forward both.
        authorization: 'Bearer client-anthropic-oauth-token',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    const { headers } = seen[0];
    assert.equal(headers['x-api-key'], 'sk-account-key');
    assert.equal(headers.authorization, undefined, 'the client bearer must not be forwarded');
  });
});

test('an OAuth account replaces the client bearer and sends no x-api-key', async () => {
  await withProxy([{ name: 'a', type: 'oauth', accessToken: 'acct-token', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'tc-proxy-key',
        authorization: 'Bearer client-anthropic-oauth-token',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    assert.equal(res.status, 200);
    const { headers } = seen[0];
    assert.equal(headers.authorization, 'Bearer acct-token');
    assert.equal(headers['x-api-key'], undefined, 'the proxy key must not be forwarded');
  });
});

// The identity-bound paths relay the client's own bearer untouched — and must
// still not relay the key the client used to authenticate to THIS proxy.
test('relayStream (/v1/code/*) keeps the client bearer and drops the proxy key', async () => {
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/abc/worker/events`, {
      headers: { 'x-api-key': 'tc-proxy-key', authorization: 'Bearer client-own-token' },
    });
    assert.equal(res.status, 200);
    const { headers } = seen[0];
    assert.equal(headers.authorization, 'Bearer client-own-token');
    assert.equal(headers['x-api-key'], undefined, 'the proxy key must not be relayed');
  });
});

test('relayUpgrade keeps the client bearer and drops the proxy key on the handshake', async () => {
  const upstream = http.createServer(() => {});
  const handshakes = [];
  upstream.on('upgrade', (req, socket) => {
    handshakes.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/session_ingress/ws/abc',
        headers: {
          connection: 'Upgrade', upgrade: 'websocket',
          'x-api-key': 'tc-proxy-key', authorization: 'Bearer client-own-token',
        },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 101);
    assert.equal(handshakes.length, 1);
    assert.equal(handshakes[0].authorization, 'Bearer client-own-token');
    assert.equal(handshakes[0]['x-api-key'], undefined, 'the proxy key must not be relayed');
  } finally {
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});
