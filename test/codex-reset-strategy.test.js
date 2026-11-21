import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closedPort, spawnServer } from '../test-helpers/spawn-server.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { autoRedeemLine, renderStatus } from '../src/status-renderer.js';
import { ResetCreditRedeemer, redeemPreconditions, shouldRedeemReset } from '../src/codex-reset-credits.js';

// The spending strategy, through the redeemer and the control plane: the
// minimum-days floor, the cohort share cap and the per-day cap deciding which
// account a dry pool spends on; a redemption made by hand from the resets
// panel entering the same ledger; and the policy's standing on every status
// surface. Nothing here reaches the network — both endpoints are faked, as in
// codex-reset-credits.test.js.

const DAY = 24 * 60 * 60 * 1000;

function codex(name, extra = {}) {
  return { name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name, accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** Spent weekly window, natural reset `days` away (null = unknown). */
function spent(account, days, now = Date.now()) {
  account.quota.unified7d = 1;
  account.quota.unified7dReset = days == null ? null : now + days * DAY;
  account.quota.unified5h = 0.1;
  return account;
}

/**
 * Put every account's natural reset on ONE UTC calendar day, `daysAhead` days
 * from now and an hour apart. A cohort is a calendar day, so resets written as
 * "3 and 3.3 days from now" share one only at some hours of the day.
 */
function sameUtcDay(accounts, daysAhead, now = Date.now()) {
  const dayStart = (Math.floor(now / DAY) + daysAhead) * DAY;
  accounts.forEach((account, i) => { account.quota.unified7dReset = dayStart + (i + 1) * 60 * 60 * 1000; });
}

function credit(extra = {}) {
  return { id: 'RateLimitResetCredit_1', status: 'available', supportedByPlan: true, expiresAt: Date.now() + 30 * DAY, title: 'Full reset', ...extra };
}

/**
 * A redeemer over a pool of spent Codex accounts whose resets are `days` away
 * each, with both endpoints faked and the log captured. `extras[i]` is merged
 * into the i-th account's config entry.
 */
function harness({ days = [3, 3], extras = [], config = { autoRedeemResets: true }, code = 'reset', credits = null, caughtUp = true } = {}) {
  const now = Date.now();
  const am = new AccountManager(days.map((_, i) => codex(String.fromCharCode(97 + i), extras[i])), 0.98);
  am.accounts.forEach((account, i) => spent(account, days[i], now));
  const calls = { consume: [], details: [] };
  const log = [];
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    // The clock the resets above were set against, so a day is a day.
    now: () => now,
    log: line => log.push(line),
    detailsFn: async account => { calls.details.push(account.name); const rows = credits?.[account.name] ?? [credit({ id: `${account.name}-1` })]; return { credits: rows, availableCount: rows.length }; },
    consumeFn: async account => { calls.consume.push(account.name); return typeof code === 'function' ? code(account.name) : { code, windowsReset: 1, credit: null }; },
    usageFn: async () => ({ sevenDay: { utilization: caughtUp ? 0 : 1, resetAt: Date.now() + 7 * DAY } }),
  });
  return { am, redeemer, calls, log, now };
}

// ── the preconditions ───────────────────────────────────────────────────────

test('the floor is a precondition with its own reason, and off by default', () => {
  const now = Date.now();
  const account = spent({ ...codex('a'), quota: {} }, 1, now);
  assert.equal(redeemPreconditions({ account, autoRedeemResets: true }).ok, true, 'no floor passed: as before');
  const floored = redeemPreconditions({ account, autoRedeemResets: true, minDaysToReset: 2, now });
  assert.equal(floored.ok, false);
  assert.match(floored.reason, /natural weekly reset is 1d away, under the 2d minimum/);
  // The exhaustion check comes first: a healthy window is "not exhausted",
  // never "too close to reset".
  const healthy = { ...codex('h'), quota: { unified7d: 0.2, unified7dReset: Date.now() + DAY } };
  assert.equal(redeemPreconditions({ account: healthy, autoRedeemResets: true, minDaysToReset: 2 }).reason, 'weekly window is not exhausted');
  // And the policy function carries it through.
  const verdict = shouldRedeemReset({ account, autoRedeemResets: true, minDaysToReset: 2, pool: [], credits: [credit()] });
  assert.equal(verdict.redeem, false);
  assert.match(verdict.reason, /under the 2d minimum/);
});

// ── the floor at the refusal ────────────────────────────────────────────────

test('with no key set a dry pool spends exactly as before', async () => {
  const { am, redeemer, calls } = harness({ days: [0.5, 0.2] });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, true);
  assert.equal(calls.consume.length, 1);
});

