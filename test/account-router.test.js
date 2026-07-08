import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRouter } from '../src/account-router.js';
import { AccountManager } from '../src/account-manager.js';

function acct(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('single-provider router wraps exactly one manager (pass-through)', () => {
  const r = new AccountRouter([acct('a'), acct('b')], 0.9);
  assert.equal(r.managers.length, 1);
  assert.equal(r.accounts.length, 2);
  assert.ok(r.defaultManager instanceof AccountManager);
  // managerFor always resolves to the one pool, whatever the host.
  assert.equal(r.managerFor('api.anthropic.com'), r.defaultManager);
  assert.equal(r.managerFor('chatgpt.com'), r.defaultManager);
  assert.equal(r.managerFor(undefined), r.defaultManager);
  // getStatus is exactly the single manager's status.
  assert.deepEqual(r.getStatus(), r.defaultManager.getStatus());
});

test('empty account list still yields a default pool', () => {
  const r = new AccountRouter([], 0.9);
  assert.equal(r.managers.length, 1);
  assert.equal(r.accounts.length, 0);
});

test('accounts are partitioned into one manager per provider group', () => {
  const r = new AccountRouter([
    acct('claude1', { provider: 'anthropic' }),
    acct('codex1', { provider: 'openai' }),
    acct('claude2'), // no provider → default (anthropic)
  ], 0.9);
  assert.equal(r.managers.length, 2, 'two provider groups → two managers');
  assert.equal(r.accounts.length, 3, 'flattened view spans both pools');
  const names = r.accounts.map((a) => a.name).sort();
  assert.deepEqual(names, ['claude1', 'claude2', 'codex1']);
});

test('managerOf finds the pool that owns an account', () => {
  const r = new AccountRouter([
    acct('claude1', { provider: 'anthropic' }),
    acct('codex1', { provider: 'openai' }),
  ], 0.9);
  const [claudeMgr, codexMgr] = r.managers;
  assert.equal(r.managerOf(claudeMgr.accounts[0]), claudeMgr);
  assert.equal(r.managerOf(codexMgr.accounts[0]), codexMgr);
});

test('addAccount routes to the matching provider pool', () => {
  const r = new AccountRouter([acct('claude1')], 0.9);
  assert.equal(r.managers.length, 1);
  r.addAccount(acct('codex1', { provider: 'openai' }));
  assert.equal(r.managers.length, 2, 'a new provider spins up its own pool');
  assert.equal(r.accounts.length, 2);
  r.addAccount(acct('claude2'));
  assert.equal(r.managers.length, 2, 'existing provider reuses its pool');
  assert.equal(r.accounts.length, 3);
});

test('exportQuotaState / restoreQuotaState round-trip across pools', () => {
  const r = new AccountRouter([
    acct('claude1', { provider: 'anthropic', accountUuid: 'uuid-a' }),
    acct('codex1', { provider: 'openai', accountUuid: 'uuid-c' }),
  ], 0.9);
  // Seed a learned weekly window on each pool's account.
  r.managers[0].accounts[0].quota.unified7d = 0.5;
  r.managers[0].accounts[0].quota.unified7dReset = Date.now() + 86400_000;
  r.managers[1].accounts[0].quota.unified7d = 0.25;
  r.managers[1].accounts[0].quota.unified7dReset = Date.now() + 86400_000;

  const saved = r.exportQuotaState();
  assert.equal(saved.length, 2, 'export spans every pool');

  const r2 = new AccountRouter([
    acct('claude1', { provider: 'anthropic', accountUuid: 'uuid-a' }),
    acct('codex1', { provider: 'openai', accountUuid: 'uuid-c' }),
  ], 0.9);
  r2.restoreQuotaState(saved);
  assert.equal(r2.managers[0].accounts[0].quota.unified7d, 0.5);
  assert.equal(r2.managers[1].accounts[0].quota.unified7d, 0.25);
});

test('onTokenRefresh registers the callback on every pool', () => {
  const r = new AccountRouter([
    acct('claude1', { provider: 'anthropic' }),
    acct('codex1', { provider: 'openai' }),
  ], 0.9);
  const cb = () => {};
  r.onTokenRefresh(cb);
  // Each manager stores the callback it was given (via its own onTokenRefresh).
  for (const m of r.managers) assert.equal(m._onTokenRefresh, cb);
  // And selectActiveAccount fans out without throwing.
  r.selectActiveAccount();
});
