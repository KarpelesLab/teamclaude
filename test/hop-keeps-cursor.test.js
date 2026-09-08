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

test('pickAlternate names the sibling without touching the cursor or the observation', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.getActiveAccount(null, 'claude-x'); // settle the fleet on `a`
  const before = am.currentIndex;
  const alt = am.pickAlternate(new Set([before]), 'claude-x');
  assert.equal(alt.name, 'b');
  assert.equal(am.currentIndex, before);
  assert.equal(am.pickAlternate(new Set([0, 1]), 'claude-x'), null, 'nothing left to hop to');
});
