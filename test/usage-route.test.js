import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { openUsageStore, USAGE_STORE_AVAILABLE } from '../src/usage/db.js';
import { recordRequest } from '../src/usage/record.js';

// node:sqlite needs Node 22.5+; on an older Node these skip.
const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;

const ACCT = [{ name: 'a', type: 'apikey', apiKey: 'k' }];
const CONFIG = { proxy: { clientKeys: [{ name: 'laptop', key: 'tc-test' }] }, upstream: 'https://api.anthropic.com' };
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('the usage route serves each window and refuses an unknown one', async () => {
  const usageStore = openUsageStore({ path: ':memory:' });
  recordRequest(usageStore, { caller: 'laptop', model: 'm', account: 'a', input: 10, output: 5 });

  const proxy = createProxyServer(new AccountManager(ACCT, 0.98), CONFIG, {}, null, null, null, { usageStore });
  const port = await listen(proxy);
  try {
    for (const w of ['5h', '7d', '30d']) {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/usage?window=${w}`, {
        headers: { 'x-api-key': 'tc-test' },
      });
      assert.equal(res.status, 200, w);
      const body = await res.json();
      assert.equal(body.window, w);
      assert.equal(body.available, true);
      assert.equal(body.totals.tokens, 15);
      assert.equal(body.callers[0].caller, 'laptop');
      assert.equal(body.callers[0].share, 1);
      assert.equal(body.callerModels[0].caller, 'laptop', w);
    }
    for (const w of ['1y', '__proto__', 'toString']) {
      const bad = await fetch(`http://127.0.0.1:${port}/teamclaude/usage?window=${w}`, {
        headers: { 'x-api-key': 'tc-test' },
      });
      assert.equal(bad.status, 400, w);
    }
    const missing = await fetch(`http://127.0.0.1:${port}/teamclaude/usage`, {
      headers: { 'x-api-key': 'tc-test' },
    });
    assert.equal(missing.status, 400);
  } finally {
    proxy.closeAllConnections?.();
    await new Promise(r => proxy.close(r));
  }
});

test('a server with no usage store answers rather than hanging', async () => {
  const proxy = createProxyServer(new AccountManager(ACCT, 0.98), CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/usage?window=5h`, {
      headers: { 'x-api-key': 'tc-test' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
  } finally {
    proxy.closeAllConnections?.();
    await new Promise(r => proxy.close(r));
  }
});

test('the route carries no credential material', async () => {
  const usageStore = openUsageStore({ path: ':memory:' });
  recordRequest(usageStore, { caller: 'laptop', model: 'm', account: 'a', input: 1 });
  const proxy = createProxyServer(new AccountManager(ACCT, 0.98), CONFIG, {}, null, null, null, { usageStore });
  const port = await listen(proxy);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/teamclaude/usage?window=5h`, {
      headers: { 'x-api-key': 'tc-test' },
    })).text();
    for (const secret of ['apiKey', 'accessToken', 'refreshToken', 'tc-test', 'sk-ant']) {
      assert.ok(!body.includes(secret), secret);
    }
  } finally {
    proxy.closeAllConnections?.();
    await new Promise(r => proxy.close(r));
  }
});
