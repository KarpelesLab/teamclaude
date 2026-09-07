import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// _switchOnSessionReset — "session quota reset and weekly expires sooner,
// switch to it" — used to run only when refreshExpiredQuotas was the path that
// first observed the 5-hour reset. getStatus reaches _clearExpiredQuotas too,
// through unavailableReason → _isNearQuota, so a status poll landing between
// the reset and the next proxied request consumed the event and the rule never
// ran. With the dashboard polling every 5s that was nearly every time (#275).
//
// These pin the observed order: status first, then a request.

const HOUR = 3600_000;
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// A: 5h window just reset, weekly lapses soon — the account the rule exists to
// move traffic onto. B: current, weekly resets much later.
function fleet() {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const [a, b] = am.accounts;
  a.quota.unified5h = 0.99;
  a.quota.unified5hReset = Date.now() - 1000;        // rolled a second ago
  a.quota.unified7d = 0.5;
  a.quota.unified7dReset = Date.now() + 6 * HOUR;    // lapses soon
  b.quota.unified5h = 0.2;
  b.quota.unified5hReset = Date.now() + 4 * HOUR;
  b.quota.unified7d = 0.1;
  b.quota.unified7dReset = Date.now() + 58 * HOUR;   // plenty of runway
  am.currentIndex = 1;                                // current = B
  return am;
}

test('a status poll before the next request does not consume the reset', () => {
  const am = fleet();
  am.getStatus();                       // the poll that used to swallow it
  assert.equal(am.currentIndex, 1, 'a status read must not switch on its own');

  am.refreshExpiredQuotas();            // the next proxied request
  assert.equal(am.currentIndex, 0, 'the switch rule should have run for A');
});

test('the rule still runs when the request path observes the reset first', () => {
  const am = fleet();
  am.refreshExpiredQuotas();
  assert.equal(am.currentIndex, 0);
});

// Many polls, not just one — the flag must survive all of them.
test('repeated polling does not wear the event down', () => {
  const am = fleet();
  for (let i = 0; i < 12; i++) am.getStatus();
  assert.equal(am.currentIndex, 1);
  am.refreshExpiredQuotas();
  assert.equal(am.currentIndex, 0);
});

// And it must fire once, not on every later request.
test('the reset is consumed once', () => {
  const am = fleet();
  am.getStatus();
  am.refreshExpiredQuotas();
  assert.equal(am.currentIndex, 0);

  // Someone switches back by hand; a later request must not drag it away again
  // on the strength of a reset that was already acted on.
  am.currentIndex = 1;
  am.refreshExpiredQuotas();
  assert.equal(am.currentIndex, 1, 'the reset fired twice');
});

test('an account with no reset pending leaves the cursor alone', () => {
  const am = fleet();
  am.accounts[0].quota.unified5hReset = Date.now() + HOUR;   // not rolled
  am.accounts[0].quota.unified5h = 0.4;
  am.getStatus();
  am.refreshExpiredQuotas();
  assert.equal(am.currentIndex, 1);
});
