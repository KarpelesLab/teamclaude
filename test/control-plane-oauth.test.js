import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isControlPlanePath } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('isControlPlanePath matches every /api/oauth/ path and rejects lookalikes', () => {
  assert.equal(isControlPlanePath('/api/oauth/validate'), true);
  assert.equal(isControlPlanePath('/api/oauth/profile'), true);
  assert.equal(isControlPlanePath('/api/oauth/usage?x=1'), true);
  assert.equal(isControlPlanePath('/api/oauth/validate?beta=true'), true);
  assert.equal(isControlPlanePath('/v1/messages'), false);
  assert.equal(isControlPlanePath('/api/oauthx'), false);
  assert.equal(isControlPlanePath('/v1/messages/../../api/oauth/profile'), false);
});

test('POST /api/oauth/validate relays the client credential to the default upstream', async () => {
  let seenUrl = null;
  let seenAuth = null;
  const upstream = http.createServer((req, res) => {
    seenUrl = req.url;
    seenAuth = req.headers.authorization;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const config = {
    proxy: { credential: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    accounts: [
      {
        name: 'rotated-acct', type: 'oauth', priority: 0,
        credential: 'account-cred-placeholder', refreshCredential: 'refresh-placeholder',
        expiresAt: Date.now() + 3600_000,
      },
    ],
  };
  const proxy = createProxyServer(new AccountManager(config.accounts), config, {}, null);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/oauth/validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Cred client-cred-placeholder',
      },
      body: JSON.stringify({ ok: true }),
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seenUrl, '/api/oauth/validate');
    assert.equal(seenAuth, 'Cred client-cred-placeholder');
    assert.notEqual(seenAuth, 'Cred account-cred-placeholder');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
