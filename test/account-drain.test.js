import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, exhaustedMessage, exhaustedDetails, retryWait } from '../src/server.js';
import { setAccountDraining, ConfigOpError } from '../src/config-ops.js';
import { accountBadges, accountControlRequest, accountControlOutcome } from '../src/dashboard.js';
import { unavailableLine } from '../src/status-renderer.js';
import { createToolSet } from '../src/mcp-tools.js';
import { Warmer } from '../src/warmer.js';

// Draining one account (accounts[].draining): no new conversation goes to it,
// while a conversation already on it — the one its last request was served by,
// which the session tracker pins in every mode — stays there until it
// finishes. Placement reads the account as unavailable (`draining`, the last
// reason), so every path that places new work passes it over.

const SESSION = '5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// One account per key, so the key the proxy sent upstream names who served it.
function accounts(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'apikey', apiKey: `k${i}` }));
}

async function withProxy(count, opts, fn) {
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(req.headers['x-api-key'] || null);
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(count), 0.98, opts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await fn({ port, served, am, last: () => served.at(-1) });
  } finally {
    proxy.close();
    upstream.close();
  }
}

// One turn of a conversation: its opening message names it.
function post(port, first, { session = SESSION, rest = [] } = {}) {
  const body = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: first }, ...rest] });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(session ? { 'x-claude-code-session-id': session } : {}) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}
const turn = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `turn ${i}` }));

test('a conversation on a draining account stays there, and new ones go elsewhere', async () => {
  await withProxy(2, {}, async ({ port, am, last }) => {
    assert.equal(await post(port, 'the running one'), 200);
    assert.equal(last(), 'k0', 'the fleet is on a0');
    am.setDraining(0, true);
    assert.equal(await post(port, 'a new one'), 200);
    assert.equal(last(), 'k1', 'nothing new goes to a0');
    assert.equal(await post(port, 'the running one', { rest: turn(2) }), 200);
    assert.equal(last(), 'k0', 'the conversation on a0 keeps being served there');
    assert.equal(await post(port, 'a new one', { rest: turn(2) }), 200);
    assert.equal(last(), 'k1');
    // No session id, no pin: a request that names no conversation is new work.
    assert.equal(await post(port, 'untagged', { session: null }), 200);
    assert.equal(last(), 'k1');
    am.setDraining(0, false);
    am.setCurrentAccount(0);
    assert.equal(await post(port, 'after the undrain'), 200);
    assert.equal(last(), 'k0', 'undrained, it takes new conversations again');
  });
});

test('with distribution on, a draining account keeps its pinned conversations and takes no new one', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, am, served, last }) => {
    for (const first of ['one', 'two', 'three']) assert.equal(await post(port, first), 200);
    const onDrained = served[0];
    am.setDraining(Number(onDrained.slice(1)), true);
    const before = served.length;
    for (const first of ['four', 'five', 'six', 'seven']) assert.equal(await post(port, first), 200);
    assert.equal(served.slice(before).includes(onDrained), false, `a new conversation landed on the draining account: ${served.slice(before)}`);
    assert.equal(await post(port, 'one', { rest: turn(2) }), 200);
    assert.equal(last(), onDrained);
  });
});

test('upstream\'s own movers still move a conversation off a draining account', async () => {
  await withProxy(2, {}, async ({ port, am, last }) => {
    assert.equal(await post(port, 'running'), 200);
    am.setDraining(0, true);
    // Out of quota: the drain does not hold it where it cannot be served.
    am.accounts[0].status = 'exhausted';
    assert.equal(await post(port, 'running', { rest: turn(2) }), 200);
    assert.equal(last(), 'k1');
  });
  await withProxy(2, {}, async ({ port, am, last }) => {
    assert.equal(await post(port, 'running'), 200);
    am.setDraining(0, true);
    // A strictly better priority pulls a pinned conversation, drain or not.
    am.accounts[1].priority = -1;
    assert.equal(await post(port, 'running', { rest: turn(2) }), 200);
    assert.equal(last(), 'k1');
  });
});

