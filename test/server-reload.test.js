import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCT = [{ name: 'a', type: 'apikey', apiKey: 'k' }];

test('POST /teamclaude/reload invokes hooks.reload and returns the added count', async () => {
  const am = new AccountManager(ACCT, 0.98);
  let called = 0;
  const proxy = createProxyServer(am, CONFIG, { reload: async () => { called++; return 2; } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.added, 2);
    assert.equal(called, 1);
  } finally {
    proxy.close();
  }
});

test('reload returns 501 when no reload handler is wired', async () => {
  const am = new AccountManager(ACCT, 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 501);
    assert.equal(body.ok, false);
  } finally {
    proxy.close();
  }
});

test('reload reports handler errors as 500', async () => {
  const am = new AccountManager(ACCT, 0.98);
  const proxy = createProxyServer(am, CONFIG, { reload: async () => { throw new Error('boom'); } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.ok, false);
    assert.match(body.error, /boom/);
  } finally {
    proxy.close();
  }
});
