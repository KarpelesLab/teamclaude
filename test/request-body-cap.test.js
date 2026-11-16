import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveMaxBodyBytes, DEFAULT_MAX_BODY_BYTES } from '../src/server.js';
import { withEnv } from '../test-helpers/env.js';

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

// The passthrough's answer is held whole too, to be relayed in one write, and
// its upstream (the top-level `upstream`) is configurable. Past the hold limit
// (64 MiB unless TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES says otherwise; 4 KiB here)
// it is a 502, and the rest is not waited for: this upstream sends twice the
// limit and never ends its answer, so the only thing that closes its
// connection is the proxy dropping it. A proxy that kept reading would leave
// the request open, and the runner's timeout would say so.
test('the token-refresh passthrough answers 502 for an answer too large to hold, and drops the rest', async (t) => {
  const LIMIT = 4096;
  /** @type {() => void} */
  let dropped = () => {};
  const upstreamDropped = new Promise((resolve) => { dropped = () => resolve(undefined); });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.on('close', () => dropped());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(Buffer.alloc(2 * LIMIT, 0x61));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  // In an after hook, which a timed-out test still runs: the upstream's answer
  // never ends, so a proxy that held on to it would hold these open.
  t.after(() => {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    proxy.close(); upstream.close();
  });
  const lines = [];
  const error = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    await withEnv({ TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES: LIMIT }, async () => {
      const res = await post(port, '/v1/oauth/token', '{}');
      assert.equal(res.status, 502);
      assert.match(res.text, /Upstream response too large/);
      // The await is the check: this upstream never ends its answer, so only
      // the proxy dropping its connection settles it, and a proxy that
      // answered but left the connection open leaves it to the runner's
      // timeout.
      await upstreamDropped;
      assert.ok(lines.some(l => /Token refresh passthrough: upstream answer larger than 4096 bytes, not relayed/.test(l)),
        `the operator is told which path it was, and the limit: ${lines.join(' | ')}`);
    });
  } finally {
    console.error = error;
  }
});

// Under the limit the passthrough relays the bytes it read, as they came: a
// token endpoint that answers in another charset (or with bytes that are not
// UTF-8 at all) reaches the client unchanged, not decoded and re-encoded.
test('the token-refresh passthrough relays its answer byte for byte', async () => {
  const answer = Buffer.from('{"error":"invalid_grant","error_description":"caf\xe9 \xff"}', 'latin1');
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json; charset=iso-8859-1' });
      res.end(answer);
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/oauth/token', headers: { 'content-type': 'application/json', 'x-api-key': 'k' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(got.status, 400);
    assert.equal(got.body.toString('hex'), answer.toString('hex'));
  } finally {
    proxy.close();
    upstream.close();
  }
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
