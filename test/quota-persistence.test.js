import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { getStatePath } from '../src/config.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('exportQuotaState carries only persistable fields and identity, no credentials', () => {
  const am = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1', orgName: 'Acme' })], 0.98);
  am.accounts[0].quota.unified7d = 0.42;
  const [entry] = am.exportQuotaState();

  // `provider` and `accountId` are identity, not credentials: they are what
  // identifies an account that has no Anthropic uuid to be matched by.
  assert.deepEqual(
    Object.keys(entry).sort(),
    // `outsideSpend` is learned state like `adaptive` (#475): per-window sums,
    // never a token or an activity stamp.
    ['id', 'accountUuid', 'accountId', 'userId', 'provider', 'name', 'orgName', 'orgUuid', 'profile', 'quota', 'adaptive', 'outsideSpend'].sort(),
  );
  assert.equal(entry.accountUuid, 'p1');
  assert.equal(entry.provider, 'anthropic');
  assert.equal(entry.quota.unified7d, 0.42);
  // Transient/credential fields must not leak.
  assert.ok(!('probing' in entry.quota));
  assert.ok(!('rateLimitedUntil' in entry.quota));
  assert.ok(!('credential' in entry));
  assert.ok(!('accessToken' in entry));
});

test('adaptive burn and concurrency learning survive an identity-matched restart', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  const t0 = Date.now();
  am1.burnRateLearner.observeUtilization(0, 'unified7d', 0.10, t0);
  am1.burnRateLearner.observeUtilization(0, 'unified7d', 0.20, t0 + 5 * 60_000);
  am1.concurrencyLearner.caps.set(0, 3.5);
  const reserve = am1.burnRateLearner.reserve(0, 'unified7d');

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());

  assert.equal(am2.burnRateLearner.reserve(0, 'unified7d'), reserve);
  assert.equal(am2.concurrencyLearner.cap(0), 3.5);
});

test('quota survives an export → restore round-trip', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  const future = Date.now() + 3600_000;
  Object.assign(am1.accounts[0].quota, { unified5h: 0.3, unified7d: 0.6, unified7dReset: future, sessionWindowStated: true, weeklyWindowStated: false });

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());

  assert.equal(am2.accounts[0].quota.unified5h, 0.3);
  assert.equal(am2.accounts[0].quota.unified7d, 0.6);
  assert.equal(am2.accounts[0].quota.unified7dReset, future);
  assert.equal(am2.accounts[0].quota.sessionWindowStated, true);
  assert.equal(am2.accounts[0].quota.weeklyWindowStated, false);
  assert.equal(am2.accounts[0].probing, false); // weekly window known → not probing
});

test('quota tier metadata survives an export → restore round-trip', () => {
  const am1 = new AccountManager([oauth('a', {
    accountUuid: 'p1', organizationType: 'claude_team',
    rateLimitTier: 'default_raven', seatTier: 'team_standard',
  })], 0.98);
  const saved = am1.exportQuotaState();
  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);

  am2.restoreQuotaState(saved);

  assert.equal(am2.accounts[0].organizationType, 'claude_team');
  assert.equal(am2.accounts[0].rateLimitTier, 'default_raven');
  assert.equal(am2.accounts[0].seatTier, 'team_standard');
});

test('restore matches by identity, not array position', () => {
  const am1 = new AccountManager([
    oauth('a@x.com (Acme)', { accountUuid: 'p1', orgUuid: 'o1' }),
    oauth('a@x.com (Personal)', { accountUuid: 'p1', orgUuid: 'o2' }),
  ], 0.98);
  am1.accounts[0].quota.unified7d = 0.1; // Acme
  am1.accounts[1].quota.unified7d = 0.9; // Personal
  const saved = am1.exportQuotaState();

  // Reverse the order in the new manager — restore must still match by org.
  const am2 = new AccountManager([
    oauth('a@x.com (Personal)', { accountUuid: 'p1', orgUuid: 'o2' }),
    oauth('a@x.com (Acme)', { accountUuid: 'p1', orgUuid: 'o1' }),
  ], 0.98);
  am2.restoreQuotaState(saved);

  assert.equal(am2.accounts[0].quota.unified7d, 0.9); // Personal
  assert.equal(am2.accounts[1].quota.unified7d, 0.1); // Acme
});

