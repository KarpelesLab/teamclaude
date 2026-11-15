import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createDefaultConfig } from '../src/config.js';
import { parseResetStatus, chooseAutoGrant, claimClaudeReset, blockedUntil, ClaudeResetRedeemer } from '../src/claude-resets.js';

// Banked Claude usage-limit resets. Nothing here reaches the network: the claim
// spends a real reset on a real account, so every test injects its own fetch.

const H = 3600_000, DAY = 24 * H;
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, orgUuid: 'org-' + name, ...extra });
const ARMED = { autoRedeemResets: true };

/** The cedar_ember block of an account at its Fable limit holding one reset. */
function block(extra = {}, grant = {}) {
  return {
    eligible: true, ineligible_reason: null, at_limit: true, exhausted: ['seven_day_overage_included'],
    next_grant_id: 'opus55-launch-promax-20260921', cooldown_until: null,
    grants: [{ id: 'opus55-launch-promax-20260921', label: 'x', resets_total: 1, resets_left: 1,
      clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], usable_now: true, paused: false,
      use_requires_limit: false, ends_at: new Date(Date.now() + 12 * DAY).toISOString(), ...grant }],
    ...extra,
  };
}

function grantBlock(grants, extra = {}) {
  const base = block().grants[0];
  return block({ next_grant_id: 'weekly', grants: grants.map(g => ({ ...base, ...g })), ...extra });
}

const weeklyGrant = { id: 'weekly', type: 'weekly', clears: ['five_hour', 'seven_day', 'seven_day_overage_included'] };
const fableGrant = { id: 'fable', type: 'full', clears: ['seven_day_overage_included'] };

function fableSpent(account, resetIn) {
  Object.assign(account.quota, { unified5h: 0.1, unified7d: 0.5, unified7dFable: 1, unified7dFableReset: Date.now() + resetIn });
  return account;
}

function harness({ accounts = [oauth('a')], status = () => block(), claim = () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }), config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => fableSpent(a, (i + 1) * DAY));
  const calls = { status: 0, claim: [], grants: [], keys: [], logs: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: line => calls.logs.push(line),
    statusFn: async (account) => { calls.status++; const b = status(account, calls); return { reset: parseResetStatus(b), usage: { fiveHour: { utilization: 0 }, sevenDay: { utilization: 0 }, sevenDayFable: { utilization: 0 } } }; },
    claimFn: async (account, c) => { calls.claim.push(account.name); calls.grants.push(c.grantId); calls.keys.push(c.requestId); return claim(calls.claim.length, c); },
  });
  am.ensureTokenFresh = async () => {};
  return { am, redeemer, calls };
}

// ── parsing ─────────────────────────────────────────────────────────────────

test('the reset block parses and validates the next grant id', () => {
  const s = parseResetStatus(block());
  assert.equal(s.eligible, true); assert.equal(s.atLimit, true);
  assert.deepEqual(s.exhausted, ['seven_day_overage_included']);
  assert.equal(s.nextGrantId, 'opus55-launch-promax-20260921');
  assert.equal(parseResetStatus(block({ next_grant_id: null })).nextGrantId, null);
  assert.equal(parseResetStatus(block({ next_grant_id: 'someone-else' })).nextGrantId, null, 'a next id naming no listed grant is not trusted');
  assert.equal(parseResetStatus(null), null);
  assert.equal(parseResetStatus({ eligible: 'yes' }), null);
});

test('auto choice ranks Fable before session before weekly, without changing the status', () => {
  const s = parseResetStatus(grantBlock([
    weeklyGrant,
    { id: 'session', type: 'session', clears: ['five_hour'] },
    { ...fableGrant, clears: ['five_hour', 'seven_day_overage_included'] },
  ], { exhausted: ['five_hour'] }));
  const before = JSON.parse(JSON.stringify(s));
  assert.equal(chooseAutoGrant(s).id, 'fable');
  assert.deepEqual(s, before);
  assert.equal(chooseAutoGrant({ ...s, grants: s.grants.filter(g => g.id !== 'fable') }).id, 'session');
});

test('auto choice requires one grant to cover every exhausted limit', () => {
  assert.equal(chooseAutoGrant(parseResetStatus(grantBlock([fableGrant], { exhausted: ['seven_day'] }))), null);
  assert.equal(chooseAutoGrant(parseResetStatus(grantBlock([fableGrant, weeklyGrant], { exhausted: ['seven_day', 'seven_day_overage_included'] }))).id, 'weekly');
  const separate = grantBlock([fableGrant, { id: 'sonnet', clears: ['seven_day_sonnet'] }], { exhausted: ['seven_day_overage_included', 'seven_day_sonnet'] });
  assert.equal(chooseAutoGrant(parseResetStatus(separate)), null, 'two partial grants cannot cover the wall together');
});

