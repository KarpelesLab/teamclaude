import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Neither AccountManager nor createProxyServer reads this path themselves (only
// src/config.js and src/index.js's CLI entry do), so this test never touches the
// real config either way. Set it anyway, before importing, as defense in depth
// against a future import gaining a module-load-time config read.
const TMP = mkdtempSync(join(tmpdir(), 'tc-dns-'));
process.env.TEAMCLAUDE_CONFIG = join(TMP, 'config.json');

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } = await import('../src/upstream-proxy.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Sends a bare POST /v1/messages through the proxy and resolves with either
// the full response (proxy answered normally) or the socket error (proxy
// destroyed the connection — the transient-error fast path).
function sendThrough(port, path = '/v1/messages', body = JSON.stringify({ model: 'claude-x', messages: [] })) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ type: 'response', status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ type: 'error', code: err.code }));
    req.end(body);
  });
}

// RFC 2606 reserves the .invalid TLD as guaranteed never to resolve, so this
// test's failure mode is deterministic regardless of network conditions.
const UNRESOLVABLE_UPSTREAM = 'https://does-not-exist.invalid';

test.afterEach(() => resetUpstreamProxy());

test('a DNS resolution failure on the upstream host is treated as transient (connection reset, not a 502 body)', async () => {
  // Force the direct (no-proxy) path regardless of this machine's own
  // HTTP_PROXY/HTTPS_PROXY: getUpstreamProxy() falls back to the environment
  // when nothing has resolved a proxy yet (see src/upstream-proxy.js), and a
  // dev or CI host that sets HTTPS_PROXY would otherwise route this request
  // through it — hitting a CONNECT-tunnel failure instead of the raw Node
  // getaddrinfo ENOTFOUND this test exists to exercise.
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

  const am = new AccountManager([
    { name: 'k', type: 'apikey', apiKey: 'sk-ant-test', upstream: UNRESOLVABLE_UPSTREAM },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: UNRESOLVABLE_UPSTREAM }, {});
  const port = await listen(proxy);

  try {
    const outcome = await sendThrough(port);

    // Transient treatment destroys the response socket before any header is
    // written, so the client never gets a full HTTP response — it sees the
    // connection reset instead. A 502 JSON body (the failover/exhaustion
    // outcome) is exactly what proves the DNS failure was NOT classified as
    // transient.
    assert.equal(
      outcome.type,
      'error',
      `expected the connection to be reset (transient handling); got a full HTTP response instead: ${JSON.stringify(outcome)}`,
    );
  } finally {
    proxy.close();
  }
});

test('a DNS failure on one account\'s own upstream still fails over to another account with a different upstream', async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

  const good = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const goodPort = await listen(good);

  const am = new AccountManager([
    { name: 'broken', type: 'apikey', apiKey: 'sk-ant-broken', upstream: UNRESOLVABLE_UPSTREAM },
    { name: 'good', type: 'apikey', apiKey: 'sk-ant-good', priority: 1, upstream: `http://127.0.0.1:${goodPort}` },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } }, {});
  const port = await listen(proxy);

  try {
    const outcome = await sendThrough(port);

    // "broken"'s upstream doesn't resolve, but "good" has its own distinct
    // upstream — a per-account override (docs/accounts.md's third-party
    // backends), not the shared default. That DNS failure says nothing about
    // whether "good"'s host is reachable, so the request must fail over
    // rather than reset the connection on the strength of "broken" alone.
    assert.deepEqual(outcome, { type: 'response', status: 200, body: JSON.stringify({ ok: true }) });
  } finally {
    proxy.close();
    good.close();
  }
});

test('a DNS failure still gets the fast reset when the only other-host account is route-ineligible for this model', async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

  // "backend" has a distinct, resolvable host, but the route below pins
  // claude-* models exclusively to "broken" — so "backend" can never legally
  // serve THIS request no matter how healthy its own host is.
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const backendPort = await listen(backend);

  const am = new AccountManager([
    { name: 'broken', type: 'apikey', apiKey: 'sk-ant-broken', upstream: UNRESOLVABLE_UPSTREAM },
    { name: 'backend', type: 'apikey', apiKey: 'sk-ant-backend', upstream: `http://127.0.0.1:${backendPort}` },
  ], 0.98, { routes: [{ name: 'claude-only', match: ['claude-*'], accounts: ['broken'] }] });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } }, {});
  const port = await listen(proxy);

  try {
    // sendThrough's body carries model: 'claude-x', which the route above
    // matches and pins to "broken" alone.
    const outcome = await sendThrough(port);

    assert.equal(
      outcome.type,
      'error',
      `expected the connection to be reset (no eligible different-host account exists); got a full HTTP response instead: ${JSON.stringify(outcome)}`,
    );
  } finally {
    proxy.close();
    backend.close();
  }
});

test('an advisor request still fails over to a healthy host that is executor-eligible only', async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const backendPort = await listen(backend);

  // "backend" cannot serve the ADVISOR model (the route pins it to "broken"),
  // but when no account satisfies both models, selection degrades to
  // executor-only routing — so failover does reach "backend". A DNS failure on
  // "broken" must therefore fail over, not reset: gating the other-host scan on
  // two-model eligibility would call this reachable healthy host "nowhere to
  // go" and reset a request selection would have served.
  const am = new AccountManager([
    { name: 'broken', type: 'apikey', apiKey: 'sk-ant-broken', upstream: UNRESOLVABLE_UPSTREAM },
    { name: 'backend', type: 'apikey', apiKey: 'sk-ant-backend', upstream: `http://127.0.0.1:${backendPort}` },
  ], 0.98, { routes: [{ name: 'advisor-pin', match: ['claude-advisor-x'], accounts: ['broken'] }] });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } }, {});
  const port = await listen(proxy);

  try {
    const outcome = await sendThrough(port, '/v1/messages', JSON.stringify({
      model: 'claude-x',
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-advisor-x' }],
      messages: [],
    }));
    assert.deepEqual(outcome, { type: 'response', status: 200, body: JSON.stringify({ ok: true }) });
  } finally {
    proxy.close();
    backend.close();
  }
});

test('a DNS failure on a pinned account\'s upstream gets the pinned-unavailable response, not a silent reset', async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

  const am = new AccountManager([
    { name: 'k', type: 'apikey', apiKey: 'sk-ant-test', upstream: UNRESOLVABLE_UPSTREAM },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } }, {});
  const port = await listen(proxy);

  try {
    // A pinned request (/tc-acct/<name>) never fails over to another account
    // regardless of host, so a DNS failure here has no failover to skip in the
    // first place — it must surface the informative pinned-unavailable 429,
    // matching what a non-DNS transport failure on a pinned account already
    // gets, not a bare connection reset that looks like a random network drop.
    const outcome = await sendThrough(port, '/tc-acct/k/v1/messages');

    assert.equal(outcome.type, 'response', `expected the pinned-unavailable 429, got a connection error instead: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.status, 429);
    assert.match(outcome.body, /pinned account is unavailable/i);
  } finally {
    proxy.close();
  }
});
