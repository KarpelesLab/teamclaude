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

// Every account is also held after the 429 that brought word of its wall, as
// the proxy holds it, so it is out for a request that names no model too. The
// status read reports the account's own readings until a claim lands on it.
function harness({ accounts = [oauth('a')], status = () => block(), claim = () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }), config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => Object.assign(fableSpent(a, (i + 1) * DAY), { status: 'throttled', rateLimitedUntil: Date.now() + H }));
  const calls = { status: 0, claim: [], grants: [], keys: [], logs: [] };
  const reading = (account) => {
    const q = calls.claim.includes(account.name) ? { unified5h: 0, unified7d: 0, unified7dFable: 0 } : account.quota;
    return { fiveHour: { utilization: q.unified5h }, sevenDay: { utilization: q.unified7d }, sevenDayFable: { utilization: q.unified7dFable } };
  };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: line => calls.logs.push(line),
    statusFn: async (account) => { calls.status++; const b = status(account, calls); return { reset: parseResetStatus(b), usage: reading(account) }; },
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

// A long-lived token carries `user:inference` alone: the status read and the
// claim would both draw a scope denial, and a refused claim is treated as one
// that may have landed, which holds the resets of the whole fleet.
test('a long-lived account is never asked for a reset, alone or beside another', async () => {
  const alone = harness({ accounts: [oauth('year', { longLived: true })] });
  const none = await alone.redeemer.maybeRedeemForPool(alone.am.accounts);
  assert.equal(none.redeemed, false);
  assert.equal(none.reason, 'no Claude account holds a usable reset');
  assert.equal(alone.calls.status + alone.calls.claim.length, 0);
  assert.equal(alone.redeemer.fleetHoldUntil, 0);

  // fableSpent gives the second account the longer wait, so it would be the
  // one chosen if it were a candidate.
  const { am, redeemer, calls } = harness({ accounts: [oauth('b'), oauth('year', { longLived: true })] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['b']);
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

// The hold is saved on the account it was armed for, and a removed account is
// no longer among those fleetHoldUntil reads.
test('a claim on an account removed while it was in flight still holds the rest of the fleet off', async () => {
  for (const verdict of [{ result: 'reset', resetsLeft: 0, cleared: ['seven_day_overage_included'] }, { error: 'socket hang up' }]) {
    const h = harness({ accounts: [oauth('a'), oauth('b')], claim: () => {
      h.am.removeAccount(h.am.accounts.findIndex(a => a.name === h.calls.claim.at(-1)));
      return verdict;
    } });
    await h.redeemer.maybeRedeemForPool(h.am.accounts);
    assert.deepEqual(h.am.accounts.map(a => a.name), ['a'], 'b, which waits longest, was claimed on and removed');
    const next = await h.redeemer.maybeRedeemForPool(h.am.accounts);
    assert.equal(next.redeemed, false); assert.match(next.reason, /holding off/, JSON.stringify(verdict));
    assert.deepEqual(h.calls.claim, ['b']);
  }
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

// Held after a 429, as the proxy holds an account: one whose readings are under
// its threshold is offered on that, and is out for every model.
const held = am => { for (const a of am.accounts) Object.assign(a, { status: 'throttled', rateLimitedUntil: Date.now() + H }); return am; };

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

test('at upstream\'s 5-hour wall and parked on a weekly reading: the weekly reading is what bars it, so a reset that clears both is spent', async () => {
  const atFiveHour = { at_limit: true, exhausted: ['five_hour'] };
  const { am, redeemer, calls } = parkedHarness({ quota: { unified5h: 1, unified7d: 0.99 }, blockExtra: atFiveHour, grants: [{ ...weeklyGrant, use_requires_limit: true }] });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, true, r.reason);
  assert.deepEqual(calls.grants, ['weekly'], 'at an upstream limit, a grant that needs one reached may be used');
  // The 5-hour wall alone is still never worth a grant, and the weekly limit
  // behind the parked reading has to be cleared too.
  const fiveHourOnly = parkedHarness({ quota: { unified5h: 1, unified7d: 0.5 }, blockExtra: atFiveHour });
  const alone = await fiveHourOnly.redeemer.maybeRedeemForPool(fiveHourOnly.am.accounts, { model: OPUS });
  assert.equal(alone.redeemed, false); assert.equal(alone.reason, 'no weekly limit is exhausted');
  const sessionOnly = parkedHarness({ quota: { unified5h: 1, unified7d: 0.99 }, blockExtra: atFiveHour, grants: [{ id: 'session', type: 'session', clears: ['five_hour'] }] });
  const partial = await sessionOnly.redeemer.maybeRedeemForPool(sessionOnly.am.accounts, { model: OPUS });
  assert.equal(partial.redeemed, false); assert.equal(partial.reason, 'its reset does not clear seven_day');
  assert.equal(fiveHourOnly.calls.claim.length + sessionOnly.calls.claim.length, 0);
});

// The Fable reset is the cheapest kind that clears an upstream Fable wall, but
// the shared weekly behind it keeps the account parked for Opus and for Fable.
test('at upstream\'s Fable wall on an account the shared weekly parks: only a reset that clears both is spent', async () => {
  const fableWall = { at_limit: true, exhausted: ['seven_day_overage_included'] };
  for (const model of [OPUS, FABLE]) {
    const both = parkedHarness({ quota: { unified7d: 0.99, unified7dFable: 1 }, blockExtra: fableWall, grants: [fableGrant, weeklyGrant] });
    assert.equal((await both.redeemer.maybeRedeemForPool(both.am.accounts, { model })).redeemed, true, model);
    assert.deepEqual(both.calls.grants, ['weekly'], model);
    assert.equal(both.am.unavailableReason(both.am.accounts[0], model), null, model);
    const fableOnly = parkedHarness({ quota: { unified7d: 0.99, unified7dFable: 1 }, blockExtra: fableWall, grants: [fableGrant] });
    const r = await fableOnly.redeemer.maybeRedeemForPool(fableOnly.am.accounts, { model });
    assert.equal(r.redeemed, false, model); assert.equal(r.reason, 'its reset does not clear seven_day');
    assert.equal(fableOnly.calls.claim.length, 0);
  }
  // A park on a reading no grant is known to clear stands at an upstream wall too.
  const scoped = parkedHarness({ quota: { unified7d: 1, scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() + 3 * DAY } } },
    blockExtra: { at_limit: true, exhausted: ['seven_day'] } });
  assert.equal((await scoped.redeemer.maybeRedeemForPool(scoped.am.accounts, { model: OPUS })).reason, 'no reset is known to clear its scopedWeekly reading');
  assert.equal(scoped.calls.claim.length, 0);
});

// The proxy usually learns of upstream's 5-hour wall from a 429, and holds the
// account `throttled` for up to an hour, which outranks `quota`.
test('held after the 429 of upstream\'s 5-hour wall and parked on a weekly reading: the reset is spent and lifts the hold', async () => {
  const atFiveHour = { at_limit: true, exhausted: ['five_hour'] };
  const { am, redeemer, calls } = parkedHarness({ quota: { unified5h: 1, unified7d: 0.99 }, blockExtra: atFiveHour });
  am.markRateLimited(0, 3600);
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'throttled');
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, true, r.reason);
  assert.deepEqual(calls.claim, ['a']);
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), null, 'the hold went with the reset');
  // A hold whose weekly reading is under the threshold is still not worth one.
  const held = parkedHarness({ quota: { unified5h: 1, unified7d: 0.5 }, blockExtra: atFiveHour });
  held.am.markRateLimited(0, 3600);
  assert.equal((await held.redeemer.maybeRedeemForPool(held.am.accounts, { model: OPUS })).reason, 'no weekly limit is exhausted');
  assert.equal(held.calls.claim.length, 0);
  // Nor is a weekly window that has already reset, read with no fresh quota:
  // the hold must not keep an expired reading in play.
  const lapsed = parkedHarness({ quota: { unified5h: 1, unified7d: 0.99 }, blockExtra: atFiveHour });
  lapsed.am.accounts[0].quota.unified7dReset = Date.now() - 1;
  lapsed.am.markRateLimited(0, 3600);
  const read = lapsed.redeemer.statusFn;
  lapsed.redeemer.statusFn = async account => ({ ...(await read(account)), usage: undefined });
  assert.equal((await lapsed.redeemer.maybeRedeemForPool(lapsed.am.accounts, { model: OPUS })).reason, 'no weekly limit is exhausted');
  assert.equal(lapsed.calls.claim.length, 0);
  // A family weekly behind the hold parks the account for the model it
  // governs, its 5-hour and shared readings under their thresholds.
  const family = parkedHarness({ quota: { unified7dFable: 0.99 }, grants: [fableGrant] });
  family.am.markRateLimited(0, 3600);
  assert.equal((await family.redeemer.maybeRedeemForPool(family.am.accounts, { model: FABLE })).redeemed, true);
  assert.deepEqual(family.calls.grants, ['fable']);
});