const H = 3600_000;
const OPUS = 'claude-opus-5';
const roundTrip = value => JSON.parse(JSON.stringify(value));
const freeze = t => t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 21, 12) });
// Entries with config ids and no upstream ids, so only the id or the name can pair a row.
const entries = list => list.map(([id, name]) => oauth(name, { id }));
function serve(am, sessionId, exclude = null) {
  am.beginSession(sessionId);
  const account = am.getActiveAccount(exclude, OPUS, null, sessionId);
  if (account) am.recordSession(sessionId, account.index, OPUS);
  am.endSession(sessionId);
  return account;
}

test('two entries that swap names each restore the quota their own entry saved, and a pin stays', t => {
  freeze(t);
  const opts = { distributeSessions: true, expiryRouting: { enabled: true, preempt: true } };
  const resets = { a: Date.now() + 8 * H, b: Date.now() + 155 * H };
  const source = new AccountManager(entries([['a', 'alice'], ['b', 'bob']]), 0.98, opts);
  for (const account of source.accounts) {
    Object.assign(account.quota, { unified7d: 0.4, unified7dReset: resets[account.id] });
    account.probing = false;
  }
  assert.equal(serve(source, 'alpha', new Set([1])).id, 'a');
  const restored = new AccountManager(entries([['a', 'bob'], ['b', 'alice']]), 0.98, opts);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  restored.restoreAffinityState(roundTrip(source.exportAffinityState()));
  for (const account of restored.accounts) assert.equal(account.quota.unified7dReset, resets[account.id], account.id);
  const live = serve(source, 'alpha').id;
  assert.equal(live, 'a');
  assert.equal(serve(restored, 'alpha').id, live, 'the pin is read against its own entry reset');
});

test('a renamed entry restores its own row, and a new entry under its old name takes nothing', t => {
  freeze(t);
  const source = new AccountManager(entries([['a', 'alice'], ['b', 'bob']]), 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const restored = new AccountManager(entries([['a', 'alice'], ['b', 'carol'], ['c', 'bob']]), 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.1, 0.9, null]);
});

test('a removed entry\'s row does not pass to a new namesake', t => {
  freeze(t);
  const source = new AccountManager(entries([['a', 'alice'], ['b', 'bob']]), 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const restored = new AccountManager(entries([['a', 'alice'], ['c', 'bob']]), 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.1, null]);
});

test('an upstream account added back as a new entry starts with no readings', t => {
  freeze(t);
  const source = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p1' }), oauth('bob', { id: 'b', accountUuid: 'p2' })], 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const restored = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p1' }), oauth('robert', { id: 'c', accountUuid: 'p2' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.1, null]);
});

