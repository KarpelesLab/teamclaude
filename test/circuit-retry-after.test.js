import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, capacityRetryAfter } from '../src/server.js';

function fixture() {
  const am = new AccountManager([
    { name: 'codex', type: 'apikey', apiKey: 'test', upstream: 'http://127.0.0.1:9' },
    { name: 'other', type: 'apikey', apiKey: 'test' },
  ]);
  am.setRoutes([{ name: 'gpt', match: ['gpt-*'], accounts: ['codex'] }]);
  am.accounts[0].circuitOpenUntil = Date.now() + 8000;
  am.accounts[0].quota.unified7d = 0.11;
  am.accounts[0].quota.unified7dReset = Date.now() + 604800000;
  am.accounts[1].quota.unified7dReset = Date.now() + 86400000;
  return am;
}

test('short circuit retry is independent of weekly resets and route-excluded accounts', () => {
  const am = fixture();
  assert.equal(capacityRetryAfter(am, 'gpt-6.1-sol', am.accounts[0].circuitOpenUntil - 8000), 8);
});

test('production-shaped Codex circuit returns a seconds-long Retry-After', async () => {
  const am = fixture();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test' } });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': 'test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }),
    });
    assert.equal(response.status, 429);
    const retry = Number(response.headers.get('retry-after'));
    assert.ok(retry >= 1 && retry <= 8);
    const body = await response.json();
    assert.match(body.error.message, /circuit-open/);
    assert.doesNotMatch(body.error.message, /3600s/);
  } finally {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
});
