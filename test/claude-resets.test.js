import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createDefaultConfig } from '../src/config.js';
import { parseResetStatus, claimableGrant, claimClaudeReset, blockedUntil, ClaudeResetRedeemer } from '../src/claude-resets.js';

// Banked Claude usage-limit resets. Nothing here reaches the network: the claim
// spends a real reset on a real account, so every test injects its own fetch.

const H = 3600_000, DAY = 24 * H;
const oauth = (name, extra = {}) => ({ id: 'id-' + name, name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, accountUuid: 'account-' + name, orgUuid: 'org-' + name, ...extra });
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

function fableSpent(account, resetIn) {
  Object.assign(account.quota, { unified5h: 0.1, unified7d: 0.5, unified7dFable: 1, unified7dFableReset: Date.now() + resetIn });
  return account;
}

function harness({ accounts = [oauth('a')], status = () => block(), claim = () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }), config = { ...ARMED }, pending = null, updateStateFn = null, tokenError = null } = {}) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => fableSpent(a, (i + 1) * DAY));
  const calls = { status: 0, claim: [], keys: [], grants: [], states: [] };
  let saved = { claudeResetPending: pending || {} };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: () => {}, pending,
    updateStateFn: updateStateFn || (async updater => { updater(saved); calls.states.push(JSON.parse(JSON.stringify(saved))); }),
    statusFn: async (account) => { calls.status++; const b = status(account, calls); return { reset: parseResetStatus(b), usage: { fiveHour: { utilization: 0 }, sevenDay: { utilization: 0 }, sevenDayFable: { utilization: 0 } } }; },
    claimFn: async (account, c) => { calls.claim.push(account.name); calls.keys.push(c.requestId); calls.grants.push(c.grantId); return claim(calls.claim.length, c); },
  });
  am.ensureTokenFresh = async () => { if (tokenError) throw new Error(tokenError); };
  return { am, redeemer, calls, saved: () => saved };
}

// ── parsing ─────────────────────────────────────────────────────────────────

test('the block parses, and only next_grant_id is claimable', () => {
  const s = parseResetStatus(block());
  assert.equal(s.eligible, true); assert.equal(s.atLimit, true);
  assert.deepEqual(s.exhausted, ['seven_day_overage_included']);
  assert.equal(claimableGrant(s).id, 'opus55-launch-promax-20260921');
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: null }))), null);
  assert.equal(claimableGrant(parseResetStatus(block({ next_grant_id: 'someone-else' }))), null, 'a next id naming no listed grant is not trusted');
  for (const g of [{ resets_left: 0 }, { usable_now: false }, { paused: true }, { ends_at: new Date(Date.now() - 1000).toISOString() }]) {
    assert.equal(claimableGrant(parseResetStatus(block({}, g))), null, JSON.stringify(g));
  }
  assert.equal(parseResetStatus(null), null);
  assert.equal(parseResetStatus({ eligible: 'yes' }), null);
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

// ── operator redemption and durable replay ─────────────────────────────────

test('manual redemption ignores automatic policy and permits a usable grant before any limit', async () => {
  const { am, redeemer, calls } = harness({
    accounts: [oauth('disabled', { disabled: true, autoRedeemReset: false })],
    config: createDefaultConfig(),
    status: () => block({ at_limit: false, exhausted: [] }),
  });
  am.accounts[0].quota.resetCredits = { available: 0, applicable: 0, seenAt: Date.now() };
  const r = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(r.outcome, 'redeemed');
  assert.equal(r.result, 'reset');
  assert.deepEqual(r.cleared, ['five_hour', 'seven_day', 'seven_day_overage_included']);
  assert.equal(calls.claim.length, 1);
  assert.equal(calls.states[0].claudeResetPending['id-disabled'].requestId, calls.keys[0], 'intent is durable before the POST');
  assert.deepEqual(calls.states.at(-1).claudeResetPending, {}, 'success clears it only with the hold');
  assert.ok(calls.states.at(-1).quota, 'the fleet hold is persisted in the same update');
  assert.equal(JSON.stringify(r).includes(calls.keys[0]), false);
});

