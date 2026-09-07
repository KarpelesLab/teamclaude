import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A pin bypasses selection entirely, so the provider partition has to be
// enforced on that path too. Without it, TC_ACCT aimed at a Claude subscription
// served a Codex request from it — an OpenAI-shaped body sent to
// api.anthropic.com with a Claude token.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function proxyWith(accounts) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization || req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  return { am, port, seen, close: () => { proxy.close(); upstream.close(); } };
}

const post = (port, path, name) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(name ? { TC_ACCT: name } : {}) },
  body: JSON.stringify({ model: 'm', messages: [] }),
});

test('a Codex request pinned to a Claude subscription is refused, not served', async () => {
  const ctx = await proxyWith([
    { name: 'claude-sub', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  try {
    const res = await post(ctx.port, '/tc-acct/claude-sub/backend-api/codex/responses');
    await res.text();
    assert.notEqual(res.status, 200, 'the request must not have been served');
    assert.deepEqual(ctx.seen, [], 'nothing should have reached upstream');
  } finally {
    ctx.close();
  }
});

test('a Claude request pinned to a Claude subscription still works', async () => {
  const ctx = await proxyWith([
    { name: 'claude-sub', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  try {
    const res = await post(ctx.port, '/tc-acct/claude-sub/v1/messages');
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(ctx.seen.length, 1);
  } finally {
    ctx.close();
  }
});

// An API key is not a seat, so a pin to one stands whoever is calling.
test('a pin to an API-key account stands for either caller', async () => {
  const ctx = await proxyWith([{ name: 'shared', type: 'apikey', apiKey: 'k-shared' }]);
  try {
    const a = await post(ctx.port, '/tc-acct/shared/v1/messages');
    await a.text();
    assert.equal(a.status, 200);
    const b = await post(ctx.port, '/tc-acct/shared/backend-api/codex/responses');
    await b.text();
    assert.equal(b.status, 200);
    assert.equal(ctx.seen.length, 2);
  } finally {
    ctx.close();
  }
});
