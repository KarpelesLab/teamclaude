import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createDefaultConfig } from '../src/config.js';
import { accountBadges } from '../src/dashboard.js';
import { createProxyServer } from '../src/server.js';
import { renderStatus, resetCreditLine } from '../src/status-renderer.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { TUI, resetCreditTag } from '../src/tui.js';
import {
  CODEX_RESET_CREDITS_CONSUME_URL,
  CODEX_RESET_CREDITS_URL,
  ResetCreditRedeemer,
  consumeResetCredit,
  fetchResetCreditDetails,
  orderRedeemCandidates,
  redeemPreconditions,
  shouldRedeemReset,
  weeklyExhausted,
} from '../src/codex-reset-credits.js';

// Free Codex rate-limit reset credits: reading them, the policy that decides
// whether one is worth spending, and the orchestration around the one call in
// the codebase that cannot be undone.
//
// Nothing here reaches the network. The consume endpoint spends a real credit
// on a real account, so every test injects its own fetch.

const DAY = 24 * 60 * 60 * 1000;

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** A Codex account exactly as a config that never mentions the option makes one. */
function codex(name, extra = {}) {
  return oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
}

// The FLEET switch, on. Arming is fleet-scoped and off by default, and nearly
// every test below is about what an armed fleet then decides — so it is spread
// in rather than defaulted, and the default itself is pinned further down.
const ARMED = { autoRedeemResets: true };

/** An account whose weekly window is spent and whose 5-hour one is not. */
function weeklySpent(account, now = Date.now()) {
  account.quota.unified7d = 1;
  account.quota.unified7dReset = now + 3 * DAY;
  account.quota.unified5h = 0.1;
  return account;
}

function credit(extra = {}) {
  return {
    id: 'RateLimitResetCredit_1',
    status: 'available',
    supportedByPlan: true,
    expiresAt: Date.now() + 30 * DAY,
    title: 'Full reset',
    ...extra,
  };
}

// ── reading the detail rows ─────────────────────────────────────────────────

test('fetchResetCreditDetails sends the account-scoped read and parses ISO expiry', async () => {
  let request;
  const result = await fetchResetCreditDetails({ credential: 'secret', accountId: 'acct-1' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          credits: [{
            id: 'RateLimitResetCredit_c56df5a5',
            reset_type: 'codex_rate_limits',
            is_supported_by_plan: true,
            status: 'available',
            granted_at: '2026-09-05T04:20:30.807703Z',
            expires_at: '2026-10-05T04:20:30.807703Z',
            title: 'Full reset',
          }],
          available_count: 1,
        }),
      };
    },
  });
  assert.equal(request.url, CODEX_RESET_CREDITS_URL);
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(result.availableCount, 1);
  assert.equal(result.credits.length, 1);
  assert.equal(result.credits[0].id, 'RateLimitResetCredit_c56df5a5');
  assert.equal(result.credits[0].supportedByPlan, true);
  // ISO-8601 at the HTTP layer — epoch seconds only one layer further down.
  assert.equal(result.credits[0].expiresAt, Date.parse('2026-10-05T04:20:30.807703Z'));
});

test('a credit row with no expiry never expires, and one with no id is dropped', async () => {
  const result = await fetchResetCreditDetails({ credential: 's', accountId: 'a' }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ credits: [{ id: 'keep', status: 'available', expires_at: null }, { status: 'available' }] }),
    }),
  });
  assert.equal(result.credits.length, 1);
  assert.equal(result.credits[0].expiresAt, null);
  // No stated count: fall back to what the rows show.
  assert.equal(result.availableCount, 1);
});

test('fetchResetCreditDetails reports a non-2xx rather than inventing an empty list', async () => {
  const result = await fetchResetCreditDetails({ credential: 's', accountId: 'a' }, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.deepEqual(result, { error: 'HTTP 401', status: 401 });
});

// ── consuming ───────────────────────────────────────────────────────────────

test('consumeResetCredit posts the idempotency key and the chosen credit', async () => {
  let request;
  const result = await consumeResetCredit({ credential: 'secret', accountId: 'acct-1' },
    { creditId: 'cred-1', redeemRequestId: 'uuid-1' }, {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ code: 'reset', credit: { id: 'cred-1', status: 'redeemed' }, windows_reset: 2 }) };
      },
    });
  assert.equal(request.url, CODEX_RESET_CREDITS_CONSUME_URL);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { redeem_request_id: 'uuid-1', credit_id: 'cred-1' });
  assert.equal(result.code, 'reset');
  assert.equal(result.windowsReset, 2);
});

