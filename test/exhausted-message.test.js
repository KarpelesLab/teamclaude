import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { candidateAccounts, computeRetryAfter, exhaustedMessage, formatWait } from '../src/server.js';

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

// The retry-after became the real window, which can be days. `resets in
// 259200s` is a number the operator has to divide before it means anything.
test('a long wait is written as a duration, a short one stays in seconds', () => {
  assert.equal(formatWait(1), '1s');
  assert.equal(formatWait(60), '60s');
  assert.equal(formatWait(119), '119s', 'seconds run up to two minutes, matching the header by eye');
  assert.equal(formatWait(120), '2m');
  assert.equal(formatWait(12 * 60), '12m');
  assert.equal(formatWait(3600), '1h');
  assert.equal(formatWait(3 * 3600 + 12 * 60), '3h 12m');
  assert.equal(formatWait(24 * 3600), '1d');
  assert.equal(formatWait(2 * 86400 + 3 * 3600), '2d 3h');
  assert.equal(formatWait(259200), '3d');
});

test('a wait is rounded up, never down, to the unit it is shown in', () => {
  // The text must not promise capacity sooner than the retry-after header does.
  assert.equal(formatWait(121), '3m');
  assert.equal(formatWait(3 * 3600 + 11 * 60 + 1), '3h 12m');
  assert.equal(formatWait(2 * 86400 + 2 * 3600 + 60), '2d 3h');
  assert.equal(formatWait(59 * 60 + 1), '1h', 'rounding that crosses a unit moves to the next one');
  assert.equal(formatWait(23 * 3600 + 59 * 60 + 1), '1d');
});

