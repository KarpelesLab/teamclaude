import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// `teamclaude release` (#643): delete the pins on one account, leaving it in
// service, so each conversation on it is placed again on its next request.

const H = 3600_000;
const OPUS = 'claude-opus-5';
const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H };
}

// a1's weekly resets sooner, so a conversation that has to be placed goes to a1
// once a0 and a1 carry the same load.
function fleet(options = { distributeSessions: true }) {
  const am = new AccountManager([oauth('a0'), oauth('a1')], 0.98, options);
  Object.assign(am.accounts[0].quota, { unified7d: 0.1, unified7dReset: Date.now() + 100 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.1, unified7dReset: Date.now() + 10 * H });
  return am;
}

async function quietly(fn) {
  const { log } = console;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

test('a released conversation is placed again; until then its pin holds it', async () => {
  const am = fleet();
  am.sessionTracker.touch('running', 0, 'unified7d');
  assert.equal(am.getActiveAccount(null, OPUS, null, 'running').name, 'a0', 'the pin holds it on the later reset');
  const result = await quietly(() => am.releasePins(0));
  assert.deepEqual(result, { name: 'a0', released: 1, stillCurrent: false });
  assert.deepEqual(am.sessionTracker.pinnedAccounts('running'), []);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'running').name, 'a1');
  assert.equal(am.accounts[0].disabled, false, 'the account stays in service');
});

test('only pins on that account go, and a conversation is counted once', async () => {
  const am = fleet();
  am.sessionTracker.touch('both', 0, 'unified7d');
  am.sessionTracker.touch('both', 0, 'unified7dFable');
  am.sessionTracker.touch('split', 0, 'unified7dFable');
  am.sessionTracker.touch('split', 1, 'unified7d');
  am.sessionTracker.touch('elsewhere', 1, 'unified7d');
  const { released } = await quietly(() => am.releasePins(0));
  assert.equal(released, 2);
  assert.deepEqual(am.sessionTracker.pinnedAccounts('split'), [1]);
  assert.deepEqual(am.sessionTracker.pinnedAccounts('elsewhere'), [1]);
});

test('a release on a cordoned account moves what the cordon would keep', async () => {
  const am = fleet();
  am.sessionTracker.touch('running', 0, 'unified7d');
  am.setCordoned(0, true);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'running').name, 'a0');
  await quietly(() => am.releasePins(0));
  assert.equal(am.getActiveAccount(null, OPUS, null, 'running').name, 'a1');
});

test('with distribution off it says when traffic stays on the current account', async () => {
  const am = fleet({});
  assert.equal((await quietly(() => am.releasePins(0))).stillCurrent, true);
  assert.equal((await quietly(() => am.releasePins(1))).stillCurrent, false);
});

test('an account that is not there releases nothing', () => {
  assert.equal(fleet().releasePins(9), null);
});

test('POST /teamclaude/account-release answers what it released', async () => {
  const am = fleet();
  am.sessionTracker.touch('running', 0, 'unified7d');
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const send = async (/** @type {string} */ body) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account-release`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await quietly(async () => {
      assert.deepEqual(await send(JSON.stringify({ account: 'a0' })), {
        status: 200, body: { ok: true, account: 'a0', released: 1, stillCurrent: false },
      });
      const missing = await send('{}');
      assert.equal(missing.status, 400);
      assert.deepEqual(missing.body.accounts, ['a0', 'a1']);
      assert.equal((await send(JSON.stringify({ account: 'nobody' }))).status, 404);
      assert.equal((await send('{not json')).status, 400);
    });
  } finally {
    proxy.close();
  }
});