test('a weekly reading exactly at the switch threshold parks the account, as it does for selection', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.98 } });
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'quota');
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, true);
  assert.deepEqual(calls.claim, ['a']);
});

test('parked by a learned scoped weekly beside the shared one: a reset that clears only the shared weekly is not spent', async () => {
  const scopedWeekly = { opus: { utilization: 0.99, resetAt: Date.now() + 3 * DAY } };
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99, scopedWeekly } });
  const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(r.redeemed, false);
  assert.equal(r.reason, 'no reset is known to clear its scopedWeekly reading');
  assert.equal(calls.claim.length, 0);
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
  const r = await redeemer.maybeRedeemForPool(held(am).accounts, { model: OPUS });
  assert.equal(r.redeemed, false); assert.match(r.reason, /not at a usage limit/);
  assert.equal(calls.claim.length, 0);
});

test('the threshold is the one that applies to the account: its own override, or the bucket\'s', async () => {
  // 92% is under the fleet's 98% and over this account's own 90%.
  const own = parkedHarness({ accounts: [oauth('a', { switchThreshold: 0.9 })], quota: { unified7d: 0.92 } });
  assert.equal((await own.redeemer.maybeRedeemForPool(own.am.accounts, { model: OPUS })).redeemed, true);
  const fleet = parkedHarness({ quota: { unified7d: 0.92 } });
  assert.equal((await fleet.redeemer.maybeRedeemForPool(held(fleet.am).accounts, { model: OPUS })).redeemed, false);
  // A fresh fleet per model: the first redemption would hold the second off.
  const perBucket = () => parkedHarness({ quota: { unified7dFable: 0.92 }, threshold: { default: 0.98, unified7dFable: 0.9 } });
  const forFable = perBucket(), forOpus = perBucket();
  assert.equal((await forFable.redeemer.maybeRedeemForPool(forFable.am.accounts, { model: FABLE })).redeemed, true);
  const opus = await forOpus.redeemer.maybeRedeemForPool(held(forOpus.am).accounts, { model: OPUS });
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

test('upstream at a limit it does not name: a grant that needs one reached is still not claimed', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 }, blockExtra: { at_limit: true }, grants: [{ ...weeklyGrant, use_requires_limit: true }] });
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