// The trap this endpoint sets: a refusal is an HTTP 200 whose body says `code`.
// Reading the status instead would report a credit as spent when none was.
test('a declined redemption is a 200 and is classified on the body, not the status', async () => {
  const result = await consumeResetCredit({ credential: 's', accountId: 'a' },
    { redeemRequestId: 'uuid-1' }, {
      fetchImpl: async (_url, options) => {
        // No credit chosen: the backend picks the next available one itself.
        assert.deepEqual(JSON.parse(options.body), { redeem_request_id: 'uuid-1' });
        return { ok: true, json: async () => ({ code: 'no_credit', credit: null, windows_reset: 0 }) };
      },
    });
  assert.deepEqual(result, { code: 'no_credit', windowsReset: 0, credit: null });
});

test('consumeResetCredit refuses without an idempotency key', async () => {
  let called = false;
  const result = await consumeResetCredit({ credential: 's', accountId: 'a' },
    { redeemRequestId: '' }, { fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; } });
  assert.equal(called, false);
  assert.equal(result.error, 'missing redeem request id');
});

// ── the weekly-only trigger ─────────────────────────────────────────────────

test('a spent 5-hour window is never the trigger', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 1;
  account.quota.unified5hReset = Date.now() + 3600_000;
  account.quota.unified7d = 0.4;
  account.quota.unified7dReset = Date.now() + 3 * DAY;
  assert.equal(weeklyExhausted(account), false);
  assert.equal(redeemPreconditions({ account, ...ARMED }).ok, false);
});

test('a weekly reading whose window has already rolled over is not exhaustion', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified7d = 1;
  account.quota.unified7dReset = Date.now() - 1000;
  assert.equal(weeklyExhausted(account), false);
});

test('a spent weekly window satisfies the preconditions, but only on an armed fleet', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const account = weeklySpent(am.accounts[0]);
  assert.equal(redeemPreconditions({ account, ...ARMED }).ok, true);
  assert.equal(redeemPreconditions({ account }).ok, false);
});

// The two "off" answers name different switches on purpose: an operator reading
// the log has to be able to tell "nothing is armed" from "this one is exempt".
test('the fleet switch and an account opt-out give distinguishable reasons', () => {
  const am = new AccountManager([codex('a'), codex('b', { autoRedeemReset: false })], 0.98);
  assert.equal(redeemPreconditions({ account: weeklySpent(am.accounts[0]) }).reason, 'auto-redeem is switched off');
  assert.equal(redeemPreconditions({ account: weeklySpent(am.accounts[1]), ...ARMED }).reason,
    'auto-redeem is switched off for this account');
});

test('an Anthropic account is never a candidate', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.equal(redeemPreconditions({ account: weeklySpent(am.accounts[0]), ...ARMED }).ok, false);
});

// ── the policy ──────────────────────────────────────────────────────────────

test('a dry Codex pool justifies spending a credit', () => {
  const am = new AccountManager([codex('a'), codex('b', { disabled: true })], 0.98);
  const account = weeklySpent(am.accounts[0]);
  const pool = [{ name: 'b', available: false }];
  const verdict = shouldRedeemReset({ account, ...ARMED, pool, credits: [credit()] });
  assert.equal(verdict.redeem, true);
  assert.equal(verdict.creditId, 'RateLimitResetCredit_1');
});

// `every` over an empty list is true, and that is the right answer: with one
// Codex account, that account being out IS the pool being dry.
test('a single-account pool is dry the moment its weekly is spent', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const verdict = shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [], credits: [credit()] });
  assert.equal(verdict.redeem, true);
});

test('a sibling that can still serve means the credit waits', () => {
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0]),
    ...ARMED,
    pool: [{ name: 'b', available: true }],
    credits: [credit()],
  });
  assert.equal(verdict.redeem, false);
  assert.equal(verdict.reason, 'another Codex account can still serve');
});

test('a credit about to expire is spent even when a sibling could serve', () => {
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  const now = Date.now();
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0], now),
    ...ARMED,
    pool: [{ name: 'b', available: true }],
    credits: [credit({ expiresAt: now + 2 * DAY })],
    now,
  });
  assert.equal(verdict.redeem, true);
  assert.match(verdict.reason, /expires in ~2d/);
});

test('the soonest-expiring redeemable credit is the one chosen', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const now = Date.now();
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0], now),
    ...ARMED,
    pool: [],
    credits: [
      credit({ id: 'later', expiresAt: now + 20 * DAY }),
      credit({ id: 'sooner', expiresAt: now + 4 * DAY }),
      credit({ id: 'never', expiresAt: null }),
    ],
    now,
  });
  assert.equal(verdict.creditId, 'sooner');
});

test('a credit the plan does not support is not one we hold', () => {
  const am = new AccountManager([codex('a')], 0.98);
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0]),
    ...ARMED,
    pool: [],
    credits: [credit({ supportedByPlan: false }), credit({ id: 'spent', status: 'redeemed' })],
  });
  assert.equal(verdict.redeem, false);
  assert.equal(verdict.reason, 'holds no redeemable credit');
});