test('the floor skips the account whose credit would buy too little, logs why, and spends on one that clears it', async () => {
  const { am, redeemer, calls, log } = harness({ days: [1, 4], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
  assert.deepEqual(calls.details, ['b'], 'the floored account never had its rows read');
  const skipped = log.find(line => /skipped/.test(line));
  assert.match(skipped, /^\[TeamClaude\] Codex rate-limit reset on "a" skipped — natural weekly reset is 1d away, under the 2d minimum \(the credit would buy 0\.14 of a week\)$/);
});

test('a whole pool under the floor spends nothing and states the floor as the reason', async () => {
  const { am, redeemer, calls } = harness({ days: [1, 0.5], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /under the 2d minimum/);
  assert.deepEqual(calls.consume, []);
});

test('an unchanged skip is logged once, not once per refused request', async () => {
  const { am, redeemer, log } = harness({ days: [1], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  for (let i = 0; i < 5; i++) await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(log.filter(line => /skipped/.test(line)).length, 1);
});

// ── the share cap at the refusal ────────────────────────────────────────────

test('a half share of one cohort redeems two of four and then holds, however dry the pool stays', async () => {
  // Four accounts resetting on the same UTC day; the fleet hold after each
  // success is stepped past by moving the clock, as a real week would.
  const { am, redeemer, calls, log } = harness({ days: [3, 3, 3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  // The accounts a redemption has not touched: the ones still on their natural
  // phase, which a real re-read would leave spent while the redeemed ones serve.
  const untouched = () => am.accounts.filter(a => !redeemer.ledger.some(r => r.account === a));
  const dry = async () => {
    const result = await redeemer.maybeRedeemForPool(untouched());
    clock += 7 * 60 * 60 * 1000;
    return result;
  };
  assert.equal((await dry()).redeemed, true);
  assert.equal((await dry()).redeemed, true);
  assert.equal(untouched().length, 2);
  const third = await dry();
  assert.equal(third.redeemed, false);
  assert.match(third.reason, /cohort of 4 already had 2 redeemed, the 50% share cap allows 2/);
  assert.equal((await dry()).redeemed, false, 'however many refusals follow, the other half keeps its phase');
  assert.equal(calls.consume.length, 2);
  assert.ok(log.some(line => /skipped — its reset cohort of 4 already had 2 redeemed/.test(line)));
});

test('under a share cap the cohort slot goes to the most exhausted, not the soonest-expiring credit', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = harness({
    days: [3, 3],
    config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 },
    credits: { a: [credit({ id: 'a-1', expiresAt: now + 2 * DAY })], b: [credit({ id: 'b-1', expiresAt: now + 20 * DAY })] },
  });
  // `a` holds the credit about to be lost; `b` is further past its window.
  am.accounts[1].quota.unified7d = 1.3;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
});

test('without a share cap the soonest-expiring credit is still spent first', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = harness({
    days: [3, 3],
    credits: { a: [credit({ id: 'a-1', expiresAt: now + 2 * DAY })], b: [credit({ id: 'b-1', expiresAt: now + 20 * DAY })] },
  });
  am.accounts[1].quota.unified7d = 1.3;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.consume, ['a']);
});

test('a share cap leaves a disabled and a cordoned account out of a cohort, and keeps a capped one in', async () => {
  // Four accounts reset on one UTC day, and two of them are out of service.
  // Half of the two that can move is one; counted over all four it was both.
  // A fifth, capped and resetting on another day, is not offered either, but
  // stays in the members: its cap is read off its usage, which changes within
  // the week.
  const { am, redeemer, calls, log } = harness({
    days: [3, 3, 3, 3, 5], extras: [{}, {}, { disabled: true }, { cordoned: true }, { maxUsage: { unified7d: 0.5 } }],
    config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false,
  });
  let clock = Date.now();
  sameUtcDay(am.accounts.slice(0, 4), 3, clock);
  redeemer.now = () => clock;
  // What server.js offers a refusal: the two in service, and here the ones a
  // redemption has not touched.
  const offered = () => am.accounts.slice(0, 2).filter(a => !redeemer.ledger.some(r => r.account === a));
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  const second = await redeemer.maybeRedeemForPool(offered());
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /cohort of 2 already had 1 redeemed, the 50% share cap allows 1/);
  assert.equal(calls.consume.length, 1);
  assert.ok(log.some(line => /skipped — its reset cohort of 2 already had 1 redeemed/.test(line)));
  assert.equal(am.unavailableReason(am.accounts[4]), 'capped');
  assert.deepEqual(redeemer._members().map(a => a.name), ['a', 'b', 'e']);
});

test('a cohort is counted over armed Codex accounts only: a Claude row and an opted-out one on the same day do not widen it', async () => {
  const { am, redeemer, calls } = harness({
    days: [3, 3, 3, 3], extras: [{}, {}, { autoRedeemReset: false }, { provider: 'anthropic' }],
    config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false,
  });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  const offered = () => am.accounts.slice(0, 2).filter(a => !redeemer.ledger.some(r => r.account === a));
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, false);
  assert.equal(calls.consume.length, 1, 'one of the two armed Codex accounts, not two of four rows');
});

test('an account waiting for a sign-in does not widen its cohort either', async () => {
  // `status: 'error'` is a refused refresh token or credential: it lasts
  // until a new sign-in, and a refusal never offers it.
  const { am, redeemer, calls } = harness({ days: [3, 3, 3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  am.accounts[2].status = 'error';
  am.accounts[3].status = 'error';
  const offered = () => am.accounts.filter(a => a.status !== 'error' && !redeemer.ledger.some(r => r.account === a));
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  assert.match((await redeemer.maybeRedeemForPool(offered())).reason, /cohort of 2 already had 1 redeemed, the 50% share cap allows 1/);
  assert.equal(calls.consume.length, 1);
});

/**
 * From here on upstream refuses every Codex refresh token, as a sign-in
 * elsewhere makes it do, and answers a credit read on an expired access token
 * with a 401. `account`'s token is expired, so the next read of its rows
 * refreshes it, and the refused refresh puts it in the error state.
 */
function refuseRefreshOf(am, redeemer, account) {
  am._codexRefreshFn = async () => { throw Object.assign(new Error('Codex token refresh failed (400): invalid_grant'), { status: 400 }); };
  account.expiresAt = Date.now() - 1000;
  const details = redeemer.detailsFn;
  redeemer.detailsFn = async (read, opts) => (read.expiresAt < Date.now() ? { error: 'HTTP 401', status: 401 } : details(read, opts));
}

test('an account a refused refresh puts in the error state during the reads leaves its cohort before the walk spends', async () => {
  // Three accounts reset on one UTC day and a has redeemed: a half share of
  // three allows two. The next refusal offers b and c, and upstream refuses
  // c's refresh token while the rows are read, which puts c in the error
  // state a cohort leaves out. Half of the two left is one, already used.
  for (const order of [['b', 'c'], ['c', 'b']]) {
    const { am, redeemer, calls, log } = harness({ days: [3, 3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
    let clock = Date.now();
    sameUtcDay(am.accounts, 3, clock);
    redeemer.now = () => clock;
    const [a, , c] = am.accounts;
    assert.equal((await redeemer.maybeRedeemForPool([a])).redeemed, true);
    clock += 7 * 60 * 60 * 1000;
    refuseRefreshOf(am, redeemer, c);
    const result = await redeemer.maybeRedeemForPool(order.map(name => am.accounts.find(account => account.name === name)));
    assert.equal(c.status, 'error', `${order}: the refused refresh put c in the error state`);
    assert.equal(result.redeemed, false, order.join());
    assert.match(result.reason, /cohort of 2 already had 1 redeemed, the 50% share cap allows 1/, order.join());
    assert.deepEqual(calls.consume, ['a'], order.join());
    assert.ok(log.some(line => /"b" skipped — its reset cohort of 2 already had 1 redeemed/.test(line)), order.join());
  }
});

test('an account the share cap holds back after the reads does not end the walk: one alone on a later day is still spent', async () => {
  // As above, and d resets alone two days later, a cohort of one that allows
  // one. b is the most exhausted, so the walk asks it first; c has left the
  // cohort by then, the cap holds b back, and the walk moves on to d.
  for (const order of [['b', 'c', 'd'], ['c', 'b', 'd']]) {
    const { am, redeemer, calls } = harness({ days: [3, 3, 3, 5], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
    let clock = Date.now();
    sameUtcDay(am.accounts.slice(0, 3), 3, clock);
    redeemer.now = () => clock;
    const [a, b, c] = am.accounts;
    assert.equal((await redeemer.maybeRedeemForPool([a])).redeemed, true);
    clock += 7 * 60 * 60 * 1000;
    b.quota.unified7d = 1.3;
    refuseRefreshOf(am, redeemer, c);
    const result = await redeemer.maybeRedeemForPool(order.map(name => am.accounts.find(account => account.name === name)));
    assert.equal(c.status, 'error', `${order}: the refused refresh put c in the error state`);
    assert.equal(result.redeemed, true, order.join());
    assert.deepEqual(calls.consume, ['a', 'd'], order.join());
  }
});

test('the fleet switch turned off during the reads is the reason the walk gives, not the share cap', async () => {
  // No account changes: the switch is turned off while c's rows are read,
  // which leaves every account out of the members. The walk says the switch
  // is off, and logs no share-cap skip for an account the cap never held
  // back.
  const config = { autoRedeemResets: true, autoRedeemMaxShare: 0.5 };
  const { am, redeemer, calls, log } = harness({ days: [3, 3, 3], config, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  const [a, b, c] = am.accounts;
  assert.equal((await redeemer.maybeRedeemForPool([a])).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  const details = redeemer.detailsFn;
  redeemer.detailsFn = async (read, opts) => {
    if (read === c) config.autoRedeemResets = false;
    return details(read, opts);
  };
  const result = await redeemer.maybeRedeemForPool([b, c]);
  assert.equal(result.redeemed, false);
  assert.equal(result.reason, 'auto-redeem is switched off');
  assert.deepEqual(calls.consume, ['a']);
  assert.deepEqual(log.filter(line => /skipped/.test(line)), []);
});

test('the share cap is asked again before each decision: an account the walk leaves in the error state is out of the next one\'s cohort', async () => {
  // a, b and c reset on one UTC day and a has redeemed: one slot is left. c
  // is the most exhausted, so it is decided first. Once its rows are read its
  // token is inside the five minutes before expiry, so the consume refreshes
  // it, upstream rejects the refresh token, and the consume answers that no
  // credit was there. The walk moves on to b with c in the error state: half
  // of the two left is one, already used.
  const { am, redeemer, calls, log } = harness({
    days: [3, 3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false,
    code: name => (name === 'c' ? { code: 'no_credit', windowsReset: 0, credit: null } : { code: 'reset', windowsReset: 1, credit: null }),
  });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  const [a, b, c] = am.accounts;
  assert.equal((await redeemer.maybeRedeemForPool([a])).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  c.quota.unified7d = 1.3;
  am._codexRefreshFn = async () => { throw Object.assign(new Error('Codex token refresh failed (400): invalid_grant'), { status: 400 }); };
  const details = redeemer.detailsFn;
  redeemer.detailsFn = async (read, opts) => {
    const rows = await details(read, opts);
    if (read === c) c.expiresAt = Date.now() + 60_000;
    return rows;
  };
  const result = await redeemer.maybeRedeemForPool([b, c]);
  assert.equal(c.status, 'error', 'the consume\'s refresh put c in the error state');
  assert.deepEqual(calls.consume, ['a', 'c']);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /cohort of 2 already had 1 redeemed, the 50% share cap allows 1/);
  assert.ok(log.some(line => /"b" skipped — its reset cohort of 2 already had 1 redeemed/.test(line)));
});

test('a throttled account of the same day still counts in its cohort: a refusal offers it', async () => {
  const { am, redeemer, calls } = harness({ days: [3, 3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  Object.assign(am.accounts[2], { status: 'throttled', rateLimitedUntil: Date.now() + 60 * 60 * 1000 });
  const offered = () => am.accounts.slice(0, 2).filter(a => !redeemer.ledger.some(r => r.account === a));
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  assert.equal((await redeemer.maybeRedeemForPool(offered())).redeemed, true, 'a half share of three allows two');
  assert.equal(calls.consume.length, 2);
});

test('the status standing sizes a cohort over the same accounts the walk does', async () => {
  const { am, redeemer } = harness({
    days: [3, 3, 3, 3], extras: [{}, {}, { disabled: true }, { cordoned: true }],
    config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false,
  });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  const [a, b] = am.accounts;
  assert.equal((await redeemer.redeemGrant(a, 'a-1', { manual: true })).redeemed, true);
  const standing = redeemer.describe(b);
  assert.equal(standing.armed, false);
  assert.equal(standing.exemptReason, 'its reset cohort of 2 already had 1 redeemed, the 50% share cap allows 1');
});

test('accounts in different cohorts are capped separately', async () => {
  const { am, redeemer, calls } = harness({ days: [2, 5], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  for (const account of am.accounts) { account.quota.unified7d = 1; const s = redeemer.state.get(account); if (s) s.cooldownUntil = 0; }
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.equal(calls.consume.length, 2, 'a cohort of one allows one, twice over');
});

// ── the per-day cap at the refusal ──────────────────────────────────────────

test('the per-day cap stops the fleet after N automatic redemptions in 24 hours, and lifts afterwards', async () => {
  const { am, redeemer, calls, log } = harness({ days: [3, 5, 6], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  const dry = async () => {
    const result = await redeemer.maybeRedeemForPool(am.accounts);
    for (const account of am.accounts) { account.quota.unified7d = 1; const s = redeemer.state.get(account); if (s) s.cooldownUntil = 0; }
    return result;
  };
  assert.equal((await dry()).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  const capped = await dry();
  assert.equal(capped.redeemed, false);
  assert.match(capped.reason, /daily cap of 1 auto-redemption is reached \(1 in the last 24h\)/);
  assert.ok(log.some(line => /skipped — the daily cap of 1/.test(line)));
  clock += 18 * 60 * 60 * 1000;
  assert.equal((await dry()).redeemed, true, 'a day later the cap has room again');
  assert.equal(calls.consume.length, 2);
});

test('a reached per-day cap is asked before any token is refreshed or credit row read', async () => {
  const { am, redeemer, calls } = harness({ days: [3, 4, 5], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1 } });
  let clock = Date.now();
  redeemer.now = () => clock;
  const refreshes = [];
  const ensure = am.ensureTokenFresh.bind(am);
  am.ensureTokenFresh = async index => { refreshes.push(index); return ensure(index); };
  assert.equal((await redeemer.maybeRedeemForPool([am.accounts[0]])).redeemed, true);
  const [details, refreshed] = [calls.details.length, refreshes.length];
  // Past the fleet hold and past the cached rows, three times over.
  for (let i = 0; i < 3; i++) {
    clock += 7 * 60 * 60 * 1000;
    const capped = await redeemer.maybeRedeemForPool(am.accounts.slice(1));
    assert.match(capped.reason, /daily cap of 1/);
  }
  assert.deepEqual(calls.details.slice(details), []);
  assert.deepEqual(refreshes.slice(refreshed), []);
  assert.deepEqual(calls.consume, ['a']);
});

test('a reached per-day cap over accounts that all fail their preconditions answers with the precondition', async () => {
  const { am, redeemer, calls } = harness({ days: [3, 1], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1, autoRedeemMinDaysToReset: 2 } });
  let clock = Date.now();
  redeemer.now = () => clock;
  assert.equal((await redeemer.maybeRedeemForPool([am.accounts[0]])).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  // b is under the floor, so no account is left to put to the cap.
  const result = await redeemer.maybeRedeemForPool([am.accounts[1]]);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /under the 2d minimum/);
  assert.deepEqual(calls.consume, ['a']);
});

test('an account the share cap holds back has no credit row read', async () => {
  const { am, redeemer, calls } = harness({ days: [3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts, 3, clock);
  redeemer.now = () => clock;
  const [a, b] = am.accounts;
  a.quota.unified7d = 1.3;
  assert.equal((await redeemer.maybeRedeemForPool([a, b])).redeemed, true);
  assert.deepEqual(calls.consume, ['a']);
  const read = calls.details.length;
  clock += 7 * 60 * 60 * 1000;
  assert.match((await redeemer.maybeRedeemForPool([b])).reason, /share cap allows 1/);
  assert.deepEqual(calls.details.slice(read), [], 'past the cached rows, and still not read');
});

test('an account the share cap holds back does not end the walk: the next one is still asked', async () => {
  // a and b share a cohort, and a redemption of a has used its one slot; c is
  // alone in a later one. b is the most exhausted, so it is asked first.
  const { am, redeemer, calls } = harness({ days: [3, 3, 5], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  sameUtcDay(am.accounts.slice(0, 2), 3, clock);
  redeemer.now = () => clock;
  const [a, b, c] = am.accounts;
  assert.equal((await redeemer.redeemGrant(a, 'a-1', { manual: true })).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  b.quota.unified7d = 1.3;
  const next = await redeemer.maybeRedeemForPool([b, c]);
  assert.equal(next.redeemed, true);
  assert.deepEqual(calls.consume, ['a', 'c']);
});

test('the per-day cap is logged once, against the first account it stops, not once per account', async () => {
  const { am, redeemer, log } = harness({ days: [3, 4, 5], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  assert.equal((await redeemer.maybeRedeemForPool([am.accounts[0]])).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  assert.match((await redeemer.maybeRedeemForPool(am.accounts.slice(1))).reason, /daily cap of 1/);
  assert.deepEqual(log.filter(line => /skipped/.test(line)), [
    '[TeamClaude] Codex rate-limit reset on "b" skipped — the daily cap of 1 auto-redemption is reached (1 in the last 24h)',
  ]);
});

test('while every answer is read, the six-hour hold already keeps automatic redemptions to 4 a day', async () => {
  // A dry refusal every half hour for a day, over more spent accounts than
  // that: a per-day cap of 4 or more changes nothing, one of 3 binds.
  for (const [perDay, spends] of [[undefined, 4], [4, 4], [10, 4], [3, 3]]) {
    const { am, redeemer, calls } = harness({ days: Array(8).fill(3), config: { autoRedeemResets: true, autoRedeemMaxPerDay: perDay }, caughtUp: false });
    let clock = Date.now();
    redeemer.now = () => clock;
    for (let i = 0; i < 48; i++) {
      await redeemer.maybeRedeemForPool(am.accounts.filter(a => !calls.consume.includes(a.name)));
      clock += 30 * 60 * 1000;
    }
    assert.equal(calls.consume.length, spends, `autoRedeemMaxPerDay ${perDay}`);
  }
});

// ── a redemption made by hand ───────────────────────────────────────────────

// The resets panel (reset-actions.js) spends through redeemGrant with
// `manual: true`. That is the same call the automatic walk ends in, so the
// ledger sees both.

test('a manual redemption takes a slot of its cohort, so the share cap holds the rest', async () => {
  const { am, redeemer, calls, log } = harness({ days: [3, 3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  sameUtcDay(am.accounts, 3, clock);
  const [a, b] = am.accounts;
  assert.equal((await redeemer.redeemGrant(a, 'a-1', { manual: true })).redeemed, true);
  assert.equal(redeemer.ledger.length, 1);
  assert.equal(redeemer.ledger[0].manual, true);
  assert.equal(redeemer.ledger[0].account, a);
  // Past the fleet hold a redemption arms, the other half of the cohort is
  // still held: one of two at a half share is the whole allowance.
  clock += 7 * 60 * 60 * 1000;
  const next = await redeemer.maybeRedeemForPool([b]);
  assert.equal(next.redeemed, false);
  assert.match(next.reason, /cohort of 2 already had 1 redeemed, the 50% share cap allows 1/);
  assert.deepEqual(calls.consume, ['a']);
  assert.ok(log.some(line => /"b" skipped — its reset cohort of 2 already had 1 redeemed/.test(line)));
});

test('a manual redemption does not count against the per-day cap', async () => {
  const { am, redeemer, calls } = harness({ days: [3, 5], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  const [a, b] = am.accounts;
  assert.equal((await redeemer.redeemGrant(a, 'a-1', { manual: true })).redeemed, true);
  assert.equal(redeemer.policyStatus().redeemedLast24h, 0);
  clock += 7 * 60 * 60 * 1000;
  assert.equal((await redeemer.maybeRedeemForPool([b])).redeemed, true, 'the one automatic redemption of the day is still there to spend');
  assert.deepEqual(calls.consume, ['a', 'b']);
  assert.equal(redeemer.policyStatus().redeemedLast24h, 1);
});

test('a redemption whose answer was lost is charged to the cohort the account was in when it was sent', async () => {
  let answers = 0;
  const { am, redeemer } = harness({
    days: [3], config: { autoRedeemResets: true },
    code: () => (answers++ === 0 ? { error: 'socket hang up' } : { code: 'already_redeemed', windowsReset: 1, credit: null }),
  });
  let clock = Date.now();
  redeemer.now = () => clock;
  const [a] = am.accounts;
  const before = a.quota.unified7dReset;
  const lost = await redeemer.maybeRedeemForPool([a]);
  assert.equal(lost.redeemed, false);
  assert.equal(redeemer.ledger.length, 0, 'no verdict, no record');
  // The POST did land: a quota read in between already shows the moved timer.
  a.quota.unified7dReset = clock + 7 * DAY;
  clock += 31 * 60 * 1000;
  const replay = await redeemer.maybeRedeemForPool([a]);
  assert.equal(replay.redeemed, true);
  assert.equal(replay.code, 'already_redeemed');
  assert.equal(redeemer.ledger.length, 1);
  assert.equal(redeemer.ledger[0].cohort, Math.floor(before / DAY));
});

test('a consume whose answer was lost comes back from the walk as uncertain', async () => {
  const { am, redeemer, calls } = harness({ days: [3], code: () => ({ error: 'socket hang up' }) });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.equal(result.uncertain, true);
  assert.match(result.reason, /it may still have been spent/);
  assert.deepEqual(calls.consume, ['a']);
});

// ── the status payload ──────────────────────────────────────────────────────

test('describe answers for a Codex row and null for any other', () => {
  const { am, redeemer } = harness({ days: [3.5], config: { autoRedeemResets: true } });
  assert.deepEqual(redeemer.describe(am.accounts[0]), { armed: true, exemptReason: null, creditValueWeeks: 0.5, daysToReset: 3.5 });
  assert.equal(redeemer.describe({ name: 'claude', type: 'oauth', quota: {} }), null);
  // With the fleet switch off nothing is spent automatically, so there is no
  // standing to report and the status screen prints no Redeem line.
  const off = harness({ days: [3.5], config: { autoRedeemResets: false, autoRedeemMinDaysToReset: 2 } });
  assert.equal(off.redeemer.describe(off.am.accounts[0]), null);
  assert.deepEqual(redeemer.policyStatus(), { minDaysToReset: 0, maxShare: 1, maxPerDay: 0, redeemedLast24h: 0 });
});

test('the status screen prints a Redeem line per Codex account, and nothing where the payload has none', () => {
  const paint = { dim: s => s, green: s => s, yellow: s => s, gray: s => s };
  assert.equal(autoRedeemLine({ quota: {} }, paint), null);
  assert.equal(autoRedeemLine({ autoRedeem: null }, paint), null);
  const armed = autoRedeemLine({ autoRedeem: { armed: true, exemptReason: null, creditValueWeeks: 0.43 } }, paint);
  assert.match(armed, /^Redeem\s+armed, credit worth 0\.43 of a week \(3\.0d to reset\)$/);
  const exempt = autoRedeemLine({ autoRedeem: { armed: false, exemptReason: 'auto-redeem is switched off', creditValueWeeks: null } }, paint);
  assert.match(exempt, /^Redeem\s+exempt — auto-redeem is switched off, credit value unknown \(no reset time\)$/);

  const row = { name: 'a', type: 'oauth', provider: 'codex', status: 'active', quota: { unified5h: 0.2, unified7d: 1 }, usage: {}, sessions: 0, autoRedeem: { armed: true, exemptReason: null, creditValueWeeks: 0.5 } };
  const out = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [row] }, { color: false });
  assert.match(out, /Redeem\s+armed, credit worth 0\.50 of a week/);
  const plain = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [{ ...row, autoRedeem: undefined }] }, { color: false });
  assert.equal(/Redeem/.test(plain), false);
});

test('the Redeem line states the days to reset as the floor\'s reason does, never rounded up to the minimum', () => {
  const paint = { dim: s => s, green: s => s, yellow: s => s, gray: s => s };
  // 1.04 and 1.96 days: credits worth 0.15 and 0.28 of a week, which worked
  // back to days read 1.05 and 1.96, and rounded read 1.1 and 2.0.
  for (const [days, shown] of [[1.04, '1d away.*\\(1\\.0d to reset\\)'], [1.96, '1\\.9d away.*\\(1\\.9d to reset\\)']]) {
    const { am, redeemer } = harness({ days: [days], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
    const line = autoRedeemLine({ autoRedeem: redeemer.describe(am.accounts[0]) }, paint);
    assert.match(line, new RegExp(`exempt — natural weekly reset is ${shown}$`));
    assert.match(line, /under the 2d minimum/);
  }
  // Its weeks and days agree with each other too: rounded to the nearest
  // hundredth, 6.199 days read "0.89 of a week", which is 6.23 days.
  const { am, redeemer } = harness({ days: [6.199] });
  assert.match(autoRedeemLine({ autoRedeem: redeemer.describe(am.accounts[0]) }, paint), /armed, credit worth 0\.88 of a week \(6\.1d to reset\)$/);
});

// ── the control plane ───────────────────────────────────────────────────────

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** The real proxy server over a faked redeemer, wired the way index.js wires it. */
async function controlPlane({ days = [3], config = { autoRedeemResets: true }, withHooks = true } = {}) {
  const h = harness({ days, config });
  const hooks = withHooks ? {
    describeAutoRedeem: account => h.redeemer.describe(account),
    getStatusExtra: () => ({ redeemPolicy: h.redeemer.policyStatus() }),
  } : {};
  const serverConfig = { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'tenant', key: 'tc-tenant' }] }, upstream: 'https://api.anthropic.com', ...config };
  const proxy = createProxyServer(h.am, serverConfig, hooks);
  const port = await listen(proxy);
  const call = (path, { method = 'GET', body, key = 'tc-test' } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body),
  }).then(async res => ({ status: res.status, data: await res.json() }));
  return { ...h, proxy, port, call, close: () => { proxy.closeAllConnections?.(); proxy.close(); } };
}

test('/teamclaude/status carries each Codex account\'s standing and the fleet policy', async () => {
  const cp = await controlPlane({ days: [3.5], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 2 } });
  try {
    const { status, data } = await cp.call('/teamclaude/status');
    assert.equal(status, 200);
    assert.deepEqual(data.accounts[0].autoRedeem, { armed: true, exemptReason: null, creditValueWeeks: 0.5, daysToReset: 3.5 });
    assert.deepEqual(data.redeemPolicy, { minDaysToReset: 0, maxShare: 1, maxPerDay: 2, redeemedLast24h: 0 });
  } finally {
    cp.close();
  }
});

/**
 * Resolves once the spawned server's output carries `pattern`, read off its
 * output events rather than a timer. Rejects once the test has ended however
 * it ended (test/README.md), so the `finally` that stops the server runs.
 */
function said(server, pattern, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      server.child.stdout.off('data', look);
      server.child.stderr.off('data', look);
      signal.removeEventListener('abort', ended);
    };
    const look = () => { if (pattern.test(server.output())) { stop(); resolve(); } };
    const ended = () => { stop(); reject(new Error(`the server never said ${pattern}`)); };
    server.child.stdout.on('data', look);
    server.child.stderr.on('data', look);
    signal.addEventListener('abort', ended);
    look();
  });
}

test('the server says at start and at a reload which reset-credit limit it reads as off', { timeout: 60_000 }, async t => {
  const server = await spawnServer({
    config: () => ({ proxy: { apiKey: 'tc-test' }, upstreamProxy: false, autoRedeemMaxShare: 50, accounts: [{ name: 'a', type: 'apikey', apiKey: 'k-a' }] }),
  });
  try {
    await said(server, /autoRedeemMaxShare is 50, which is not a fraction strictly between 0 and 1, so the cohort share cap is off/, t.signal);
    await writeFile(server.configPath, JSON.stringify({ ...server.config, autoRedeemMaxShare: 0.5, autoRedeemMaxPerDay: '2/day' }));
    const reload = await fetch(`http://127.0.0.1:${server.port}/teamclaude/reload`, { method: 'POST', headers: { 'x-api-key': 'tc-test' }, signal: t.signal });
    assert.equal(reload.status, 200);
    await said(server, /autoRedeemMaxPerDay is "2\/day", which is not a whole number above 0, so the per-day cap is off/, t.signal);
  } finally {
    await server.stop();
  }
});

/**
 * Resolves once `file` holds `pattern`, read again on each change the file
 * system reports rather than on a timer. Rejects once the test has ended.
 */
function written(file, pattern, signal) {
  return new Promise((resolve, reject) => {
    const watcher = watch(file);
    const stop = () => { watcher.close(); signal.removeEventListener('abort', ended); };
    const look = () => readFile(file, 'utf8').then(text => { if (pattern.test(text)) { stop(); resolve(); } }, () => {});
    const ended = () => { stop(); reject(new Error(`${file} never held ${pattern}`)); };
    watcher.on('change', look);
    signal.addEventListener('abort', ended);
    look();
  });
}

test('a redeemer\'s line reaches the --activity-log file, not only the console', { timeout: 60_000 }, async t => {
  // The redeemers are built before headless mode tees the console into the
  // activity file, and under a TUI while its start holds the console, so a
  // log bound as they are built reaches neither. A Codex account saved as
  // spent, a day from its reset, under a 3-day floor: a refused Codex
  // request has the walk skip it and say so.
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-redeem-log-'));
  const activity = join(dir, 'activity.log');
  const now = Date.now();
  await writeFile(join(dir, 'config.state.json'), JSON.stringify({
    quota: [{ provider: 'codex', accountId: 'acct-a', name: 'a', quota: { unified7d: 1, unified7dReset: now + DAY, unified7dSeenAt: now } }],
  }));
  // An upstream nothing listens on, for the probe a dry pool sends first.
  const dead = await closedPort();
  const server = await spawnServer({
    dir, args: ['--activity-log', activity],
    config: () => ({
      proxy: { apiKey: 'tc-test' }, upstreamProxy: false, autoRedeemResets: true, autoRedeemMinDaysToReset: 3,
      accounts: [{ name: 'a', type: 'oauth', provider: 'codex', accountId: 'acct-a', accessToken: 't-a', refreshToken: 'r-a', expiresAt: now + 3600_000, upstream: `http://127.0.0.1:${dead}` }],
    }),
  });
  try {
    const ask = () => fetch(`http://127.0.0.1:${server.port}/backend-api/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [] }), signal: t.signal,
    }).then(res => res.text().then(() => res.status), () => null);
    // The first request a dry pool turns away revalidates it with a probe;
    // the next, inside the probe's minute, is refused outright.
    await ask();
    assert.equal(await ask(), 429);
    const line = /Codex rate-limit reset on "a" skipped — natural weekly reset is [\d.]+d away, under the 3d minimum/;
    await said(server, line, t.signal);
    await written(activity, line, t.signal);
  } finally {
    await server.stop();
  }
});

test('a server built without the hooks answers status as before', async () => {
  const cp = await controlPlane({ withHooks: false });
  try {
    const { data } = await cp.call('/teamclaude/status');
    assert.equal('autoRedeem' in data.accounts[0], false);
    assert.equal('redeemPolicy' in data, false);
  } finally {
    cp.close();
  }
});