test('auto choice spends the sooner-expiring grant before next_grant_id, with no expiry last', () => {
  const now = Date.now();
  const soon = { ...fableGrant, id: 'soon', ends_at: new Date(now + H).toISOString() };
  const later = { ...fableGrant, id: 'later', ends_at: new Date(now + DAY).toISOString() };
  const noExpiry = { ...fableGrant, id: 'no-expiry', ends_at: null };
  for (const next of ['later', 'no-expiry']) {
    assert.equal(chooseAutoGrant(parseResetStatus(grantBlock([noExpiry, later, soon], { next_grant_id: next })), now).id, 'soon');
  }
  assert.equal(chooseAutoGrant(parseResetStatus(grantBlock([noExpiry, later], { next_grant_id: 'no-expiry' })), now).id, 'later');
  for (const ends_at of [null, new Date(now + H).toISOString()]) {
    const tied = grantBlock([{ ...fableGrant, id: 'first', ends_at }, { ...fableGrant, id: 'next', ends_at }], { next_grant_id: 'next' });
    assert.equal(chooseAutoGrant(parseResetStatus(tied), now).id, 'next');
  }
});

test('auto choice needs no next grant id, but needs eligible status and a usable unexpired grant', () => {
  const now = Date.now();
  assert.equal(chooseAutoGrant(null, now), null);
  assert.equal(chooseAutoGrant(parseResetStatus(block({ eligible: false })), now), null);
  assert.equal(chooseAutoGrant(parseResetStatus(block({ grants: [] })), now), null);
  assert.equal(chooseAutoGrant(parseResetStatus(grantBlock([fableGrant], { next_grant_id: null })), now).id, 'fable');
  for (const g of [{ resets_left: 0 }, { usable_now: false }, { paused: true }, { ends_at: new Date(now).toISOString() }]) {
    assert.equal(chooseAutoGrant(parseResetStatus(block({}, g)), now), null, JSON.stringify(g));
  }
});

test('the claim posts the org-scoped body Claude Code sends, and reads the verdict from the body', async () => {
  let seen;
  const r = await claimClaudeReset({ credential: 'tok', orgUuid: 'org-1' }, { grantId: 'g_1', requestId: 'req-1' }, {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ result: 'reset', resets_left: 0, cleared: ['five_hour'], cooldown_until: '2026-10-10T09:08:22+00:00' }) }; },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/api/organizations/org-1/reset_rate_limits');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(JSON.parse(seen.opts.body), { program: 'cedar_ember', grant_id: 'g_1', request_id: 'req-1' });
  assert.equal(seen.opts.headers.Authorization, 'Bearer tok');
  assert.equal(r.result, 'reset'); assert.deepEqual(r.cleared, ['five_hour']);
  const bad = await claimClaudeReset({ credential: 'tok', orgUuid: 'org-1' }, { grantId: 'g_1', requestId: 'r' }, { fetchImpl: async () => ({ ok: false, status: 502 }) });
  assert.deepEqual(bad, { error: 'HTTP 502', status: 502 });
  assert.match((await claimClaudeReset({ credential: 'tok' }, { grantId: 'g', requestId: 'r' })).error, /identity/);
  assert.match((await claimClaudeReset({ credential: 'tok', orgUuid: 'o' }, { grantId: 'BAD ID', requestId: 'r' })).error, /malformed/);
});

// ── the pool-dry policy ─────────────────────────────────────────────────────

test('off by default: a config that never mentions the switch spends nothing', async () => {
  assert.equal(createDefaultConfig().autoRedeemResets, false);
  const { am, redeemer, calls } = harness({ config: createDefaultConfig() });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /switched off/);
  assert.equal(calls.status + calls.claim.length, 0);
});

test('the switch is read live off the shared config: switching it off stops the next refusal', async () => {
  const config = { autoRedeemResets: true };
  const { am, redeemer, calls } = harness({ config, accounts: [oauth('a'), oauth('b')] });
  config.autoRedeemResets = false;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.claim.length, 0);
});

