import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const SESSION_ID = '43e47b27-842d-4397-a7f0-a5d940c35289';
const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };

test('GET /teamclaude/session/:id returns only the pinned account and quota windows', async () => {
  const am = new AccountManager([{
    name: 'claude-b@example.com',
    type: 'oauth',
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
  }], 0.98);
  am.sessionTracker.touch(SESSION_ID, 0);
  Object.assign(am.accounts[0].quota, {
    unified5h: 0.03,
    unified7d: 0,
    unified7dFable: 0.01,
    unified5hReset: Date.parse('2026-07-24T21:00:00.000Z'),
  });

  const proxy = createProxyServer(am, CONFIG);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session/${SESSION_ID}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(body.sessionId, SESSION_ID);
    assert.equal(body.account.name, 'claude-b@example.com');
    assert.equal(body.limits.fiveHour.utilization, 0.03);
    assert.equal(body.limits.weekly.utilization, 0);
    assert.equal(body.limits.fable.utilization, 0.01);
    assert.equal(body.limits.fiveHour.resetsAt, '2026-07-24T21:00:00.000Z');
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('secret-access-token'));
    assert.ok(!serialized.includes('secret-refresh-token'));
    assert.ok(!serialized.includes('apiKey'));
  } finally {
    proxy.close();
  }
});

test('session endpoint rejects invalid IDs and returns 404 for unknown UUIDs', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, CONFIG);
  const port = await listen(proxy);
  try {
    const invalid = await fetch(`http://127.0.0.1:${port}/teamclaude/session/not-a-uuid`);
    assert.equal(invalid.status, 400);
    const missing = await fetch(`http://127.0.0.1:${port}/teamclaude/session/${SESSION_ID}`);
    assert.equal(missing.status, 404);
  } finally {
    proxy.close();
  }
});