test('legacy accounts without accountUuid keep automatic redemption and durable manual replay', async () => {
  const accounts = [oauth('legacy', { accountUuid: null })];
  const automatic = harness({ accounts });
  assert.equal((await automatic.redeemer.maybeRedeemForPool(automatic.am.accounts)).redeemed, true);

  const first = harness({ accounts, claim: () => ({ error: 'timeout' }) });
  await first.redeemer.redeemAccount(first.am.accounts[0]);
  const pending = first.redeemer.exportPending();
  assert.equal(pending['id-legacy'].accountUuid, null);
  pending['id-legacy'].createdAt -= 31 * 60 * 1000;
  const second = harness({ accounts, pending, claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: [] }) });
  assert.equal((await second.redeemer.redeemAccount(second.am.accounts[0])).outcome, 'redeemed');
  assert.deepEqual(second.calls.keys, first.calls.keys);
});

test('already_used confirms the earlier redemption rather than reporting a second spend', async () => {
  const { am, redeemer, calls } = harness({ claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: ['seven_day'] }) });
  const r = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(r.outcome, 'redeemed');
  assert.equal(r.result, 'already_used');
  assert.equal(calls.claim.length, 1);
});

test('manual refusal cases never reach the claim POST', async () => {
  for (const [name, options, reason] of [
    ['ineligible', { status: () => block({ eligible: false }) }, 'ineligible'],
    ['no usable grant', { status: () => block({}, { usable_now: false }) }, 'no_usable_grant'],
    ['cooldown', { status: () => block({ cooldown_until: new Date(Date.now() + H).toISOString() }) }, 'cooldown'],
    ['unsupported provider', { accounts: [oauth('cx', { provider: 'codex' })] }, 'unsupported_seat'],
  ]) {
    const { am, redeemer, calls } = harness(options);
    const r = await redeemer.redeemAccount(am.accounts[0]);
    assert.equal(r.outcome, 'declined', name);
    assert.equal(r.reason, reason, name);
    assert.equal(calls.claim.length, 0, name);
  }
});

test('token refresh, status and initial persistence failures are pre-claim failures with no POST', async () => {
  for (const options of [
    { tokenError: 'expired' },
    { status: () => { throw new Error('unreachable'); } },
    { updateStateFn: async () => { throw new Error('read-only state'); } },
  ]) {
    const { am, redeemer, calls } = harness(options);
    const r = await redeemer.redeemAccount(am.accounts[0]);
    assert.equal(r.outcome, 'pre_claim_failed');
    assert.equal(calls.claim.length, 0);
  }
});

test('a lost or unrecognized verdict is unknown, retains pending and replays identical ids only after the hold', async () => {
  let verdict = { error: 'socket hang up' };
  let clock = Date.now();
  const { am, redeemer, calls } = harness({ claim: () => verdict });
  redeemer.now = () => clock;
  const first = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(first.outcome, 'unknown');
  assert.equal(first.mayHaveRedeemed, true);
  assert.equal(Object.keys(redeemer.exportPending()).length, 1);
  assert.equal(calls.claim.length, 1);
  verdict = { result: 'already_used', resetsLeft: 0, cleared: ['seven_day'] };
  const immediate = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(immediate.outcome, 'declined');
  assert.equal(immediate.reason, 'cooldown');
  assert.equal(calls.claim.length, 1, 'the hold forbids an immediate replay POST');
  clock += 31 * 60 * 1000;
  const second = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(second.outcome, 'redeemed');
  assert.equal(second.result, 'already_used');
  assert.equal(calls.claim.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
  assert.equal(calls.grants[0], calls.grants[1]);
  assert.equal(calls.status, 2, 'one fresh eligibility read and one post-replay quota read; replay itself has no grant gate');
  assert.deepEqual(redeemer.exportPending(), {});
});

test('missing and unrecognized 2xx verdicts are unknown and keep the durable claim pending', async () => {
  for (const verdict of [{ resetsLeft: 1 }, { result: 'mystery', resetsLeft: 1 }]) {
    const { am, redeemer, calls } = harness({ claim: () => verdict });
    const r = await redeemer.redeemAccount(am.accounts[0]);
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.mayHaveRedeemed, true);
    assert.equal(calls.claim.length, 1);
    assert.equal(Object.keys(redeemer.exportPending()).length, 1);
  }
});

