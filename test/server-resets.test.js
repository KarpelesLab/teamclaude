import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ClaudeResetRedeemer, parseResetStatus } from '../src/claude-resets.js';
import { ResetCreditRedeemer } from '../src/codex-reset-credits.js';
import { createResetActions } from '../src/reset-actions.js';

// GET /teamclaude/resets, POST /teamclaude/resets/read and
// /teamclaude/resets/redeem are the control-plane form of the TUI's resets
// panel (`r`): a headless server or a page has no other way to see or spend a
// banked reset. The server owns only the HTTP contract; reading and spending
// stay in reset-actions.js, stubbed here so no test can reach a real claim.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const CONFIG = {
  proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] },
  upstream: 'http://127.0.0.1:9',
};
const FAR = Date.now() + 365 * 24 * 3600_000;
const ACCTS = [
  { name: 'alice@example.com', type: 'oauth', accessToken: 'a', refreshToken: 'ra', expiresAt: FAR, orgUuid: 'org-a' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
  { name: 'carol@example.com', type: 'oauth', provider: 'codex', accessToken: 'c', refreshToken: 'rc', expiresAt: FAR, accountId: 'acct-c' },
];

const DETAILS = { provider: 'claude', error: null, seenAt: 1, stale: false, retryAt: null, ineligibleReason: null,
  atLimit: true, exhausted: ['seven_day'], cooldownUntil: null, weeklyResetsAt: null, fleetHoldUntil: null,
  grants: [{ id: 'g-weekly', kind: 'weekly', label: 'Weekly reset', resetsLeft: 1, resetsTotal: 1, clears: ['five_hour', 'seven_day'],
    endsAt: null, next: true, blocked: null, warnings: [] }] };

function stubActions({ cached = () => DETAILS, window = () => ({ readAt: null, until: 0 }), read = async () => DETAILS, redeem } = {}) {
  const calls = { cached: [], read: [], redeem: [], opts: [] };
  const actions = {
    cached: account => { calls.cached.push(account.name); return cached(account); },
    readWindow: account => window(account),
    read: async account => { calls.read.push(account.name); return read(account); },
    redeem: async (account, grantId, opts) => {
      calls.redeem.push([account.name, grantId]);
      calls.opts.push(opts);
      return redeem ? redeem(account, grantId)
        : { redeemed: true, uncertain: false, message: `Manually redeemed a claude reset on "${account.name}" (reset)`, result: 'reset', resetsLeft: 0, cleared: ['seven_day'] };
    },
  };
  return { actions, calls };
}

async function withServer(hooks, fn, config = CONFIG) {
  const am = new AccountManager(ACCTS.map(a => ({ ...a })), 0.98);
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await fn(port, logs);
  } finally {
    console.log = orig;
    proxy.close();
  }
}