test('a Codex account added back as a new entry starts with no readings', t => {
  freeze(t);
  const source = new AccountManager([oauth('bob', { id: 'b', provider: 'codex', accountId: 'w1', userId: 'u1' })], 0.98);
  source.accounts[0].quota.unified7d = 0.9;
  const restored = new AccountManager([oauth('robert', { id: 'c', provider: 'codex', accountId: 'w1', userId: 'u1' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.equal(restored.accounts[0].quota.unified7d, null);
});

test('a new Codex entry takes no removed entry\'s row, by name or by workspace', t => {
  freeze(t);
  const source = new AccountManager([oauth('ann', { id: 'a', provider: 'codex' }), oauth('bob', { id: 'b', provider: 'codex', accountId: 'w1' })], 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 1;
  const restored = new AccountManager([oauth('ann', { id: 'c', provider: 'codex', accountId: 'w1', userId: 'u1' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.equal(restored.accounts[0].quota.unified7d, null);
});

test('a removed entry\'s row does not pass to a new namesake whose upstream id is not known yet', t => {
  freeze(t);
  const source = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p1' }), oauth('bob', { id: 'b', accountUuid: 'p2' })], 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const restored = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p1' }), oauth('bob', { id: 'c' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.1, null]);
});

test('a removed entry\'s row with no organization does not pass to a new entry in an organization', t => {
  freeze(t);
  const source = new AccountManager([oauth('bob', { id: 'w' }), oauth('bob', { id: 'p', accountUuid: 'p1' })], 0.98);
  source.accounts[0].quota.unified7d = 0.08;
  source.accounts[1].quota.unified7d = 1;
  const restored = new AccountManager([oauth('bob', { id: 'n', accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.equal(restored.accounts[0].quota.unified7d, null);
});

test('a live entry\'s row does not pass to a new entry of the same upstream account', t => {
  freeze(t);
  const source = new AccountManager([oauth('bob', { id: 'a', accountUuid: 'p1' })], 0.98);
  source.accounts[0].quota.unified7d = 0.9;
  const restored = new AccountManager([oauth('bob', { id: 'a', accountUuid: 'p1' }), oauth('bob2', { id: 'c', accountUuid: 'p1' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.9, null]);
});

test('a row saved without an entry id restores by identity', t => {
  freeze(t);
  const source = new AccountManager(entries([['a', 'alice'], ['b', 'bob']]), 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const legacy = roundTrip(source.exportQuotaState()).map(({ id: _id, ...row }) => row);
  const restored = new AccountManager(entries([['b', 'bob'], ['a', 'alice']]), 0.98);
  restored.restoreQuotaState(legacy);
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [0.9, 0.1]);
});

test('a row whose entry id now names another upstream account is dropped alone', t => {
  freeze(t);
  const source = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p1' }), oauth('bob', { id: 'b', accountUuid: 'p2' })], 0.98);
  source.accounts[0].quota.unified7d = 0.1;
  source.accounts[1].quota.unified7d = 0.9;
  const restored = new AccountManager([oauth('alice', { id: 'a', accountUuid: 'p3' }), oauth('bob', { id: 'b', accountUuid: 'p2' })], 0.98);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  assert.deepEqual(restored.accounts.map(a => a.quota.unified7d), [null, 0.9]);
});

test('a restored window whose reset already passed is cleared on first use', () => {
  const am = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am.restoreQuotaState([
    { accountUuid: 'p1', quota: { unified7d: 0.5, unified7dReset: 1000 } }, // reset far in the past
  ]);
  assert.equal(am.accounts[0].quota.unified7d, 0.5); // restored...
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].quota.unified7d, null); // ...then cleared as stale
});

test('a limit of 0 in a state file is not restored, nor its remaining; a positive pair is', () => {
  // Written by a version that stored any limit upstream sent: restored as-is, it
  // handed 1 - 0/0 = NaN back to every standard-quota reader.
  const am = new AccountManager([oauth('a', { accountUuid: 'p1' }), oauth('b', { accountUuid: 'p2' }), oauth('c', { accountUuid: 'p3' })], 0.98);
  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  am.restoreQuotaState([
    { accountUuid: 'p1', quota: { tokensLimit: 0, tokensRemaining: 0, requestsLimit: 0, requestsRemaining: 0, resetsAt } },
    { accountUuid: 'p2', quota: { tokensLimit: 1000, tokensRemaining: 100, requestsLimit: 50, requestsRemaining: 5, resetsAt } },
    { accountUuid: 'p3', quota: { tokensRemaining: 7, requestsRemaining: 3, resetsAt } },
  ]);
  const [a, b, c] = am.accounts;
  assert.equal(am._maxUtilization(a), 0);
  assert.equal(a.quota.tokensLimit, null);
  assert.equal(a.quota.requestsLimit, null);
  assert.equal(a.quota.tokensRemaining, null, 'a refused pair is dropped whole');
  assert.equal(a.quota.requestsRemaining, null, 'a refused pair is dropped whole');
  assert.equal(a.quota.resetsAt, resetsAt, 'the rest of the entry is restored as before');
  assert.equal(b.quota.tokensLimit, 1000);
  assert.equal(b.quota.requestsLimit, 50);
  assert.equal(b.quota.tokensRemaining, 100);
  assert.equal(b.quota.requestsRemaining, 5);
  assert.equal(am._maxUtilization(b), 0.9);
  assert.equal(c.quota.tokensRemaining, 7, 'a remaining saved without a limit is restored as before');
  assert.equal(c.quota.requestsRemaining, 3, 'a remaining saved without a limit is restored as before');
});

test('restoreQuotaState ignores a non-array / missing payload', () => {
  const am = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am.restoreQuotaState(undefined);
  am.restoreQuotaState(null);
  assert.equal(am.accounts[0].quota.unified7d, null); // unchanged, no throw
});

test('getStatePath sits beside the config as a .state.json sibling', () => {
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = '/tmp/teamclaude-xyz.json';
  try {
    assert.equal(getStatePath(), '/tmp/teamclaude-xyz.state.json');
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
});
