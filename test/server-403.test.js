import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const HOUR = 3600_000;

// Upstream answers 403 "Request not allowed" to every token outside `live` —
// how Anthropic rejects a credential it will not serve at all (as opposed to a
// 401, which says the token merely needs refreshing). Records each bearer so a
// test can prove which account was tried.
function forbiddingUpstream(live) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (!live.has(token)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

// The client never sees the credential the proxy injects, so a 403 about that
// credential is not something the client can act on — but Claude Code reads a
// 403 as "your session is dead", drops its own login and asks for a re-login.
// Report it as a proxy error instead: the account needs attention, the client's
// own credential is untouched.
test('a 403 on the injected credential reaches the client as a proxy error, not a 403', async () => {
  const { server: upstream, seen } = forbiddingUpstream(new Set());   // nothing is accepted
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 502);
    assert.match(body, /proxy_error/);
    assert.match(body, /account \\"a\\"/);             // names the account that was rejected
    assert.equal(seen.length, 1);                      // no other account to try
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A 403 is about one account's credential, so the request itself is still
// serveable — fail over the way the 401 path does rather than giving up.
test('a 403 fails over to another account', async () => {
  const { server: upstream, seen } = forbiddingUpstream(new Set(['b-token']));
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'a-token', refreshToken: 'ra', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accessToken: 'b-token', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
    ],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});
