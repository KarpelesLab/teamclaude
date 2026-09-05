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
