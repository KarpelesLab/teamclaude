import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

// Spin up an HTTP server on an ephemeral port and return { server, port, url }.
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}` };
}

// Make a request to the proxy. Resolves with { status, body } on a real HTTP
// response, or rejects with the socket error (e.g. ECONNRESET) if the proxy
// destroys the connection.
function clientRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', max_tokens: 1, messages: [] }));
  });
}

function apiKeyManager() {
  // apikey type → ensureTokenFresh() is a no-op, so the test makes zero
  // network calls beyond the local mock upstream.
  return new AccountManager([{ name: 'test', type: 'apikey', apiKey: 'sk-test' }], 0.98);
}

test('transient upstream failure is retried, not dropped on the client', async (t) => {
  let hits = 0;
  const up = await listen((req, res) => {
    hits++;
    if (hits === 1) {
      // Simulate a stale-keep-alive / transient connection failure: kill the
      // socket with no response so the proxy's fetch() throws "fetch failed".
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits }));
  });

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await clientRequest(proxy.address().port);

  assert.equal(result.status, 200, 'client should get a 200 after the proxy retries the transient failure');
  assert.equal(JSON.parse(result.body).ok, true);
  assert.equal(hits, 2, 'upstream should have been hit twice (1 transient failure + 1 success)');
});

test('persistent upstream failure returns a clean 502, never a destroyed socket', async (t) => {
  const up = await listen((req) => { req.socket.destroy(); }); // always fails

  const proxy = createProxyServer(apiKeyManager(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await clientRequest(proxy.address().port); // must resolve, not reject
  assert.equal(result.status, 502, 'exhausted retries should yield a 502, not a dropped connection');
  const body = JSON.parse(result.body);
  assert.equal(body.type, 'error');
});

function twoApiKeys() {
  return new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'sk-a' },
    { name: 'b', type: 'apikey', apiKey: 'sk-b' },
  ], 0.98);
}

// timeout guards: the OLD behaviour (wait retry-after, retry SAME account) loops
// forever, so these fail fast as timeouts instead of hanging the whole run.
test('429 rotates to the next account instead of blocking the connection', { timeout: 4000 }, async (t) => {
  const up = await listen((req, res) => {
    if (req.headers['x-api-key'] === 'sk-a') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '300' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, servedBy: req.headers['x-api-key'] }));
  });

  const proxy = createProxyServer(twoApiKeys(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const started = Date.now();
  const result = await clientRequest(proxy.address().port);
  const elapsed = Date.now() - started;

  assert.equal(result.status, 200, 'should rotate to account b and return 200');
  assert.equal(JSON.parse(result.body).servedBy, 'sk-b');
  assert.ok(elapsed < 1000, `must not block on retry-after (took ${elapsed}ms)`);
});

test('429 on every account returns a clean 429 with retry-after, not a hang', { timeout: 4000 }, async (t) => {
  const up = await listen((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });

  const proxy = createProxyServer(twoApiKeys(), { upstream: up.url, proxy: {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.close(); up.server.close(); });

  const result = await clientRequest(proxy.address().port);
  assert.equal(result.status, 429, 'all accounts limited → 429 to client');
  assert.ok(result.headers['retry-after'], 'should tell the client how long to back off');
  assert.equal(JSON.parse(result.body).error.type, 'rate_limit_error');
});
