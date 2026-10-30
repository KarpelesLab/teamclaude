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

async function proxyFor(refreshError) {
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H }], 0.98, {
    refreshFn: async () => { throw refreshError; },
  });
  am.accounts[0].probing = false;
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