// The plan gate is applied BEFORE the expiry reasoning, so an unsupported
// credit expiring tomorrow cannot make a "use it or lose it" case for spending
// a supported one that has a month left.
test('an unsupported credit expiring tomorrow justifies nothing', () => {
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  const now = Date.now();
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0], now),
    ...ARMED,
    pool: [{ name: 'b', available: true }],
    credits: [
      credit({ id: 'unsupported', supportedByPlan: false, expiresAt: now + DAY }),
      credit({ id: 'supported', expiresAt: now + 30 * DAY }),
    ],
    now,
  });
  assert.equal(verdict.redeem, false);
  assert.equal(verdict.reason, 'another Codex account can still serve');
});

// ── orchestration ───────────────────────────────────────────────────────────

/** A redeemer whose first account is out of quota, with both endpoints faked. */
function harness({ accounts = [codex('a')], credits = [credit()], code = 'reset', usage = {}, quota = weeklySpent, config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  quota(am.accounts[0]);
  const calls = { details: 0, consume: 0, usage: 0, keys: [] };
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    log: () => {},
    detailsFn: async () => { calls.details++; return { credits, availableCount: credits.length }; },
    consumeFn: async (_account, attempt) => {
      calls.consume++;
      calls.keys.push(attempt.redeemRequestId);
      return typeof code === 'function' ? code(calls.consume) : { code, windowsReset: 1, credit: null };
    },
    usageFn: async () => { calls.usage++; return { sevenDay: { utilization: 0.0, resetAt: Date.now() + 7 * DAY }, ...usage }; },
  });
  // Every entry point is the pool-dry refusal, so a one-account decision is a
  // one-account refusal.
  const offer = () => redeemer.maybeRedeemForPool([am.accounts[0]]);
  return { am, redeemer, calls, offer };
}

test('a successful redemption clears the hold and re-reads the quota', async () => {
  const { am, calls, offer } = harness();
  am.markRateLimited(0, 600);
  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.equal(calls.consume, 1);
  assert.equal(calls.usage, 1);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].quota.unified7d, 0);
});

test('the policy says no and nothing is consumed', async () => {
  // Two Codex accounts, the sibling healthy: rotation can still serve.
  const { calls, offer } = harness({ accounts: [codex('a'), codex('b')] });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(calls.consume, 0);
});

test('a healthy weekly window never reaches the endpoints', async () => {
  const { calls, offer } = harness({ quota: account => { account.quota.unified7d = 0.5; } });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(calls.details, 0);
  assert.equal(calls.consume, 0);
});

test('a known-zero credit count costs no request at all', async () => {
  const { am, calls, offer } = harness();
  am.accounts[0].quota.resetCredits = { available: 0, applicable: 0, seenAt: Date.now() };
  const result = await offer();
  assert.equal(result.reason, 'holds no reset credits');
  assert.equal(calls.details, 0);
});

test('a declined redemption arms a cooldown so a hot refusal loop cannot hammer the endpoint', async () => {
  const { calls, offer } = harness({ code: 'nothing_to_reset' });
  const first = await offer();
  assert.equal(first.redeemed, false);
  assert.match(first.reason, /nothing_to_reset/);
  for (let i = 0; i < 5; i++) await offer();
  assert.equal(calls.consume, 1);
});

// The point of the idempotency key: an attempt that failed after upstream had
// already acted is indistinguishable from one that never arrived, so the retry
// replays the key and upstream — not us — decides which it was.
test('a failed attempt reuses its key, and already_redeemed counts as a success', async () => {
  const { redeemer, calls, offer } = harness({
    code: n => (n === 1 ? { error: 'socket hang up' } : { code: 'already_redeemed', windowsReset: 1, credit: null }),
  });
  const first = await offer();
  assert.equal(first.redeemed, false);

  // Past the cooldown the failure armed.
  redeemer.now = () => Date.now() + 31 * 60 * 1000;
  const second = await offer();
  assert.equal(second.redeemed, true);
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
});

test('the detail rows are cached, then re-read once the TTL lapses', async () => {
  // A pool with a healthy sibling, so the policy always declines and the only
  // cost of asking again is the detail fetch the cache is there to bound.
  const { redeemer, calls, offer } = harness({ accounts: [codex('a'), codex('b')] });
  await offer();
  await offer();
  assert.equal(calls.details, 1);

  redeemer.now = () => Date.now() + 7 * 60 * 60 * 1000;
  await offer();
  assert.equal(calls.details, 2);
});

test('a credit list that cannot be read spends nothing', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  weeklySpent(am.accounts[0]);
  let consumed = 0;
  const redeemer = new ResetCreditRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    detailsFn: async () => ({ error: 'HTTP 500' }),
    consumeFn: async () => { consumed++; return { code: 'reset' }; },
    usageFn: async () => ({}),
  });
  const result = await redeemer.maybeRedeemForPool([am.accounts[0]]);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /HTTP 500/);
  assert.equal(consumed, 0);
});