test('armed: one reset is spent on the account that would otherwise wait longest, and the account is re-read', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('soon'), oauth('late'), oauth('mid')] });
  // fableSpent gives index 0 a 1-day wait, index 1 two days, index 2 three days.
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, true);
  assert.deepEqual(calls.claim, ['mid']);
  assert.equal(am.accounts[2].quota.unified7dFable, 0, 'the quota was re-applied from the fresh read');
  assert.ok(blockedUntil(am.accounts[0]) > 0);
});

test('a Fable-only wall spends a held Fable grant even when next is weekly', async () => {
  const { am, redeemer, calls } = harness({ status: () => grantBlock([weeklyGrant, fableGrant]) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.grants, ['fable']);
  assert.match(calls.logs[0], /Redeeming a banked Claude Fable reset on "a"/);
});

test('a weekly wall with only a Fable grant declines because it does not cover the wall', async () => {
  const { am, redeemer, calls } = harness({ status: () => grantBlock([fableGrant], { next_grant_id: 'fable', exhausted: ['seven_day'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false);
  assert.equal(r.reason, 'its reset does not clear seven_day');
  assert.equal(calls.claim.length, 0);
});

test('a weekly wall spends the weekly grant, not a cheaper Fable grant', async () => {
  const { am, redeemer, calls } = harness({ status: () => grantBlock([fableGrant, weeklyGrant], { next_grant_id: 'fable', exhausted: ['seven_day'] }) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.grants, ['weekly']);
  assert.match(calls.logs[0], /Redeeming a banked Claude weekly reset/);
});

test('two Fable grants spend the sooner-expiring one', async () => {
  const { am, redeemer, calls } = harness({ status: () => grantBlock([
    { ...fableGrant, id: 'later', ends_at: new Date(Date.now() + DAY).toISOString() },
    { ...fableGrant, id: 'soon', ends_at: new Date(Date.now() + H).toISOString() },
  ], { next_grant_id: 'later' }) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.grants, ['soon']);
});

test('a paused, unusable, spent or expired cheaper grant is skipped for a covering weekly grant', async () => {
  for (const blocked of [{ paused: true }, { usable_now: false }, { resets_left: 0 }, { ends_at: new Date(Date.now() - H).toISOString() }]) {
    const { am, redeemer, calls } = harness({ status: () => grantBlock([{ ...fableGrant, ...blocked }, weeklyGrant], { next_grant_id: 'fable' }) });
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true, JSON.stringify(blocked));
    assert.deepEqual(calls.grants, ['weekly']);
  }
});

test('one dry pool costs one reset: a second refusal right after holds off', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const again = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(again.redeemed, false); assert.match(again.reason, /holding off/);
  assert.equal(calls.claim.length, 1);
});

test('concurrent refusals share one attempt', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  const [x, y] = await Promise.all([redeemer.maybeRedeemForPool(am.accounts), redeemer.maybeRedeemForPool(am.accounts)]);
  assert.equal(x.redeemed && y.redeemed, true);
  assert.equal(calls.claim.length, 1);
});

test('nothing is spent where the reset would not return the account to service', async () => {
  const { am, redeemer, calls } = harness({ status: () => block({ exhausted: ['seven_day_overage_included', 'seven_day_sonnet'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /does not clear seven_day_sonnet/);
  assert.equal(calls.claim.length, 0);
});

test('an account not actually at a limit, or holding nothing, or ineligible, is passed over', async () => {
  for (const b of [block({ at_limit: false, exhausted: [] }), block({}, { resets_left: 0 }), block({ eligible: false, ineligible_reason: 'tier' })]) {
    const { am, redeemer, calls } = harness({ status: () => b });
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false, JSON.stringify(b).slice(0, 80));
    assert.equal(calls.claim.length, 0);
  }
});

test('an account exempted, disabled, without an org id, or reading zero held resets is never asked', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('ex', { autoRedeemReset: false }), oauth('off', { disabled: true }), oauth('noorg', { orgUuid: null }), oauth('zero')] });
  am.accounts[3].quota.resetCredits = { available: 0, applicable: 0, seenAt: Date.now() };
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
});

test('upstream declining spends nothing and moves on to the next account', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')], claim: n => (n === 1 ? { result: 'not_limited', reason: null, resetsLeft: 1, cleared: [] } : { result: 'reset', resetsLeft: 0, cleared: ['seven_day_overage_included'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, true);
  assert.equal(calls.claim.length, 2);
});

test('no verdict: the fleet holds, and the next attempt replays the SAME request id', async () => {
  let fail = true;
  let clock = Date.now();
  const { am, redeemer, calls } = harness({ claim: () => (fail ? { error: 'socket hang up' } : { result: 'already_used', resetsLeft: 0, cleared: ['seven_day_overage_included'] }) });
  redeemer.now = () => clock;
  const first = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(first.redeemed, false); assert.match(first.reason, /may still have gone through/);
  assert.match((await redeemer.maybeRedeemForPool(am.accounts)).reason, /holding off/);
  fail = false;
  clock += 31 * 60 * 1000;
  const later = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(later.redeemed, true, 'already_used for our own key means it went through');
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
});

test('no verdict on one account: no sibling is spent in the same refusal', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('a'), oauth('b')], claim: () => ({ error: 'socket hang up' }) });
  await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(calls.claim.length, 1);
});