test('a drain keeps a conversation where it is, and never draws it from a healthy account to a draining one', () => {
  const am = new AccountManager(accounts(2), 0.98);
  // Its Fable turns ran on a0 and its Opus turns on a1; then a0 drains.
  am.sessionTracker.touch('conversation', 0, 'unified7dFable');
  am.sessionTracker.touch('conversation', 1, 'unified7d');
  am.setCurrentAccount(1);
  am.setDraining(0, true);
  assert.deepEqual([...am.drainKeeps('conversation', 'claude-opus-5')], [], 'its Opus pin names a healthy account');
  assert.deepEqual([...am.drainKeeps('conversation', 'claude-fable-5')], [0]);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5', null, 'conversation')?.index, 1);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5', null, 'conversation')?.index, 0);
});

test('a route pin naming the draining account still keeps the conversations on it', () => {
  const am = new AccountManager(accounts(2), 0.98);
  am.sessionTracker.touch('running', 0, 'unified7d');
  am.setDraining(0, true);
  // The operator's route pin for these models names the account being drained.
  am._pinnedAccountForModel = () => am.accounts[0];
  assert.equal(am.getActiveAccount(null, 'claude-opus-5', null, 'running')?.index, 0);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5', null, 'a-new-one')?.index, 1);
});

test('hops, probes and fallbacks never place new work on a draining account', () => {
  const am = new AccountManager(accounts(3), 0.98);
  am.setDraining(1, true);
  assert.equal(am.pickAlternate(new Set([0]))?.index, 2, 'a failover hop skips it');
  assert.equal(am._isProbeable(am.accounts[1]), false);
  // Everything else spent: the soonest-reset fallback does not reach for it.
  for (const i of [0, 2]) { am.accounts[i].status = 'exhausted'; am.accounts[i].quota.unified5hReset = Date.now() + 3600_000; }
  am.accounts[1].quota.unified5hReset = Date.now() + 60_000;
  assert.notEqual(am.getActiveAccount()?.index, 1);
});

test('every other reason outranks draining, and eligibility says why a draining account takes nothing new', () => {
  const am = new AccountManager(accounts(2), 0.98);
  am.setDraining(0, true);
  assert.equal(am.unavailableReason(am.accounts[0]), 'draining');
  assert.deepEqual(am.eligibility(0), { eligible: false, reason: 'draining, so it takes no new conversations' });
  am.accounts[0].status = 'exhausted';
  assert.equal(am.unavailableReason(am.accounts[0]), 'exhausted');
  am.setDisabled(0, true);
  assert.equal(am.unavailableReason(am.accounts[0]), 'disabled');
  am.setDisabled(0, false);
  assert.equal(am.accounts[0].draining, true, 'an enable leaves the drain on');
});

test('the refusal when nothing is left in service names the drain', () => {
  const draining = [{ name: 'a0', draining: true }, { name: 'a1', draining: true }];
  assert.match(exhaustedMessage(draining, 'claude-opus-5', 60),
    /^No account can serve this request for claude-opus-5: every account eligible for it is draining \(2\), and a draining account takes no new conversations \(teamclaude undrain <account> puts one back\)\.$/);
  assert.match(exhaustedMessage([{ name: 'a0', draining: true }, { name: 'a1', disabled: true }], null, 60), /draining \(1\) or disabled \(1\)/);
  assert.equal(exhaustedDetails(draining, 60, null).error_code, 'no_eligible_account');
  assert.match(exhaustedMessage([{ name: 'a0', status: 'exhausted' }, { name: 'a1', draining: true }], null, 60),
    /all 1 account \(1 draining\) are at their quota or rate limit/);
  const am = new AccountManager(accounts(2), 0.98);
  am.accounts[0].draining = true;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 10_000;
  am.accounts[1].status = 'throttled';
  am.accounts[1].rateLimitedUntil = Date.now() + 3600_000;
  assert.ok(retryWait(am, am.accounts).seconds > 600, 'the wait is not the draining account\'s');
});

test('the refusal for a conversation kept on a draining account is not "no eligible account"', async () => {
  await withProxy(2, {}, async ({ port, am }) => {
    assert.equal(await post(port, 'running'), 200);
    am.setDraining(0, true);
    am.setDisabled(1, true);
    // The account it is kept on is held for a moment: the answer waits on it.
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() + 30_000;
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'running' }, ...turn(2)] }));
    });
    assert.equal(body.status, 429);
    assert.doesNotMatch(body.text, /no_eligible_account/);
    assert.doesNotMatch(body.text, /is draining/);
  });
});

