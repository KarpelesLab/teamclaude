import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('a disabled account is skipped by selection', () => {
  const am = new AccountManager([oauth('a', { disabled: true }), oauth('b')], 0.98);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am._selectNext().name, 'b');
});

test('disabling the active account rotates away from it', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.currentIndex = 0;
  am.setDisabled(0, true);
  assert.equal(am.getActiveAccount().name, 'b');
});

test('re-enabling brings the account back into rotation', () => {
  const am = new AccountManager([oauth('a', { disabled: true }), oauth('b')], 0.98);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  am.setDisabled(0, false);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('enabling an errored account clears the error so it is retried', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].status = 'error';
  am.accounts[0].disabled = true;
  am.setDisabled(0, false);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('disabling does NOT clobber an error state (only enabling resets it)', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].status = 'error';
  am.setDisabled(0, true);
  assert.equal(am.accounts[0].status, 'error'); // unchanged
  assert.equal(am.accounts[0].disabled, true);
});

test('all accounts disabled → no account available', () => {
  const am = new AccountManager([oauth('a', { disabled: true }), oauth('b', { disabled: true })], 0.98);
  assert.equal(am.getActiveAccount(), null);
});

test('getStatus exposes the disabled flag', () => {
  const am = new AccountManager([oauth('a', { disabled: true }), oauth('b')], 0.98);
  const s = am.getStatus();
  assert.equal(s.accounts[0].disabled, true);
  assert.equal(s.accounts[1].disabled, false);
});