// ── the time budget ─────────────────────────────────────────────────────────

// The attempt runs with the refused request waiting on it, so what it may spend
// is ONE budget across the refresh, the read and the redeem — not a timeout
// each. These run on a clock the test moves by hand, so "the budget ran out" is
// a fact about the attempt rather than a race with a real timer.
function budgeted({ budgetMs = 1000, refreshCost = 0, detailsCost = 0 } = {}) {
  const am = new AccountManager([codex('a')], 0.98);
  const clock = { at: Date.now() };
  weeklySpent(am.accounts[0], clock.at);
  am.ensureTokenFresh = async () => { clock.at += refreshCost; };
  const calls = { details: 0, consume: 0, usage: 0, detailsTimeout: null, consumeTimeout: null };
  const redeemer = new ResetCreditRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    now: () => clock.at,
    timeoutMs: budgetMs,
    detailsFn: async (_account, opts) => {
      calls.details++;
      calls.detailsTimeout = opts.timeoutMs;
      clock.at += detailsCost;
      return { credits: [credit()], availableCount: 1 };
    },
    consumeFn: async (_account, _attempt, opts) => {
      calls.consume++;
      calls.consumeTimeout = opts.timeoutMs;
      return { code: 'reset', windowsReset: 1, credit: null };
    },
    usageFn: async () => { calls.usage++; return { sevenDay: { utilization: 0, resetAt: clock.at + 7 * DAY } }; },
  });
  return { am, redeemer, calls, clock, offer: () => redeemer.maybeRedeemForPool([am.accounts[0]]) };
}

test('a slow credit read leaves the redeem only what is left of the budget', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, detailsCost: 600 });
  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.equal(calls.detailsTimeout, 1000);
  assert.equal(calls.consumeTimeout, 400, 'the redeem gets the remainder, never the whole budget a second time');
});

test('a refresh that eats the budget stops before the credit read', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, refreshCost: 1000 });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.details, 0, 'a call with nothing left to spend is not made at all');
});

test('a budget spent before the redeem declines rather than making the irreversible call late', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, detailsCost: 1000 });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.consume, 0);
});

// An expired budget is a declined attempt like any other, so it owes the same
// cooldown: without it, every refusal in a burst against a slow upstream would
// re-enter here and hold its own request for the budget all over again.
test('a spent budget arms the cooldown rather than being retried per refusal', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, detailsCost: 1000 });
  await offer();
  const again = await offer();
  assert.match(again.reason, /cooling down/);
  assert.equal(calls.consume, 0);
});

// The budget has to BIND on the token refresh, not merely be checked once it
// returns. `ensureTokenFresh` takes no timeout and every concurrent refusal
// joins the same one, so a refresh that hangs would otherwise hold the client
// for as long as it liked and then be waved through by a deadline check that
// can only report a promise already broken. This one never finishes at all.
test('a token refresh that outlives the budget is left behind, not waited out', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  weeklySpent(am.accounts[0]);
  /** @type {() => void} */
  let finishRefresh = () => {};
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = resolve; });
  const calls = { details: 0, consume: 0 };
  const redeemer = new ResetCreditRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    timeoutMs: 20,
    detailsFn: async () => { calls.details++; return { credits: [credit()], availableCount: 1 }; },
    consumeFn: async () => { calls.consume++; return { code: 'reset', windowsReset: 1, credit: null }; },
    usageFn: async () => ({}),
  });

  const started = Date.now();
  const result = await redeemer.maybeRedeemForPool([am.accounts[0]]);
  const waited = Date.now() - started;
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.ok(waited < 2000, `the refusal waited ${waited}ms on a refresh that never finished`);
  assert.equal(calls.details, 0, 'nothing is read on a token the attempt never got');

  // And it stays left behind: a refresh landing after the deadline is no longer
  // this attempt's business.
  finishRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.consume, 0, 'a refresh that finished late must not reach the irreversible call');
});

test('an Anthropic account never reaches a Codex endpoint', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  weeklySpent(am.accounts[0]);
  let touched = 0;
  const redeemer = new ResetCreditRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    detailsFn: async () => { touched++; return { credits: [] }; },
    consumeFn: async () => { touched++; return { code: 'reset' }; },
    usageFn: async () => { touched++; return {}; },
  });
  assert.equal((await redeemer.maybeRedeemForPool([am.accounts[0]])).redeemed, false);
  assert.equal(touched, 0);
});

test('a fleet nobody armed stops before any request', async () => {
  const { calls, offer } = harness({ config: {} });
  const result = await offer();
  assert.match(result.reason, /auto-redeem is switched off$/);
  assert.equal(calls.details, 0);
});