test('a 5-hour wall alone is never worth a grant', async () => {
  const { am, redeemer, calls } = harness({ status: () => block({ exhausted: ['five_hour'] }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /no weekly limit/);
  assert.equal(calls.claim.length, 0);
});

test('a cooldown upstream already reports is honoured without a claim', async () => {
  const until = Date.now() + H;
  const { am, redeemer, calls } = harness({ status: () => block({ cooldown_until: new Date(until).toISOString() }) });
  const r = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /cooldown/);
  assert.equal(calls.claim.length, 0);
});

test('a reset that landed also lifts a stored upstream rejection', async () => {
  const { am, redeemer } = harness();
  Object.assign(am.accounts[0].quota, { unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
});

test('the fleet hold is saved with the quota state, so a restart does not lift it', async () => {
  const { am, redeemer } = harness({ accounts: [oauth('a'), oauth('b')], claim: () => ({ error: 'socket hang up' }) });
  await redeemer.maybeRedeemForPool(am.accounts);
  const saved = am.exportQuotaState();
  // A fresh process: new manager, new redeemer, nothing held in memory.
  const { am: am2, redeemer: r2, calls } = harness({ accounts: [oauth('a'), oauth('b')] });
  am2.restoreQuotaState(saved);
  const r = await r2.maybeRedeemForPool(am2.accounts);
  assert.equal(r.redeemed, false); assert.match(r.reason, /holding off/);
  assert.equal(calls.claim.length, 0);
});

test('a Codex row or a third-party backend is never a Claude candidate', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('cx', { provider: 'codex', accountId: 'x' }), oauth('nano', { upstream: 'https://api.nano-gpt.com/api' })] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
});

// ── parked at the switch threshold (#685) ───────────────────────────────────
//
// Selection stops using an account at its switch threshold, so upstream never
// reports it at a limit: `at_limit: false, exhausted: []`. The redeemer then
// asks the manager whether a weekly reading is what holds the account out.

const OPUS = 'claude-opus-4-7', FABLE = 'claude-fable-5-1', SONNET = 'claude-sonnet-4-6';
const NOT_WALLED = { at_limit: false, exhausted: [] };
const fableWithSession = { ...fableGrant, clears: ['five_hour', 'seven_day_overage_included'] };

/**
 * One redeemer over accounts whose readings are `quota` (per account, or one
 * for all). The status read reports the same readings until a claim lands and
 * zeroes after it, as upstream would; `upstream` overrides what it reports.
 */
function parkedHarness({ accounts = [oauth('a')], quota, upstream = null, grants = [weeklyGrant], blockExtra = {}, threshold = 0.98 } = {}) {
  const am = new AccountManager(accounts, threshold);
  const readings = a => ({ unified5h: 0.1, unified7d: 0.5, ...(typeof quota === 'function' ? quota(a) : quota) });
  for (const a of am.accounts) {
    const q = readings(a);
    Object.assign(a.quota, q, { unified5hReset: Date.now() + H, unified7dReset: Date.now() + 3 * DAY });
    if (q.unified7dFable != null) a.quota.unified7dFableReset = Date.now() + 3 * DAY;
    if (q.unified7dSonnet != null) a.quota.unified7dSonnetReset = Date.now() + 3 * DAY;
  }
  am.ensureTokenFresh = async () => {};
  const calls = { status: 0, claim: [], grants: [], logs: [] };
  let clock = Date.now();
  const bucket = v => (v == null ? null : { utilization: v });
  const usageOf = account => {
    const q = calls.claim.length ? { unified5h: 0, unified7d: 0, unified7dFable: 0 } : { ...readings(account), ...upstream };
    return { fiveHour: bucket(q.unified5h), sevenDay: bucket(q.unified7d), sevenDayFable: bucket(q.unified7dFable), sevenDaySonnet: bucket(q.unified7dSonnet) };
  };
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED }, now: () => clock, log: line => calls.logs.push(line),
    statusFn: async account => { calls.status++; return { reset: parseResetStatus(grantBlock(grants, { ...NOT_WALLED, ...blockExtra })), usage: usageOf(account) }; },
    claimFn: async (account, c) => { calls.claim.push(account.name); calls.grants.push(c.grantId); return { result: 'reset', reason: null, resetsLeft: 0, cleared: [], cooldownUntil: null }; },
  });
  return { am, redeemer, calls, advance: ms => { clock += ms; } };
}

