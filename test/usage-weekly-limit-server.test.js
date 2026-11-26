import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closeUsageStore, openUsageStore, usageStoreAvailable } from '../src/usage/db.js';

// proxy.clientKeys[].weeklyUsd, end to end: replies are priced and booked, a
// key at its figure gets 403 before any account is asked, the control plane is
// untouched, and an edit to clientKeys applies to the next request. No usage
// history here, so these run on every supported Node.

// claude-sonnet-5-5 at $2/$10 per MTok: 1000 in + 500 out = $0.007.
const REPLY_USAGE = { input_tokens: 1000, output_tokens: 500 };
const MESSAGE = { method: 'POST', path: '/v1/messages', body: { model: 'claude-sonnet-5-5', messages: [] } };

/** @param {http.Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (server.address()).port)));
}

/**
 * @param {number} port
 * @param {{ method?: string, path: string, key?: string, body?: any }} req
 * @param {AbortSignal} signal
 * @returns {Promise<{ status: number, json: any }>}
 */
function send(port, { method = 'GET', path, key, body }, signal) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...(key ? { 'x-api-key': key } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, signal }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: /** @type {number} */ (res.statusCode), json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** @param {import('node:test').TestContext} t @param {any[]} clientKeys @param {{ modelMap?: Record<string, string>, usageStore?: any, beforeReply?: (am: any) => void }} [opts] */
async function proxyWith(t, clientKeys, { modelMap, usageStore, beforeReply } = {}) {
  const hits = { n: 0 };
  const upstream = http.createServer((req, res) => {
    hits.n++;
    req.resume();
    req.on('end', () => {
      beforeReply?.(am);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'claude-sonnet-5-5', usage: REPLY_USAGE }));
    });
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamPort = await listen(upstream);
  /** @type {any} */
  const am = new AccountManager([{ name: 'acct', type: 'apikey', apiKey: 'sk-ant-acct', ...(modelMap ? { modelMap } : {}) }], 0.98);
  const config = { proxy: { apiKey: 'tc-shared', clientKeys }, upstream: `http://127.0.0.1:${upstreamPort}` };
  const proxy = createProxyServer(am, config, {}, null, null, null, usageStore ? { usageStore } : {});
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const port = await listen(proxy);
  return { port, hits, config, call: (/** @type {string} */ key) => send(port, { ...MESSAGE, key }, t.signal) };
}

test('a key is served until its replies reach the figure, then refused before any account', async (t) => {
  const { hits, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.01 }]);

  assert.equal((await call('tc-agent')).status, 200);   // $0.007
  assert.equal((await call('tc-agent')).status, 200);   // under at admission, $0.014 after
  const refused = await call('tc-agent');

  assert.equal(refused.status, 403);
  assert.equal(refused.json.type, 'error');
  assert.equal(refused.json.error.type, 'permission_error');
  assert.match(refused.json.error.message, /^weekly spending limit of \$0\.01 reached \(spent \$0\.01\); it resets at \d{4}-\d\d-\d\dT00:00:00\.000Z$/);
  assert.equal(hits.n, 2);
});

test('keys without a figure and the shared key are never limited', async (t) => {
  const { hits, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.01 }, { name: 'laptop', key: 'tc-laptop' }]);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call('tc-laptop')).status, 200);
    assert.equal((await call('tc-shared')).status, 200);
  }
  assert.equal(hits.n, 6);
});

test('a key whose weeklyUsd cannot be read is refused', async (t) => {
  const { hits, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: '200' }]);
  const res = await call('tc-agent');
  assert.equal(res.status, 403);
  assert.match(res.json.error.message, /not a number/);
  assert.equal(hits.n, 0);
});

test('status reports the spend; a key over its figure still reads status', async (t) => {
  const { port, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.01 }]);
  await call('tc-agent');
  await call('tc-agent');
  assert.equal((await call('tc-agent')).status, 403);

  const status = await send(port, { path: '/teamclaude/status', key: 'tc-agent' }, t.signal);

  assert.equal(status.status, 200);
  assert.deepEqual(status.json.clientLimits.map((/** @type {any} */ r) => [r.name, r.weeklyUsd, r.spentUsd, r.remainingUsd]), [['agent', 0.01, 0.01, 0]]);
});

test('an edit to clientKeys applies to the next request, with the week already spent', async (t) => {
  const { config, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent' }]);
  assert.equal((await call('tc-agent')).status, 200);
  assert.equal((await call('tc-agent')).status, 200);   // $0.014, booked with no limit set

  config.proxy.clientKeys = [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.01 }];   // what a reload does
  assert.equal((await call('tc-agent')).status, 403);

  config.proxy.clientKeys = [{ name: 'agent', key: 'tc-agent' }];
  assert.equal((await call('tc-agent')).status, 200);
});

test('a reply is priced at the model the account was sent, after its modelMap', async (t) => {
  // claude-opus-4-1 at $15/$75 per MTok: 1000 in + 500 out = $0.0525.
  const { hits, call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.05 }], { modelMap: { 'claude-sonnet-5-5': 'claude-opus-4-1' } });
  assert.equal((await call('tc-agent')).status, 200);
  assert.equal((await call('tc-agent')).status, 403);
  assert.equal(hits.n, 1);
});

test('a reload that changes modelMap while a reply is running does not reprice it', async (t) => {
  const { call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.05 }], {
    modelMap: { 'claude-sonnet-5-5': 'claude-opus-4-1' },
    beforeReply: (am) => { am.accounts[0].modelMap = {}; },
  });
  assert.equal((await call('tc-agent')).status, 200);   // sent as Opus 4.1: $0.0525
  assert.equal((await call('tc-agent')).status, 403);
});

test('usage history records each named reply\'s cost and a refusal as capped', { skip: !usageStoreAvailable() }, async (t) => {
  const usageStore = openUsageStore({ path: ':memory:' });
  t.after(() => closeUsageStore(usageStore));
  const { call } = await proxyWith(t, [{ name: 'agent', key: 'tc-agent', weeklyUsd: 0.01 }], { usageStore });
  for (let i = 0; i < 3; i++) await call('tc-agent');
  await call('tc-shared');

  const rows = usageStore.db.prepare('SELECT status, cost_micro, capped FROM usage ORDER BY rowid').all().map((/** @type {any} */ r) => ({ ...r }));
  assert.deepEqual(rows, [
    { status: 200, cost_micro: 7000, capped: 0 },
    { status: 200, cost_micro: 7000, capped: 0 },
    { status: 403, cost_micro: 0, capped: 1 },
    { status: 200, cost_micro: 0, capped: 0 },   // unnamed traffic: no spend to read back
  ]);
});
