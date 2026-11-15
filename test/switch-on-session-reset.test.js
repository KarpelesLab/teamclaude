import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// switchOnSessionReset: false keeps traffic on a healthy current account when
// another account's 5-hour window resets, instead of moving every conversation
// (and its prompt cache) onto it. The reset still returns that account to
// rotation; it is simply not a reason to leave the current one.

const HOUR = 3600_000;
const OPUS = 'claude-opus-5';
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// A: 5h window just reset, weekly lapses soon. B: current, healthy, weekly
// resets much later. The same shape as session-reset-race.test.js.
function fleet(opts = {}, aSession = 0.99) {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, opts);
  const [a, b] = am.accounts;
  a.quota.unified5h = aSession;
  a.quota.unified5hReset = Date.now() - 1000;
  a.quota.unified7d = 0.5;
  a.quota.unified7dReset = Date.now() + 6 * HOUR;
  b.quota.unified5h = 0.2;
  b.quota.unified5hReset = Date.now() + 4 * HOUR;
  b.quota.unified7d = 0.1;
  b.quota.unified7dReset = Date.now() + 58 * HOUR;
  am.currentIndex = 1;
  return am;
}

test('default: the reset still moves traffic to the sooner weekly', () => {
  const am = fleet();
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'a');
});

test('off: a healthy current account keeps the traffic', () => {
  const am = fleet({ switchOnSessionReset: false });
  for (let turn = 0; turn < 3; turn++) assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('off: an idle account whose barely used window resets does not pull traffic either', () => {
  // A keep-warm request leaves an idle account with a running window at ~1%;
  // its reset five hours later is the same event.
  const am = fleet({ switchOnSessionReset: false }, 0.01);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('off: the reset account is back in rotation, and wins it on the sooner weekly', () => {
  const am = fleet({ switchOnSessionReset: false });
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
  am.accounts[1].quota.unified7d = 0.99;
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'a');
});

test('off: only a literal false turns it off', () => {
  assert.equal(fleet({ switchOnSessionReset: 'false' }).switchOnSessionReset, true);
  assert.equal(fleet({ switchOnSessionReset: false }).switchOnSessionReset, false);
});

test('setter applies live', () => {
  const am = fleet();
  am.setSwitchOnSessionReset(false);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('a reset seen while off is not replayed when it is turned back on', () => {
  const am = fleet({ switchOnSessionReset: false });
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
  am.setSwitchOnSessionReset(true);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});
