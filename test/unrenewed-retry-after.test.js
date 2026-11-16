import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Where the 429 hold (#551) and the unrenewed answer (#552) meet: the 503 for an
// expired token that could not be renewed tells the client to come back when the
// account's hold lifts — the token endpoint's Retry-After — not after a fixed 30 s.

const H = 3600_000;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function proxyFor(refreshError, others = []) {
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([...others, { name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H }], 0.98, {
    refreshFn: async () => { throw refreshError; },
  });
  for (const account of am.accounts) account.probing = false;
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const send = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) });
    await r.arrayBuffer();
    return { status: r.status, retryAfter: Number(r.headers.get('retry-after')) };
  };
  return { send, close: () => { proxy.close(); upstream.close(); } };
}

test("the unrenewed 503 carries the token endpoint's Retry-After, not a fixed 30 s", async () => {
  const f = await proxyFor(Object.assign(new Error('Token refresh failed (429): {}'), { status: 429, retryAfterMs: 120_000 }));
  try {
    const r = await f.send();
    assert.equal(r.status, 503);
    assert.ok(r.retryAfter > 30 && r.retryAfter <= 120, `${r.retryAfter}`);
  } finally { f.close(); }
});

test('control: with no hold behind it (a coordinator stand-down), the 503 keeps its short default', async () => {
  const f = await proxyFor(Object.assign(new Error('not renewed without the callback.net lock: busy'), { code: 'CALLBACK_LOCK_UNAVAILABLE' }));
  try {
    const r = await f.send();
    assert.equal(r.status, 503);
    assert.equal(r.retryAfter, 30);
  } finally { f.close(); }
});

// The hold is read from the account whose token could not be renewed, not looked
// up by its name: names are not unique, and the first account of that name can be
// another one with no hold behind it (here a disabled one, never tried).
test('the unrenewed 503 carries its own account\'s Retry-After beside a same-named account', async () => {
  const f = await proxyFor(Object.assign(new Error('Token refresh failed (429): {}'), { status: 429, retryAfterMs: 120_000 }), [
    { name: 'a', type: 'oauth', accessToken: 'off-a', refreshToken: 'rt-off', expiresAt: Date.now() + H, disabled: true },
  ]);
  try {
    const r = await f.send();
    assert.equal(r.status, 503);
    assert.ok(r.retryAfter > 30 && r.retryAfter <= 120, `${r.retryAfter}`);
  } finally { f.close(); }
});

// A kept 400/401/403 (a page in front of the token endpoint, not its refusal)
// holds the renewal of the refresh token it answered for 30 s, and the 503
// says how much of that is left. It holds no other token: once a new one has
// arrived and failed for now (a 5xx), nothing holds the renewal, and the 503
// keeps its short default instead of the old token's remainder.
test('the unrenewed 503 carries what is left of a kept 4xx\'s hold, and only while the account holds that token', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T00:00:00Z') });
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const sent = [];
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H }], 0.98, {
    refreshFn: async (rt) => {
      sent.push(rt);
      throw rt === 'rt-a'
        ? Object.assign(new Error('Token refresh failed (403): <html>Access denied</html>'), { status: 403, grantRefused: false })
        : Object.assign(new Error('Token refresh failed (500): {}'), { status: 500 });
    },
  });
  for (const account of am.accounts) account.probing = false;
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const send = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) });
    await r.arrayBuffer();
    return { status: r.status, retryAfter: Number(r.headers.get('retry-after')) };
  };
  try {
    assert.deepEqual(await send(), { status: 503, retryAfter: 30 });
    t.mock.timers.tick(20_000);
    assert.deepEqual(await send(), { status: 503, retryAfter: 10 }, 'rt-a is still held, for 10 s more');
    am.updateAccountTokens(0, { accessToken: 'dead-new', refreshToken: 'rt-new', expiresAt: Date.now() - H });
    assert.deepEqual(await send(), { status: 503, retryAfter: 30 }, 'rt-new is held by nothing');
    assert.deepEqual(sent, ['rt-a', 'rt-new']);
  } finally { proxy.close(); upstream.close(); }
});
