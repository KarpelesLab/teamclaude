import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { exhaustedMessage } from '../src/server.js';

// `All 3 accounts exhausted. Retry in 60s.` was wrong three ways at once, and
// each one sent the operator somewhere unhelpful (#168).

const oauth = (name, over = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...over,
});

const fleet = (...accts) => new AccountManager(accts, 0.98);

test('a disabled account is not counted as capacity that ran out', () => {
  const am = fleet(oauth('a'), oauth('b'), oauth('c', { disabled: true }));
  const msg = exhaustedMessage(am, null, 60);
  assert.match(msg, /2 accounts/, 'the disabled one was counted');
  assert.doesNotMatch(msg, /3 accounts/);
  assert.match(msg, /1 more disabled/, 'the operator should still be told it is there');
});

test('the model is named, so a family refusal does not read as a fleet outage', () => {
  const am = fleet(oauth('a'));
  const msg = exhaustedMessage(am, 'claude-fable-5', 60);
  assert.match(msg, /claude-fable-5/);
});

test('a request with no model says nothing about one', () => {
  const am = fleet(oauth('a'));
  assert.doesNotMatch(exhaustedMessage(am, null, 60), /for (null|undefined)/);
});

// "exhausted" reads terminal, "retry in 60s" reads transient. Saying both at
// once is what nudged the operator into retrying by hand instead of looking.
test('the wording does not contradict itself', () => {
  const am = fleet(oauth('a'), oauth('b'));
  const msg = exhaustedMessage(am, 'claude-opus-4', 60);
  assert.doesNotMatch(msg, /exhausted/i);
  assert.match(msg, /quota or rate limit/i);
  assert.match(msg, /resets in 60s/i);
});

test('singular reads correctly with one account', () => {
  const am = fleet(oauth('a'));
  const msg = exhaustedMessage(am, null, 30);
  assert.match(msg, /all 1 account\b/);
  assert.doesNotMatch(msg, /1 accounts/);
});

test('a fleet with no reset to name still says something actionable', () => {
  const am = fleet(oauth('a'));
  assert.match(exhaustedMessage(am, null, 0), /Retry shortly/);
});

// AccountManager normalizes status/quota on construction, so tests mutate the
// live account objects the same way warmer/account-disable tests do.
function markFableSpent(account, utilization = 0.999) {
  account.quota.unified7dFable = utilization;
  account.quota.unified7dFableReset = Date.now() + 3600_000;
  account.quota.unified7dFableSeenAt = Date.now();
  account.quota.unified7d = 0.1;
  account.quota.unified5h = 0.1;
}

// Mixed fleet: one account genuinely spent the family weekly, another still has
// Fable headroom but holds a dead refresh token (status=error after invalid_grant).
// Blaming "all accounts at quota" here is what sends operators into a wait loop
// while the TUI still shows the errored account's Fable bar as available.
test('credential-error accounts are named separately from quota', () => {
  const am = fleet(oauth('john'), oauth('jpeg340'));
  markFableSpent(am.accounts[0], 0.999);
  markFableSpent(am.accounts[1], 0.13);
  am.accounts[1].status = 'error';

  const msg = exhaustedMessage(am, 'claude-fable-5-1', 60);
  assert.match(msg, /claude-fable-5-1/);
  assert.match(msg, /"jpeg340".*re-login/i);
  assert.match(msg, /teamclaude login/);
  assert.match(msg, /"john".*quota or rate-limited/i);
  assert.doesNotMatch(msg, /all 2 accounts are at their quota/i);
  // Waiting alone will not clear an invalid_grant; the next step is re-auth.
  assert.match(msg, /Re-auth/i);
});

test('pure auth-error fleet does not claim a quota reset', () => {
  const am = fleet(oauth('a'), oauth('b'));
  am.accounts[0].status = 'error';
  am.accounts[1].status = 'error';
  const msg = exhaustedMessage(am, 'claude-fable-5-1', 60);
  assert.match(msg, /needs? re-login/i);
  assert.doesNotMatch(msg, /Quota resets/i);
  assert.doesNotMatch(msg, /at their quota or rate limit/i);
});

test('pure quota fleet keeps the reset countdown', () => {
  const am = fleet(oauth('a'), oauth('b'));
  markFableSpent(am.accounts[0]);
  markFableSpent(am.accounts[1]);
  const msg = exhaustedMessage(am, 'claude-fable-5-1', 45);
  assert.match(msg, /quota or rate-limited/i);
  assert.match(msg, /resets in 45s/i);
  assert.doesNotMatch(msg, /re-login/i);
});