test('parked below 0.98: the reset still goes to the account that would wait longest', async () => {
  // The fleet's threshold, and the accounts' own under the fleet default.
  for (const [threshold, own] of [[0.9, {}], [0.98, { switchThreshold: 0.9 }]]) {
    for (const order of [['soon', 'late'], ['late', 'soon']]) {
      const { am, redeemer, calls } = parkedHarness({ accounts: order.map(name => oauth(name, own)), quota: { unified7d: 0.92 }, threshold });
      for (const a of am.accounts) a.quota.unified7dReset = Date.now() + (a.name === 'late' ? 6 : 1) * DAY;
      assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, true);
      assert.deepEqual(calls.claim, ['late'], `threshold ${threshold}, own ${JSON.stringify(own)}, config order ${order}`);
    }
  }
  // A request that names no model: each window at its own bucket's threshold.
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('soon'), oauth('late')], quota: { unified7d: 0.92 }, threshold: 0.9 });
  for (const a of am.accounts) a.quota.unified7dReset = Date.now() + (a.name === 'late' ? 6 : 1) * DAY;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['late'], 'no model');
});

test('the ranking reads only what bars the refused model, each against the threshold that governs it', async () => {
  // A Fable request holds the shared weekly to the Fable bucket's threshold.
  for (const order of [['soon', 'late'], ['late', 'soon']]) {
    const { am, redeemer, calls } = parkedHarness({ accounts: order.map(name => oauth(name)), quota: { unified7d: 0.92, unified7dFable: 0.5 },
      threshold: { default: 0.98, unified7dFable: 0.9 } });
    for (const a of am.accounts) a.quota.unified7dReset = Date.now() + (a.name === 'late' ? 6 : 1) * DAY;
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: FABLE })).redeemed, true);
    assert.deepEqual(calls.claim, ['late'], `per-bucket threshold, config order ${order}`);
  }
  // A Fable window does not bar an Opus request: `soon` is back for Opus in a
  // day, though its Fable weekly waits six.
  for (const order of [['soon', 'late'], ['late', 'soon']]) {
    const { am, redeemer, calls } = parkedHarness({ accounts: order.map(name => oauth(name)),
      quota: a => (a.name === 'soon' ? { unified7d: 0.99, unified7dFable: 0.99 } : { unified7d: 0.99 }) });
    for (const a of am.accounts) {
      a.quota.unified7dReset = Date.now() + (a.name === 'late' ? 3 : 1) * DAY;
      if (a.name === 'soon') a.quota.unified7dFableReset = Date.now() + 6 * DAY;
    }
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).redeemed, true);
    assert.deepEqual(calls.claim, ['late'], `another family's window, config order ${order}`);
  }
  // The 5-hour window bars every model: `a` is back for Opus only when its
  // 5-hour window resets, in four hours, though its weekly resets in one.
  const five = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: a => (a.name === 'a' ? { unified5h: 0.99, unified7d: 0.99 } : { unified7d: 0.99 }) });
  const [a5, b5] = five.am.accounts;
  Object.assign(a5.quota, { unified7dReset: Date.now() + H, unified5hReset: Date.now() + 4 * H });
  b5.quota.unified7dReset = Date.now() + 2 * H;
  assert.equal((await five.redeemer.maybeRedeemForPool(five.am.accounts, { model: OPUS })).redeemed, true);
  assert.deepEqual(five.calls.claim, ['a'], 'the 5-hour window');
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

