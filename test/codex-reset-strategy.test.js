import { test } from 'node:test';
import assert from 'node:assert/strict';
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
 * each, with both endpoints faked and the log captured.
 */
function harness({ days = [3, 3], config = { autoRedeemResets: true }, code = 'reset', credits = null, caughtUp = true } = {}) {
  const now = Date.now();
  const am = new AccountManager(days.map((_, i) => codex(String.fromCharCode(97 + i))), 0.98);
  am.accounts.forEach((account, i) => spent(account, days[i], now));
  const calls = { consume: [], details: [] };
  const log = [];
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    log: line => log.push(line),
    detailsFn: async account => { calls.details.push(account.name); const rows = credits?.[account.name] ?? [credit({ id: `${account.name}-1` })]; return { credits: rows, availableCount: rows.length }; },
    consumeFn: async account => { calls.consume.push(account.name); return typeof code === 'function' ? code(account.name) : { code, windowsReset: 1, credit: null }; },
    usageFn: async () => ({ sevenDay: { utilization: caughtUp ? 0 : 1, resetAt: Date.now() + 7 * DAY } }),
  });
  return { am, redeemer, calls, log, now };
}

// ── the preconditions ───────────────────────────────────────────────────────

test('the floor is a precondition with its own reason, and off by default', () => {
  const account = spent({ ...codex('a'), quota: {} }, 1);
  assert.equal(redeemPreconditions({ account, autoRedeemResets: true }).ok, true, 'no floor passed: as before');
  const floored = redeemPreconditions({ account, autoRedeemResets: true, minDaysToReset: 2 });
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

// ── the status payload ──────────────────────────────────────────────────────

test('describe answers for a Codex row and null for any other', () => {
  const { am, redeemer } = harness({ days: [3.5], config: { autoRedeemResets: true } });
  assert.deepEqual(redeemer.describe(am.accounts[0]), { armed: true, exemptReason: null, creditValueWeeks: 0.5 });
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
    assert.deepEqual(data.accounts[0].autoRedeem, { armed: true, exemptReason: null, creditValueWeeks: 0.5 });
    assert.deepEqual(data.redeemPolicy, { minDaysToReset: 0, maxShare: 1, maxPerDay: 2, redeemedLast24h: 0 });
  } finally {
    cp.close();
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
