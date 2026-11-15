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
// Anthropic OAuth token and the operator's proxy key. The operator's
// usage-dimension labels are held to the same rule further down.

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

async function withProxy(accounts, fn, proxyConfig = {}) {
  const { server: upstream, seen } = recordingUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key', ...proxyConfig }, upstream: `http://127.0.0.1:${upstreamPort}` });
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

// Usage-dimension headers carry the operator's own labels (project, branch)
// and are consumed by the proxy. The forward path has always dropped them; the
// identity-bound relays must too, or a label configured to stay on the
// operator's infrastructure reaches the upstream on every profile call.
const DIMENSIONS = { usageDimensions: [{ name: 'project', header: 'x-tc-project' }] };

test('relayStream drops usage-dimension headers on the client-credential paths', async () => {
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    for (const path of ['/v1/code/sessions/abc/worker/events', '/api/oauth/profile']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { 'x-api-key': 'tc-proxy-key', authorization: 'Bearer client-own-token', 'x-tc-project': 'private/repo', 'x-tc-other': 'kept' },
      });
      assert.equal(res.status, 200);
    }
    assert.equal(seen.length, 2);
    for (const { url, headers } of seen) {
      assert.equal(headers.authorization, 'Bearer client-own-token', url);
      assert.equal(headers['x-tc-project'], undefined, `${url}: the dimension header must not be relayed`);
      // Only the configured header goes; this is not a general filter.
      assert.equal(headers['x-tc-other'], 'kept', url);
    }
  }, DIMENSIONS);
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

test('relayUpgrade drops usage-dimension headers on the handshake', async () => {
  const upstream = http.createServer(() => {});
  const handshakes = [];
  upstream.on('upgrade', (req, socket) => {
    handshakes.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key', ...DIMENSIONS }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/session_ingress/ws/abc',
        headers: {
          connection: 'Upgrade', upgrade: 'websocket',
          'x-api-key': 'tc-proxy-key', authorization: 'Bearer client-own-token',
          'x-tc-project': 'private/repo', 'x-tc-other': 'kept',
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
    assert.equal(handshakes[0]['x-tc-project'], undefined, 'the dimension header must not be relayed');
    assert.equal(handshakes[0]['x-tc-other'], 'kept');
  } finally {
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});

// A dimension configured on one of the handshake's own names (an odd choice,
// but one the config accepts) must not cost the channel: those names still go
// up, and a configured label beside them still does not.
test('relayUpgrade keeps the handshake headers a dimension names, and still gets a 101', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  const handshakes = [];
  upstream.on('upgrade', (req, socket) => {
    handshakes.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], 0.98);
  const usageDimensions = ['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'x-tc-project'].map((header, i) => ({ name: `d${i}`, header }));
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key', usageDimensions }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/session_ingress/ws/abc',
        headers: {
          connection: 'Upgrade', upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
          'x-api-key': 'tc-proxy-key', 'x-tc-project': 'private/repo',
        },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 101);
    assert.equal(handshakes.length, 1);
    assert.equal(handshakes[0].upgrade, 'websocket');
    assert.match(handshakes[0].connection, /upgrade/i);
    assert.equal(handshakes[0]['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
    assert.equal(handshakes[0]['sec-websocket-version'], '13');
    assert.equal(handshakes[0]['x-tc-project'], undefined, 'a label beside them is still dropped');
  } finally {
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});

// relayRaw builds its request from three named client headers. One of them
// configured as a dimension is the operator's label like any other: read as
// not sent, so relayRaw's own default goes up instead of the label.
test('relayRaw sends its default in place of a dimension header among its three', async () => {
  const usageDimensions = ['content-type', 'accept', 'user-agent'].map((header, i) => ({ name: `d${i}`, header }));
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'x-api-key': 'tc-proxy-key', 'content-type': 'text/plain; label=a', accept: 'text/plain; label=b', 'user-agent': 'label-c' },
      body: '{"grant_type":"refresh_token"}',
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.equal(seen[0].headers.accept, 'application/json');
    assert.equal(seen[0].headers['user-agent'], 'node');
  }, { usageDimensions });
});

test('relayRaw forwards its three headers as sent when none is a dimension', async () => {
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'x-api-key': 'tc-proxy-key', 'content-type': 'text/plain; label=a', accept: 'text/plain; label=b', 'user-agent': 'label-c' },
      body: '{"grant_type":"refresh_token"}',
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0].headers['content-type'], 'text/plain; label=a');
    assert.equal(seen[0].headers.accept, 'text/plain; label=b');
    assert.equal(seen[0].headers['user-agent'], 'label-c');
  }, DIMENSIONS);
});
