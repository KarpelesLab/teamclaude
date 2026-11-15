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
    ['accountUuid', 'accountId', 'userId', 'provider', 'name', 'orgName', 'orgUuid', 'profile', 'quota', 'adaptive', 'outsideSpend'].sort(),
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
