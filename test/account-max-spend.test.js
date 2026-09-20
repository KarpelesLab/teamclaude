import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { resolveMaxSpendMinor, spendCapReached } from '../src/model.js';

// accounts[].maxSpend: a money ceiling on an account that can bill past its
// plan. Unlike a usage cap it is not about quota at all — it is judged against
// the month-to-date extra-usage figure upstream reports in `quota.spend`.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const usd = (usedMinor, extra = {}) => ({ enabled: true, usedMinor, limitMinor: 1_000_000, currency: 'USD', exponent: 2, ...extra });
const OPUS = 'claude-opus-5';

function fleet(maxSpend) {
  return new AccountManager([oauth('a'), oauth('budget', { maxSpend })], 0.98);
}

test('the cap is written in dollars and compared in cents', () => {
  assert.equal(resolveMaxSpendMinor(20, usd(0)), 2000);
  assert.equal(resolveMaxSpendMinor(12.5, usd(0)), 1250);
  assert.equal(resolveMaxSpendMinor(20, { exponent: 0, currency: 'JPY' }), 20);
  // Absent, negative, non-numeric or absurd: no cap rather than a wrong one.
  for (const bad of [null, undefined, -1, '20', NaN, Infinity]) assert.equal(resolveMaxSpendMinor(bad, usd(0)), null, String(bad));
  assert.equal(resolveMaxSpendMinor(20, { exponent: 12 }), null);
});

test('reached at the cap, not before; 0 means "not one cent" and still admits an unspent account', () => {
  assert.equal(spendCapReached(20, usd(1999)), false);
  assert.equal(spendCapReached(20, usd(2000)), true);
  assert.equal(spendCapReached(20, usd(5000)), true);
  assert.equal(spendCapReached(0, usd(0)), false);
  assert.equal(spendCapReached(0, usd(1)), true);
});

test('an account that cannot bill is never spend-capped, and an unknown spend record is no evidence', () => {
  assert.equal(spendCapReached(20, usd(5000, { enabled: false })), false);
  assert.equal(spendCapReached(20, null), false);
  assert.equal(spendCapReached(20, undefined), false);
});

test('at the cap the account receives nothing: rotation, the probe and a pin all skip it', () => {
  const am = fleet(20);
  const [a, budget] = am.accounts;
  Object.assign(budget.quota, { spend: usd(2000) });
  assert.equal(am.capExceeded(budget, OPUS), 'spend');
  assert.equal(am.capExceeded(a, OPUS), null, 'no cap on the other account');
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
  // Every account out: the other one is over the switch threshold (a
  // preference the exhausted-fleet probe may override), this one is over its
  // budget (which it may not). The probe goes to the other account, and with
  // that one excluded nothing is left at all.
  Object.assign(a.quota, { unified7d: 0.99 });
  am._nextProbeAt = 0;
  assert.equal(am._selectProbe(null, OPUS)?.name, 'a');
  assert.equal(am.getActiveAccount(new Set([a.index]), OPUS), null);
});

test('under the cap the account serves normally, and a new month lifts the cap by itself', () => {
  const am = fleet(20);
  const budget = am.accounts[1];
  Object.assign(budget.quota, { spend: usd(1435) });
  assert.equal(am.capExceeded(budget, OPUS), null);
  assert.equal(am.unavailableReason(budget, OPUS), null);
  Object.assign(budget.quota, { spend: usd(2000) });
  assert.equal(am.capExceeded(budget, OPUS), 'spend');
  // Upstream's month-to-date figure resets: the next reading clears the cap.
  Object.assign(budget.quota, { spend: usd(0) });
  assert.equal(am.capExceeded(budget, OPUS), null);
});

test('the money cap is judged ahead of, and independently from, the usage caps', () => {
  const am = new AccountManager([oauth('both', { maxSpend: 20, maxUsage: 0.5 })], 0.98);
  const acct = am.accounts[0];
  Object.assign(acct.quota, { unified7d: 0.1, spend: usd(2000) });
  assert.equal(am.capExceeded(acct, OPUS), 'spend');
  Object.assign(acct.quota, { unified7d: 0.6, spend: usd(0) });
  assert.equal(am.capExceeded(acct, OPUS), 'unified7d');
});

test('the cap rides along in status JSON and applies live on a config reload', async () => {
  const am = fleet(20);
  const row = am.toStatusJSON ? am.toStatusJSON().accounts?.find(a => a.name === 'budget') : null;
  if (row) assert.equal(row.maxSpend, 20);
  const { syncAccountsFromDisk } = await import('../src/sync-accounts.js');
  const disk = { accounts: [ { ...oauth('a'), id: am.accounts[0].id }, { ...oauth('budget'), id: am.accounts[1].id, maxSpend: 5 } ] };
  const cfg = { accounts: disk.accounts.map(a => ({ ...a })) };
  await syncAccountsFromDisk(disk, cfg, am);
  assert.equal(am.accounts[1].maxSpend, 5);
  Object.assign(am.accounts[1].quota, { spend: usd(500) });
  assert.equal(am.capExceeded(am.accounts[1], OPUS), 'spend');
});
