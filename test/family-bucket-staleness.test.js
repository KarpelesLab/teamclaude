import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';
const FABLE = 'claude-fable-5-1';

// A short staleness floor keeps the tests instant.
const STALE_MS = 1000;
function manager(names = ['a'], opts = {}) {
  return new AccountManager(names.map(n => oauth(n)), 0.98, { familyStaleMs: STALE_MS, ...opts });
}

// Drive an account into the state the bug produces: a spent family reading whose
// own reset window is still days out, so the reset-based expiry never fires.
function spendFable(account, { utilization = 0.98, seenAt = Date.now() } = {}) {
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 0.2;
  account.quota.unified7dFable = utilization;
  account.quota.unified7dFableReset = Date.now() + 7 * 24 * 3600_000;
  account.quota.unified7dFableSeenAt = seenAt;
}

test('a fresh spent Fable reading still bars Fable', () => {
  const am = manager();
  spendFable(am.accounts[0]);

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true, 'other families are unaffected');
});

test('a spent Fable reading past the staleness floor is cleared and Fable routes again', () => {
  const am = manager();
  spendFable(am.accounts[0], { seenAt: Date.now() - STALE_MS - 1 });

  assert.equal(am._isAvailable(am.accounts[0], FABLE), true, 'the stale reading no longer bars Fable');
  const q = am.accounts[0].quota;
  assert.equal(q.unified7dFable, null, 'the reading is dropped, not merely ignored');
  assert.equal(q.unified7dFableReset, null);
  assert.equal(q.unified7dFableSeenAt, null);
});

test('revalidation falls back to the shared weekly bucket, which still gates', () => {
  const am = manager();
  spendFable(am.accounts[0], { seenAt: Date.now() - STALE_MS - 1 });
  am.accounts[0].quota.unified7d = 0.99;          // shared weekly is genuinely spent
  am.accounts[0].quota.unified7dReset = Date.now() + 3600_000;

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'clearing the family bucket must not unblock a spent account');
});

test('a spent reading with no timestamp starts the clock instead of being discarded', () => {
  const am = manager();
  spendFable(am.accounts[0], { seenAt: null });    // e.g. restored from a pre-upgrade state file

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'still trusted for one window');
  const seenAt = am.accounts[0].quota.unified7dFableSeenAt;
  assert.ok(seenAt, 'the clock is started on first use');

  am.accounts[0].quota.unified7dFableSeenAt = seenAt - STALE_MS - 1;
  assert.equal(am._isAvailable(am.accounts[0], FABLE), true, 'and it expires a window later');
});

test('a family reading with headroom is left alone however old it is', () => {
  const am = manager();
  spendFable(am.accounts[0], { utilization: 0.5, seenAt: Date.now() - 30 * STALE_MS });

  assert.equal(am._isAvailable(am.accounts[0], FABLE), true);
  assert.equal(am.accounts[0].quota.unified7dFable, 0.5, 'a reading that gates nothing is kept for display');
});

test('a Fable response re-arms the gate with a fresh reading and timestamp', () => {
  const am = manager();
  spendFable(am.accounts[0], { seenAt: Date.now() - STALE_MS - 1 });
  assert.equal(am._isAvailable(am.accounts[0], FABLE), true, 'stale reading cleared');

  // The revalidating request comes back 429 with the real (still spent) numbers.
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 7 * 24 * 3600_000) / 1000)),
  });

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'the fresh reading gates again');
  assert.ok(am.accounts[0].quota.unified7dFableSeenAt, 'and is trusted for a full window');
});

test('the zero-spend usage probe also refreshes the reading', () => {
  const am = manager();
  spendFable(am.accounts[0]);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);

  am.applyUsageData(0, { sevenDayFable: { utilization: 0, resetAt: null } });

  assert.equal(am._isAvailable(am.accounts[0], FABLE), true, 'a probe corrects the reading without waiting for staleness');
  assert.equal(am.accounts[0].quota.unified7dFable, 0);
});

test('the same staleness escape covers the Sonnet bucket', () => {
  const am = manager();
  const q = am.accounts[0].quota;
  q.unified7d = 0.2;
  q.unified7dSonnet = 0.99;
  q.unified7dSonnetReset = Date.now() + 7 * 24 * 3600_000;
  q.unified7dSonnetSeenAt = Date.now() - STALE_MS - 1;

  assert.equal(am._isAvailable(am.accounts[0], SONNET), true);
  assert.equal(q.unified7dSonnet, null);
});

test('a stale reading is cleared per family, not fleet-wide', () => {
  const am = manager(['a', 'b']);
  spendFable(am.accounts[0], { seenAt: Date.now() - STALE_MS - 1 });
  spendFable(am.accounts[1]);                      // fresh reading on the sibling

  am.refreshExpiredQuotas();

  assert.equal(am.accounts[0].quota.unified7dFable, null, 'stale reading dropped');
  assert.equal(am.accounts[1].quota.unified7dFable, 0.98, 'fresh reading kept');
});

test('the observation stamp survives a restart', () => {
  const am = manager();
  spendFable(am.accounts[0]);
  const seenAt = am.accounts[0].quota.unified7dFableSeenAt;

  const restored = manager();
  restored.restoreQuotaState(am.exportQuotaState());

  assert.equal(restored.accounts[0].quota.unified7dFableSeenAt, seenAt);
});
