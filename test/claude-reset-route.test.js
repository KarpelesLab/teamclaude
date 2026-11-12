import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveUniqueAccountPin } from '../src/server.js';
import { ClaudeResetRedeemer, fetchClaudeResetStatus, claimClaudeReset } from '../src/claude-resets.js';
import { updateState } from '../src/config.js';

const PROXY_KEY = 'tc-operator';
const CLIENT_KEY = 'tc-client';
const accounts = [
  { id: 'a', name: 'same@example.com', type: 'oauth', accessToken: 'token-a', accountUuid: 'account-a', orgUuid: 'org-a' },
  { id: 'b', name: 'other@example.com', type: 'oauth', accessToken: 'token-b', accountUuid: 'account-b', orgUuid: 'org-b' },
];

async function withServer(result, fn, configAccounts = accounts) {
  const am = new AccountManager(configAccounts, 0.98);
  am.ensureTokenFresh = async () => {};
  const calls = [];
  const proxy = createProxyServer(am, {
    proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'tenant', key: CLIENT_KEY }] },
    upstream: 'http://127.0.0.1:9',
  }, {
    redeemClaudeReset: async index => {
      calls.push(index);
      return typeof result === 'function' ? result(am.accounts[index]) : result;
    },
  });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/teamclaude/claude-reset`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  try { await fn({ am, calls, post, port }); } finally { proxy.close(); }
}

test('the operator route returns only whitelisted redemption fields and calls once', async () => {
  await withServer(account => ({
    outcome: 'redeemed', account: account.name, result: 'reset', resetsLeft: 0,
    cleared: ['seven_day'], grantId: 'secret-grant', requestId: 'secret-request', credential: 'secret-token',
  }), async ({ calls, post }) => {
    const res = await post({ account: 'other@example.com' }, { 'x-api-key': PROXY_KEY });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: true, account: 'other@example.com', outcome: 'redeemed', reason: 'reset failed',
      result: 'reset', resetsLeft: 0, cleared: ['seven_day'],
    });
    assert.deepEqual(calls, [1]);
    assert.doesNotMatch(JSON.stringify(body), /secret-grant|secret-request|secret-token/);
  });
});

test('a known redeemed outcome can carry pending: true without exposing claim ids', async () => {
  await withServer(account => ({
    outcome: 'redeemed', account: account.name, result: 'already_used', resetsLeft: 0,
    cleared: ['seven_day'], pending: true, grantId: 'secret-grant', requestId: 'secret-request',
  }), async ({ post }) => {
    const res = await post({ account: 'other@example.com' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, 'redeemed');
    assert.equal(body.result, 'already_used');
    assert.equal(body.pending, true);
    assert.doesNotMatch(JSON.stringify(body), /secret-grant|secret-request/);
  });
});

test('decline, pre-claim failure and unknown retain distinct HTTP outcomes', async () => {
  for (const [result, status, expected] of [
    [{ outcome: 'declined', reason: 'no_usable_grant', result: 'not_limited' }, 409, { ok: false, account: '', outcome: 'declined', reason: 'no_usable_grant', result: 'not_limited' }],
    [{ outcome: 'pre_claim_failed', reason: 'status unavailable' }, 502, { ok: false, account: '', outcome: 'pre_claim_failed', reason: 'status unavailable' }],
    [{ outcome: 'unknown', reason: 'timeout', mayHaveRedeemed: true }, 502, { ok: false, account: '', outcome: 'unknown', reason: 'timeout', mayHaveRedeemed: true }],
    [{ outcome: 'redeemed', result: 'mystery' }, 502, { ok: false, account: '', outcome: 'unknown', reason: 'unrecognized redemption verdict', mayHaveRedeemed: true }],
  ]) {
    await withServer(result, async ({ post }) => {
      const res = await post({ account: 'other@example.com' });
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), expected);
    });
  }
});

test('an unexpected hook exception is unknown, never a false pre-claim guarantee', async () => {
  await withServer(() => { throw new Error('post-claim quota application failed'); }, async ({ post }) => {
    const res = await post({ account: 'other@example.com' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, outcome: 'unknown', reason: 'reset operation failed', mayHaveRedeemed: true });
  });
});

test('client keys and cross-origin browser posts are refused before redemption', async () => {
  await withServer({ outcome: 'redeemed' }, async ({ calls, post }) => {
    const client = await post({ account: 'other@example.com' }, { 'x-api-key': CLIENT_KEY });
    assert.equal(client.status, 403);
    const cross = await post({ account: 'other@example.com' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(cross.status, 403);
    assert.deepEqual(calls, []);
  });
});

test('an ambiguous account alias is a conflict and never picks the first match', async () => {
  const duplicate = [accounts[0], { ...accounts[1], name: 'same@example.com (Org two)' }];
  await withServer({ outcome: 'redeemed' }, async ({ am, calls, post }) => {
    assert.deepEqual(resolveUniqueAccountPin(am, 'same@example.com'), { index: null, error: 'ambiguous' });
    assert.deepEqual(resolveUniqueAccountPin(am, 'account-b/org-b'), { index: 1, error: null });
    const res = await post({ account: 'same@example.com' });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, outcome: 'declined', reason: 'ambiguous_account' });
    assert.deepEqual(calls, []);
  }, duplicate);
});

test('an unknown account or missing body is a safe refusal', async () => {
  await withServer({ outcome: 'redeemed' }, async ({ calls, post }) => {
    const missing = await post({ account: 'nobody@example.com' });
    assert.equal(missing.status, 404);
    const malformed = await post({});
    assert.equal(malformed.status, 400);
    const callerIds = await post({ account: 'other@example.com', grantId: 'caller-grant', requestId: 'caller-request' });
    assert.equal(callerIds.status, 400);
    assert.deepEqual(await callerIds.json(), { ok: false, error: 'only "account" is accepted' });
    assert.deepEqual(calls, []);
  });
});

test('a keyless caller admitted only by a non-loopback open proxy cannot redeem', async () => {
  const am = new AccountManager(accounts, 0.98);
  let calls = 0;
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:9' }, {
    redeemClaudeReset: async () => { calls++; return { outcome: 'redeemed' }; },
  });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/claude-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ account: 'other@example.com' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, outcome: 'declined', reason: 'keyless_remote_refused' });
    assert.equal(calls, 0);
  } finally { proxy.close(); }
});

test('loopback restart replays identical ids through the real state writer without leaking them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-reset-route-'));
  const statePath = join(dir, 'config.state.json');
  const previousConfig = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'config.json');
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previousConfig;
    await rm(dir, { recursive: true, force: true });
  });
  let clock = Date.now();
  const claims = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const uri = String(url);
    calls.push(uri);
    if (uri.includes('/api/oauth/usage')) {
      return { ok: true, status: 200, json: async () => ({
        cedar_ember: {
          eligible: true, next_grant_id: 'grant-1', grants: [{
            id: 'grant-1', resets_left: 1, usable_now: true, paused: false,
            ends_at: new Date(Date.now() + 60_000).toISOString(), clears: ['seven_day'],
          }],
        },
      }) };
    }
    if (uri.includes('/api/organizations/org-b/reset_rate_limits')) {
      claims.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => claims.length === 1
        ? { result: 'mystery', resets_left: 1 }
        : { result: 'already_used', resets_left: 0, cleared: ['seven_day'] } };
    }
    throw new Error(`unexpected Anthropic URL: ${uri}`);
  };
  const statusFn = (account, opts) => fetchClaudeResetStatus(account, { ...opts, fetchImpl });
  const claimFn = (account, claim, opts) => claimClaudeReset(account, claim, { ...opts, fetchImpl });
  const start = async pending => {
    const am = new AccountManager(accounts, 0.98);
    am.ensureTokenFresh = async () => {};
    const redeemer = new ClaudeResetRedeemer(am, { statusFn, claimFn, updateStateFn: updateState, pending, now: () => clock, log: () => {} });
    const proxy = createProxyServer(am, { proxy: { apiKey: PROXY_KEY }, upstream: 'http://127.0.0.1:9' }, {
      redeemClaudeReset: index => redeemer.redeemAccount(am.accounts[index]),
    });
    const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
    return { proxy, port };
  };
  const post = port => fetch(`http://127.0.0.1:${port}/teamclaude/claude-reset`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': PROXY_KEY }, body: JSON.stringify({ account: 'other@example.com' }),
  });

  const first = await start(null);
  assert.equal(claims.length, 0, 'no operator confirmation, no claim');
  const unknown = await post(first.port);
  assert.equal(unknown.status, 502);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.outcome, 'unknown');
  assert.equal(unknownBody.mayHaveRedeemed, true);
  assert.equal(claims.length, 1, 'no automatic retry after uncertainty');
  assert.deepEqual(calls.map(url => url.includes('/api/oauth/usage') ? 'status' : 'claim'), ['status', 'claim']);
  first.proxy.close();

  const persisted = JSON.parse(await readFile(statePath, 'utf-8'));
  assert.equal(Object.keys(persisted.claudeResetPending).length, 1);
  clock += 31 * 60 * 1000;
  const second = await start(persisted.claudeResetPending);
  const confirmed = await post(second.port);
  assert.equal(confirmed.status, 200);
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.result, 'already_used');
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0], claims[1]);
  assert.deepEqual(calls.map(url => url.includes('/api/oauth/usage') ? 'status' : 'claim'), ['status', 'claim', 'claim', 'status'], 'replay has no fresh grant-status read');
  assert.doesNotMatch(JSON.stringify([unknownBody, confirmedBody]), /grant-1|requestId|token-a|token-b/);
  second.proxy.close();
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')).claudeResetPending, {});
});