// Whether a weekly reading parks an account depends on the refused request's
// model, so a pass made for one model must not stand in for another's.
test('a pass made for one model neither cools the account down for another nor answers its refusal', async () => {
  // The 5-hour reading holds the account out for every model, the Fable weekly
  // only for Fable: an Opus refusal is passed over, a Fable one is worth a reset.
  const quota = { unified5h: 0.99, unified7dFable: 0.99 };
  const after = parkedHarness({ quota });
  const opus = await after.redeemer.maybeRedeemForPool(after.am.accounts, { model: OPUS });
  assert.equal(opus.redeemed, false); assert.match(opus.reason, /not at a usage limit/);
  const fable = await after.redeemer.maybeRedeemForPool(after.am.accounts, { model: FABLE });
  assert.equal(fable.redeemed, true, fable.reason);
  assert.deepEqual(after.calls.claim, ['a']);

  // Both refusals at once: the Opus attempt is in flight when the Fable
  // refusal arrives, and the Fable one does not take its answer.
  const together = parkedHarness({ quota });
  const [o, f] = await Promise.all([OPUS, FABLE].map(model => together.redeemer.maybeRedeemForPool(together.am.accounts, { model })));
  assert.equal(o.redeemed, false);
  assert.equal(f.redeemed, true, f.reason);
  assert.deepEqual(together.calls.claim, ['a']);
});

test('a model\'s pass is kept by the weekly bucket that governs the model and by its family', async () => {
  // A route can meter one Opus model on the Fable bucket: the two Opus models
  // are then parked by different readings.
  const routed = parkedHarness({ quota: { unified5h: 0.99, unified7dFable: 0.99 } });
  routed.am.setRoutes([{ name: 'opus-on-fable', match: ['claude-opus-4-7'], bucket: 'unified7dFable' }]);
  assert.match((await routed.redeemer.maybeRedeemForPool(routed.am.accounts, { model: 'claude-opus-4-6' })).reason, /not at a usage limit/);
  assert.equal((await routed.redeemer.maybeRedeemForPool(routed.am.accounts, { model: 'claude-opus-4-7' })).redeemed, true);
  // A learned scoped weekly is one family's: it parks Opus here, not Haiku.
  const scoped = parkedHarness({ quota: { unified7d: 0.99, scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() + 3 * DAY } } } });
  assert.match((await scoped.redeemer.maybeRedeemForPool(scoped.am.accounts, { model: OPUS })).reason, /scopedWeekly/);
  assert.equal((await scoped.redeemer.maybeRedeemForPool(scoped.am.accounts, { model: 'claude-haiku-4-5' })).redeemed, true);
  // A parked wall no grant covers is the model's as well: with the shared
  // weekly's own threshold lower, it parks Opus and not Fable.
  const uncovered = parkedHarness({ quota: { unified7d: 0.92, unified7dFable: 0.99 }, grants: [fableGrant], threshold: { default: 0.98, unified7d: 0.9 } });
  assert.equal((await uncovered.redeemer.maybeRedeemForPool(uncovered.am.accounts, { model: OPUS })).reason, 'its reset does not clear seven_day');
  assert.equal((await uncovered.redeemer.maybeRedeemForPool(uncovered.am.accounts, { model: FABLE })).redeemed, true);
});

test('a pass that does not turn on the model holds the account for every model', async () => {
  const { am, redeemer, calls } = harness({ status: () => block({ exhausted: ['seven_day_overage_included', 'seven_day_sonnet'] }) });
  assert.match((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).reason, /does not clear seven_day_sonnet/);
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: FABLE })).redeemed, false);
  assert.equal(calls.status, 1, 'upstream\'s own wall is the same for every model, so the account is not read again');
});