test('the message carries the readable wait for a fleet spent for days', () => {
  const am = fleet(oauth('a'));
  // Half an hour short of 2d 3h, so the rounded text holds however long the
  // test takes to get from here to the computation.
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + (2 * 24 + 3) * 3600_000 - 30 * 60_000;
  const retryAfter = computeRetryAfter(am, am.accounts, 'claude-opus-5');
  const msg = said(am, 'claude-opus-5', retryAfter);
  assert.match(msg, /resets in 2d 3h\./);
  assert.doesNotMatch(msg, /\d{4,}s/, 'the raw second count leaked into the sentence');
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

// ── a dead credential is not a quota (#407) ───────────────────
//
// One account genuinely spent, another with headroom but holding a refresh token
// that was revoked (`status: 'error'` after invalid_grant). Selection skips both,
// correctly. The message said "all 2 accounts are at their quota or rate limit",
// the TUI went on showing room on the errored account, and the operator waited
// for a reset when the fix was `teamclaude login`.

// AccountManager normalizes status and quota on construction, so these mutate
// the live account objects, the way the warmer and account-disable tests do.
const spendWeekly = (account, resetInMs) => {
  account.quota.unified7d = 1;
  account.quota.unified7dReset = Date.now() + resetInMs;
};
const DAYS_2_HOURS_3 = (2 * 24 + 3) * 3600_000 - 30 * 60_000;

test('a credential-dead account is named, apart from the ones at their quota', () => {
  const am = fleet(oauth('john'), oauth('jpeg340'));
  spendWeekly(am.accounts[0], DAYS_2_HOURS_3);
  am.accounts[1].status = 'error';

  const msg = said(am, 'claude-fable-5-1', 60);
  assert.match(msg, /for claude-fable-5-1: account "jpeg340" needs re-login \(run: teamclaude login\); 1 account is at its quota or rate limit\./);
  assert.doesNotMatch(msg, /all 2 accounts/, 'the dead credential was counted as spent quota');
  assert.doesNotMatch(msg, /"john"/, 'only the account that needs action is named');
});

test('the wait beside a dead credential belongs to the accounts still worth waiting for', () => {
  const am = fleet(oauth('john'), oauth('jpeg340'), oauth('off', { disabled: true }));
  spendWeekly(am.accounts[0], DAYS_2_HOURS_3);
  // The dead account has the sooner reset. It must not be the wait that is
  // named: its window rolling over does not bring its token back.
  spendWeekly(am.accounts[1], 5 * 60_000);
  am.accounts[1].status = 'error';

  const candidates = candidateAccounts(am, 'claude-opus-5', undefined);
  const msg = exhaustedMessage(candidates, 'claude-opus-5', computeRetryAfter(am, candidates, 'claude-opus-5'));
  assert.match(msg, /needs re-login \(run: teamclaude login\); 1 account is at its quota or rate limit\. Quota resets in 2d 3h\. \(1 more disabled\)$/);
});

test('a mixed fleet with no reset to name still says to retry', () => {
  const am = fleet(oauth('a'), oauth('b'), oauth('c'));
  am.accounts[1].status = 'error';
  const msg = said(am, null, 0);
  assert.match(msg, /account "b" needs re-login/);
  assert.match(msg, /2 accounts are at their quota or rate limit\. Retry shortly\.$/);
});

test('a fleet of nothing but dead credentials promises no reset', () => {
  const am = fleet(oauth('a'), oauth('b'), oauth('c', { disabled: true }));
  am.accounts[0].status = 'error';
  am.accounts[1].status = 'error';
  const msg = said(am, 'claude-fable-5-1', 60);
  assert.match(msg, /accounts "a", "b" need re-login \(run: teamclaude login\), and no other account is eligible for it\. \(1 more disabled\)$/);
  assert.doesNotMatch(msg, /resets in/i, 'waiting will not bring a revoked token back');
  assert.doesNotMatch(msg, /Retry shortly/i);
  assert.doesNotMatch(msg, /quota or rate limit/i);
});

test('one dead account on its own reads in the singular', () => {
  const am = fleet(oauth('solo'));
  am.accounts[0].status = 'error';
  const msg = said(am, null, 60);
  assert.match(msg, /: account "solo" needs re-login/);
  assert.doesNotMatch(msg, /accounts "solo"|need re-login/);
  assert.doesNotMatch(msg, /resets in/i);
});

test('several dead accounts are pluralised, and the list of names is capped', () => {
  const am = fleet(...['a', 'b', 'c', 'd', 'e'].map(n => oauth(n)), oauth('spent'));
  for (const acct of am.accounts.slice(0, 5)) acct.status = 'error';
  const msg = said(am, null, 60);
  assert.match(msg, /accounts "a", "b", "c" and 2 more need re-login/);
  assert.doesNotMatch(msg, /"d"|"e"/, 'the cap did not hold');
  assert.match(msg, /; 1 account is at its quota or rate limit\. Quota resets in 60s\.$/);
});

test('exactly as many dead accounts as the cap are all named, with no "more"', () => {
  const am = fleet(oauth('a'), oauth('b'), oauth('c'));
  for (const acct of am.accounts) acct.status = 'error';
  const msg = said(am, null, 60);
  assert.match(msg, /accounts "a", "b", "c" need re-login/);
  assert.doesNotMatch(msg, /more need/);
});

// An OAuth entitlement denial is an organisation-policy 403 with a cooldown on
// it. The token is fine, a new login changes nothing, and the cooldown is a
// clock `computeRetryAfter` already reads — so it waits with the quota group.
test('an entitlement-denied account is not told to log in again', () => {
  const am = fleet(oauth('a'), oauth('b'));
  am.markEntitlementDenied(1, 300);
  assert.equal(am.unavailableReason(am.accounts[1], 'claude-opus-5'), 'entitlement');

  const msg = said(am, 'claude-opus-5', 60);
  assert.doesNotMatch(msg, /re-login|teamclaude login/);
  assert.match(msg, /all 2 accounts are at their quota or rate limit\. Quota resets in 60s\.$/);
});

test('an entitlement denial beside a dead credential stays in the waiting group', () => {
  const am = fleet(oauth('dead'), oauth('denied'));
  am.accounts[0].status = 'error';
  am.markEntitlementDenied(1, 300);
  const msg = said(am, null, 60);
  assert.match(msg, /account "dead" needs re-login/);
  assert.doesNotMatch(msg, /"denied"/);
  assert.match(msg, /1 account is at its quota or rate limit\. Quota resets in 60s\.$/);
});

test('a dead account the route keeps away from the model is not mentioned', () => {
  // The defect in the first cut of this: it classified the whole fleet, so an
  // account the route excludes printed as `unavailable (route)`, and a dead one
  // outside the route told the operator to fix a login this request never used.
  const am = new AccountManager(
    [oauth('a'), oauth('b'), oauth('c')], 0.98,
    { routes: [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }] });
  am.accounts[0].status = 'error';
  const msg = said(am, 'claude-fable-5', 60);
  assert.doesNotMatch(msg, /"a"|re-login|route/);
  assert.match(msg, /all 1 account\b/);
});

test('an account name cannot forge a line or move the cursor in the client\'s terminal', () => {
  // Names come out of OAuth payloads. This one tries a newline and an erase.
  // Plain records, so nothing upstream of the message gets to tidy the name.
  const msg = exhaustedMessage([{ name: 'ev\nil\x1b[2J', status: 'error' }, { name: 'ok', status: 'active' }], null, 60);
  assert.ok(!msg.includes('\n') && !msg.includes('\x1b'), 'a control character reached the message');
  assert.match(msg, /account "ev il" needs re-login/);
});

test('the function needs no manager: plain account records are enough', () => {
  const msg = exhaustedMessage(
    [{ name: 'x', status: 'error' }, { name: 'y', status: 'active' }, { name: 'z', disabled: true, status: 'error' }],
    'm', 90);
  assert.equal(msg, 'No account can serve this request for m: account "x" needs re-login (run: teamclaude login); '
    + '1 account is at its quota or rate limit. Quota resets in 90s. (1 more disabled)');
});

test('an account inside its routing cooldown is named with its own next step, not filed under quota', () => {
  const soon = Date.now() + 20_000;
  const routed = { name: 'routed@example.com', status: 'active', routingFailedUntil: soon };
  assert.equal(
    exhaustedMessage([routed], null, 20),
    'No account can serve this request: account "routed@example.com" cannot reach its routing proxy (see: teamclaude routing <name>), and no other account is eligible for it.',
  );
  assert.equal(
    exhaustedMessage([routed, { name: 'full', status: 'active' }], 'claude-opus-5', 300),
    'No account can serve this request for claude-opus-5: account "routed@example.com" cannot reach its routing proxy (see: teamclaude routing <name>); 1 account is at its quota or rate limit. Quota resets in 5m.',
  );
  assert.equal(
    exhaustedMessage([{ name: 'dead', status: 'error' }, routed], null, 20),
    'No account can serve this request: account "dead" needs re-login (run: teamclaude login); account "routed@example.com" cannot reach its routing proxy (see: teamclaude routing <name>), and no other account is eligible for it.',
  );
  // A cooldown that has lapsed is not a blocker any more.
  assert.match(exhaustedMessage([{ name: 'was-routed', status: 'active', routingFailedUntil: Date.now() - 1 }], null, 60), /at their quota or rate limit/);
});
