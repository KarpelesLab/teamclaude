import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// How upstream answers an inference-only token (`claude setup-token`) on one of
// Claude Code's profile-plane calls: a 403 with a structured scope code. The
// client's own login carries user:profile and is served. Records each attempt
// so a test can prove which credential went out.
function scopeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push({ token, apiKey: req.headers['x-api-key'] ?? null, project: req.headers['x-tc-project'] ?? null });
    if (token !== 'client-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'OAuth token does not meet scope requirement user:profile',
          details: { error_code: 'oauth_scope_insufficient', required_scopes: ['user:profile'], match: 'any' },
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

// Setup-token accounts: no refresh token, no expiry.
function inferenceOnlyPool() {
  return new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'a-token' },
      { name: 'b', type: 'oauth', accessToken: 'b-token' },
    ],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
}

async function send(port, { method = 'GET', path = '/api/claude_code_grove', bearer = 'client-token', extra = {} } = {}) {
  const headers = { 'x-api-key': 'k', ...extra };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (method === 'POST') headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify({ model: 'x', messages: [] }) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

test('a scope 403 goes out on the client credential and leaves the pool where it was', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = inferenceOnlyPool();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status, body } = await send(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { ok: true });
    // One attempt on the pool, then the client's own login. b is never tried.
    assert.deepEqual(seen.map(s => s.token), ['a-token', 'client-token']);
    // The proxy key authenticated the client to the proxy; it never leaves.
    assert.equal(seen[1].apiKey, null);
    assert.equal(am.accounts[am.currentIndex].name, 'a');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Usage-dimension headers are the operator's own labels and never travel
// upstream, on the pooled attempt or on the client-credential one.
test('the client-credential retry drops usage-dimension headers too', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = inferenceOnlyPool();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k', usageDimensions: [{ name: 'project', header: 'x-tc-project' }] },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await send(proxyPort, { extra: { 'x-tc-project': 'private/repo' } });
    assert.equal(status, 200);
    assert.deepEqual(seen.map(s => s.token), ['a-token', 'client-token']);
    assert.deepEqual(seen.map(s => s.project), [null, null]);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a completion that draws a scope 403 is never sent on the client credential', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = inferenceOnlyPool();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await send(proxyPort, { method: 'POST', path: '/v1/messages?beta=true' });
    assert.equal(status, 502);
    assert.ok(!seen.some(s => s.token === 'client-token'), 'a completion must spend the pool, not the client login');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('with no client bearer a scope 403 fails over as before', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = inferenceOnlyPool();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await send(proxyPort, { bearer: null });
    assert.equal(status, 502);
    assert.deepEqual(seen.map(s => s.token), ['a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A pin keeps its account for every request: the pinned GET is answered the
// way it was before, not on the client's login.
test('a pinned GET that draws a scope 403 stays on its account', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = inferenceOnlyPool();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await send(proxyPort, { path: '/tc-acct/b/api/claude_code_grove' });
    assert.equal(status, 502);
    assert.deepEqual(seen.map(s => s.token), ['b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The client's bearer on a Codex path is its OpenAI login. The scope retry is
// Anthropic's, so it must never send that bearer anywhere.
test('a Codex account that draws a scope 403 never sends the client bearer', async () => {
  const { server: upstream, seen } = scopeUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'codex:a', type: 'oauth', provider: 'codex', accountId: 'acct-a', accessToken: 'a-token', upstream: `http://127.0.0.1:${upstreamPort}` }],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await send(proxyPort, { path: '/backend-api/codex/models' });
    assert.equal(status, 502);
    assert.deepEqual(seen.map(s => s.token), ['a-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});
