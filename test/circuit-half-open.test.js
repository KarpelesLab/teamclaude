import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('_isAvailable does not mutate circuitOpenUntil on an open or expired circuit', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const a = am.accounts[0];
  const openUntil = Date.now() + 30_000;
  a.circuitOpenUntil = openUntil;
  a.consecutiveFailures = 2;

  assert.equal(am._isAvailable(a), false);
  assert.equal(a.circuitOpenUntil, openUntil, 'open circuit must stay open across availability reads');

  // Status / TUI path: getStatus and eligible maps call _isAvailable.
  am.getStatus();
  assert.equal(a.circuitOpenUntil, openUntil);

  // Expired half-open: still must not clear as a filter side effect.
  const expired = Date.now() - 1000;
  a.circuitOpenUntil = expired;
  assert.equal(am._isAvailable(a), true, 'expired circuit is half-open eligible');
  assert.equal(a.circuitOpenUntil, expired, 'status/filter must not close the breaker');
  am.getStatus();
  assert.equal(a.circuitOpenUntil, expired);
});

// RF-1: a leaked half-open probe claim must not hide the account forever.
// Bound is 120s — claims older than that are treated as released (read-only
// in _isAvailable; the next _acquireCircuitProbe re-claims by overwrite).
const PROBE_CLAIM_TTL_MS = 120_000;

test('stale probe claim no longer hides account; a new probe can claim', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() - 1;
  a.consecutiveFailures = 1;
  // Simulate a leaked claim from a request that never scored/released.
  a.circuitProbeInFlightAt = Date.now() - PROBE_CLAIM_TTL_MS - 1;

  assert.equal(am._isAvailable(a), true, 'stale claim must not hide the account');
  assert.equal(am._acquireCircuitProbe(a), true, 'stale claim is re-claimable');
  assert.ok(a.circuitProbeInFlightAt != null
    && Date.now() - a.circuitProbeInFlightAt < 1000,
    'acquire overwrites the stale timestamp with a fresh claim');
});

test('fresh probe claim still blocks concurrent probes', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() - 1;
  a.consecutiveFailures = 1;
  a.circuitProbeInFlightAt = Date.now();

  assert.equal(am._isAvailable(a), false, 'fresh claim hides the account');
  assert.equal(am._acquireCircuitProbe(a), false, 'fresh claim blocks a second probe');
  const held = a.circuitProbeInFlightAt;
  assert.equal(a.circuitProbeInFlightAt, held, 'failed acquire must not touch the claim');
});

test('status reads during a stale probe claim do not mutate', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() - 1;
  const staleAt = Date.now() - PROBE_CLAIM_TTL_MS - 5_000;
  a.circuitProbeInFlightAt = staleAt;

  const expiredUntil = a.circuitOpenUntil;
  assert.equal(am._isAvailable(a), true);
  assert.equal(a.circuitProbeInFlightAt, staleAt, '_isAvailable must not clear or refresh');
  assert.equal(a.circuitOpenUntil, expiredUntil, 'breaker timestamp untouched by availability');
  am.getStatus();
  assert.equal(a.circuitProbeInFlightAt, staleAt, 'getStatus must not clear or refresh');
  assert.equal(a.circuitOpenUntil, expiredUntil, 'breaker timestamp untouched by status');
});

test('half-open allows exactly one concurrent trial request', { timeout: 10000 }, async () => {
  let hits = 0;
  let upstreamReached;
  const firstUpstreamRequest = new Promise(resolve => { upstreamReached = resolve; });
  let releaseUpstream;
  const gate = new Promise(r => { releaseUpstream = r; });
  const upstream = http.createServer((_req, res) => {
    hits++;
    upstreamReached();
    gate.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'solo', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}` },
    { name: 'other', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${upPort}`, priority: 1 },
  ]);
  // Expire the circuit so the next selection enters half-open.
  am.accounts[0].circuitOpenUntil = Date.now() - 1;
  am.accounts[0].consecutiveFailures = 1;
  // Make "other" unavailable so the only eligible account is the half-open one.
  am.accounts[1].disabled = true;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const p1 = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'a' }] }),
    });
    // Wait for actual upstream dispatch, which proves the probe was acquired.
    // A fixed delay races connection setup and scheduling under load.
    await firstUpstreamRequest;
    assert.ok(am.accounts[0].circuitProbeInFlightAt != null, 'probe claim timestamp set');

    const p2 = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'b' }] }),
    });
    await new Promise(r => setTimeout(r, 30));
    // Second request must not stampede the half-open account.
    assert.equal(hits, 1, 'only one trial may reach the half-open upstream');

    releaseUpstream();
    const r1 = await p1;
    await r1.text();
    const r2 = await p2;
    await r2.text();
    // After success the probe slot is free; the second request may have been
    // refused or served after — either way the in-flight stampede did not happen.
    assert.equal(am.accounts[0].circuitProbeInFlightAt, null);
  } finally {
    releaseUpstream();
    await close(proxy); await close(upstream);
  }
});