test('drainRemaining counts the conversations a drain keeps there, or what is open there if more', () => {
  const am = new AccountManager(accounts(2), 0.98);
  am.setDraining(0, true);
  assert.equal(am.drainRemaining(0), 0);
  am.sessionTracker.touch('conversation-1', 0, 'unified7d');
  am.sessionTracker.touch('conversation-2', 0, 'unified7d');
  am.sessionTracker.touch('conversation-3', 1, 'unified7d');
  assert.equal(am.drainRemaining(0), 2);
  for (let i = 0; i < 3; i++) am.beginActivity(0);
  assert.equal(am.drainRemaining(0), 3, 'three requests open, one with no conversation');
  const status = am.getStatus();
  assert.deepEqual(status.accounts.map(a => [a.name, a.draining, a.drainRemaining]), [['a0', true, 3], ['a1', false, undefined]]);
  assert.equal(status.accounts[0].unavailable, 'draining');
});

test('the control endpoint drains through its hook, reloads, and answers what is left', async () => {
  const am = new AccountManager(accounts(2), 0.98);
  const config = { accounts: accounts(2) };
  const calls = [];
  const hooks = {
    setAccountDraining: async (account, draining, spec) => setAccountDraining(config, account, draining, spec),
    reload: async () => {
      calls.push('reload');
      config.accounts.forEach((row, i) => am.setDraining(i, !!row.draining));
      return 0;
    },
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, hooks);
  const port = await listen(proxy);
  const send = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/account-drain`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...headers }, body: JSON.stringify(body),
  });
  try {
    am.sessionTracker.touch('conversation-1', 0, 'unified7d');
    let res = await send({ account: 'a0', draining: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'a0', draining: true, remaining: 1, inService: 1 });
    assert.deepEqual(calls, ['reload']);
    assert.equal(config.accounts[0].draining, true);
    res = await send({ account: 'a1', draining: true });
    assert.deepEqual(await res.json(), { ok: true, name: 'a1', draining: true, remaining: 0, inService: 0 });
    res = await send({ account: 'a0', draining: false });
    assert.deepEqual(await res.json(), { ok: true, name: 'a0', draining: false, inService: 0 });
    assert.equal('draining' in config.accounts[0], false, 'an undrain deletes the key');
    res = await send({ account: 'a0', draining: 'yes' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'draining must be true or false' });
    res = await send({ account: 'nobody', draining: true });
    assert.equal(res.status, 400);
    // Pinning a session onto a draining account is new work too.
    const pin = await fetch(`http://127.0.0.1:${port}/teamclaude/session-pin`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ sessionId: SESSION, account: 'a1' }),
    });
    assert.equal(pin.status, 409);
    assert.match((await pin.json()).error, /account "a1" is draining/);
  } finally {
    proxy.close();
  }
  // One email in two orgs: the answer counts the org the request named.
  const twins = [{ name: 'me@example.com', type: 'apikey', apiKey: 'k1', orgName: 'Alpha', orgUuid: 'org-alpha' },
    { name: 'me@example.com', type: 'apikey', apiKey: 'k2', orgName: 'Beta', orgUuid: 'org-beta' }];
  const twinAm = new AccountManager(twins.map(a => ({ ...a })), 0.98);
  const twinConfig = { accounts: twins.map(a => ({ ...a })) };
  const twinServer = createProxyServer(twinAm, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, {
    setAccountDraining: async (account, draining, spec) => setAccountDraining(twinConfig, account, draining, spec),
    reload: async () => { twinConfig.accounts.forEach((row, i) => twinAm.setDraining(i, !!row.draining)); return 0; },
  });
  const twinPort = await listen(twinServer);
  try {
    twinAm.sessionTracker.touch('on-beta', 1, 'unified7d');
    const res = await fetch(`http://127.0.0.1:${twinPort}/teamclaude/account-drain`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ account: 'me@example.com', org: 'Beta', draining: true }),
    });
    const answer = await res.json();
    assert.equal(answer.remaining, 1, JSON.stringify(answer));
    assert.equal(twinConfig.accounts[1].draining, true);
    assert.equal(twinConfig.accounts[0].draining, undefined);
  } finally {
    twinServer.close();
  }
  const bare = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, {});
  const barePort = await listen(bare);
  try {
    const res = await fetch(`http://127.0.0.1:${barePort}/teamclaude/account-drain`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ account: 'a0', draining: true }),
    });
    assert.equal(res.status, 501);
  } finally {
    bare.close();
  }
});

