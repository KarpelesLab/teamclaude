import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// One switchThreshold governed every bucket, which conflates two different
// risks: 98% of a 5-hour window that refills in two hours is a nuisance, 98% of
// a weekly window with six days left means the account is done for the week.
// switchThreshold now also accepts a per-bucket table. A bare number must behave
// exactly as it always has.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

test('a bare number governs every bucket, as before', () => {
  const am = new AccountManager([oauth('a')], 0.9);
  for (const b of ['unified5h', 'unified7d', 'unified7dFable', 'tokens', 'requests', 'default']) {
    assert.equal(am.thresholdFor(b), 0.9, b);
  }
});

test('a table gives each bucket its own threshold, with default as the fallback', () => {
  const am = new AccountManager([oauth('a')], { default: 0.98, unified7d: 0.9 });
  assert.equal(am.thresholdFor('unified7d'), 0.9);
  assert.equal(am.thresholdFor('unified5h'), 0.98, 'unlisted buckets take default');
  assert.equal(am.thresholdFor('unified7dFable'), 0.98);
});

test('a table with no default still falls back to the historical value', () => {
  const am = new AccountManager([oauth('a')], { unified7d: 0.5 });
  assert.equal(am.thresholdFor('unified7d'), 0.5);
  assert.equal(am.thresholdFor('unified5h'), 0.98);
});

test('a malformed table degrades to the default rather than gating on NaN', () => {
  const am = new AccountManager([oauth('a')], { default: 'soon', unified7d: null });
  assert.equal(am.thresholdFor('unified7d'), 0.98);
  assert.equal(am.thresholdFor('unified5h'), 0.98);
});

test('the weekly bucket can rotate earlier than the 5-hour one', () => {
  const am = new AccountManager([oauth('a')], { default: 0.98, unified7d: 0.9 });
  const q = am.accounts[0].quota;
  q.unified5h = 0.95;                       // under both thresholds
  q.unified7d = 0.92;                       // over the weekly one only
  q.unified7dReset = Date.now() + 3 * 24 * 3600_000;

  assert.equal(am._isAvailable(am.accounts[0], OPUS), false, 'weekly threshold rotates it off');

  const relaxed = new AccountManager([oauth('a')], 0.98);
  Object.assign(relaxed.accounts[0].quota, q);
  assert.equal(relaxed._isAvailable(relaxed.accounts[0], OPUS), true, 'the single-number default keeps serving');
});

test('a family bucket takes its own entry', () => {
  const am = new AccountManager([oauth('a')], { default: 0.98, unified7dFable: 0.8 });
  const q = am.accounts[0].quota;
  q.unified5h = 0.1;
  q.unified7d = 0.2;
  q.unified7dFable = 0.85;
  q.unified7dFableReset = Date.now() + 3 * 24 * 3600_000;

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'Fable is over its own 80%');
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true, 'Opus is unaffected');
});

test('getStatus reports a representative number and the table when there is one', () => {
  const plain = new AccountManager([oauth('a')], 0.95).getStatus();
  assert.equal(plain.switchThreshold, 0.95);
  assert.equal(plain.switchThresholds, null);

  const table = new AccountManager([oauth('a')], { default: 0.98, unified7d: 0.9 }).getStatus();
  assert.equal(table.switchThreshold, 0.98, 'the header still has one number to show');
  assert.deepEqual(table.switchThresholds, { default: 0.98, unified7d: 0.9 });
});
