import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/server.js';
import { allowLoopbackForward } from '../src/forward-target.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// An accountManager that MUST NOT be consulted for a third-party host — if the
// forward path ever routed to Anthropic, getActiveAccount would throw. This is
// the principle under test: account logic only for hosts we manage.
const noRouteManager = {
  getActiveAccount() { throw new Error('third-party host must not be routed to Anthropic'); },
  getStatus() { return {}; },
};

// Absolute-form request through the proxy (`GET http://target/…`), as sent by any
// tool honoring HTTP_PROXY.
function proxyRequest({ proxyPort, method = 'GET', absoluteUrl, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: absoluteUrl, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

test('forwards an absolute-form HTTP request to its target host, not to Anthropic', async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'x-served-by': 'target', 'content-type': 'text/plain' });
    res.end('hello from target');
  });
  const targetPort = await listen(target);

  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  allowLoopbackForward(proxy); // the target stands in for a remote host but lives on 127.0.0.1
  const proxyPort = await listen(proxy);

  const r = await proxyRequest({ proxyPort, absoluteUrl: `http://127.0.0.1:${targetPort}/hello` });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-served-by'], 'target');
  assert.equal(r.body, 'hello from target');

  proxy.close(); target.close();
});

test('forwards a POST body and method to the target', async () => {
  const target = http.createServer((req, res) => {
    let received = '';
    req.on('data', (c) => { received += c; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, echo: received }));
    });
  });
  const targetPort = await listen(target);

  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  allowLoopbackForward(proxy); // the target stands in for a remote host but lives on 127.0.0.1
  const proxyPort = await listen(proxy);

  const r = await proxyRequest({ proxyPort, method: 'POST', absoluteUrl: `http://127.0.0.1:${targetPort}/`, body: 'payload-123' });
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(r.body), { method: 'POST', echo: 'payload-123' });

  proxy.close(); target.close();
});

test('returns 502 (not a hang) when the target host is unreachable', async () => {
  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  allowLoopbackForward(proxy); // the target stands in for a remote host but lives on 127.0.0.1
  const proxyPort = await listen(proxy);

  // Port 1 is not listening → connection refused.
  const r = await proxyRequest({ proxyPort, absoluteUrl: 'http://127.0.0.1:1/' });
  assert.equal(r.status, 502);
  assert.match(r.body, /proxy_error/);

  proxy.close();
});

// Proxy credentials belong to TeamClaude; an unrelated x-api-key belongs to
// the application using HTTP_PROXY and must still reach that application's API.
for (const { name, proxyConfig, presented, expected, status = 200 } of [
  { name: 'shared proxy key', proxyConfig: { apiKey: 'tc-shared', trustLoopback: false }, presented: 'tc-shared', expected: undefined },
  { name: 'named client key', proxyConfig: { apiKey: 'tc-shared', clientKeys: [{ name: 'agent', key: 'tc-client' }], trustLoopback: false }, presented: 'tc-client', expected: undefined },
  { name: 'client key without a shared key', proxyConfig: { clientKeys: [{ name: 'agent', key: 'tc-client' }], trustLoopback: false }, presented: 'tc-client', expected: undefined },
  { name: 'proxy key on an exempt loopback connection', proxyConfig: { apiKey: 'tc-shared' }, presented: 'tc-shared', expected: undefined },
  { name: 'destination key on an exempt loopback connection', proxyConfig: { apiKey: 'tc-shared' }, presented: 'destination-key', expected: 'destination-key' },
  { name: 'destination key with no proxy keys configured', proxyConfig: {}, presented: 'destination-key', expected: 'destination-key' },
  { name: 'destination key when every client key entry is unusable', proxyConfig: { clientKeys: [{ name: '', key: 'x' }] }, presented: 'destination-key', expected: 'destination-key' },
  { name: 'no x-api-key', proxyConfig: { apiKey: 'tc-shared' }, presented: undefined, expected: undefined },
  { name: 'invalid proxy key with loopback exemption disabled', proxyConfig: { apiKey: 'tc-shared', trustLoopback: false }, presented: 'wrong-key', expected: undefined, status: 401 },
]) {
  test(`HTTP forwarding keeps credentials scoped correctly: ${name}`, async () => {
    const seen = [];
    const target = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); });
    const proxy = createProxyServer(noRouteManager, { proxy: proxyConfig });
    allowLoopbackForward(proxy); // a controlled stand-in for an external API
    try {
      const targetPort = await listen(target);
      const proxyPort = await listen(proxy);
      const r = await proxyRequest({
        proxyPort,
        absoluteUrl: `http://127.0.0.1:${targetPort}/credential-test`,
        headers: { ...(presented === undefined ? {} : { 'x-api-key': presented }), 'x-application-header': 'preserved' },
      });
      assert.equal(r.status, status);
      if (status === 401) {
        assert.equal(seen.length, 0, 'unauthorized requests must never reach the destination');
      } else {
        assert.equal(seen.length, 1);
        assert.equal(seen[0]['x-api-key'], expected);
        assert.equal(seen[0]['x-application-header'], 'preserved');
      }
    } finally {
      proxy.closeAllConnections(); target.closeAllConnections();
      proxy.close(); target.close();
    }
  });
}

// ── Destination policy ───────────────────────────────────────
//
// The relay is transparent, and "transparent to anywhere" included this machine:
// `GET http://127.0.0.1:<our port>/teamclaude/status` arrived at our own listener
// from a loopback socket and passed the API-key gate as a local caller — so a
// remote client holding only a low-trust key had the whole control plane, plus
// any loopback-only service and the cloud metadata address.

test('a forward to a loopback address is refused with 403 and never dialled', async () => {
  const trap = http.createServer(() => { throw new Error('the proxy must not connect to a loopback target'); });
  const trapPort = await listen(trap);
  let connections = 0;
  trap.on('connection', () => { connections++; });

  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  const proxyPort = await listen(proxy);
  try {
    for (const target of [`http://127.0.0.1:${trapPort}/x`, `http://localhost:${trapPort}/x`, `http://[::1]:${trapPort}/x`, `http://0.0.0.0:${trapPort}/x`]) {
      const r = await proxyRequest({ proxyPort, absoluteUrl: target });
      assert.equal(r.status, 403, target);
      assert.match(r.body, /refused/, target);
    }
    assert.equal(connections, 0, 'no connection may reach a loopback target');
  } finally {
    proxy.close(); trap.close();
  }
});

test("a forward to the proxy's own listener is refused, not answered as a local caller", async () => {
  // A key is configured, so a remote caller without it must be turned away —
  // including one trying to arrive at the control plane through the relay.
  const proxy = createProxyServer(noRouteManager, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' });
  const proxyPort = await listen(proxy);
  try {
    // The test client is itself loopback and so passes the gate for the relay
    // request; what matters is that the relayed hop is refused rather than
    // served — the answer must be the 403, never the status document.
    const r = await proxyRequest({ proxyPort, absoluteUrl: `http://127.0.0.1:${proxyPort}/teamclaude/status` });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.body, /accounts/);
  } finally {
    proxy.close();
  }
});

test('the link-local range is refused by literal address', async () => {
  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  const proxyPort = await listen(proxy);
  try {
    const r = await proxyRequest({ proxyPort, absoluteUrl: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(r.status, 403);
  } finally {
    proxy.close();
  }
});