// The account-level key is a veto and nothing more, so it has to be read at the
// same moment and stop the attempt just as early.
test('an account that opted out stops there too, even on an armed fleet', async () => {
  const { calls, offer } = harness({ accounts: [codex('a', { autoRedeemReset: false })] });
  const result = await offer();
  assert.match(result.reason, /switched off for this account/);
  assert.equal(calls.details, 0);
});

// The polarity a reader gets wrong: an account saying `true` is not a switch.
test('a per-account `true` redeems nothing while the fleet switch is off', async () => {
  const { calls, offer } = harness({ accounts: [codex('a', { autoRedeemReset: true })], config: {} });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(calls.consume, 0);
});

// Read off the shared config per refusal, not snapshotted at construction: the
// TUI toggle and `POST /teamclaude/reload` both work by mutating that object,
// so an attempt after the flip has to see the new answer.
test('flipping the fleet switch binds on the next refusal, with no restart', async () => {
  const config = {};
  const { calls, offer } = harness({ config });
  assert.equal((await offer()).redeemed, false);
  config.autoRedeemResets = true;
  assert.equal((await offer()).redeemed, true);
  assert.equal(calls.consume, 1);
});

// ── choosing between accounts ───────────────────────────────────────────────

// The policy answers "should THIS account spend one?". A pool-dry refusal asks
// which of several spent accounts should, so the choice between them is its own
// pure step.

test('the ordering drops an account holding nothing and offers the soonest-expiring credit first', () => {
  const now = Date.now();
  const a = codex('a');
  const b = codex('b');
  const c = codex('c');
  const order = orderRedeemCandidates([
    { account: a, credits: [credit({ id: 'a-1', expiresAt: now + 20 * DAY })] },
    { account: b, credits: [credit({ id: 'b-1', status: 'redeemed', expiresAt: now + DAY })] },
    { account: c, credits: [credit({ id: 'c-1', expiresAt: now + 10 * DAY })] },
  ]);
  assert.deepEqual(order.map(entry => entry.account.name), ['c', 'a']);
  assert.equal(order[0].credit.id, 'c-1');
});

test('a credit that never expires sorts behind one that does, and two of them do not compare as NaN', () => {
  const now = Date.now();
  const order = orderRedeemCandidates([
    { account: codex('a'), credits: [credit({ expiresAt: null })] },
    { account: codex('b'), credits: [credit({ expiresAt: now + 5 * DAY })] },
    { account: codex('c'), credits: [credit({ expiresAt: null })] },
  ]);
  assert.deepEqual(order.map(entry => entry.account.name), ['b', 'a', 'c']);
});

test('an account whose only credit its plan cannot spend is not a candidate', () => {
  const order = orderRedeemCandidates([
    { account: codex('a'), credits: [credit({ supportedByPlan: false })] },
  ]);
  assert.deepEqual(order, []);
});

// ── the pool-dry refusal ────────────────────────────────────────────────────

/** A redeemer over a pool of spent Codex accounts, each with its own rows. */
function poolHarness({ accounts = [codex('a'), codex('b')], credits = {}, code = 'reset', config = { ...ARMED }, caughtUp = true, usageFn = null } = {}) {
  const am = new AccountManager(accounts, 0.98);
  for (const account of am.accounts) weeklySpent(account);
  const calls = { details: [], consume: [] };
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    log: () => {},
    detailsFn: async account => {
      calls.details.push(account.name);
      const rows = credits[account.name] ?? [credit()];
      return { credits: rows, availableCount: rows.length };
    },
    consumeFn: async account => {
      calls.consume.push(account.name);
      return typeof code === 'function' ? code(account.name) : { code, windowsReset: 1, credit: null };
    },
    // `caughtUp: false` is the re-read that still reports the window spent —
    // upstream has not caught up with its own reset yet. `usageFn` replaces it
    // outright, for the re-read that does not answer at all.
    usageFn: usageFn ?? (async () => ({ sevenDay: { utilization: caughtUp ? 0 : 1, resetAt: Date.now() + 7 * DAY } })),
  });
  return { am, redeemer, calls };
}

test('a dry pool spends the credit that would be lost first, and spends exactly one', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = poolHarness({
    credits: {
      a: [credit({ id: 'a-1', expiresAt: now + 20 * DAY })],
      b: [credit({ id: 'b-1', expiresAt: now + 10 * DAY })],
    },
  });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
});

test('an account holding nothing is passed over for one that does', async () => {
  const { am, redeemer, calls } = poolHarness({ credits: { a: [], b: [credit()] } });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
});

