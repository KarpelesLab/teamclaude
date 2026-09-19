import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { candidateAccounts, exhaustedMessage } from '../src/server.js';

// `All 3 accounts exhausted. Retry in 60s.` was wrong three ways at once, and
// each one sent the operator somewhere unhelpful (#168).

const oauth = (name, over = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...over,
});
const chatgpt = (name, over = {}) => oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...over });

const fleet = (...accts) => new AccountManager(accts, 0.98);

/** What the 429 says, for a request on `model` arriving on `provider`'s path. */
const said = (am, model, retryAfter, provider) =>
  exhaustedMessage(candidateAccounts(am, model, provider), model, retryAfter);

test('a disabled account is not counted as capacity that ran out', () => {
  const am = fleet(oauth('a'), oauth('b'), oauth('c', { disabled: true }));
  const msg = said(am, null, 60);
  assert.match(msg, /2 accounts/, 'the disabled one was counted');
  assert.doesNotMatch(msg, /3 accounts/);
  assert.match(msg, /1 more disabled/, 'the operator should still be told it is there');
});

test('the model is named, so a family refusal does not read as a fleet outage', () => {
  const am = fleet(oauth('a'));
  const msg = said(am, 'claude-fable-5', 60);
  assert.match(msg, /claude-fable-5/);
});

test('a request with no model says nothing about one', () => {
  const am = fleet(oauth('a'));
  assert.doesNotMatch(said(am, null, 60), /for (null|undefined)/);
});

// "exhausted" reads terminal, "retry in 60s" reads transient. Saying both at
// once is what nudged the operator into retrying by hand instead of looking.
test('the wording does not contradict itself', () => {
  const am = fleet(oauth('a'), oauth('b'));
  const msg = said(am, 'claude-opus-4', 60);
  assert.doesNotMatch(msg, /exhausted/i);
  assert.match(msg, /quota or rate limit/i);
  assert.match(msg, /resets in 60s/i);
});

test('singular reads correctly with one account', () => {
  const am = fleet(oauth('a'));
  const msg = said(am, null, 30);
  assert.match(msg, /all 1 account\b/);
  assert.doesNotMatch(msg, /1 accounts/);
});

test('a fleet with no reset to name still says something actionable', () => {
  const am = fleet(oauth('a'));
  assert.match(said(am, null, 0), /Retry shortly/);
});

// ── the count that #168 named but never fixed ─────────────────
//
// `all 12 accounts are at their quota or rate limit` for a Codex request that
// only ever had two accounts to its name. The other ten were healthy Anthropic
// subscriptions the request could not have reached, and an operator reading
// that goes looking for a fleet-wide outage.

test('a Codex request counts the accounts that could have served it', () => {
  const am = new AccountManager(
    [chatgpt('one'), chatgpt('two'), ...Array.from({ length: 10 }, (_, i) => oauth(`claude-${i}`))],
    0.98, { routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['one', 'two'] }] });

  const msg = said(am, 'gpt-5.6-sol', 60, 'codex');
  assert.match(msg, /all 2 accounts/);
  assert.doesNotMatch(msg, /12 accounts/, 'the whole fleet was counted again');
  assert.doesNotMatch(msg, /disabled/, 'nothing here is disabled');
});

test('a route with an accounts list is the pool, whatever the fleet holds', () => {
  const am = new AccountManager(
    [oauth('a'), oauth('b'), oauth('c')], 0.98,
    { routes: [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }] });
  assert.match(said(am, 'claude-fable-5', 60), /all 1 account\b/);
  assert.match(said(am, 'claude-opus-5', 60), /all 3 accounts/, 'an unrouted model still sees the fleet');
});

// Narrowing the pool makes the empty pool reachable, and an empty pool is a
// different fault: no window is going to reset, so the operator must be sent to
// the config rather than told to wait.
test('a request no account is eligible for is not reported as exhaustion', () => {
  const am = new AccountManager(
    [chatgpt('one')], 0.98,
    { routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['one'] }] });
  // An inbound Claude Code request: a ChatGPT subscription cannot serve
  // /v1/messages, and the route lets nothing else near the model.
  const msg = said(am, 'gpt-5.6-sol', 60);
  assert.doesNotMatch(msg, /0 account/);
  assert.doesNotMatch(msg, /resets in/, 'there is no window to wait for');
  assert.match(msg, /no configured account is eligible/);
});

test('an eligible pool the operator turned off says so', () => {
  const am = fleet(oauth('a', { disabled: true }), oauth('b', { disabled: true }));
  const msg = said(am, null, 60);
  assert.match(msg, /every account eligible for it is disabled \(2\)/);
  assert.doesNotMatch(msg, /0 account/);
});

test('the disabled aside counts only accounts the request could have used', () => {
  // Otherwise "(2 more disabled)" invites the operator to re-enable an account
  // that would not have taken the request either way.
  const am = new AccountManager(
    [chatgpt('one'), chatgpt('two', { disabled: true }), oauth('claude-1', { disabled: true })],
    0.98, { routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['one', 'two'] }] });
  const msg = said(am, 'gpt-5.6-sol', 60, 'codex');
  assert.match(msg, /all 1 account\b/);
  assert.match(msg, /1 more disabled/);
  assert.doesNotMatch(msg, /2 more disabled/, 'a disabled Anthropic account is not this request\'s missing capacity');
});
