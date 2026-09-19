import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// 403 rotates the account out, 5xx hops once, 429 throttles and switches. A 401
// did none of it unless the account carried a refresh token: the answer was
// relayed to the client and the account stayed `active`, so the next request
// picked it again — 4,124 consecutive 401s from one account in the report
// (#412). A 401 now fails over, and an account nothing here can repair leaves
// rotation.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function withFleet(accounts, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = req.headers['x-api-key'] || req.headers.authorization;
      seen.push(key);
      const dead = key === 'dead-key' || key === 'Bearer dead-token';
      res.writeHead(dead ? 401 : 200, { 'content-type': 'application/json' });
      res.end(dead
        ? JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } })
        : JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const send = () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [] }),
    });
    await run({ am, seen, send, errors });
  } finally {
    console.error = origError;
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('a 401 on an API-key account fails over, and the account leaves rotation', async () => {
  await withFleet([
    { name: 'dead', type: 'apikey', apiKey: 'dead-key' },
    { name: 'live', type: 'apikey', apiKey: 'live-key' },
  ], async ({ am, seen, send, errors }) => {
    const res = await send();
    assert.equal(res.status, 200, 'the client must not be handed the account\'s 401');
    await res.text();
    assert.deepEqual(seen, ['dead-key', 'live-key']);
    assert.equal(am.accounts[0].status, 'error', 'nothing can repair a rejected API key');
    assert.ok(errors.some(e => /taken out of rotation/.test(e) && /dead/.test(e)), errors.join('\n'));

    // The next request does not try the dead account again.
    const again = await send();
    await again.text();
    assert.equal(again.status, 200);
    assert.deepEqual(seen, ['dead-key', 'live-key', 'live-key']);
  });
});

test('an OAuth account with no refresh token is handled the same way', async () => {
  await withFleet([
    { name: 'dead', type: 'oauth', accessToken: 'dead-token', expiresAt: Date.now() + 3600_000 },
    { name: 'live', type: 'apikey', apiKey: 'live-key' },
  ], async ({ am, seen, send }) => {
    const res = await send();
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0], 'Bearer dead-token');
    assert.equal(am.accounts[0].status, 'error');
  });
});

test('with every account rejected the client gets a proxy error, not a relayed 401', async () => {
  await withFleet([{ name: 'dead', type: 'apikey', apiKey: 'dead-key' }], async ({ send }) => {
    const res = await send();
    await res.text();
    assert.notEqual(res.status, 401, 'Claude Code reads a 401 as its own login having died');
    assert.notEqual(res.status, 200);
  });
});
