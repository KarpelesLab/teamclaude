import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(blockedModels) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, blockedModels });
  const proxyPort = await listen(proxy);

  return {
    get hits() { return upstreamHits; },
    post: (model) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }),
    }),
    close() { proxy.close(); upstream.close(); },
  };
}

test('a blocked model (glob) is rejected with a non-retryable 400 and never forwarded', async () => {
  const t = await setup(['*fable*']);
  try {
    const res = await t.post('claude-fable-5');
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(t.hits, 0, 'must not reach upstream');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /blocked/i);
  } finally { t.close(); }
});

test('a non-blocked model is forwarded normally', async () => {
  const t = await setup(['*fable*']);
  try {
    const res = await t.post('claude-opus-4-8');
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1, 'forwarded to upstream');
  } finally { t.close(); }
});

test('an empty blocklist blocks nothing', async () => {
  const t = await setup([]);
  try {
    const res = await t.post('claude-fable-5');
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
  } finally { t.close(); }
});

test('an exact (non-glob) pattern blocks only that model', async () => {
  const t = await setup(['claude-fable-5']);
  try {
    let res = await t.post('claude-fable-5');
    await res.text();
    assert.equal(res.status, 400);
    assert.equal(t.hits, 0);

    res = await t.post('claude-fable-5-mini'); // different name → not blocked
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
  } finally { t.close(); }
});