const get = (port, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/resets`, { headers: { 'x-api-key': PROXY_KEY, ...headers } });
const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_KEY, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('without reset actions every resets route answers 501', async () => {
  await withServer({}, async (port) => {
    assert.equal((await get(port)).status, 501);
    assert.equal((await post(port, '/teamclaude/resets/read', { account: 'alice@example.com' })).status, 501);
    assert.equal((await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g' })).status, 501);
  });
});

test('the list is the cached reading of every OAuth Claude and Codex account, with no upstream read', async () => {
  const until = Date.now() + 60_000;
  const { actions, calls } = stubActions({
    cached: account => account.name === 'carol@example.com' ? null : DETAILS,
    window: account => ({ readAt: 5, until: account.name === 'alice@example.com' ? until : 0 }),
  });
  await withServer({ resetActions: actions }, async (port) => {
    const res = await get(port);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      accounts: [
        { account: 'alice@example.com', provider: 'claude', details: DETAILS, readableAt: until },
        { account: 'carol@example.com', provider: 'codex', details: null, readableAt: null },
      ],
    });
    assert.deepEqual(calls.read, [], 'listing must never send a reset read');
  });
});

test('read sends a fresh read for one account and answers with its details', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port) => {
    const res = await post(port, '/teamclaude/resets/read', { account: 'alice@example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'alice@example.com', read: true, details: DETAILS, readableAt: null });
    assert.deepEqual(calls.read, ['alice@example.com']);
  });
});

// The TUI's two-minute floor (and an upstream Retry-After) bind here too: a
// page polling this route must not turn into a usage request per poll.
test('read inside the read floor answers from the cache without a request', async () => {
  const until = Date.now() + 60_000;
  const { actions, calls } = stubActions({ window: () => ({ readAt: Date.now(), until }) });
  await withServer({ resetActions: actions }, async (port) => {
    const res = await post(port, '/teamclaude/resets/read', { account: 'alice@example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'alice@example.com', read: false, details: DETAILS, readableAt: until });
    assert.deepEqual(calls.read, []);
  });
});

test('redeem spends the chosen grant on the named account and logs the outcome', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port, logs) => {
    const res = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, account: 'alice@example.com', redeemed: true, uncertain: false,
      message: 'Manually redeemed a claude reset on "alice@example.com" (reset)', result: 'reset', resetsLeft: 0, cleared: ['seven_day'],
    });
    assert.deepEqual(calls.redeem, [['alice@example.com', 'g-weekly']]);
    assert.ok(logs.includes('[TeamClaude] Manually redeemed a claude reset on "alice@example.com" (reset)'), logs.join('\n'));
  });
});

test('a declined redeem is a 409 with the reason, and an unread verdict a 502', async () => {
  let verdict = 'declined';
  const { actions } = stubActions({
    redeem: account => verdict === 'declined'
      ? { redeemed: false, uncertain: false, message: `Manual reset on "${account.name}": chosen reset is no longer listed` }
      : { redeemed: false, uncertain: true, message: `Manual reset on "${account.name}": claim failed (timeout)` },
  });
  await withServer({ resetActions: actions }, async (port, logs) => {
    const declined = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'gone' });
    assert.equal(declined.status, 409);
    assert.deepEqual(await declined.json(), { ok: false, account: 'alice@example.com', redeemed: false, uncertain: false,
      error: 'Manual reset on "alice@example.com": chosen reset is no longer listed' });
    verdict = 'uncertain';
    const unread = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' });
    assert.equal(unread.status, 502);
    assert.equal((await unread.json()).uncertain, true);
    assert.equal(logs.length, 2, 'every outcome is logged, a refusal too');
  });
});

test('bad input is refused before anything is read or spent', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port) => {
    const cases = [
      ['/teamclaude/resets/read', '{', 400],
      ['/teamclaude/resets/read', {}, 400],
      ['/teamclaude/resets/read', { account: 'nobody@example.com' }, 404],
      ['/teamclaude/resets/read', { account: 'bob@example.com' }, 400],
      ['/teamclaude/resets/redeem', { account: 'alice@example.com' }, 400],
      ['/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 7 }, 400],
      ['/teamclaude/resets/redeem', { grantId: 'g-weekly' }, 400],
      ['/teamclaude/resets/redeem', { account: 'nobody@example.com', grantId: 'g-weekly' }, 404],
      ['/teamclaude/resets/redeem', { account: 'bob@example.com', grantId: 'g-weekly' }, 400],
    ];
    for (const [path, body, status] of cases) {
      const res = await post(port, path, body);
      assert.equal(res.status, status, `${path} ${JSON.stringify(body)}`);
      assert.equal((await res.json()).ok, false);
    }
    assert.deepEqual(calls.read, []);
    assert.deepEqual(calls.redeem, []);
  });
});

// Grant ids are spend handles; a client key may use the pool, not spend or
// inspect its resets.
test('a client key is refused every resets route; the proxy key is not', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port) => {
    assert.equal((await get(port, { 'x-api-key': CLIENT_KEY })).status, 403);
    assert.equal((await post(port, '/teamclaude/resets/read', { account: 'alice@example.com' }, { 'x-api-key': CLIENT_KEY })).status, 403);
    assert.equal((await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' }, { 'x-api-key': CLIENT_KEY })).status, 403);
    assert.deepEqual(calls.read, []);
    assert.deepEqual(calls.redeem, []);
    assert.equal((await get(port)).status, 200);
  });
});

test('a cross-origin page cannot spend a reset', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port) => {
    const res = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.deepEqual(calls.redeem, []);
  });
});

// With no proxy key the gate admits every caller, so the routes hold the
// MCP endpoint's line themselves: this machine only, and a Host that names
// it (a rebound page is same-origin to its browser and passes the gate above).
test('a key-less proxy serves the resets routes to this machine only', async () => {
  const { actions, calls } = stubActions();
  const keyless = { proxy: {}, upstream: CONFIG.upstream };
  // fetch() refuses to set Host, so these drive http.request.
  const send = (port, method, path, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify({ account: 'alice@example.com', grantId: 'g-weekly' }) : undefined);
  });
  await withServer({ resetActions: actions }, async (port) => {
    const local = { host: `127.0.0.1:${port}` };
    assert.equal(await send(port, 'POST', '/teamclaude/resets/redeem', { host: 'attacker.example' }), 403);
    assert.equal(await send(port, 'POST', '/teamclaude/resets/redeem', { ...local, 'x-forwarded-for': '203.0.113.9' }), 403);
    assert.equal(await send(port, 'GET', '/teamclaude/resets', { host: 'attacker.example' }), 403);
    assert.deepEqual(calls.redeem, []);
    assert.deepEqual(calls.cached, []);
    assert.equal(await send(port, 'POST', '/teamclaude/resets/redeem', local), 200);
    assert.deepEqual(calls.redeem, [['alice@example.com', 'g-weekly']]);
  }, keyless);
});

test('redeem refuses during the hold unless the body says force', async () => {
  const { actions, calls } = stubActions();
  await withServer({ resetActions: actions }, async (port) => {
    await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' });
    await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly', force: 'yes' });
    await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly', force: true });
    assert.deepEqual(calls.opts, [{ refuseWhileHeld: true }, { refuseWhileHeld: true }, { refuseWhileHeld: false }]);
  });
});

// The hook the server is given is reset-actions.js itself (index.js): one
// pass through the real module, with the network stubbed at the redeemer,
// pins the shape the routes rely on.
test('the routes drive the real reset actions end to end', async () => {
  const at = Date.now();
  const iso = time => new Date(time).toISOString();
  const raw = { eligible: true, at_limit: true, exhausted: ['seven_day'], next_grant_id: 'g-weekly', grants: [
    { id: 'g-weekly', label: 'Weekly reset', resets_total: 1, resets_left: 1, usable_now: true, paused: false,
      clears: ['five_hour', 'seven_day'], ends_at: iso(at + 24 * 3600_000) }] };
  const claims = [];
  const am = new AccountManager(ACCTS.map(a => ({ ...a })), 0.98);
  const claudeRedeemer = new ClaudeResetRedeemer(am, { config: {}, log: () => {},
    statusFn: async () => ({ reset: parseResetStatus(raw), usage: { sevenDay: { utilization: 1 } } }),
    claimFn: async (account, attempt) => { claims.push([account.name, attempt.grantId]); return { result: 'reset', resetsLeft: 0, cleared: ['five_hour', 'seven_day'] }; },
  });
  const codexRedeemer = new ResetCreditRedeemer(am, { config: {}, log: () => {} });
  const resetActions = createResetActions({ accountManager: am, claudeRedeemer, codexRedeemer });
  const proxy = createProxyServer(am, CONFIG, { resetActions });
  const port = await listen(proxy);
  const orig = console.log;
  console.log = () => {};
  try {
    const before = await (await get(port)).json();
    assert.equal(before.accounts[0].details, null, 'nothing has been read yet');
    const read = await (await post(port, '/teamclaude/resets/read', { account: 'alice@example.com' })).json();
    assert.equal(read.read, true);
    assert.deepEqual(read.details.grants.map(g => [g.id, g.kind, g.blocked]), [['g-weekly', 'weekly', null]]);
    const listed = await (await get(port)).json();
    assert.equal(listed.accounts[0].details.grants[0].id, 'g-weekly', 'the read is cached for the list');
    assert.ok(listed.accounts[0].readableAt > at, 'and starts the read floor');
    const spent = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' });
    assert.equal(spent.status, 200);
    assert.equal((await spent.json()).redeemed, true);
    assert.deepEqual(claims, [['alice@example.com', 'g-weekly']]);
    // The same POST again, as a caller that lost the answer would send it:
    // the hold the claim armed refuses it, and nothing more is claimed.
    const again = await post(port, '/teamclaude/resets/redeem', { account: 'alice@example.com', grantId: 'g-weekly' });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /"force": true/);
    assert.deepEqual(claims, [['alice@example.com', 'g-weekly']]);
  } finally {
    console.log = orig;
    proxy.close();
  }
});
