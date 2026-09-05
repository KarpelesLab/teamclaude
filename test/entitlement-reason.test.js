import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus, unavailableLine, UNAVAILABLE_TEXT } from '../src/status-renderer.js';

// unavailableReason's contract is "a short reason string, or null when the
// account can serve". The entitlement branch returned `false`, which read as
// available against that contract and, being falsy, made unavailableLine drop
// the row — so the one state added to make refusals explainable (#166) was the
// only one that explained nothing (#258).

const acct = (over = {}) => ({ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...over });

function denied() {
  const am = new AccountManager([acct(), acct({ name: 'b' })], 0.98);
  am.accounts[0].entitlementDeniedUntil = Date.now() + 60_000;
  return am;
}

test('an entitlement-denied account reports a reason string, not false', () => {
  const am = denied();
  const reason = am.unavailableReason(am.accounts[0]);
  assert.equal(typeof reason, 'string', 'every other branch returns a string');
  assert.equal(reason, 'entitlement');
  // The contract's other half: null, and only null, means "can serve".
  assert.equal(am.unavailableReason(am.accounts[1]), null);
});

test('the reason survives into getStatus rather than reading as available', () => {
  const am = denied();
  const status = am.getStatus();
  assert.equal(status.accounts[0].unavailable, 'entitlement');
  assert.notEqual(status.accounts[0].unavailable, false, '`false` reads as available');
});

test('status prints a line for it, which is the whole point of the reason', () => {
  const am = denied();
  const status = am.getStatus();
  const line = unavailableLine(status.accounts[0], { red: s => s, dim: s => s });
  assert.ok(line, 'a refusal with a reason must render a line');
  assert.match(line, /organization/i);

  const text = renderStatus(status, { color: false });
  assert.match(text, /organization/i);
});

test('the reason has human text, like every other reason', () => {
  assert.ok(UNAVAILABLE_TEXT.entitlement, 'an unmapped reason would print the bare key');
});

// Routing must not change: the account was already correctly excluded, because
// _isAvailable tests === null and `false !== null` happened to hold too.
test('the account is still kept out of rotation', () => {
  const am = denied();
  const picked = am.getActiveAccount();
  assert.equal(picked.name, 'b', 'entitlement-denied must not be selected');
});

// _isProbeable is a different function with a boolean contract, and the same
// helper feeds both — so a fix applied by search-and-replace would break it.
test('the probe path keeps its boolean answer', () => {
  const am = denied();
  assert.equal(am._isProbeable(am.accounts[0]), false);
  assert.equal(am._isProbeable(am.accounts[1]), true);
});