test('a dry pool holding no credit anywhere spends nothing and says so', async () => {
  const { am, redeemer, calls } = poolHarness({ credits: { a: [], b: [] } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.deepEqual(calls.consume, []);
});

// A refusal is a FLEET state, so every request refused at the same moment
// arrives here asking the same question. Without the pool-level guard each one
// would walk the same candidate list and could reach a different account on it.
test('concurrent refusals are one decision, not one redemption per refused request', async () => {
  const { am, redeemer, calls } = poolHarness();
  const results = await Promise.all([0, 1, 2, 3].map(() => redeemer.maybeRedeemForPool(am.accounts)));
  assert.equal(calls.consume.length, 1);
  assert.equal(results.filter(r => r.redeemed).length, 4);
});

test('an unarmed fleet refuses the whole pool without reading a single credit list', async () => {
  const { am, redeemer, calls } = poolHarness({ config: {} });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /auto-redeem is switched off$/);
  assert.deepEqual(calls.details, []);
});

test('an Anthropic account offered among the candidates never reaches a Codex endpoint', async () => {
  const { am, redeemer, calls } = poolHarness({ accounts: [oauth('claude'), codex('b')] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.details, ['b']);
  assert.deepEqual(calls.consume, ['b']);
});

// A refusal that redeems does not end the exhaustion for every request behind
// it: the re-read can still report the window spent (upstream not caught up
// with its own reset), and the next refusal must not answer that with a second
// credit. The cooldown is what holds that line.
test('a second refusal after a reset that does not read as one is refused by the cooldown', async () => {
  const { am, redeemer, calls } = poolHarness({ accounts: [codex('a')], caughtUp: false });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /cooling down/);
  assert.deepEqual(calls.consume, ['a']);
});

// A redemption holds the WHOLE pool, not just the account that spent one. The
// sibling's own policy usually says the same thing — the account just returned
// to service is one that "can still serve" — but that reading depends on the
// quota re-read having landed. This is the case where it did not: the reset
// worked, the re-read failed, so the account still reads spent and the next
// refusal walks straight to a sibling holding a credit of its own.
test('a reset whose quota re-read fails still holds every other account', async () => {
  const { am, redeemer, calls } = poolHarness({ usageFn: async () => ({ error: 'HTTP 500' }) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);

  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /cooling down/);
  assert.equal(calls.consume.length, 1, 'one dry pool, one credit');
});

// The uncertain half of the same rule. A consume that never came back with a
// verdict may still have been acted on — upstream states a refusal as a 200
// with a `code`, so an error is "we do not know", never "no". Walking on to the
// next account would answer a credit that may already be gone with another one;
// the retry replays the same key instead, and upstream says which it was.
test('a consume whose verdict never arrived stops the walk rather than spending again', async () => {
  const { am, redeemer, calls } = poolHarness({ code: () => ({ error: 'socket hang up' }) });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /socket hang up/);
  assert.equal(calls.consume.length, 1, 'a POST that may have landed is never answered with a second one');

  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.match(second.reason, /cooling down/);
  assert.equal(calls.consume.length, 1);
});

// The cross-account case the cooldown is not the only answer to: past the hold,
// what declines is the policy itself — the first redemption returned its
// account to service, which is exactly the "another Codex account can still
// serve" the sibling then reads.
test('a redemption that returns one account to service stops the sibling spending too', async () => {
  const { am, redeemer, calls } = poolHarness();
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const sibling = am.accounts.find(a => a.name !== calls.consume[0]);

  redeemer.now = () => Date.now() + 7 * 60 * 60 * 1000;
  const second = await redeemer.maybeRedeemForPool([sibling]);
  assert.equal(second.redeemed, false);
  assert.equal(second.reason, 'another Codex account can still serve');
  assert.equal(calls.consume.length, 1);
});

// ── the pool-dry refusal, through the proxy ─────────────────────────────────

/**
 * One request through a proxy whose pool is dry: every Codex account's weekly
 * window reads spent, so selection refuses before choosing anyone and no
 * upstream request is ever made. `onRedeem` stands in for the redeemer;
 * returning true makes the first candidate selectable, the way a real
 * redemption's quota re-read does.
 */
async function forwardOneRefusedRequest({ onRedeem, accounts = [codex('a')], path = '/backend-api/codex/responses', model = 'gpt-5.6-sol' } = {}) {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));

  const am = new AccountManager(accounts.map(a => ({ ...a, upstream: `http://127.0.0.1:${upstreamPort}` })), 0.98);
  for (const account of am.accounts) weeklySpent(account);
  // The revalidation probe is throttled to one request a minute, so on a pool
  // this dry the overwhelming majority of requests never reach it — which is
  // the state the hook exists for.
  am._nextProbeAt = Date.now() + 60 * 60 * 1000;

  const asked = [];
  const hooks = onRedeem ? {
    redeemCodexResetForPool: async (/** @type {Record<string, any>[]} */ candidates) => {
      asked.push(candidates.map(a => a.name));
      const redeemed = await onRedeem();
      // What a real redemption leaves behind: the hold dropped and the quota
      // re-read, so the account is selectable again.
      if (redeemed) am.applyCodexUsageData(candidates[0].index, { sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } });
      return { redeemed, reason: 'test' };
    },
  } : {};
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const proxyPort = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }),
    });
    await res.text();
    return { status: res.status, hits, asked, am };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a pool-dry refusal asks whether to redeem, and serves the request when one was', async () => {
  const r = await forwardOneRefusedRequest({ onRedeem: async () => true });
  assert.deepEqual(r.asked, [['a']]);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1, 'the request selection refused must actually be served afterwards');
});