test('refusals judged on the same readings share a pass and an attempt, whatever their family', async () => {
  // No scoped bucket is learned, so Opus and Haiku are both judged on the
  // 5-hour window and the shared weekly.
  const after = parkedHarness({ quota: { unified5h: 0.99 } });
  assert.match((await after.redeemer.maybeRedeemForPool(after.am.accounts, { model: OPUS })).reason, /not at a usage limit/);
  assert.equal((await after.redeemer.maybeRedeemForPool(after.am.accounts, { model: 'claude-haiku-4-5' })).redeemed, false);
  assert.equal(after.calls.status, 1, 'the pass made for Opus holds for Haiku');
  assert.equal(declines(after.calls).length, 1);
  const together = parkedHarness({ quota: { unified5h: 0.99 } });
  const [o, h] = await Promise.all([OPUS, 'claude-haiku-4-5'].map(model => together.redeemer.maybeRedeemForPool(together.am.accounts, { model })));
  assert.equal(h.reason, o.reason);
  assert.equal(together.calls.status, 1, 'one attempt answers both');
  // A scoped bucket gates only beside the shared weekly: an Opus model a route
  // meters on the Fable bucket is judged as Fable is, scoped Opus bucket or not.
  const routed = parkedHarness({ quota: { unified5h: 0.99, scopedWeekly: { opus: { utilization: 0.2, resetAt: Date.now() + 3 * DAY } } } });
  routed.am.setRoutes([{ name: 'opus-on-fable', match: ['claude-opus-4-7'], bucket: 'unified7dFable' }]);
  for (const model of [OPUS, FABLE]) assert.equal((await routed.redeemer.maybeRedeemForPool(routed.am.accounts, { model })).redeemed, false);
  assert.equal(routed.calls.status, 1);
});

// No account has learned a scoped Opus weekly yet, so Opus and Haiku start
// with one key. The walk's own status read then reports Opus's weekly spent
// beside the shared one: Opus is parked on a reading no grant is known to
// clear, Haiku on the shared weekly alone, which the weekly reset clears.
function scopedFirstSeen() {
  const h = parkedHarness({ quota: { unified7d: 0.99 } });
  const scopedWeekly = { opus: { utilization: 0.99, resetAt: Date.now() + 3 * DAY } };
  const read = h.redeemer.statusFn;
  h.redeemer.statusFn = async account => {
    const r = await read(account);
    return h.calls.claim.length ? r : { ...r, usage: { ...r.usage, scopedWeekly } };
  };
  assert.equal(h.am.accounts[0].quota.scopedWeekly?.opus, undefined);
  return h;
}

test('a scoped bucket first seen in the walk\'s own read keys the pass it decides', async () => {
  const { am, redeemer, calls } = scopedFirstSeen();
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS })).reason, 'no reset is known to clear its scopedWeekly reading');
  assert.ok(am.accounts[0].quota.scopedWeekly.opus, 'the read taught the fleet the scoped bucket');
  const haiku = await redeemer.maybeRedeemForPool(am.accounts, { model: 'claude-haiku-4-5' });
  assert.equal(haiku.redeemed, true, haiku.reason);
  assert.deepEqual(calls.claim, ['a']);
});

test('a refusal that joins an attempt is matched on the key the attempt\'s reads give the attempt\'s model', async () => {
  // The Haiku refusal joins the Opus attempt on the key both had before the
  // read, and does not take the decline the read made Opus's own.
  const { am, redeemer, calls } = scopedFirstSeen();
  const [o, h] = await Promise.all([OPUS, 'claude-haiku-4-5'].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(o.reason, 'no reset is known to clear its scopedWeekly reading');
  assert.equal(h.redeemed, true, h.reason);
  assert.deepEqual(calls.claim, ['a']);
});

test('a refusal that joins an attempt is matched on the key the attempt\'s reads give the refusal\'s own model', async () => {
  // The other way round: an Opus refusal joins a Haiku attempt. That walk's
  // read of a teaches the fleet a scoped Opus weekly and shows a can serve
  // Haiku after all, but not Opus, which a's scoped weekly parks; b, parked
  // on the shared weekly alone, is Opus's to redeem.
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: 0.99 } });
  const [a] = am.accounts;
  a.quota.unified7dReset = Date.now() + 5 * DAY;
  const scopedWeekly = { opus: { utilization: 0.99, resetAt: Date.now() + 3 * DAY } };
  const read = redeemer.statusFn;
  redeemer.statusFn = async account => {
    const r = await read(account);
    return account === a && !calls.claim.length ? { ...r, usage: { ...r.usage, sevenDay: { utilization: 0.5 }, scopedWeekly } } : r;
  };
  const [haiku, opus] = await Promise.all(['claude-haiku-4-5', OPUS].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(haiku.available, true); assert.equal(haiku.account, 'a');
  assert.notEqual(am.unavailableReason(a, OPUS), null, 'a cannot serve Opus');
  assert.equal(opus.redeemed, true, opus.reason); assert.equal(opus.account, 'b');
  assert.deepEqual(calls.claim, ['b']);
});

