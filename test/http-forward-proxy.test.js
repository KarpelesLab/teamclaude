import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// An accountManager that MUST NOT be consulted for third-party HTTP — if the
// forward path ever routed to Anthropic, getActiveAccount would throw.
const noRouteManager = {
  getActiveAccount() { throw new Error('third-party HTTP must not be routed to Anthropic'); },
  getStatus() { return {}; },
};

// Absolute-form request through the proxy (`GET http://target/…`) as sent by any
// tool honoring HTTP_PROXY.
function proxyRequest({ proxyPort, method = 'GET', absoluteUrl, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: absoluteUrl }, (res) => {
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
  const proxyPort = await listen(proxy);

  const r = await proxyRequest({ proxyPort, method: 'POST', absoluteUrl: `http://127.0.0.1:${targetPort}/`, body: 'payload-123' });
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(r.body), { method: 'POST', echo: 'payload-123' });

  proxy.close(); target.close();
});

test('returns 502 (not a hang) when the target host is unreachable', async () => {
  const proxy = createProxyServer(noRouteManager, { proxy: {}, upstream: 'https://api.anthropic.com' });
  const proxyPort = await listen(proxy);

  // Port 1 is not listening → connection refused.
  const r = await proxyRequest({ proxyPort, absoluteUrl: 'http://127.0.0.1:1/' });
  assert.equal(r.status, 502);
  assert.match(r.body, /proxy_error/);

  proxy.close();
});
