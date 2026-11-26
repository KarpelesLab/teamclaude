import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// #760: a 401 during a 429 hold put the account in `error`, and signing it in
// again made it `active` with the hold's deadline still on it. Nothing clears
// the hold of an account that is not `throttled`, so once it lapsed the
// all-unavailable revival read it as a quota reset and sent the request there.

const DAY = 24 * 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const row = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + DAY });

function fleet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return new AccountManager([row('a'), row('b')], 0.98, {});
}

// a: weekly spent. b: Fable weekly spent, so it serves Opus and no advisor.
function spend(am) {
  am.applyUsageData(0, { sevenDay: { utilization: 0.99, resetAt: Date.now() + 5 * DAY } });
  am.applyUsageData(1, {
    sevenDay: { utilization: 0.5, resetAt: Date.now() + 4 * DAY },
    sevenDayFable: { utilization: 0.99, resetAt: Date.now() + 4 * DAY },
  });
}

test('a sign-in that clears an error clears the 429 hold the error replaced', (t) => {
  const am = fleet(t);
  am.markRateLimited(0, 60);
  am.markCredentialRejected(0, '401');
  assert.equal(am.accounts[0].status, 'error');
  am.updateAccountTokens(0, { accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + DAY });
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('new tokens leave a running 429 hold on an account that is not in error', (t) => {
  const am = fleet(t);
  am.markRateLimited(0, 60);
  const until = am.accounts[0].rateLimitedUntil;
  am.updateAccountTokens(0, { accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + DAY });
  assert.equal(am.accounts[0].status, 'throttled');
  assert.equal(am.accounts[0].rateLimitedUntil, until);
});

test('a lapsed hold left on an active account is not read as a reset', (t) => {
  const am = fleet(t);
  // The state the sign-in used to leave, once the hold's deadline had passed.
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  spend(am);
  assert.equal(am.getActiveAccount(null, OPUS, null).name, 'b', 'setup: b serves Opus');
  assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b',
    'no account serves the advisor, so the request is routed by its main model');
});

test('a throttled account whose hold has lapsed is still revived when nothing else can serve', (t) => {
  const am = fleet(t);
  am.accounts[1].disabled = true;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  assert.equal(am.getActiveAccount(null, OPUS, null).name, 'a');
  assert.equal(am.accounts[0].status, 'active');
});
