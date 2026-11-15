import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Affinity distribution through the real request path: a conversation pinned
// to an account is not moved by the one-hop 429 failover while that account
// can still serve it (a pause is not "out of usage"), and a 5xx hop that does
// detour the request does not re-pin the conversation on the detour.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;

const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

async function post(port, session) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: res.status, body: await res.text() };
}

async function withFleet(mode, handler, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res, seen); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, {
    distributeSessions: mode,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  // 'a' is the fuller account, so affinity places the first conversation there.
  am.accounts[0].quota.unified5h = 0.6;
  am.accounts[0].quota.unified5hReset = Date.now() + 3 * HOUR;
  am.accounts[1].quota.unified5h = 0.2;
  am.accounts[1].quota.unified5hReset = Date.now() + 3 * HOUR;
  for (const a of am.accounts) a.probing = false;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, upstreamProxy: false });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};

// Serve 'a' normally, except on the request number named, which gets `status`.
function refuseNth(n, status, headers) {
  return (req, res, seen) => {
    if (tokenOf(req) === 't-a' && seen.length === n) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'overloaded_error' } }));
      return;
    }
    ok(res);
  };
}

test('affinity: a rate-limit 429 on the pinned account waits in place rather than hopping', async () => {
  await withFleet('affinity', refuseNth(2, 429, { 'retry-after': '1' }), async ({ proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a']);
    // The pinned account pauses for a second; the request absorbs it inline and
    // retries the same account instead of hopping to the idle sibling.
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-a']);
    // And the conversation is still there afterwards.
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-a', 't-a']);
  });
});

test('adaptive: the same 429 still takes the one-hop failover', async () => {
  await withFleet('adaptive', refuseNth(2, 429, { 'retry-after': '1' }), async ({ proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-b']);
  });
});

test('affinity: a 5xx hop serves the request elsewhere but does not move the pin', async () => {
  await withFleet('affinity', refuseNth(2, 503, { 'retry-after': '1' }), async ({ proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-b'], 'the overloaded response hops once');
    // The next request is back on the pinned account, not on the detour.
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-b', 't-a']);
  });
});

test('affinity: a pinned account that is out of usage does release the conversation', async () => {
  await withFleet('affinity', (req, res) => ok(res), async ({ am, proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a']);
    am.accounts[0].quota.unified5h = 0.99;
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// A cordon keeps a running conversation where it is, and so does affinity
// across a temporary failure. Together the conversation must still come back.
test('affinity: a cordoned account keeps its conversation through a 5xx hop', async () => {
  await withFleet('affinity', refuseNth(2, 503, { 'retry-after': '1' }), async ({ am, proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    am.setCordoned(0, true);
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-b'], 'the overloaded response hops once');
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-b', 't-a']);
  });
});

test('affinity: a cordoned account keeps its conversation through a rate-limit 429', async () => {
  await withFleet('affinity', refuseNth(2, 429, { 'retry-after': '1' }), async ({ am, proxyPort, seen }) => {
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    am.setCordoned(0, true);
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-a'], 'the request waits in place');
    assert.equal((await post(proxyPort, 'sess-1')).status, 200);
    assert.deepEqual(seen, ['t-a', 't-a', 't-a', 't-a']);
  });
});