test('a refusal with nothing to redeem is the refusal it always was', async () => {
  const r = await forwardOneRefusedRequest({ onRedeem: async () => false });
  assert.deepEqual(r.asked, [['a']]);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

test('a redeemer that throws leaves the refusal exactly as it was', async () => {
  const r = await forwardOneRefusedRequest({ onRedeem: async () => { throw new Error('upstream exploded'); } });
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

// Redeeming on an account the request could not use afterwards would spend
// something scarce for nothing: an operator's own decision survives a cleared
// quota window, so those accounts are never offered.
test('only the accounts a reset would return to service are offered', async () => {
  const r = await forwardOneRefusedRequest({
    onRedeem: async () => false,
    accounts: [codex('off', { disabled: true }), codex('a'), codex('capped', { maxUsage: { unified7d: 0.5 } })],
  });
  assert.deepEqual(r.asked, [['a']]);
});

test('an exhausted Anthropic fleet is refused without a word about reset credits', async () => {
  const r = await forwardOneRefusedRequest({
    onRedeem: async () => true,
    accounts: [oauth('claude')],
    path: '/v1/messages',
    model: 'claude-opus-4-1',
  });
  assert.deepEqual(r.asked, []);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

// A server built without the hook — every test that is not about redemption —
// refuses exactly as it did before the feature existed.
test('a proxy with no redeem hook refuses a dry pool unchanged', async () => {
  const r = await forwardOneRefusedRequest({ onRedeem: null });
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

// ── what the operator sees ──────────────────────────────────────────────────

// The badge count is the account's HOLDINGS (`available_count`), which says
// nothing about plan support — that is stated only by the detail rows, and
// they cost a request nobody should make to draw a badge. The two counts must
// stay distinguishable in the code; here they are simply never conflated.

test('the TUI row tags an account holding credits, and only then', () => {
  assert.equal(resetCreditTag({ resetCredits: { available: 1, applicable: 0 } }), 'RC1');
  assert.equal(resetCreditTag({ resetCredits: { available: 2, applicable: 2 } }), 'RC2');
  assert.equal(resetCreditTag({ resetCredits: { available: 0, applicable: 0 } }), '');
  assert.equal(resetCreditTag({ resetCredits: null }), '');
  assert.equal(resetCreditTag({}), '');
});

test('the status screen names the credits, and says when none would apply yet', () => {
  const paint = { dim: s => s, cyan: s => s, gray: s => s };
  assert.equal(resetCreditLine({ quota: {} }, paint), null);
  assert.equal(resetCreditLine({ quota: { resetCredits: { available: 0, applicable: 0 } } }, paint), null);

  const one = resetCreditLine({ quota: { resetCredits: { available: 1, applicable: 0 } } }, paint);
  assert.match(one, /1 free rate-limit reset credit/);
  assert.match(one, /none applicable to a window right now/);

  const two = resetCreditLine({ quota: { resetCredits: { available: 2, applicable: 1 } } }, paint);
  assert.match(two, /2 free rate-limit reset credits/);
  assert.equal(/none applicable/.test(two), false);
});

test('the status screen stays silent for an account holding nothing', () => {
  const account = { name: 'a', type: 'oauth', status: 'active', quota: { unified5h: 0.2, unified7d: 0.3 }, usage: {}, sessions: 0 };
  const out = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [account] }, { color: false });
  assert.equal(/Reset/.test(out), false);

  const holding = { ...account, quota: { ...account.quota, resetCredits: { available: 1, applicable: 0 } } };
  const shown = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [holding] }, { color: false });
  assert.match(shown, /Reset\s+1 free rate-limit reset credit/);
});

test('the dashboard card carries the same count', () => {
  const card = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 1, applicable: 0 } } }, 'a');
  assert.ok(card.some(b => b.text === '1 reset credit'));
  const plural = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 3, applicable: 1 } } }, 'a');
  assert.ok(plural.some(b => b.text === '3 reset credits'));
  const none = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 0, applicable: 0 } } }, 'a');
  assert.equal(none.some(b => /reset credit/.test(b.text)), false);
});

// ── the TUI switch ──────────────────────────────────────────────────────────

// The settings screen edits the SHARED config object the redeemer reads, so a
// toggle has to change that object AND persist. One without the other is either
// a switch that does nothing or one that does not survive a restart — and this
// is the switch whose whole point is being able to kill the feature at once.

const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function settingsTui(extra = {}) {
  /** @type {any[]} */
  const saved = [];
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const config = { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [], ...extra };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async (/** @type {any} */ c) => { saved.push(c.autoRedeemResets); },
    syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, config, saved };
}

