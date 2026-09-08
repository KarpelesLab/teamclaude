import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveMaxBodyBytes, DEFAULT_MAX_BODY_BYTES } from '../src/server.js';

// The forward path buffers the whole request body (to resend it on another
// account after a 429), and so does the token-refresh passthrough. Neither had
// a ceiling, so one client could hold as much of the proxy's memory as it cared
// to send. The cap is driven down here so the tests stay small.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CAP = 1024;

async function withProxy(fn) {
  let reached = 0;
  const upstream = http.createServer((req, res) => {
    reached++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const ended = [];
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k', maxBodyBytes: CAP },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  }, { onRequestEnd: (_id, info) => ended.push(info) });
  const port = await listen(proxy);
  try {
    await fn({ port, reached: () => reached, ended });
  } finally {
    proxy.close();
    upstream.close();
  }
}

// http.request rather than fetch: the server tears the connection down after
// the 413, and this client reports the response it received before that
// rather than folding the teardown into one opaque "fetch failed".
function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'x-api-key': 'k' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const oversized = () => JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x'.repeat(4 * CAP) }] });

test('a body past the cap is refused with a 413 and never forwarded', async () => {
  await withProxy(async ({ port, reached, ended }) => {
    const res = await post(port, '/v1/messages', oversized());
    assert.equal(res.status, 413);
    assert.match(res.text, /too large/);
    assert.equal(reached(), 0);
    // The activity row this request opened is closed, with the refusal on it.
    assert.equal(ended.length, 1);
    assert.equal(ended[0].status, 413);
    assert.equal(ended[0].account, '(too large)');
  });
});

test('a body under the cap is forwarded as before', async () => {
  await withProxy(async ({ port, reached }) => {
    const res = await post(port, '/v1/messages', JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
    assert.equal(res.status, 200);
    assert.equal(reached(), 1);
  });
});

test('the token-refresh passthrough is capped too', async () => {
  await withProxy(async ({ port, reached }) => {
    const res = await post(port, '/v1/oauth/token', oversized());
    assert.equal(res.status, 413);
    assert.equal(reached(), 0);
  });
});

test('resolveMaxBodyBytes: default, override, quoted number, opt-out', () => {
  assert.equal(resolveMaxBodyBytes({}), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes(undefined), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: 4096 } }), 4096);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: '4096' } }), 4096);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: '' } }), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: -1 } }), DEFAULT_MAX_BODY_BYTES);
  assert.equal(resolveMaxBodyBytes({ proxy: { maxBodyBytes: 0 } }), Infinity);
  assert.ok(DEFAULT_MAX_BODY_BYTES >= 64 * 1024 * 1024);
});