test('a refusal keyed apart from the attempt it joins does not take its decline once an expiry makes the keys alike', async t => {
  // a has learned a scoped Opus weekly, which runs out while the Opus walk
  // reads b, and another request's selection sweeps it. The walk passed a
  // over on that bucket and b on its Fable-only reset; Haiku, parked on a's
  // shared weekly alone, is served by a's weekly reset.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: 0.99 } });
  const [a, b] = am.accounts;
  Object.assign(a.quota, { unified7dReset: Date.now() + 5 * DAY, scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() + 5_000 } } });
  const read = redeemer.statusFn;
  let swept = false;
  redeemer.statusFn = async account => {
    if (account === b && !swept) { swept = true; t.mock.timers.tick(10_000); am.refreshExpiredQuotas(); }
    const r = await read(account);
    return account === b ? { ...r, reset: parseResetStatus(grantBlock([fableGrant], NOT_WALLED)) } : r;
  };
  const [opus, haiku] = await Promise.all([OPUS, 'claude-haiku-4-5'].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(opus.reason, 'its reset does not clear seven_day');
  assert.equal(a.quota.scopedWeekly.opus, undefined, 'the bucket ran out during the attempt');
  assert.equal(haiku.redeemed, true, haiku.reason);
  assert.deepEqual(calls.claim, ['a']);
});

test('a refusal that joins once an expiry has made the keys alike does not take a decline made on the bucket that ran out', async t => {
  // As above, but the Haiku refusal arrives after a's scoped Opus weekly ran
  // out: its own selection sweeps the reading, and only then does it join.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: 0.99 } });
  const [a, b] = am.accounts;
  Object.assign(a.quota, { unified7dReset: Date.now() + 5 * DAY, scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() + 5_000 } } });
  const read = redeemer.statusFn;
  let late = null;
  redeemer.statusFn = async account => {
    if (account === b && !late) {
      t.mock.timers.tick(10_000);
      am.refreshExpiredQuotas('claude-haiku-4-5', new Set());
      assert.equal(a.quota.scopedWeekly.opus, undefined, 'the bucket ran out before the refusal joined');
      late = redeemer.maybeRedeemForPool(am.accounts, { model: 'claude-haiku-4-5' });
    }
    const r = await read(account);
    return account === b ? { ...r, reset: parseResetStatus(grantBlock([fableGrant], NOT_WALLED)) } : r;
  };
  const opus = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
  assert.equal(opus.reason, 'its reset does not clear seven_day');
  assert.ok(late, 'the Haiku refusal joined while the attempt ran');
  const haiku = await late;
  assert.equal(haiku.redeemed, true, haiku.reason);
  assert.deepEqual(calls.claim, ['a']);
});

// The budget has to bind on the token refresh too: ensureTokenFresh takes no
// timeout, and a refusal waiting on this attempt is held as long as it runs.
test('a token refresh that outlives the attempt\'s budget is left behind, not waited out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 } });
  /** @type {() => void} */
  let finishRefresh = () => {};
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = resolve; });
  let settled = null;
  const attempt = redeemer.maybeRedeemForPool(am.accounts, { model: OPUS }).then(r => { settled = r; });
  t.mock.timers.tick(redeemer.timeoutMs);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.ok(settled, 'the attempt answered when its budget ran out, the refresh still pending');
    assert.match(settled.reason, /budget/);
    assert.equal(calls.status, 0, 'nothing is read on a token the attempt never got');
  } finally { finishRefresh(); await attempt; }
  assert.equal(calls.claim.length, 0, 'a refresh that lands late does not reach the claim');
  // A refresh that fails is that account's answer, not the walk's: the next
  // account is still asked.
  const failing = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: 0.99 } });
  failing.am.accounts[0].quota.unified7dReset = Date.now() + 6 * DAY;
  failing.am.ensureTokenFresh = async index => { if (index === 0) throw new Error('refresh refused'); };
  const next = await failing.redeemer.maybeRedeemForPool(failing.am.accounts, { model: OPUS });
  assert.equal(next.redeemed, true, next.reason);
  assert.deepEqual(failing.calls.claim, ['b']);
});

test('concurrent refusals for one model share one attempt, whatever it decides', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified5h: 0.99 } });
  const [x, y] = await Promise.all([OPUS, OPUS].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(x.redeemed || y.redeemed, false);
  assert.equal(y.reason, x.reason);
  assert.equal(calls.status, 1);
});

