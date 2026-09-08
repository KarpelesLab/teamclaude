import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A 429 with no retry-after and no anthropic-ratelimit-* headers is upstream
// refusing the REQUEST (a model id it will not serve), not throttling the
// account. It used to be treated as a throttle: the account was paused for a
// fabricated 60s, so every other session on it waited, and the client was held
// for the same 60s per attempt (#288). Now nothing is paused, the request gets
// its one hop, and then the 429 goes back to the client without a made-up
// retry-after.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

async function post(port, model = 'claude-retired') {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [] }),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after'), ms: Date.now() - t0 };
}

// Refuses `claude-retired` with a headerless 429 (the shape observed upstream)
// and serves everything else.
function upstreamHandler(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const { model } = JSON.parse(raw || '{}');
    if (model === 'claude-retired') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This model is not available.' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

async function withFleet(names, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); upstreamHandler(req, res); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(names.map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const paused = (am, i) => am.accounts[i].pausedUntil != null && am.accounts[i].pausedUntil > Date.now();

test('a headerless 429 that follows the request onto a sibling goes back to the client, pausing nothing', async () => {
  await withFleet(['a', 'b'], async ({ am, proxyPort, seen }) => {
    const r = await post(proxyPort);
    assert.equal(r.status, 429, 'the refusal belongs to the client');
    assert.deepEqual(seen, ['t-a', 't-b'], 'one hop, then the answer is in');
    assert.equal(r.retryAfter, null, 'no fabricated retry-after');
    assert.match(r.body.error.message, /not available/, 'the upstream reason reaches the client');
    assert.ok(r.ms < 5000, `answered in ${r.ms}ms, not a fabricated 60s`);
    assert.equal(paused(am, 0), false, 'the refused account is not paused');
    assert.equal(paused(am, 1), false, 'nor the sibling');
    // Other traffic on the same account is unaffected: the next request, for a
    // model upstream serves, goes to `a` and is answered at once.
    const ok = await post(proxyPort, 'claude-fine');
    assert.equal(ok.status, 200);
    assert.equal(seen[2], 't-a', 'the fleet still rests on a, unpaused');
    assert.ok(ok.ms < 2000, `served in ${ok.ms}ms`);
  });
});

test('with no sibling, a headerless 429 gets one short retry and then reaches the client', async () => {
  await withFleet(['a'], async ({ am, proxyPort, seen }) => {
    const r = await post(proxyPort);
    assert.equal(r.status, 429);
    assert.equal(seen.length, 2, 'one retry, not a walk');
    assert.ok(r.ms >= 1900 && r.ms < 10_000, `one 2s retry, got ${r.ms}ms`);
    assert.equal(paused(am, 0), false);
  });
});

// The control: a 429 that carries rate-limit headers is still a throttle and
// still pauses the account (the existing server-429 tests pin the rest).
test('a 429 with a retry-after header is still treated as a throttle', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([account('a')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const p = post(proxyPort);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(paused(am, 0), true, 'a throttle pauses the account');
    await p;
  } finally { proxy.close(); upstream.close(); }
});
