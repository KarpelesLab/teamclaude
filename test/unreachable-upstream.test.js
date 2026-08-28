import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// What one unreachable upstream costs a fleet. These drive the real server and
// import nothing this change adds, so they run against the tree as it was and
// report the behaviour, not a missing symbol.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const accounts = (names) => names.map(n => ({ name: n, type: 'apikey', apiKey: `k-${n}` }));

// A fresh name per run, so no resolver cache can answer it from a previous one.
const unresolvable = () => `http://nx-${Date.now()}-${Math.random().toString(36).slice(2)}-teamclaude.invalid`;

// Behind an ambient proxy a DNS failure never reaches the classification: the
// proxy resolves the name and reports its own refusal, leaving no resolution
// code to read. Disable it through the seam upstream-proxy.test.js already uses.
function withoutAmbientProxy() {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  return resetUpstreamProxy;
}

// Drive one request through a proxy and collect the upstream failures it logged.
async function oneRequest(proxyPort) {
  const lines = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a) => lines.push(a.map(x => (x instanceof Error ? x.message : String(x))).join(' '));
  console.log = () => {};
  let outcome;
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    outcome = `${res.status} ${await res.text()}`;
  } catch {
    outcome = 'connection closed';        // the transient path, by design
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  return { outcome, attempts: lines.filter(l => l.includes('Upstream error')) };
}

const sawResolutionFailure = (got) => got.attempts.some(l => /ENOTFOUND|EAI_AGAIN/.test(l));
const nothingMeasured = (got) =>
  `this environment did not produce a resolution failure, so nothing here was measured: ${got.attempts.join(' | ') || '(no attempts logged)'}`;

test('an unresolvable upstream is not walked through the whole fleet', async () => {
  const am = new AccountManager(accounts(['a', 'b', 'c', 'd']), 0.98);
  const restore = withoutAmbientProxy();
  const proxy = createProxyServer(am, { proxy: {}, upstream: unresolvable() });
  const port = await listen(proxy);
  let got;
  try {
    got = await oneRequest(port);
  } finally {
    restore();
    proxy.close();
  }
  assert.ok(sawResolutionFailure(got), nothingMeasured(got));
  assert.equal(got.attempts.length, 1,
    `one unresolvable host spent ${got.attempts.length} of ${am.accounts.length} accounts`);
  assert.ok(!/rate_limit_error/.test(got.outcome),
    `a name that would not resolve was reported to the client as exhausted quota: ${got.outcome}`);
});

test('an unresolvable upstream still fails over to an account on a different host', async () => {
  const am = new AccountManager(accounts(['a', 'b']), 0.98);
  const reached = [];
  const good = http.createServer((req, res) => {
    reached.push(req.headers['x-api-key'] || 'none');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const goodPort = await listen(good);
  am.accounts[1].upstream = `http://127.0.0.1:${goodPort}`;   // 'b' has its own backend

  const restore = withoutAmbientProxy();
  const proxy = createProxyServer(am, { proxy: {}, upstream: unresolvable() });
  const port = await listen(proxy);
  let got;
  try {
    got = await oneRequest(port);
  } finally {
    restore();
    proxy.close();
    good.close();
  }
  assert.ok(sawResolutionFailure(got), nothingMeasured(got));
  assert.match(got.outcome, /^200 /,
    `the request did not reach the account whose host was up: ${got.outcome}`);
  assert.equal(reached.length, 1, 'the account on the reachable host was not the one that served');
});

// Once an account has been tried, its host is no longer somewhere else to go.
// Without that term the last failure still counts the accounts already spent, so
// the fleet runs out of untried accounts and the client is told its quota is
// exhausted, for two hosts that would not resolve.
test('a fleet whose hosts are all unresolvable closes rather than reporting exhaustion', async () => {
  const am = new AccountManager(accounts(['a', 'b']), 0.98);
  am.accounts[1].upstream = unresolvable();          // a different host, equally unresolvable

  const restore = withoutAmbientProxy();
  const proxy = createProxyServer(am, { proxy: {}, upstream: unresolvable() });
  const port = await listen(proxy);
  let got;
  try {
    got = await oneRequest(port);
  } finally {
    restore();
    proxy.close();
  }
  assert.ok(sawResolutionFailure(got), nothingMeasured(got));
  assert.equal(got.attempts.length, 2,
    `two accounts on two dead hosts produced ${got.attempts.length} attempts`);
  assert.ok(!/rate_limit_error/.test(got.outcome),
    `two names that would not resolve were reported to the client as exhausted quota: ${got.outcome}`);
});

// The shape that made ECONNREFUSED unsafe to route through the condition while
// the other-host scan read the raw account list: a disabled account carrying
// its own upstream was never selected, never entered the tried set, and counted
// toward "another host is available" indefinitely. The scan now gates on
// selection's own eligibility predicate, which closes that instance — this test
// pins ECONNREFUSED as unconditional so any future gap in the condition stays a
// non-regression instead of a fleet walk.
//
// A refused port here on purpose. This is about a code that must stay
// unconditional, so the test has to use one.
test('a refused connection is not walked through the fleet by an unselectable account', async () => {
  const am = new AccountManager(accounts(['a', 'b', 'c', 'd']), 0.98);
  const good = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const goodPort = await listen(good);
  am.accounts[3].upstream = `http://127.0.0.1:${goodPort}`;
  am.accounts[3].disabled = true;

  // Same determinism guard as the tests above. A configured proxy without a
  // loopback bypass changes the error shape, and this test would then be
  // measuring that instead.
  const restore = withoutAmbientProxy();
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' });
  const port = await listen(proxy);
  let got;
  try {
    got = await oneRequest(port);
  } finally {
    restore();
    proxy.close();
    good.close();
  }
  assert.ok(got.attempts.length > 0, 'the request never reached the upstream error path');
  assert.equal(got.attempts.length, 1,
    `one refused connection spent ${got.attempts.length} accounts, because an account selection cannot choose counted toward a failover that could never be taken`);
  assert.ok(!/rate_limit_error/.test(got.outcome),
    `a network failure was reported to the client as exhausted quota: ${got.outcome}`);
});