test('restart with the grant gone honors restored createdAt before replaying identical ids', async () => {
  let clock = Date.now();
  const first = harness({ claim: () => ({ error: 'timeout' }) });
  first.redeemer.now = () => clock;
  await first.redeemer.redeemAccount(first.am.accounts[0]);
  const pending = first.redeemer.exportPending();
  const second = harness({ pending, status: () => block({ next_grant_id: null }), claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: [] }) });
  second.redeemer.now = () => clock;
  const immediate = await second.redeemer.redeemAccount(second.am.accounts[0]);
  assert.equal(immediate.outcome, 'declined');
  assert.equal(immediate.reason, 'cooldown');
  assert.equal(second.calls.claim.length, 0, 'restored createdAt supplies the restart-safe hold without restored quota');
  clock += 31 * 60 * 1000;
  const r = await second.redeemer.redeemAccount(second.am.accounts[0]);
  assert.equal(r.outcome, 'redeemed');
  assert.equal(second.calls.status, 1, 'the only fresh read is quota reapplication after the replay');
  assert.deepEqual(second.calls.keys, first.calls.keys);
  assert.deepEqual(second.calls.grants, first.calls.grants);
});

test('an automatic attempt resolves durable pending work even with an empty candidate list', async () => {
  const first = harness({ claim: () => ({ error: 'timeout' }) });
  await first.redeemer.redeemAccount(first.am.accounts[0]);
  const pending = first.redeemer.exportPending();
  pending['id-a'].createdAt -= 31 * 60 * 1000;
  const second = harness({ pending, claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: [] }) });
  const r = await second.redeemer.maybeRedeemForPool([]);
  assert.equal(r.redeemed, true);
  assert.deepEqual(second.calls.keys, first.calls.keys);
  assert.equal(second.calls.claim.length, 1);
});

test('a sibling manual attempt resolves the pending account first but does not spend the sibling', async () => {
  const accounts = [oauth('a'), oauth('b')];
  const first = harness({ accounts, claim: () => ({ error: 'timeout' }) });
  await first.redeemer.redeemAccount(first.am.accounts[0]);
  const pending = first.redeemer.exportPending();
  pending['id-a'].createdAt -= 31 * 60 * 1000;
  const second = harness({ accounts, pending, claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: [] }) });
  const r = await second.redeemer.redeemAccount(second.am.accounts[1]);
  assert.equal(r.outcome, 'declined');
  assert.equal(r.reason, 'pending_replay');
  assert.deepEqual(second.calls.claim, ['a']);
  assert.equal(second.calls.status, 1, 'the only fresh read is A’s quota reapplication; B never selects a grant');
});

test('multiple durable pending claims resolve one per confirmation in createdAt order', async () => {
  const accounts = [oauth('a'), oauth('b')];
  const record = (account, requestId, createdAt) => ({
    accountUuid: account.accountUuid, orgUuid: account.orgUuid,
    grantId: 'grant_1', requestId, createdAt,
  });
  const pending = {
    'id-a': record(accounts[0], 'request-a', 20),
    'id-b': record(accounts[1], 'request-b', 10),
  };
  const { am, redeemer, calls } = harness({ accounts, pending, claim: () => ({ result: 'already_used', resetsLeft: 0, cleared: [] }) });
  let clock = Date.now();
  redeemer.now = () => clock;
  const r = await redeemer.redeemAccount(am.accounts[1]);
  assert.equal(r.outcome, 'redeemed');
  assert.deepEqual(calls.claim, ['b']);
  assert.deepEqual(calls.keys, ['request-b']);
  clock += 61 * 60 * 1000;
  const sibling = await redeemer.redeemAccount(am.accounts[1]);
  assert.equal(sibling.outcome, 'declined');
  assert.equal(sibling.reason, 'pending_replay');
  assert.deepEqual(calls.claim, ['b', 'a']);
  assert.deepEqual(calls.keys, ['request-b', 'request-a']);
});

test('orphaned and identity-mismatched pending records fail closed without a POST', async () => {
  const base = harness({ claim: () => ({ error: 'timeout' }) });
  await base.redeemer.redeemAccount(base.am.accounts[0]);
  const pending = base.redeemer.exportPending();
  pending['id-a'].createdAt -= 31 * 60 * 1000;
  for (const accounts of [[oauth('other')], [oauth('a', { accountUuid: 'changed' })]]) {
    const { am, redeemer, calls } = harness({ accounts, pending });
    const r = await redeemer.redeemAccount(am.accounts[0]);
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.mayHaveRedeemed, true);
    assert.equal(calls.claim.length + calls.status, 0);
  }
});

