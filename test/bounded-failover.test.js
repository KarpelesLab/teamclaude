import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// One bounded failover hop when the current account cannot serve but a sibling
// can (#137, #165, #156).
//
// #84's argument — moving a shared burst to the next account just throttles it
// too and discards the KV cache — holds under load and not when a sibling is
// idle, which is what every reporter hit. So: at most one hop, never onto an
// account already tried or inside its own 429 pause.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;

const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

async function withFleet(handler, fn, extraConfig = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res, seen); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, ...extraConfig });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

// A rate-limit 429 (no `rejected` status) used to wait 60s and retry the SAME
// account, never touching the idle sibling.
test('a rate-limit 429 fails over once to an idle sibling', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200, 'the idle sibling should have served it');
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// #165: a headerless 429 — no anthropic-ratelimit-* at all — is the same shape.
test('a headerless 429 fails over rather than retrying the same account', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'true' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// The maintainer's point: if the second account is throttled too, the limit is
// scoped to the egress IP, not to either account. Hopping further would prove
// nothing and pay a cold cache each time, so the budget is one hop — the request
// must not walk the fleet.
test('a fleet-wide 429 stops after one hop instead of walking every account', async () => {
  await withFleet((req, res) => {
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 429, 'a 429 the fleet cannot escape belongs to the client');
    assert.equal(seen.length, 2, `expected one hop, upstream saw ${seen.length} attempts`);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// #156: a 529 is the provider saying it is overloaded, not a statement about
// this account. Surfacing it turned a provider transient into a client failure.
test('an upstream 529 fails over instead of reaching the client', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

test('a provider-wide 529 stops after one hop and reaches the client', async () => {
  await withFleet((req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 529);
    assert.equal(seen.length, 2, `expected one hop, upstream saw ${seen.length}`);
  });
});

// A quota rejection is durable exhaustion and already rotates; the hop must not
// change that path or double-count against it.
test('a quota-rejection 429 still rotates as before', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ am, proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled', 'a quota rejection still throttles the account');
  });
});

test('isPaused reports the rate-limit pause selection does not model', () => {
  const am = new AccountManager(accounts(), 0.98);
  assert.equal(am.isPaused(0), false);
  am.pauseAccount(0, 30);
  assert.equal(am.isPaused(0), true);
  assert.equal(am.isPaused(1), false);
});
