import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// The upstream admission gate is sized from the environment when
// upstream-fetch.js is first evaluated, so the pool is narrowed BEFORE server.js
// (which imports it) is loaded. A width of one and no queue makes the second
// concurrent request the overload case.
process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS = '1';
process.env.TEAMCLAUDE_UPSTREAM_MAX_QUEUE = '0';
const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); }
  assert.fail('condition did not settle within 1s');
}

function post(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-opus-5', messages: [] }));
  });
}

// Local saturation is not an account failure: the request past the pool and
// its queue gets a 503 with Retry-After, is never retried on another account
// (that would only add load to the same saturated origin), and its activity row
// is not attributed to an account it never reached.
test('a request past the upstream pool and queue gets a 503, with no account rotation or attribution', { timeout: 4000 }, async () => {
  let reached = 0;
  const held = [];
  const upstream = http.createServer((req, res) => {
    reached++;
    req.resume();
    req.on('end', () => held.push(res)); // answered only when the test says so
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k1' },
    { name: 'b', type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  const ended = [];
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` },
    { onRequestEnd: (_id, info) => ended.push(info) });
  const port = await listen(proxy);
  try {
    const first = post(port);
    await until(() => held.length === 1);

    const second = await post(port);
    assert.equal(second.status, 503);
    assert.equal(second.headers['retry-after'], '1');
    assert.equal(JSON.parse(second.text).error.type, 'overloaded_error');
    assert.equal(reached, 1, 'the refused request never went upstream, on either account');
    await until(() => ended.length === 1);
    assert.equal(ended[0].status, 503);
    assert.equal(ended[0].account, '(upstream queue full)');
    assert.ok(am.accounts.every(a => !a.error), 'no account was sidelined over a local queue');

    // The permit is released when the held response ends, and the next
    // request goes through as normal.
    held[0].writeHead(200, { 'content-type': 'application/json' });
    held[0].end('{}');
    assert.equal((await first).status, 200);
    const third = post(port);
    await until(() => held.length === 2);
    held[1].writeHead(200, { 'content-type': 'application/json' });
    held[1].end('{}');
    assert.equal((await third).status, 200);
    // First and third reached the upstream; the refused second never did.
    assert.equal(reached, 2);
  } finally {
    proxy.closeAllConnections(); proxy.close();
    upstream.closeAllConnections(); upstream.close();
  }
});