test('a refusal for another model that waited on a reset that landed is answered by it', async () => {
  const { am, redeemer, calls } = parkedHarness({ quota: { unified7d: 0.99 } });
  const [o, f] = await Promise.all([OPUS, FABLE].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(o.redeemed, true);
  assert.equal(f.redeemed, true, f.reason);
  assert.deepEqual(calls.claim, ['a']);
});

// The offer is filtered by route, the key is not: a refusal that joins or
// waits on another's attempt may not have been offered the account that
// attempt answered for.
test('another refusal\'s answer about an account this one was not offered is not this one\'s answer', async () => {
  // An Opus attempt over x, y and z finds x serviceable; a Haiku refusal
  // offered z alone joins it, then makes its own attempt.
  const joined = parkedHarness({ accounts: [oauth('x'), oauth('y'), oauth('z')], quota: a => ({ unified7d: a.name === 'x' ? 0.5 : 0.99 }) });
  const [x, , z] = joined.am.accounts;
  Object.assign(x.quota, { unified7d: 0.99, unified7dReset: Date.now() + 6 * DAY });
  const [opus, haiku] = await Promise.all([
    joined.redeemer.maybeRedeemForPool(joined.am.accounts, { model: OPUS }),
    joined.redeemer.maybeRedeemForPool([z], { model: 'claude-haiku-4-5' }),
  ]);
  assert.equal(opus.available, true); assert.equal(opus.account, 'x');
  assert.equal(haiku.redeemed, true, haiku.reason); assert.equal(haiku.account, 'z');
  assert.deepEqual(joined.calls.claim, ['z']);
  // The same when the attempt answers before walking, x already able to serve.
  const early = parkedHarness({ accounts: [oauth('x'), oauth('z')], quota: a => ({ unified7d: a.name === 'x' ? 0.5 : 0.99 }) });
  const [, ez] = early.am.accounts;
  const [eo, eh] = await Promise.all([
    early.redeemer.maybeRedeemForPool(early.am.accounts, { model: OPUS }),
    early.redeemer.maybeRedeemForPool([ez], { model: 'claude-haiku-4-5' }),
  ]);
  assert.equal(eo.available, true); assert.equal(eo.account, 'x');
  assert.equal(eh.redeemed, true, eh.reason);
  assert.deepEqual(early.calls.claim, ['z']);
  // A Fable refusal offered z alone waits on an Opus attempt that spends on
  // y: that reset does not serve it, and its own attempt holds off.
  const waited = parkedHarness({ accounts: [oauth('y'), oauth('z')], quota: { unified7d: 0.99 } });
  const [y2, z2] = waited.am.accounts;
  const [o, f] = await Promise.all([
    waited.redeemer.maybeRedeemForPool([y2], { model: OPUS }),
    waited.redeemer.maybeRedeemForPool([z2], { model: FABLE }),
  ]);
  assert.equal(o.redeemed, true);
  assert.equal(f.redeemed, false); assert.match(f.reason, /holding off/);
  assert.deepEqual(waited.calls.claim, ['y']);
  // `available` speaks for its own key: a Fable refusal offered the same
  // account does not take an Opus walk's answer that it can serve Opus, and
  // walks itself, the account still parked on its Fable weekly.
  const other = parkedHarness({ quota: { unified7d: 0.99, unified7dFable: 0.99 }, upstream: { unified7d: 0.5 } });
  const [o3, f3] = await Promise.all([OPUS, FABLE].map(model => other.redeemer.maybeRedeemForPool(other.am.accounts, { model })));
  assert.equal(o3.available, true);
  assert.equal(f3.redeemed, true, f3.reason);
  assert.deepEqual(other.calls.claim, ['a']);
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

/** Two accounts parked on the shared weekly; `x` ranks first on a stale local
 *  reading, and its fresh read shows the week well short of the threshold. */
function staleFleet() {
  const h = parkedHarness({ accounts: [oauth('y'), oauth('x')], quota: a => (a.name === 'x' ? { unified7d: 0.5, unified7dFable: 0.3 } : { unified7d: 0.99 }) });
  const x = h.am.accounts[1];
  Object.assign(x.quota, { unified7d: 0.99, unified7dReset: Date.now() + 6 * DAY });
  return { ...h, x };
}

// The fresh read is judged before anything about the account's own resets:
// one that holds none, or is not eligible, can still serve the request.
test('a stale account with no reset of its own still ends the walk once its fresh read shows it can serve', async () => {
  for (const own of [grantBlock([{ ...weeklyGrant, resets_left: 0 }], NOT_WALLED), block({ eligible: false, ineligible_reason: 'tier' })]) {
    const { am, redeemer, calls } = staleFleet();
    const read = redeemer.statusFn;
    redeemer.statusFn = async account => {
      const r = await read(account);
      return account.name === 'x' ? { ...r, reset: parseResetStatus(own) } : r;
    };
    const r = await redeemer.maybeRedeemForPool(am.accounts, { model: OPUS });
    assert.equal(r.available, true, r.reason);
    assert.deepEqual(calls.claim, [], 'the pool was not dry: no reset is spent on y');
  }
});

test('a fresh read that shows an account can serve ends the walk without spending, and the request is served', async () => {
  const served = [];
  const upstream = http.createServer((req, res) => { served.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const { am, redeemer, calls, x } = staleFleet();
  am._nextProbeAt = Date.now() + H;
  const hooks = { redeemClaudeResetForPool: (cands, opts) => redeemer.maybeRedeemForPool(cands, opts) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  try {
    const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [] }) });
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(calls.claim, [], 'the pool was not dry: no reset is spent on y');
    assert.deepEqual(served, [`Bearer ${x.credential}`]);
  } finally { proxy.close(); upstream.close(); }
});

test('a refusal that waited on another model\'s walk sees what that walk re-read', async () => {
  const { am, redeemer, calls } = staleFleet();
  const [o, f] = await Promise.all([OPUS, FABLE].map(model => redeemer.maybeRedeemForPool(am.accounts, { model })));
  assert.equal(o.available, true);
  assert.equal(f.available, true, f.reason);
  assert.deepEqual(calls.claim, []);
  assert.equal(calls.status, 1, 'the Opus walk read x; the Fable refusal needs no read of its own');
});

// Selection routes an advisor request by its own model when no account can
// serve the advisor too, so a pool is dry only for the request's model: a
// reset judged on that model serves the request, though the advisor's family
// bucket stays spent.
test('an advisor request on a dry pool is served by a reset judged on its own model', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const sharedOnly = { ...weeklyGrant, clears: ['five_hour', 'seven_day'] };
  const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: 0.99, unified7dFable: 0.99 }, grants: [sharedOnly] });
  // After the claim upstream reports the shared weekly cleared and the Fable
  // weekly as it was.
  redeemer.statusFn = async () => ({ reset: parseResetStatus(grantBlock([sharedOnly], NOT_WALLED)),
    usage: { fiveHour: { utilization: 0.1 }, sevenDay: { utilization: calls.claim.length ? 0 : 0.99 }, sevenDayFable: { utilization: 0.99 } } });
  redeemer.claimFn = async account => { calls.claim.push(account.name); return { result: 'reset', resetsLeft: 0, cleared: ['five_hour', 'seven_day'] }; };
  am._nextProbeAt = Date.now() + H;
  const hooks = { redeemClaudeResetForPool: (cands, opts) => redeemer.maybeRedeemForPool(cands, opts) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  try {
    const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
    const body = { model: OPUS, max_tokens: 1, tools: [{ type: 'advisor_20260301', name: 'advisor', model: FABLE }], messages: [] };
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await res.text();
    assert.equal(calls.claim.length, 1);
    assert.equal(res.status, 200);
    assert.equal(hits, 1);
  } finally { proxy.close(); upstream.close(); }
});

