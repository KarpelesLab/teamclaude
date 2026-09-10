import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameIdentity, distinctAccounts, findUpsertTarget } from '../src/identity.js';
import { AccountManager } from '../src/account-manager.js';

// One email can hold a Claude subscription and a ChatGPT one. Both accounts are
// then named after that email, and the Codex account carries no Anthropic
// `accountUuid` — so identity fell through to the display name and called them
// one account.
const claude = { name: 'me@example.com', type: 'oauth', accountUuid: 'uuid-1', orgUuid: 'org-1', orgName: 'Acme' };
const codex = { name: 'me@example.com', type: 'oauth', provider: 'codex', accountId: 'chatgpt-1' };

test('a Claude and a Codex account sharing one email are not the same account', () => {
  assert.equal(sameIdentity(claude, codex), false);
  assert.equal(sameIdentity(codex, claude), false);
  assert.equal(distinctAccounts(claude, codex), true);
});

test('two Codex accounts are told apart by their ChatGPT account id', () => {
  const other = { name: 'me@example.com', type: 'oauth', provider: 'codex', accountId: 'chatgpt-2' };
  assert.equal(sameIdentity(codex, { ...codex }), true);
  assert.equal(sameIdentity(codex, other), false);
  assert.equal(distinctAccounts(codex, other), true);
});

test('a Codex login does not upsert onto the Claude entry with the same name', () => {
  const accounts = [claude];
  assert.equal(findUpsertTarget(accounts, codex), -1);
  assert.equal(findUpsertTarget([...accounts, codex], { ...codex }), 1);
});

// Regression: restoreQuotaState matched a saved entry to an account by name
// when either side had no uuid, so the Claude account's persisted buckets —
// `scopedWeekly` among them — were restored onto the Codex account with the
// same name. A Codex row then reported an Anthropic model bucket it cannot
// have, and rotation gated the Codex account on a Claude family limit.
test('a Codex account does not inherit the persisted quota of its Claude namesake', () => {
  const am = new AccountManager([
    { ...claude, accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { ...codex, accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.98);

  am.restoreQuotaState([{
    accountUuid: 'uuid-1', orgUuid: 'org-1', orgName: 'Acme', name: 'me@example.com',
    quota: {
      unified7d: 0.69,
      unified7dFable: 1,
      scopedWeekly: { fable: { utilization: 1, resetAt: Date.now() + 86_400_000 } },
    },
  }]);

  assert.equal(am.accounts[0].quota.unified7d, 0.69);
  assert.equal(am.accounts[1].quota.unified7d, null);
  assert.equal(am.accounts[1].quota.unified7dFable, null);
  assert.deepEqual(am.accounts[1].quota.scopedWeekly, {});
});

test('a Codex account restores its own saved quota', () => {
  const am = new AccountManager([
    { ...codex, accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.98);

  am.restoreQuotaState(am.exportQuotaState().map(row => ({
    ...row, quota: { ...row.quota, unified7d: 0.35 },
  })));

  assert.equal(am.accounts[0].quota.unified7d, 0.35);
});
