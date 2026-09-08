import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// What travels upstream on each path, credential-wise. The proxy replaces the
// client's credential with a fleet account's on the inference path, and relays
// the client's OWN bearer on the identity-bound paths; on neither must a
// credential that belongs to someone else leak through. A per-account
// `upstream` can be a third-party host, so "someone else" includes the client's
// Anthropic OAuth token and the operator's proxy key.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// An upstream that records the request headers it received.
function recordingUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

async function withProxy(accounts, fn) {
  const { server: upstream, seen } = recordingUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-proxy-key' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await fn(port, seen);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('an API-key account replaces the client credential; the client bearer does not reach upstream', async () => {
  await withProxy([{ name: 'a', type: 'apikey', apiKey: 'sk-account-key' }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'tc-proxy-key',
        // Claude Code sends its own OAuth bearer alongside; the proxy must
        // swap it for the account's credential, not forward both.
        authorization: 'Bearer client-anthropic-oauth-token',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    const { headers } = seen[0];
    assert.equal(headers['x-api-key'], 'sk-account-key');
    assert.equal(headers.authorization, undefined, 'the client bearer must not be forwarded');
  });
});

test('an OAuth account replaces the client bearer and sends no x-api-key', async () => {
  await withProxy([{ name: 'a', type: 'oauth', accessToken: 'acct-token', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], async (port, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'tc-proxy-key',
        authorization: 'Bearer client-anthropic-oauth-token',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    });
    assert.equal(res.status, 200);
    const { headers } = seen[0];
    assert.equal(headers.authorization, 'Bearer acct-token');
    assert.equal(headers['x-api-key'], undefined, 'the proxy key must not be forwarded');
  });
});
