import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// When no account can serve a request, the server may spend a banked Codex
// reset credit (the `autoRedeem` hook) and run selection again, instead of
// answering 429 while a credit that would have emptied a window sits unused.
// The hook is the operator's opt-in and owns the lock; the server's part is to
// ask exactly once per request, and only when nobody could serve it.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-fine', messages: [] }),
  });
  return { status: res.status, body: await res.json() };
}

async function withFleet(hooks, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push((req.headers.authorization || '').replace(/^Bearer /, ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([account('a')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const exhaust = (am) => am.markRateLimited(0, 3600);
const revive = (am) => { am.accounts[0].pausedUntil = null; am.accounts[0].status = 'active'; };

test('a redeemed credit turns "no account can serve this" into a served request', async () => {
  let asked = 0;
  await withFleet({
    autoRedeem: async (provider) => { asked++; assert.equal(provider, 'anthropic'); return true; },
  }, async ({ am, proxyPort, seen }) => {
    exhaust(am);
    // The hook is what empties the window in production (it re-probes); here the
    // test plays that part, since the hook itself is the thing under test only
    // for whether it was consulted.
    const original = am.getActiveAccount.bind(am);
    let calls = 0;
    am.getActiveAccount = (...args) => { if (++calls === 2) revive(am); return original(...args); };
    const r = await post(proxyPort);
    assert.equal(r.status, 200, 'served after the redemption');
    assert.equal(asked, 1, 'the hook was consulted exactly once');
    assert.deepEqual(seen, ['t-a']);
  });
});

test('a refused redemption falls through to the ordinary 429, and is not asked twice for one request', async () => {
  let asked = 0;
  await withFleet({ autoRedeem: async () => { asked++; return false; } }, async ({ am, proxyPort, seen }) => {
    exhaust(am);
    const r = await post(proxyPort);
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /at their quota/);
    assert.equal(asked, 1);
    assert.deepEqual(seen, []);
  });
});

test('without the hook nothing changes: the exhausted fleet answers 429 as before', async () => {
  await withFleet({}, async ({ am, proxyPort }) => {
    exhaust(am);
    const r = await post(proxyPort);
    assert.equal(r.status, 429);
  });
});

test('an account that can serve the request never triggers a redemption', async () => {
  let asked = 0;
  await withFleet({ autoRedeem: async () => { asked++; return true; } }, async ({ proxyPort, seen }) => {
    const r = await post(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(asked, 0);
    assert.deepEqual(seen, ['t-a']);
  });
});
