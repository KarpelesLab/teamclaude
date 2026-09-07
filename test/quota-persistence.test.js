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

  assert.deepEqual(Object.keys(entry).sort(), ['accountUuid', 'name', 'orgName', 'orgUuid', 'profile', 'quota'].sort());
  assert.equal(entry.accountUuid, 'p1');
  assert.equal(entry.quota.unified7d, 0.42);
  // Transient/credential fields must not leak.
  assert.ok(!('probing' in entry.quota));
  assert.ok(!('rateLimitedUntil' in entry.quota));
  assert.ok(!('credential' in entry));
  assert.ok(!('accessToken' in entry));
});

test('quota survives an export → restore round-trip', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  const future = Date.now() + 3600_000;
  Object.assign(am1.accounts[0].quota, { unified5h: 0.3, unified7d: 0.6, unified7dReset: future });

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());

  assert.equal(am2.accounts[0].quota.unified5h, 0.3);
  assert.equal(am2.accounts[0].quota.unified7d, 0.6);
  assert.equal(am2.accounts[0].quota.unified7dReset, future);
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