const switchRow = (/** @type {any} */ tui) => tui._settingsFields().find((/** @type {any} */ f) => f.id === 'autoRedeemResets');

test('settings: the row reads off until the switch is set, then on', () => {
  assert.match(plain(switchRow(settingsTui().tui).value()), /^off$/);
  assert.match(plain(switchRow(settingsTui({ autoRedeemResets: false }).tui).value()), /^off$/);
  assert.match(plain(switchRow(settingsTui({ autoRedeemResets: true }).tui).value()), /^on$/);
});

test('settings: toggling flips the config the redeemer reads, and persists it', async () => {
  const { tui, config, saved } = settingsTui();
  await switchRow(tui).right();
  assert.equal(config.autoRedeemResets, true);
  assert.equal(saved.at(-1), true);
  assert.match(plain(switchRow(tui).value()), /^on$/);

  await switchRow(tui).left();
  assert.equal(config.autoRedeemResets, false);
  assert.equal(saved.at(-1), false);
  assert.match(plain(switchRow(tui).value()), /^off$/);
});

test('settings: Enter toggles it the same way ←→ do', async () => {
  const { tui, config } = settingsTui({ autoRedeemResets: true });
  await switchRow(tui).enter();
  assert.equal(config.autoRedeemResets, false);
});

// A save that throws must not leave the running fleet and the operator's screen
// disagreeing about a switch this consequential: the in-memory flip stands and
// the failure is said out loud.
test('settings: a failed save still leaves the switch where the operator put it', async () => {
  const { tui, config } = settingsTui();
  tui.saveConfig = async () => { throw new Error('disk full'); };
  await switchRow(tui).right();
  assert.equal(config.autoRedeemResets, true);
  assert.ok(tui.log.some((/** @type {any} */ l) => /Failed to save/.test(plain(l.msg))));
});

// ── configuration ───────────────────────────────────────────────────────────

// The absent key is the case that matters: a redemption cannot be undone and
// the credits are scarce, so an operator who has never heard of the feature
// must get a fleet that spends nothing.
test('the fleet switch defaults off in a fresh config', () => {
  assert.equal(createDefaultConfig().autoRedeemResets, false);
});

// Negative only: `true` and an absent key are the same statement, because
// nothing per-account arms anything.
test('accounts[].autoRedeemReset only ever vetoes', () => {
  const am = new AccountManager([
    codex('default'),
    codex('off', { autoRedeemReset: false }),
    codex('on', { autoRedeemReset: true }),
  ], 0.98);
  assert.equal(am.accounts[0].autoRedeemReset, true);
  assert.equal(am.accounts[1].autoRedeemReset, false);
  assert.equal(am.accounts[2].autoRedeemReset, true);
});

// The redeem decision reads this per refusal, so a disk edit must land on the
// running account — and must mirror onto memConfig, or the next TUI save spreads
// a stale key over it and silently reverts the edit. BOTH polarities mirror
// here, unlike the opt-in flags beside it: `false` is the side that acts.
test('reload applies and clears an account opt-out, and mirrors memConfig', async () => {
  const base = codex('a');
  const mem = { accounts: [{ ...base }] };
  const am = new AccountManager(mem.accounts, 0.98);
  assert.equal(am.accounts[0].autoRedeemReset, true);

  await syncAccountsFromDisk({ accounts: [{ ...base, autoRedeemReset: false }] }, mem, am);
  assert.equal(am.accounts[0].autoRedeemReset, false);
  assert.equal(mem.accounts[0].autoRedeemReset, false);

  // Taking the key back off returns the account to following the fleet switch.
  await syncAccountsFromDisk({ accounts: [{ ...base }] }, mem, am);
  assert.equal(am.accounts[0].autoRedeemReset, true);
  assert.equal('autoRedeemReset' in mem.accounts[0], false);
});

// The count is the only thing an operator sees when the probe is off, and the
// probe is off by default — so it has to survive a restart.
test('the credit count survives export and restore', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, { sevenDay: { utilization: 1, resetAt: Date.now() + DAY }, resetCredits: { available: 1, applicable: 0 } });
  assert.equal(am.accounts[0].quota.resetCredits.available, 1);
  assert.equal(typeof am.accounts[0].quota.resetCredits.seenAt, 'number');

  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const restored = new AccountManager([codex('a')], 0.98);
  restored.restoreQuotaState(saved);
  assert.equal(restored.accounts[0].quota.resetCredits.available, 1);
});

// A payload that says nothing about credits must not blank what we knew: the
// count is the one field here with no other source.
test('a usage reading with no credit counters leaves the last one alone', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, { resetCredits: { available: 1, applicable: 1 } });
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + DAY } });
  assert.equal(am.accounts[0].quota.resetCredits.available, 1);
});