test('config-ops writes the flag, and undrain deletes it', () => {
  const config = { accounts: [{ name: 'a@example.com' }, { name: 'b@example.com' }] };
  assert.deepEqual(setAccountDraining(config, 'a@example.com', true), { name: 'a@example.com', draining: true });
  assert.equal(config.accounts[0].draining, true);
  assert.deepEqual(setAccountDraining(config, 'a@example.com', false), { name: 'a@example.com', draining: false });
  assert.equal('draining' in config.accounts[0], false);
  assert.throws(() => setAccountDraining(config, 'a@example.com', 1), ConfigOpError);
});

test('the dashboard posts the drain to its own route and says what it left', () => {
  const request = accountControlRequest('a0', { draining: true }, 'key');
  assert.equal(request.url, '/teamclaude/account-drain');
  assert.deepEqual(JSON.parse(request.init.body), { account: 'a0', draining: true });
  assert.equal(accountControlRequest('a0', { disabled: true }, 'key').url, '/teamclaude/disable');
  assert.equal(accountControlRequest('a0', { place: 'first' }, 'key').url, '/teamclaude/priority');
  assert.deepEqual(accountControlOutcome({ ok: true, name: 'a0', draining: true, remaining: 2, inService: 1 }, { draining: true }),
    { kind: 'ok', text: 'draining a0: no new conversations, 2 still on it' });
  assert.deepEqual(accountControlOutcome({ ok: true, name: 'a0', draining: true, remaining: 0, inService: 0 }, { draining: true }),
    { kind: 'warn', text: 'draining a0: no new conversations, 0 still on it, so disabling or removing it ends nothing running; no other account takes new conversations now' });
  assert.deepEqual(accountControlOutcome({ ok: true, name: 'a0', draining: false, inService: 1 }, { draining: false }),
    { kind: 'ok', text: 'undrained a0: it takes new conversations again' });
  const badges = accountBadges({ name: 'a0', draining: true, drainRemaining: 2, status: 'active' }, null, null, Date.now());
  assert.ok(badges.some(b => b.cls === 'draining' && b.text === 'draining · 2 left'), JSON.stringify(badges));
});

test('teamclaude status says an account is draining and how many are left, rather than that it is blocked', () => {
  const plain = { dim: s => s, yellow: s => s, red: s => s };
  assert.equal(unavailableLine({ unavailable: 'draining', drainRemaining: 2 }, plain), 'Draining takes no new conversations; 2 still on it');
  assert.match(unavailableLine({ unavailable: 'disabled' }, plain), /^Blocked/);
});

test('get_status shows the drain, and set_account_draining writes it', async () => {
  // With ids, as a loaded config has them: the tool finds the entry by id.
  const rows = () => accounts(2).map(a => ({ ...a, id: `id-${a.name}` }));
  const am = new AccountManager(rows(), 0.98);
  const config = { accounts: rows() };
  const tools = createToolSet('full', { accountManager: am, config, hooks: { persistAccounts: async () => {} } });
  const result = await tools.call('set_account_draining', { account: 'a1', draining: true });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(am.accounts[1].draining, true);
  assert.equal(config.accounts[1].draining, true);
  const status = (await tools.call('get_status', {})).structuredContent;
  assert.deepEqual(status.accounts.map(a => [a.name, a.draining, a.drainRemaining, a.eligible]), [['a0', false, undefined, true], ['a1', true, 0, false]]);
});

test('keep-warm opens no window on a draining account', async () => {
  const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
  const am = new AccountManager([oauth('kept'), oauth('drained', { draining: true })], 0.98);
  const warmer = new Warmer(am, { intervalMs: 0, port: 3456, spawnFn: async () => 0 });
  assert.equal(warmer._isWarmCandidate(am.accounts[0]), true);
  assert.equal(warmer._isWarmCandidate(am.accounts[1]), false);
});
