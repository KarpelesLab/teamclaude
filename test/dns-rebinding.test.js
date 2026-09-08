import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isLocalHostHeader } from '../src/server.js';

// DNS rebinding against the loopback exemption. A page at attacker.example
// whose DNS answer flips to 127.0.0.1 has the browser send loopback-sourced,
// same-origin requests to the proxy — and, unlike the cross-origin case, the
// page can READ the answers. The one header the page cannot forge is Host,
// which the browser derives from its own URL bar, so a key-less loopback
// request must carry a Host that names this machine.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];

async function withServer(config, fn) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com', ...config });
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

// fetch() refuses to set Host, so drive http.request, which lets the test say
// exactly what the browser would have sent.
function get(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/teamclaude/status', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a rebound name is refused even though the request is loopback and same-origin', async () => {
  await withServer({}, async (port) => {
    const res = await get(port, { host: 'attacker.example', 'sec-fetch-site': 'same-origin' });
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error.message, /Host header/);
  });
});

test('the names a local browser actually uses are all accepted', async () => {
  await withServer({}, async (port) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'LocalHost']) {
      const res = await get(port, { host, 'sec-fetch-site': 'same-origin' });
      assert.equal(res.status, 200, `Host: ${host}`);
    }
  });
});

test('a valid key makes the Host header irrelevant', async () => {
  await withServer({}, async (port) => {
    const res = await get(port, { host: 'attacker.example', 'x-api-key': 'tc-test' });
    assert.equal(res.status, 200);
  });
});

test('the configured bind address is accepted, a wildcard bind widens nothing', async () => {
  await withServer({ proxy: { apiKey: 'tc-test', host: '192.0.2.10' } }, async (port) => {
    assert.equal((await get(port, { host: '192.0.2.10:3456' })).status, 200);
    assert.equal((await get(port, { host: '192.0.2.11:3456' })).status, 403);
  });
  await withServer({ proxy: { apiKey: 'tc-test', host: '0.0.0.0' } }, async (port) => {
    assert.equal((await get(port, { host: '0.0.0.0:3456' })).status, 403);
    assert.equal((await get(port, { host: `localhost:${port}` })).status, 200);
  });
});

// Node rejects an HTTP/1.1 request without Host before the handler runs, so
// the only client that can arrive without one speaks HTTP/1.0 — a hand-rolled
// local tool, never a browser. It stays served.
test('an HTTP/1.0 request with no Host header is still served', async () => {
  await withServer({}, async (port) => {
    const sock = net.connect(port, '127.0.0.1');
    await once(sock, 'connect');
    sock.write('GET /teamclaude/status HTTP/1.0\r\n\r\n');
    let raw = '';
    sock.on('data', (c) => { raw += c; });
    await once(sock, 'close');
    assert.match(raw, /^HTTP\/1\.[01] 200/);
  });
});

test('isLocalHostHeader: hostname extraction and the accepted set', () => {
  assert.equal(isLocalHostHeader('localhost'), true);
  assert.equal(isLocalHostHeader('localhost:3456'), true);
  assert.equal(isLocalHostHeader('127.0.0.1:3456'), true);
  assert.equal(isLocalHostHeader('[::1]:3456'), true);
  assert.equal(isLocalHostHeader('::1'), true);
  assert.equal(isLocalHostHeader(undefined), true);            // HTTP/1.0
  assert.equal(isLocalHostHeader('attacker.example'), false);
  assert.equal(isLocalHostHeader('127.0.0.1.attacker.example'), false);
  assert.equal(isLocalHostHeader('localhost.attacker.example'), false);
  assert.equal(isLocalHostHeader('[::1'), false);              // malformed
  // The bind address counts, unless it is a wildcard.
  assert.equal(isLocalHostHeader('192.0.2.10:1', '192.0.2.10'), true);
  assert.equal(isLocalHostHeader('[fe80::1]:1', 'fe80::1'), true);
  assert.equal(isLocalHostHeader('0.0.0.0', '0.0.0.0'), false);
  assert.equal(isLocalHostHeader('::', '::'), false);
});