test('a success whose hold cannot be persisted stays pending but preserves the known redeemed outcome', async () => {
  let writes = 0;
  const { am, redeemer, calls } = harness({
    updateStateFn: async updater => {
      writes++;
      if (writes === 2) throw new Error('disk full');
      updater({});
    },
  });
  const r = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(r.outcome, 'redeemed');
  assert.equal(r.pending, true);
  assert.equal(r.mayHaveRedeemed, undefined);
  assert.equal(Object.keys(redeemer.exportPending()).length, 1);
  assert.equal(calls.claim.length, 1);
});

test('manual during manual or automatic attempts declines in_progress without another POST', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { am, redeemer, calls } = harness({ claim: async () => { await gate; return { result: 'reset', resetsLeft: 0, cleared: [] }; } });
  const first = redeemer.redeemAccount(am.accounts[0]);
  await new Promise(resolve => setImmediate(resolve));
  const second = await redeemer.redeemAccount(am.accounts[0]);
  const automatic = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(second.outcome, 'declined');
  assert.equal(second.reason, 'in_progress');
  assert.equal(automatic.redeemed, false);
  assert.equal(automatic.reason, 'in_progress');
  release();
  assert.equal((await first).outcome, 'redeemed');
  assert.equal(calls.claim.length, 1);
});

test('manual during an automatic attempt declines in_progress while pool calls still join', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { am, redeemer, calls } = harness({ claim: async () => { await gate; return { result: 'reset', resetsLeft: 0, cleared: [] }; } });
  const first = redeemer.maybeRedeemForPool(am.accounts);
  const joined = redeemer.maybeRedeemForPool(am.accounts);
  await new Promise(resolve => setImmediate(resolve));
  const manual = await redeemer.redeemAccount(am.accounts[0]);
  assert.equal(manual.outcome, 'declined');
  assert.equal(manual.reason, 'in_progress');
  release();
  assert.equal((await first).redeemed, true);
  assert.equal((await joined).redeemed, true);
  assert.equal(calls.claim.length, 1);
});

test('removal after intent persistence but before the POST clears intent and never claims a sibling', async () => {
  const h = harness({ updateStateFn: async updater => { updater({}); h.am.removeAccount(0); } });
  const account = h.am.accounts[0];
  const r = await h.redeemer.redeemAccount(account);
  assert.equal(r.outcome, 'pre_claim_failed');
  assert.equal(r.reason, 'account_removed');
  assert.equal(h.calls.claim.length, 0);
  assert.deepEqual(h.redeemer.exportPending(), {});
});

test('removal after a successful POST stays unknown and never reapplies quota to a sibling', async () => {
  const accounts = [oauth('a'), oauth('b')];
  const h = harness({ accounts, claim: () => { h.am.removeAccount(0); return { result: 'reset', resetsLeft: 0, cleared: [] }; } });
  const before = { ...h.am.accounts[1].quota };
  const r = await h.redeemer.redeemAccount(h.am.accounts[0]);
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.mayHaveRedeemed, true);
  assert.equal(h.calls.claim.length, 1);
  assert.deepEqual(h.am.accounts[0].quota, before, 'the sibling at the renumbered index is untouched');
  assert.ok(h.redeemer.exportPending()['id-a'], 'the unresolved original account remains fail-closed');
});

test('removal during the first manual refresh prevents status and claim without touching a sibling', async () => {
  const accounts = [oauth('a'), oauth('b')];
  const h = harness({ accounts });
  const account = h.am.accounts[0];
  const before = { ...h.am.accounts[1].quota };
  h.am.ensureTokenFresh = async () => { h.am.removeAccount(0); };
  const r = await h.redeemer.redeemAccount(account);
  assert.equal(r.outcome, 'pre_claim_failed');
  assert.equal(r.reason, 'account_removed');
  assert.equal(h.calls.status + h.calls.claim.length, 0);
  assert.deepEqual(h.am.accounts[0].quota, before);
});

test('removal during the quota status read cannot apply usage to the replacement index', async () => {
  const accounts = [oauth('a'), oauth('b')];
  const h = harness({ accounts, status: (_account, calls) => {
    if (calls.status === 2) h.am.removeAccount(0);
    return block();
  } });
  const before = { ...h.am.accounts[1].quota };
  const r = await h.redeemer.redeemAccount(h.am.accounts[0]);
  assert.equal(r.outcome, 'redeemed');
  assert.equal(h.calls.status, 2);
  assert.deepEqual(h.am.accounts[0].quota, before, 'the sibling at the renumbered index is untouched');
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