// unavailableReason names `quota` ahead of `route`, so an account the model's
// route excludes reads as resettable unless the offer asks the route itself.
test('a dry pool offers only the accounts the request model\'s route allows, parked or at the upstream limit', async () => {
  for (const atLimit of [false, true]) {
    let hits = 0;
    const upstream = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
    const { am, redeemer, calls } = parkedHarness({ accounts: [oauth('a'), oauth('b')], quota: { unified7d: atLimit ? 1 : 0.99 },
      blockExtra: atLimit ? { at_limit: true, exhausted: ['seven_day'] } : {} });
    am.setRoutes([{ name: 'fable-on-a', match: ['*fable*'], accounts: ['a'] }]);
    // `b` would wait longest, so it is the one a route-blind offer spends on.
    am.accounts[1].quota.unified7dReset = Date.now() + 6 * DAY;
    am._nextProbeAt = Date.now() + H;
    const offered = [];
    const hooks = { redeemClaudeResetForPool: (cands, opts) => { offered.push(cands.map(a => a.name)); return redeemer.maybeRedeemForPool(cands, opts); } };
    const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
    try {
      const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
      const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: FABLE, max_tokens: 1, messages: [] }) });
      await res.text();
      assert.deepEqual(offered, [['a']], `atLimit=${atLimit}`);
      assert.deepEqual(calls.claim, ['a'], `atLimit=${atLimit}`);
      assert.equal(res.status, 200);
      assert.equal(hits, 1);
    } finally { proxy.close(); upstream.close(); }
  }
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

// An account this request already tried stays excluded from the re-selection
// after a redemption, so it is not worth a reset for this request either: here
// a is sent the request and turned away at its 5-hour limit, and only b, whose
// Fable window was spent before the request came, is offered.
test('an account the request already tried is not offered for a reset', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    res.writeHead(429, {
      'content-type': 'application/json', 'retry-after': '3600',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + H) / 1000)),
      'anthropic-ratelimit-unified-5h-utilization': '1',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  });
  const port = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  fableSpent(am.accounts[1], 3 * DAY);
  am._nextProbeAt = Date.now() + H;
  const asked = [];
  const hooks = { redeemClaudeResetForPool: async (cands) => { asked.push(cands.map(a => a.name)); return { redeemed: false, reason: 'test' }; } };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${port}` }, hooks);
  const pport = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${pport}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [] }) });
    await res.text();
    assert.deepEqual(seen, ['t-a'], 'the fixture must send the request to a alone');
    assert.deepEqual(asked, [['b']]);
  } finally { proxy.close(); upstream.close(); }
});