const declines = calls => calls.logs.filter(l => /banked reset not redeemed/.test(l));

test('parked at the switch threshold on the all-models weekly: the reset is spent though upstream reports no limit', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.985 }, grants: [fableWithSession, weeklyGrant] });
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'quota');
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, true);
  assert.deepEqual(calls.grants, ['weekly'], 'a Fable reset does not clear the shared weekly, so the cheaper grant is not the one');
  assert.equal(am.accounts[0].quota.unified7d, 0, 'the account was re-read after the claim');
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), null);
});

test('parked on the Fable weekly alone: the cheapest grant that clears it is spent', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7dFable: 0.99 }, grants: [weeklyGrant, fableGrant] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: FABLE })).redeemed, true);
  assert.deepEqual(calls.grants, ['fable']);
});

test('a Fable request parked by the shared weekly needs a grant that clears the shared weekly', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99, unified7dFable: 0.4 }, grants: [fableGrant] });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: FABLE });
  assert.equal(r.redeemed, false); assert.equal(r.reason, 'its reset does not clear seven_day');
  assert.equal(calls.claim.length, 0);
});

test('parked on both weekly readings: one grant has to clear both', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99, unified7dFable: 0.99 }, grants: [fableGrant, weeklyGrant] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: FABLE })).redeemed, true);
  assert.deepEqual(calls.grants, ['weekly']);
});

test('parked by the weekly and the 5-hour window: a grant that leaves the 5-hour wall standing is not spent', async () => {
  const quota = { unified5h: 0.99, unified7dFable: 0.99 };
  const kept = parkedHarness({ quota, grants: [fableGrant] });
  const r = await kept.redeemer.maybeRedeemForPool(kept.am.accounts, { model: FABLE });
  assert.equal(r.redeemed, false); assert.equal(r.reason, 'its reset does not clear five_hour');
  const spent = parkedHarness({ quota, grants: [fableGrant, fableWithSession] });
  assert.equal((await spent.redeemer.maybeRedeemForPool(spent.am.accounts, { model: FABLE })).redeemed, true);
  assert.deepEqual(spent.calls.grants, ['fable']);
});

test('parked only by the 5-hour window: a weekly reset is never spent for it', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified5h: 0.99, unified7d: 0.5 } });
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'quota', 'the server would offer this account');
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false); assert.match(r.reason, /not at a usage limit/);
  assert.equal(calls.claim.length, 0);
});

test('below its switch threshold: nothing is spent', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.97 } });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false); assert.match(r.reason, /not at a usage limit/);
  assert.equal(calls.claim.length, 0);
});

test('the threshold is the one that applies to the account: its own override, or the bucket\'s', async () => {
  // 92% is under the fleet's 98% and over this account's own 90%.
  const own = parkedHarness({ accounts: [oauth('a', { switchThreshold: 0.9 })], quota: { unified7d: 0.92 } });
  assert.equal((await own.redeemer.maybeRedeemForPool(own.am.accounts, { model: OPUS })).redeemed, true);
  const fleet = parkedHarness({ quota: { unified7d: 0.92 } });
  assert.equal((await fleet.redeemer.maybeRedeemForPool(fleet.am.accounts, { model: OPUS })).redeemed, false);
  // A fresh fleet per model: the first redemption would hold the second off.
  const perBucket = () => parkedHarness({ quota: { unified7dFable: 0.92 }, threshold: { default: 0.98, unified7dFable: 0.9 } });
  const forFable = perBucket(), forOpus = perBucket();
  assert.equal((await forFable.redeemer.maybeRedeemForPool(forFable.am.accounts, { model: FABLE })).redeemed, true);
  const opus = await forOpus.redeemer.maybeRedeemForPool(forOpus.am.accounts, { model: OPUS });
  assert.equal(opus.redeemed, false, 'the Fable bucket does not park an Opus request');
  assert.match(opus.reason, /not at a usage limit/);
});

test('a parked account that opted out is never asked', async () => {
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a', { autoRedeemReset: false })], quota: { unified7d: 0.99 } });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
});

