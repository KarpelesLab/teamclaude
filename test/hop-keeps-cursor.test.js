import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The one-hop failovers (#271) detour ONE request around an account that just
// refused it. Their destination used to come from getActiveAccount, which is a
// selection: it moved currentIndex, logged "Switched to account", and every
// other session followed the hop. Under a sustained 429 the cursor bounced
// between two siblings on every request (#286). The hop now picks its
// destination without moving anything, and the next request starts from the
// account the fleet was on.

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

async function withFleet(handler, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const ok = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };

// Refuse `a` for the first request only, so the second request shows where
// the fleet actually rests afterwards.
function refuseOnce(status, headers) {
  let refused = false;
  return (req, res) => {
    if (tokenOf(req) === 't-a' && !refused) {
      refused = true;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      return;
    }
    ok(res);
  };
}

test('a rate-limit hop serves the request from the sibling and leaves the cursor where it was', async () => {
  // retry-after 1: the hop happens before any wait, and the short pause on `a`
  // keeps the second request quick.
  await withFleet(refuseOnce(429, { 'retry-after': '1' }), async ({ am, proxyPort, seen }) => {
    assert.equal(am.currentIndex, 0);
    const { status } = await post(proxyPort);
    assert.equal(status, 200, 'the sibling served it');
    assert.deepEqual(seen, ['t-a', 't-b']);
    assert.equal(am.currentIndex, 0, 'the detour did not move the fleet');
    // Once the pause is over the fleet is still on `a`: the next request
    // starts there, not on the account the detour happened to use.
    await new Promise(r => setTimeout(r, 1100));
    const second = await post(proxyPort);
    assert.equal(second.status, 200);
    assert.equal(am.currentIndex, 0, 'still there after the pause');
    assert.equal(seen[2], 't-a', 'the fleet still rests on the original account');
  });
});

test('a 5xx hop leaves the cursor where it was, and the next request goes back to the original account', async () => {
  await withFleet(refuseOnce(529, {}), async ({ am, proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
    assert.equal(am.currentIndex, 0, 'the detour did not move the fleet');
    // Nothing paused `a` (a 5xx is the provider's problem, not the account's),
    // so the fleet is still on it and the next request goes there first.
    await post(proxyPort);
    assert.equal(seen[2], 't-a', 'the fleet still rests on the original account');
  });
});

// The same detour onto the first account in the list: its index is 0, a
// destination like any other (a hop's account that has left reads -1), so it is
// taken as it is and never picked again as though it had left.
test('a 5xx hop onto the first account in the list is a detour like any other', async t => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => { lines.push(String(args[0])); });
  let refused = false;
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-b' && !refused) {
      refused = true;
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    ok(res);
  }, async ({ am, proxyPort, seen }) => {
    am.currentIndex = 1;
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-b', 't-a']);
    assert.equal(am.currentIndex, 1, 'the detour onto a moved the fleet');
    assert.deepEqual(lines.filter(l => l.includes('was removed before the hop reached it')), [],
      'a live destination at index 0 was taken for one that had left');
  });
});

// The hop's account is removed before the attempt it names (here at the hop's
// own log line; in the field while the failed body is discarded). Removing an
// account renumbers the rest in place (removeAccount). Held by index, the hop
// then went to whichever account slid into its place, here x, which is
// disabled; removed during the discard it read -1 instead, and the client was
// told every account was at its quota. It is a detour still, so it is picked
// again: d serves, and the fleet stays.
test('a 5xx hop whose account is removed is picked again, and the cursor stays', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(tokenOf(req));
    if (tokenOf(req) === 't-a') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    ok(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([...accounts(),
    { name: 'x', type: 'oauth', accessToken: 't-x', refreshToken: 'r', expiresAt: Date.now() + HOUR, disabled: true },
    { name: 'd', type: 'oauth', accessToken: 't-d', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  t.mock.method(console, 'log', (...args) => {
    if (/failing over once to "b"/.test(String(args[0]))) am.removeAccount(am.accounts.findIndex(a => a.name === 'b'));
  });
  try {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-d']);
    assert.equal(am.accounts[am.currentIndex].name, 'a', 'the detour moved the fleet');
  } finally { proxy.close(); upstream.close(); }
});

// The second pick keeps the hop sites' rule: never onto an account inside its
// own 429 pause. c is paused and ranks below b, so the hop picks b, and b is
// removed at the hop's own log line, which leaves c alone. The request is not
// sent there (it would wait out the pause in admission) and is answered as one
// with no account is: the no-account branch's 429, as before this change. The
// second pick's own log line says which way it went, so the test reads that
// first rather than waiting out c's pause.
test('a 5xx hop picked again never lands on an account inside its 429 pause', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(tokenOf(req));
    if (tokenOf(req) === 't-a') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    ok(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([...accounts(),
    { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'r', expiresAt: Date.now() + HOUR, priority: 1 },
  ], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  am.pauseAccount(2, 60);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  let picked = () => {};
  const secondPick = new Promise(resolve => { picked = resolve; });
  t.mock.method(console, 'log', (...args) => {
    const line = String(args[0]);
    if (/failing over once to "b"/.test(line)) am.removeAccount(am.accounts.findIndex(a => a.name === 'b'));
    if (line.includes('"b" was removed before the hop reached it')) picked(line);
  });
  try {
    const answer = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [] }),
    }).then(async r => ({ status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.text() }));
    answer.catch(() => {});
    const first = await Promise.race([secondPick, answer.then(() => 'answered with no second pick')]);
    assert.match(first, /— no other account can take it now$/, 'the second pick went to the account inside its 429 pause');
    const { status, retryAfter } = await answer;
    assert.equal(status, 429);
    assert.equal(retryAfter, '60');
    assert.deepEqual(seen, ['t-a'], 'the request was sent to the account inside its 429 pause');
    assert.equal(am.accounts[am.currentIndex].name, 'a', 'the fleet cursor moved');
  } finally { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); }
});

test('pickAlternate names the sibling without touching the cursor or the observation', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.getActiveAccount(null, 'claude-x'); // settle the fleet on `a`
  const before = am.currentIndex;
  const alt = am.pickAlternate(new Set([before]), 'claude-x');
  assert.equal(alt.name, 'b');
  assert.equal(am.currentIndex, before);
  assert.equal(am.pickAlternate(new Set([0, 1]), 'claude-x'), null, 'nothing left to hop to');
});
