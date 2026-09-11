import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, loopbackExempt, isForwardedRequest, resolveUpgradeAuth } from '../src/server.js';
import { resolveConnectAuth } from '../src/mitm.js';

// The loopback exemption behind a reverse proxy on the same host. nginx or
// Caddy terminating TLS in front of a listener bound to 127.0.0.1 is the
// ordinary way this proxy is deployed on a public name — and then every caller
// on the internet is loopback-sourced, so the key gate never ran and an
// anonymous POST /v1/messages had a pooled credential injected (#324). The
// browser checks do not catch it: curl sends no Origin, and the Host header is
// written by the operator's own reverse proxy (nginx defaults it to the
// proxy_pass address, which is local), so it reports the proxy's configuration
// rather than the request's provenance.
//
// Two answers. A request carrying a forwarding header is never exempt, which
// fails closed on the common deployments with no configuration. And
// `proxy.trustLoopback: false` switches the exemption off for a reverse proxy
// configured to send none of them.

const PROXY = { apiKey: 'the-operator-key', clientKeys: [{ name: 'alice', key: 'alice-key' }] };
const local = '127.0.0.1';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('loopbackExempt: a forwarding header or trustLoopback:false refuses the exemption', () => {
  assert.equal(loopbackExempt({}, local, PROXY), true);
  assert.equal(loopbackExempt({ host: '127.0.0.1:8484' }, local, PROXY), true);
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    assert.equal(loopbackExempt({ [h]: '203.0.113.7' }, local, PROXY), false, h);
  }
  assert.equal(loopbackExempt({}, local, { ...PROXY, trustLoopback: false }), false);
  assert.equal(loopbackExempt({}, local, { trustLoopback: false }), false, 'even with no keys, the flag stands');
  assert.equal(loopbackExempt({}, '203.0.113.7', PROXY), false, 'a remote address was never exempt');
  // The setting is off only when it says so; any other value keeps the default.
  assert.equal(loopbackExempt({}, local, { ...PROXY, trustLoopback: 'false' }), true);
  assert.equal(loopbackExempt({}, local, undefined), true);
});

test('isForwardedRequest: an empty header value is not a forwarding mark', () => {
  assert.equal(isForwardedRequest({ 'x-forwarded-for': '' }), false);
  assert.equal(isForwardedRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }), true);
  assert.equal(isForwardedRequest({ forwarded: 'for=203.0.113.7' }), true);
  assert.equal(isForwardedRequest(undefined), false);
});

test('the WebSocket and CONNECT gates refuse the same requests', () => {
  const sock = { remoteAddress: local };
  const refused = { ok: false, client: null };
  const exempt = { ok: true, client: null };
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'localhost:8484' } }, sock, PROXY), exempt);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'localhost:8484', 'x-forwarded-for': '203.0.113.7' } }, sock, PROXY), refused);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'localhost:8484' } }, sock, { ...PROXY, trustLoopback: false }), refused);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'localhost:8484', 'x-forwarded-for': '203.0.113.7', 'x-api-key': 'alice-key' } }, sock, PROXY), { ok: true, client: 'alice' });

  assert.deepEqual(resolveConnectAuth({ headers: {} }, sock, PROXY), exempt);
  assert.deepEqual(resolveConnectAuth({ headers: { 'x-forwarded-for': '203.0.113.7' } }, sock, PROXY), refused);
  assert.deepEqual(resolveConnectAuth({ headers: {} }, sock, { ...PROXY, trustLoopback: false }), refused);
  assert.deepEqual(resolveConnectAuth({ headers: { 'proxy-authorization': 'Bearer alice-key' } }, sock, { ...PROXY, trustLoopback: false }), { ok: true, client: 'alice' });
});

// The reproduction from the report: a server configured WITH a key, a keyless
// POST /v1/messages whose Host is what nginx sends by default. Before, the
// request took the messages path, a pooled account was selected and its
// credential injected; the upstream here records what it was handed.
function post(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }));
  });
}

async function withProxy(proxyConfig, fn) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(req.headers['x-api-key'] ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const up = await listen(upstream);
  const am = new AccountManager([{ name: 'pooled', type: 'api_key', apiKey: 'sk-POOLED-SECRET' }], 0.98);
  const proxy = createProxyServer(am, { proxy: proxyConfig, upstream: `http://127.0.0.1:${up}` });
  const port = await listen(proxy);
  try {
    await fn(port, seen);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a keyless request forwarded by a same-host reverse proxy is refused, and no credential is spent', async () => {
  await withProxy({ apiKey: 'the-operator-key', host: '127.0.0.1' }, async (port, seen) => {
    const forwarded = await post(port, '/v1/messages', { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.7' });
    assert.equal(forwarded.status, 401);
    assert.deepEqual(seen, [], 'the upstream never saw the pooled credential');

    // The same request with the key is served, forwarded or not.
    const keyed = await post(port, '/v1/messages', { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.7', 'x-api-key': 'the-operator-key' });
    assert.equal(keyed.status, 200);
    assert.deepEqual(seen, ['sk-POOLED-SECRET']);

    // A plain local caller — nothing forwarded — keeps the exemption.
    const plain = await post(port, '/v1/messages', { host: `127.0.0.1:${port}` });
    assert.equal(plain.status, 200);
  });
});

test('trustLoopback:false closes the exemption for a reverse proxy that forwards nothing', async () => {
  await withProxy({ apiKey: 'the-operator-key', host: '127.0.0.1', trustLoopback: false }, async (port, seen) => {
    const keyless = await post(port, '/v1/messages', { host: `127.0.0.1:${port}` });
    assert.equal(keyless.status, 401);
    assert.deepEqual(seen, []);
    const keyed = await post(port, '/v1/messages', { host: `127.0.0.1:${port}`, 'x-api-key': 'the-operator-key' });
    assert.equal(keyed.status, 200);
  });
});