test('past its threshold but out for another reason: the reset would not return it to service', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 } });
  am.accounts[0].status = 'error';
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'error');
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false); assert.match(r.reason, /not at a usage limit/);
  assert.equal(calls.claim.length, 0);
});

test('parked on a reading no grant is known to clear: nothing is spent', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7dSonnet: 0.99 } });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: SONNET });
  assert.equal(r.redeemed, false); assert.equal(r.reason, 'no reset is known to clear its unified7dSonnet reading');
  assert.equal(calls.claim.length, 0);
});

test('a grant that needs the upstream limit reached is not claimed below it', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 }, grants: [{ ...weeklyGrant, use_requires_limit: true }] });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false); assert.match(r.reason, /only be used at the upstream limit/);
  assert.equal(calls.claim.length, 0);
});

test('the parked verdict is judged on the fresh read, not on a stale local reading', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 }, upstream: { unified7d: 0.4 } });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false);
  assert.equal(calls.claim.length, 0);
  assert.equal(am.accounts[0].quota.unified7d, 0.4);
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), null, 'the account is back in rotation on what upstream says');
});

test('several parked accounts: still one reset, on the account that would wait longest', async () => {
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('soon'), oauth('late')], quota: { unified7d: 0.99 } });
  am.accounts[1].quota.unified7dReset = Date.now() + 5 * DAY;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, true);
  assert.deepEqual(calls.claim, ['late']);
  assert.match((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).reason, /holding off/);
  assert.equal(calls.claim.length, 1);
});

test('a decline is logged once per account per cooldown, not once per refusal', async () => {
  const { am, redeemer, calls, advance } = parkedHarness({ quota: { unified7d: 0.99 }, grants: [fableGrant] });
  for (let i = 0; i < 3; i++) assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, false);
  assert.deepEqual(declines(calls), ['[TeamClaude] Account "a": banked reset not redeemed: its reset does not clear seven_day']);
  assert.equal(calls.status, 1, 'the account is not even read again inside its cooldown');
  advance(31 * 60 * 1000);
  await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(declines(calls).length, 2);
  assert.equal(calls.claim.length, 0);
});

test('an account holding no reset is passed over without a line', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 }, grants: [{ ...weeklyGrant, resets_left: 0 }] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, false);
  assert.deepEqual(calls.logs, []);
});

test('a dry pool of parked accounts: the proxy hands the redeemer the model, and serves the request once one is redeemed', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7dFable: 0.99 }, grants: [weeklyGrant, fableGrant] });
  am._nextProbeAt = Date.now() + H;
  const hooks = { redeemClaudeResetForPool: (cands, opts) => redeemer.maybeRedeemForPool(cands, opts) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  try {
    const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: FABLE, max_tokens: 1, messages: [] }) });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(hits, 1);
    assert.deepEqual(calls.grants, ['fable'], 'the Fable bucket parked it, so the model reached the redeemer');
  } finally { proxy.close(); upstream.close(); }
});

// ── through the proxy ───────────────────────────────────────────────────────

async function oneRefusedClaudeRequest({ onRedeem }) {
  let hits = 0;
  const upstream = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const a of am.accounts) fableSpent(a, 3 * DAY);
  am._nextProbeAt = Date.now() + H;
  const asked = [];
  const hooks = onRedeem ? { redeemClaudeResetForPool: async (cands) => {
    asked.push(cands.map(a => a.name));
    const redeemed = await onRedeem();
    if (redeemed) Object.assign(cands[0].quota, { unified7dFable: 0, unified7d: 0 });
    return { redeemed, reason: 'test' };
  } } : {};
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [] }) });
    await res.text();
    return { status: res.status, hits, asked };
  } finally { proxy.close(); upstream.close(); }
}

test('a dry Claude pool asks the Claude redeemer, and serves the request when one was redeemed', async () => {
  const r = await oneRefusedClaudeRequest({ onRedeem: async () => true });
  assert.deepEqual(r.asked, [['a', 'b']]);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1);
});

test('a declined redemption leaves the refusal exactly as it was', async () => {
  const r = await oneRefusedClaudeRequest({ onRedeem: async () => false });
  assert.equal(r.asked.length, 1);
  assert.notEqual(r.status, 200);
  assert.equal(r.hits, 0);
});

test('without the hook nothing changes', async () => {
  const r = await oneRefusedClaudeRequest({});
  assert.notEqual(r.status, 200);
  assert.equal(r.hits, 0);
});
