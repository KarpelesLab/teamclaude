import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createDefaultConfig } from '../src/config.js';
import { fetchUsage, normalizeUsagePayload } from '../src/oauth.js';
import { createProxyServer } from '../src/server.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { TUI } from '../src/tui.js';
import {
  CLAUDE_REDEEM_BUDGET_MS,
  CLAUDE_RESET_STATUS_URL,
  ClaudeResetRedeemer,
  claimClaudeReset,
  claimOutcome,
  claudeResetClaimUrl,
  fetchClaudeResetStatus,
  orderRedeemCandidates,
  parseCedarEmber,
  redeemPreconditions,
  redeemableGrant,
  shouldRedeemReset,
  weeklyExhausted,
} from '../src/claude-reset-credits.js';

// Claude's banked usage-limit resets (`cedar_ember` grants): reading them, the
// policy that decides whether one is worth spending, and the orchestration
// around the claim, which cannot be undone.
//
// Nothing here reaches the network. A claim spends a real reset on a real
// account, so every test injects its own fetch.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** A Claude subscription as a login leaves it: the profile's organization id included. */
function claude(name, extra = {}) {
  return oauth(name, { orgUuid: 'org-' + name, ...extra });
}

function codex(name, extra = {}) {
  return oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
}

// The FLEET switch, on. The same key the Codex redeemer reads: one switch arms
// both providers, and its default is pinned further down.
const ARMED = { autoRedeemResets: true };

/** An account whose shared weekly window is actually spent, as just read, and whose 5-hour one is not. */
function weeklySpent(account, now = Date.now()) {
  account.quota.unified7d = 1;
  account.quota.unified7dReset = now + 3 * DAY;
  account.quota.unified7dSeenAt = now;
  account.quota.unified5h = 0.1;
  return account;
}

/** One grant as the endpoint states it, shaped like the live Max reading in claude-banked-resets.test.js. */
function rawGrant(over = {}) {
  const now = Date.now();
  return {
    id: 'grant-a',
    label: 'one usage-limit reset',
    resets_total: 1,
    resets_left: 1,
    starts_at: iso(now - 10 * DAY),
    ends_at: iso(now + 20 * DAY),
    clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 0, seven_day: 100, seven_day_overage_included: 0 },
    blocking: [],
    ...over,
  };
}

/** The `cedar_ember` block as the endpoint states it. */
function rawBlock(over = {}, grantOver = {}) {
  return {
    eligible: true,
    ineligible_reason: null,
    at_limit: true,
    exhausted: ['seven_day'],
    grants: [rawGrant(grantOver)],
    next_grant_id: 'grant-a',
    weekly_resets_at: iso(Date.now() + 3 * DAY),
    cooldown_until: null,
    ...over,
  };
}

/** The same block, as the policy reads it. */
function block(over = {}, grantOver = {}) {
  const parsed = parseCedarEmber(rawBlock(over, grantOver));
  assert.ok(parsed, 'fixture must parse');
  return parsed;
}

/** A fetch that answers one JSON body and records what it was asked. */
function answering(body, { ok = true, status = 200 } = {}) {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

// ── reading the status ──────────────────────────────────────────────────────

test('the status read is the anytime read Claude Code makes, with the usage probe\'s own headers', async () => {
  const { calls, fetchImpl } = answering({ seven_day: { utilization: 100 }, cedar_ember: rawBlock() });
  const routing = { host: '127.0.0.1', port: 1 };
  const result = await fetchClaudeResetStatus({ credential: 'secret', routing }, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_RESET_STATUS_URL);
  assert.equal(new URL(calls[0].url).host, 'api.anthropic.com');
  assert.match(calls[0].url, /\/api\/oauth\/usage\?cedar_ember=1&skip_spend=1$/);
  assert.equal(calls[0].init.routing, routing, 'the account\'s own egress, like every other call it makes');

  // Gated on the User-Agent, so it must be exactly what the usage probe sends.
  const probe = answering({});
  await fetchUsage('secret', null, { fetchImpl: probe.fetchImpl });
  assert.deepEqual(calls[0].init.headers, probe.calls[0].init.headers);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');

  assert.ok(result.block);
  assert.equal(result.block.nextGrantId, 'grant-a');
  assert.equal(result.block.grants[0].id, 'grant-a');
});

// The status IS a usage reading, so its buckets come back too, mapped exactly
// as the probe maps them — the grant ids reduced to the probe's count. Its
// spend block does not: `skip_spend=1` asked upstream to leave that out.
test('the status read returns the payload\'s own usage reading, without its grant ids or spend', async () => {
  const payload = {
    five_hour: { utilization: 10, resets_at: iso(Date.now() + 3600_000) },
    seven_day: { utilization: 40, resets_at: iso(Date.now() + 3 * DAY) },
    extra_usage: { is_enabled: true },
    cedar_ember: rawBlock(),
  };
  const result = await fetchClaudeResetStatus({ credential: 's' }, answering(payload));
  assert.ok('usage' in result && result.usage);
  assert.equal(result.usage.sevenDay?.utilization, 0.4);
  assert.equal(result.usage.fiveHour?.utilization, 0.1);
  assert.equal(result.usage.spend, null);
  assert.deepEqual(result.usage.resetCredits, normalizeUsagePayload(payload).resetCredits);
  assert.equal(JSON.stringify(result.usage).includes('grant-a'), false);
});

test('the parser keeps only the grants Claude Code would, with its defaults', () => {
  const parsed = parseCedarEmber(rawBlock({
    grants: [
      rawGrant({ id: 'keep-me' }),
      rawGrant({ id: 'Upper-Case' }),
      rawGrant({ id: 'x'.repeat(41) }),
      rawGrant({ id: undefined }),
      rawGrant({ id: 'fraction', resets_left: 1.5 }),
      rawGrant({ id: 'negative', resets_left: -1 }),
      rawGrant({ id: 'missing', resets_left: undefined }),
      rawGrant({ id: 'bare', usable_now: undefined, paused: undefined, use_requires_limit: undefined, clears: 'seven_day', ends_at: undefined }),
      rawGrant({ id: 'garbled', usable_now: 'yes', paused: 'no', use_requires_limit: 'no', ends_at: 'soon' }),
      null,
      'grant',
    ],
    next_grant_id: 'keep-me',
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.grants.map(g => g.id), ['keep-me', 'bare', 'garbled']);

  const bare = parsed.grants[1];
  assert.equal(bare.usableNow, false);
  assert.equal(bare.paused, false);
  assert.equal(bare.useRequiresLimit, true);
  assert.deepEqual(bare.clears, []);
  assert.equal(bare.endsAt, null);

  // A value of the wrong type falls back to the default rather than reading truthy.
  const garbled = parsed.grants[2];
  assert.equal(garbled.usableNow, false);
  assert.equal(garbled.paused, false);
  assert.equal(garbled.useRequiresLimit, true);
  assert.equal(garbled.endsAt, null);
});

test('next_grant_id counts only when it names a grant that survived', () => {
  assert.equal(parseCedarEmber(rawBlock({ next_grant_id: 'grant-a' }))?.nextGrantId, 'grant-a');
  assert.equal(parseCedarEmber(rawBlock({ next_grant_id: 'not-listed' }))?.nextGrantId, null);
  assert.equal(parseCedarEmber(rawBlock({ next_grant_id: 'BAD' }))?.nextGrantId, null);
  assert.equal(parseCedarEmber(rawBlock({ next_grant_id: 'grant-a' }, { resets_left: 'one' }))?.nextGrantId, null);
  assert.equal(parseCedarEmber(rawBlock({ next_grant_id: null }))?.nextGrantId, null);
});

test('a block without a boolean `eligible` is no block at all', () => {
  assert.equal(parseCedarEmber(undefined), null);
  assert.equal(parseCedarEmber(null), null);
  assert.equal(parseCedarEmber('eligible'), null);
  assert.equal(parseCedarEmber(rawBlock({ eligible: 'true' })), null);
  assert.equal(parseCedarEmber(rawBlock({ eligible: undefined })), null);
  const ineligible = parseCedarEmber({ eligible: false, ineligible_reason: 'cli_version' });
  assert.equal(ineligible?.eligible, false);
  assert.equal(ineligible?.ineligibleReason, 'cli_version');
  assert.deepEqual(ineligible?.grants, []);
});

test('the block keeps what the policy reads; an absent exhausted list reads as an empty one', () => {
  const now = Date.now();
  const raw = rawBlock({
    cooldown_until: iso(now + MIN),
    weekly_resets_at: iso(now + 3 * DAY),
    exhausted: ['seven_day', 42, 'five_hour'],
  });
  const parsed = parseCedarEmber(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.exhausted, ['seven_day', 'five_hour']);
  assert.equal(parsed.cooldownUntil, Date.parse(iso(now + MIN)));
  assert.equal(parsed.weeklyResetsAt, Date.parse(iso(now + 3 * DAY)));
  assert.equal(parsed.grants[0].endsAt, Date.parse(raw.grants[0].ends_at));
  // Claude Code reads it as `exhausted ?? []`: upstream naming no limit spent.
  assert.deepEqual(parseCedarEmber(rawBlock({ exhausted: undefined }))?.exhausted, []);
  // Present but malformed lists nothing, which the policy reads as "not spent".
  assert.deepEqual(parseCedarEmber(rawBlock({ exhausted: 'seven_day' }))?.exhausted, []);
});

test('a status read that fails is reported, never read as "no reset"', async () => {
  for (const status of [401, 403, 500]) {
    const { fetchImpl } = answering({}, { ok: false, status });
    assert.deepEqual(await fetchClaudeResetStatus({ credential: 's' }, { fetchImpl }), { error: `HTTP ${status}`, status });
  }
  const thrown = await fetchClaudeResetStatus({ credential: 's' }, { fetchImpl: async () => { throw new Error('socket hang up'); } });
  assert.deepEqual(thrown, { error: 'socket hang up', status: null });
  const unreadable = await fetchClaudeResetStatus({ credential: 's' }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'nope' }) });
  assert.equal(unreadable.status, null);
  assert.match(unreadable.error ?? '', /unreadable/);
});

test('a usage payload with no reset block is a read, with nothing in it', async () => {
  const { fetchImpl } = answering({ seven_day: { utilization: 100 } });
  const result = await fetchClaudeResetStatus({ credential: 's' }, { fetchImpl });
  assert.ok('block' in result);
  assert.equal(result.block, null);
});

test('an account with no credential is never sent anywhere', async () => {
  const { calls, fetchImpl } = answering({});
  const result = await fetchClaudeResetStatus({ credential: null }, { fetchImpl });
  assert.equal(calls.length, 0);
  assert.ok(result.error);
});

// ── claiming ────────────────────────────────────────────────────────────────

test('a claim posts the program, the grant and the idempotency key to the account\'s organization', async () => {
  const { calls, fetchImpl } = answering({ result: 'reset', resets_left: 0, cleared: ['five_hour', 'seven_day'], weekly_resets_at: null });
  const routing = { host: '127.0.0.1', port: 1 };
  const account = { credential: 'secret', orgUuid: '00000000-0000-4000-8000-000000000000', routing };
  const answer = await claimClaudeReset(account, { grantId: 'grant-a', requestId: 'req-1' }, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.routing, routing, 'the account\'s own egress, like the status read');
  assert.equal(calls[0].url, claudeResetClaimUrl(account.orgUuid));
  assert.equal(calls[0].url, `https://api.anthropic.com/api/organizations/${account.orgUuid}/reset_rate_limits`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { program: 'cedar_ember', grant_id: 'grant-a', request_id: 'req-1' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(answer, { result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day'] });
});

test('an organization id cannot steer the claim off its path', () => {
  assert.equal(claudeResetClaimUrl('../../oauth/token?x=1'),
    'https://api.anthropic.com/api/organizations/..%2F..%2Foauth%2Ftoken%3Fx%3D1/reset_rate_limits');
});

test('a claim is classified on the body, and a result nobody listed is not a success', async () => {
  const claim = async (/** @type {any} */ body) => claimClaudeReset({ credential: 's', orgUuid: 'o' },
    { grantId: 'grant-a', requestId: 'req-1' }, answering(body));
  assert.equal(/** @type {any} */ (await claim({ result: 'not_limited', reason: 'not_limited' })).result, 'not_limited');
  assert.equal(/** @type {any} */ (await claim({ result: 'surprise' })).result, 'unavailable');
  assert.equal(/** @type {any} */ (await claim({})).result, 'unavailable');
  const unreadable = await claim('reset');
  assert.equal('result' in unreadable, false);
  assert.match(/** @type {any} */ (unreadable).error, /unreadable/);
});

test('a claim with no organization, or a malformed grant or request id, is never sent', async () => {
  const { calls, fetchImpl } = answering({ result: 'reset' });
  const attempts = [
    claimClaudeReset({ credential: 's', orgUuid: null }, { grantId: 'grant-a', requestId: 'req-1' }, { fetchImpl }),
    claimClaudeReset({ credential: 's', orgUuid: 'o' }, { grantId: 'Grant A', requestId: 'req-1' }, { fetchImpl }),
    claimClaudeReset({ credential: 's', orgUuid: 'o' }, { grantId: 'grant-a', requestId: '' }, { fetchImpl }),
    claimClaudeReset({ credential: 's', orgUuid: 'o' }, { grantId: 'grant-a', requestId: 'has space' }, { fetchImpl }),
    claimClaudeReset({ credential: null, orgUuid: 'o' }, { grantId: 'grant-a', requestId: 'req-1' }, { fetchImpl }),
  ];
  for (const answer of await Promise.all(attempts)) assert.equal(/** @type {any} */ (answer).unsent, true);
  assert.equal(calls.length, 0);
});

test('a claim that fails in transport carries its HTTP status, or none', async () => {
  for (const status of [429, 401, 403, 503]) {
    const answer = await claimClaudeReset({ credential: 's', orgUuid: 'o' }, { grantId: 'grant-a', requestId: 'r' },
      answering({}, { ok: false, status }));
    assert.deepEqual(answer, { error: `HTTP ${status}`, status });
  }
  const thrown = await claimClaudeReset({ credential: 's', orgUuid: 'o' }, { grantId: 'grant-a', requestId: 'r' },
    { fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); } });
  assert.deepEqual(thrown, { error: 'The operation was aborted due to timeout', status: null });
});

// What an answer means depends on whether this account already holds an
// unconfirmed claim on the same grant — the same table Claude Code acts on.
test('what a claim\'s answer means, fresh and as a replay of an unconfirmed one', () => {
  const verdict = (/** @type {string} */ result) => ({ result, reason: null, resetsLeft: null, cleared: [] });
  /** @type {Array<[any, string, string]>} */
  const table = [
    [verdict('reset'), 'spent', 'spent'],
    [verdict('already_used'), 'declined', 'spent'],
    [verdict('not_limited'), 'declined', 'declined'],
    [verdict('ineligible'), 'declined', 'declined'],
    [verdict('cooldown'), 'declined', 'unknown'],
    [verdict('unavailable'), 'unknown', 'unknown'],
    [{ error: 'socket hang up', status: null }, 'unknown', 'unknown'],
    [{ error: 'HTTP 502', status: 502 }, 'unknown', 'unknown'],
    [{ error: 'HTTP 404', status: 404 }, 'unknown', 'unknown'],
    [{ error: 'HTTP 429', status: 429 }, 'refused', 'refused'],
    [{ error: 'HTTP 401', status: 401 }, 'refused', 'refused'],
    [{ error: 'HTTP 403', status: 403 }, 'refused', 'refused'],
    [{ error: 'no organization', status: null, unsent: true }, 'refused', 'refused'],
  ];
  for (const [answer, fresh, replay] of table) {
    assert.equal(claimOutcome(answer, false), fresh, `${JSON.stringify(answer)} fresh`);
    assert.equal(claimOutcome(answer, true), replay, `${JSON.stringify(answer)} replayed`);
  }
});

// ── the real-limit trigger ──────────────────────────────────────────────────

test('a spent 5-hour window is never the trigger', () => {
  const am = new AccountManager([claude('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified5h = 1;
  account.quota.unified5hReset = Date.now() + 3600_000;
  account.quota.unified7d = 0.4;
  account.quota.unified7dReset = Date.now() + 3 * DAY;
  assert.equal(weeklyExhausted(account), false);
  assert.equal(redeemPreconditions({ account, ...ARMED }).ok, false);
});

test('a weekly reading whose window has already rolled over is not exhaustion', () => {
  const am = new AccountManager([claude('a')], 0.98);
  const account = am.accounts[0];
  account.quota.unified7d = 1;
  account.quota.unified7dReset = Date.now() - 1000;
  assert.equal(weeklyExhausted(account), false);
});

// A local threshold takes an account out of rotation early — that is its job —
// but it is not a Claude limit: claiming there would answer `not_limited` at
// best and, with an early-use grant, spend a reset on headroom the account
// still had.
test('an account rotated out by a local threshold or cap is not at a limit', () => {
  const am = new AccountManager([
    claude('threshold', { switchThreshold: 0.9 }),
    claude('capped', { maxUsage: 0.9 }),
  ], 0.98);
  for (const account of am.accounts) {
    account.quota.unified7d = 0.95;
    account.quota.unified7dReset = Date.now() + 3 * DAY;
    assert.notEqual(am.unavailableReason(account), null, 'out of rotation');
    assert.equal(weeklyExhausted(account), false);
    assert.equal(redeemPreconditions({ account, ...ARMED }).reason, 'weekly window is not exhausted');
  }
});

test('a spent weekly window satisfies the preconditions, but only on an armed fleet', () => {
  const am = new AccountManager([claude('a')], 0.98);
  const account = weeklySpent(am.accounts[0]);
  assert.equal(redeemPreconditions({ account, ...ARMED }).ok, true);
  assert.equal(redeemPreconditions({ account }).ok, false);
});

test('the fleet switch and an account opt-out give distinguishable reasons', () => {
  const am = new AccountManager([claude('a'), claude('b', { autoRedeemReset: false })], 0.98);
  assert.equal(redeemPreconditions({ account: weeklySpent(am.accounts[0]) }).reason, 'auto-redeem is switched off');
  assert.equal(redeemPreconditions({ account: weeklySpent(am.accounts[1]), ...ARMED }).reason,
    'auto-redeem is switched off for this account');
});

// The redeemer sends an Anthropic OAuth token to Anthropic and nothing else to
// anyone: an API key, a third-party backend's key and a Codex token all fail
// here, before any request is shaped.
test('only a Claude subscription login is a candidate', () => {
  const am = new AccountManager([
    { name: 'key', type: 'apikey', apiKey: 'k', orgUuid: 'org-key' },
    claude('backend', { upstream: 'https://backend.example' }),
    codex('codex', { orgUuid: 'org-codex' }),
  ], 0.98);
  for (const account of am.accounts) {
    assert.equal(redeemPreconditions({ account: weeklySpent(account), ...ARMED }).reason, 'not a Claude subscription account');
  }
});

test('an account with no organization id has nothing to claim against, and none is invented', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const verdict = redeemPreconditions({ account: weeklySpent(am.accounts[0]), ...ARMED });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /organization/);
});

// ── which grant ─────────────────────────────────────────────────────────────

test('the block offers its next grant when everything Claude Code checks holds', () => {
  const offer = redeemableGrant(block());
  assert.equal(offer.grant?.id, 'grant-a');
});

test('every reason a block offers nothing', () => {
  const now = Date.now();
  /** @type {Array<[string, ReturnType<typeof parseCedarEmber>]>} */
  const table = [
    ['no block', null],
    ['not eligible', block({ eligible: false, ineligible_reason: 'tier' })],
    ['cooldown', block({ cooldown_until: iso(now + 5 * MIN) })],
    ['weekly', block({ exhausted: ['five_hour'] })],
    ['next grant', block({ next_grant_id: null })],
    ['not usable', block({}, { usable_now: false })],
    ['paused', block({}, { paused: true })],
    ['none left', block({}, { resets_left: 0 })],
    ['expired', block({}, { ends_at: iso(now - MIN) })],
    ['weekly', block({}, { clears: ['five_hour', 'seven_day_sonnet'] })],
    // Early use: upstream would let this grant be spent without a limit, and
    // the block does not say the weekly one is spent.
    ['limit', block({ exhausted: undefined }, { use_requires_limit: false })],
  ];
  for (const [why, b] of table) {
    const offer = redeemableGrant(b, now);
    assert.equal(offer.grant, null, why);
    assert.match(offer.reason, new RegExp(why), why);
  }
});

test('a cooldown that has passed, and a grant with no stated end, block nothing', () => {
  assert.equal(redeemableGrant(block({ cooldown_until: iso(Date.now() - MIN) })).grant?.id, 'grant-a');
  assert.equal(redeemableGrant(block({}, { ends_at: null })).grant?.id, 'grant-a');
});

// At a wall Claude Code offers nothing for a limit the status does not list as
// spent ("may have lifted already"), and it reads a missing list as an empty one.
test('a status that does not list the weekly limit as spent offers nothing, whether or not it lists anything', () => {
  for (const exhausted of [undefined, [], ['five_hour']]) {
    const offer = redeemableGrant(block({ exhausted }, { use_requires_limit: true }));
    assert.equal(offer.grant, null, JSON.stringify(exhausted));
    assert.match(offer.reason, /weekly/);
  }
});

// ── the policy ──────────────────────────────────────────────────────────────

test('a dry Claude pool justifies spending the next grant', () => {
  const am = new AccountManager([claude('a'), claude('b', { disabled: true })], 0.98);
  const verdict = shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [{ name: 'b', available: false }], block: block() });
  assert.equal(verdict.redeem, true);
  assert.equal(verdict.grantId, 'grant-a');
  assert.equal(verdict.reason, 'every other Claude account is unavailable');
});

test('a single-account pool is dry the moment its weekly is spent', () => {
  const am = new AccountManager([claude('a')], 0.98);
  assert.equal(shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [], block: block() }).redeem, true);
});

test('a sibling that can still serve means the reset waits', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  const verdict = shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [{ name: 'b', available: true }], block: block() });
  assert.equal(verdict.redeem, false);
  assert.equal(verdict.reason, 'another Claude account can still serve');
  assert.equal(verdict.grantId, null);
});

test('a reset about to expire is spent even when a sibling could serve', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  const now = Date.now();
  const verdict = shouldRedeemReset({
    account: weeklySpent(am.accounts[0], now),
    ...ARMED,
    pool: [{ name: 'b', available: true }],
    block: block({}, { ends_at: iso(now + 2 * DAY) }),
    now,
  });
  assert.equal(verdict.redeem, true);
  assert.match(verdict.reason, /expires in ~2d/);
});

test('a reset with no stated end never counts as about to expire', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  const verdict = shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [{ name: 'b', available: true }], block: block({}, { ends_at: null }) });
  assert.equal(verdict.redeem, false);
});

test('a block that offers nothing is refused whatever the pool says', () => {
  const am = new AccountManager([claude('a')], 0.98);
  const verdict = shouldRedeemReset({ account: weeklySpent(am.accounts[0]), ...ARMED, pool: [], block: block({}, { paused: true }) });
  assert.equal(verdict.redeem, false);
  assert.match(verdict.reason, /paused/);
});

// ── choosing between accounts ───────────────────────────────────────────────

test('the ordering drops an account offering nothing and asks the soonest-ending grant first', () => {
  const now = Date.now();
  const order = orderRedeemCandidates([
    { account: claude('a'), block: block({}, { ends_at: iso(now + 20 * DAY) }) },
    { account: claude('b'), block: block({}, { ends_at: iso(now + DAY), paused: true }) },
    { account: claude('c'), block: block({}, { ends_at: iso(now + 10 * DAY) }) },
    { account: claude('d'), block: null },
  ], now);
  assert.deepEqual(order.map(entry => entry.account.name), ['c', 'a']);
  assert.equal(order[0].grant.id, 'grant-a');
});

test('a grant that never ends sorts behind one that does, and two of them do not compare as NaN', () => {
  const now = Date.now();
  const order = orderRedeemCandidates([
    { account: claude('a'), block: block({}, { ends_at: null }) },
    { account: claude('b'), block: block({}, { ends_at: iso(now + 5 * DAY) }) },
    { account: claude('c'), block: block({}, { ends_at: null }) },
  ], now);
  assert.deepEqual(order.map(entry => entry.account.name), ['b', 'a', 'c']);
});

// ── orchestration ───────────────────────────────────────────────────────────

// A usage re-read showing the week still spent: an unconfirmed claim's re-read
// that does not show it landing.
const stillSpent = () => ({ sevenDay: { utilization: 1, resetAt: Date.now() + 3 * DAY } });

/**
 * A redeemer whose first account's weekly window is spent, with the status
 * read, the claim and the usage re-read all faked. `status` and `claim` take
 * either an answer or a function of the call number.
 */
function harness({ accounts = [claude('a')], status = null, claim = 'reset', usage = {}, quota = weeklySpent, config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  quota(am.accounts[0]);
  /** @type {{status: number, claim: number, usage: number, keys: string[], grants: string[], logs: string[]}} */
  const calls = { status: 0, claim: 0, usage: 0, keys: [], grants: [], logs: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config,
    log: (/** @type {string} */ line) => { calls.logs.push(line); },
    statusFn: async () => {
      calls.status++;
      if (typeof status === 'function') return status(calls.status);
      return status ?? { block: block() };
    },
    claimFn: async (/** @type {any} */ _account, /** @type {any} */ attempt) => {
      calls.claim++;
      calls.keys.push(attempt.requestId);
      calls.grants.push(attempt.grantId);
      if (typeof claim === 'function') return claim(calls.claim);
      return { result: claim, reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day'] };
    },
    usageFn: async () => { calls.usage++; return { sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY }, ...usage }; },
  });
  const offer = (/** @type {any} */ opts) => redeemer.maybeRedeemForPool([am.accounts[0]], opts);
  const later = (/** @type {number} */ ms) => { redeemer.now = () => Date.now() + ms; };
  return { am, redeemer, calls, offer, later };
}

test('a reset that lands lifts the hold and the upstream rejection, and re-reads the quota', async () => {
  const { am, calls, offer } = harness();
  const account = am.accounts[0];
  am.markRateLimited(0, 600);
  account.quota.unifiedStatus = 'rejected';
  account.quota.unifiedStatusSeenAt = Date.now();

  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.equal(calls.claim, 1);
  assert.equal(calls.usage, 1);
  assert.equal(account.status, 'active');
  assert.equal(account.quota.unifiedStatus, null);
  assert.equal(account.quota.unifiedStatusSeenAt, null);
  assert.equal(account.quota.unified7d, 0);
  assert.equal(am.unavailableReason(account), null, 'back in service for the re-forwarded request');
});

// applyUsageData never writes unifiedStatus, so without the clear a spent and
// refilled account still reads `upstream-rejected` until the verdict goes stale.
test('the manager can drop a stale upstream rejection, and leaves any other verdict alone', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unifiedStatusSeenAt = Date.now();
  am.accounts[1].quota.unifiedStatus = 'allowed_warning';
  am.accounts[1].quota.unifiedStatusSeenAt = 1;
  assert.equal(am.unavailableReason(am.accounts[0]), 'upstream-rejected');
  am.clearUpstreamRejected(0);
  am.clearUpstreamRejected(1);
  am.clearUpstreamRejected(9);
  assert.equal(am.unavailableReason(am.accounts[0]), null);
  assert.equal(am.accounts[1].quota.unifiedStatus, 'allowed_warning');
  assert.equal(am.accounts[1].quota.unifiedStatusSeenAt, 1);
});

test('the policy says no and nothing is claimed', async () => {
  const { calls, offer } = harness({ accounts: [claude('a'), claude('b')] });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(calls.claim, 0);
});

test('a healthy weekly window never reaches the endpoints', async () => {
  const { calls, offer } = harness({ quota: account => { account.quota.unified7d = 0.5; } });
  assert.equal((await offer()).redeemed, false);
  assert.equal(calls.status, 0);
  assert.equal(calls.claim, 0);
});

test('a known-zero reset count costs no request at all, and an absent one is not zero', async () => {
  const zero = harness();
  zero.am.accounts[0].quota.resetCredits = { available: 0, applicable: 0, expiresAt: null, seenAt: Date.now() };
  assert.equal((await zero.offer()).reason, 'holds no reset credits');
  assert.equal(zero.calls.status, 0);

  const unknown = harness();
  assert.equal((await unknown.offer()).redeemed, true);
  assert.equal(unknown.calls.status, 1);
});

// The status is the account's own state, so a block that offers nothing will
// offer nothing again in a minute; without a cooldown a dry pool would re-read
// it every time the 20-second cache lapsed.
test('a status that offers nothing arms a cooldown rather than being re-read per refusal', async () => {
  const { calls, offer, later } = harness({ status: { block: block({}, { usable_now: false }) } });
  const first = await offer();
  assert.match(first.reason, /not usable/);
  for (let i = 0; i < 5; i++) await offer();
  later(5 * MIN);
  await offer();
  assert.equal(calls.status, 1);
  later(31 * MIN);
  await offer();
  assert.equal(calls.status, 2);
});

// A cooldown is a reset someone has just started on the account, so its week
// is on its way back. Its own end is too soon to look again: a reading taken
// before that reset lands must not still count as recent when the pool next
// decides anything.
test('a status reporting an upstream cooldown holds the pool past that cooldown', async () => {
  const { calls, offer, later } = harness({ status: { block: block({ cooldown_until: iso(Date.now() + 5 * MIN) }) } });
  assert.match((await offer()).reason, /cooldown/);
  later(6 * MIN);
  assert.match((await offer()).reason, /cooling down/);
  assert.equal(calls.status, 1);
  later(31 * MIN);
  await offer();
  assert.equal(calls.status, 2);
});

test('the status is re-read once it is 20 seconds old', async () => {
  // A healthy sibling, so the policy declines on the pool every time and the
  // only cost of asking again is the read the cache bounds.
  const { calls, offer, later } = harness({ accounts: [claude('a'), claude('b')] });
  await offer();
  later(19_000);
  await offer();
  assert.equal(calls.status, 1);
  later(21_000);
  await offer();
  assert.equal(calls.status, 2);
});

test('a status that cannot be read spends nothing and arms a cooldown', async () => {
  const { calls, offer } = harness({ status: { error: 'HTTP 403', status: 403 } });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /HTTP 403/);
  await offer();
  assert.equal(calls.status, 1);
  assert.equal(calls.claim, 0);
});

test('a declined claim arms a cooldown so a hot refusal loop cannot hammer the endpoint', async () => {
  const { calls, offer } = harness({ claim: 'not_limited' });
  const first = await offer();
  assert.equal(first.redeemed, false);
  assert.match(first.reason, /not_limited/);
  for (let i = 0; i < 5; i++) await offer();
  assert.equal(calls.claim, 1);
});

// The idempotency key: a claim whose answer never arrived is indistinguishable
// from one that never left, so the retry replays the key and upstream says
// which it was. `already_used` for a replay is the earlier claim landing.
test('an unconfirmed claim keeps its key, and already_used on the replay is the earlier one landing', async () => {
  const { calls, offer, later } = harness({
    claim: n => (n === 1 ? { error: 'socket hang up', status: null } : { result: 'already_used', reason: 'already_used', resetsLeft: 0, cleared: [] }),
    usage: stillSpent(),
  });
  assert.equal((await offer()).redeemed, false);
  later(31 * MIN);
  const second = await offer();
  assert.equal(second.redeemed, true);
  assert.equal(calls.keys.length, 2);
  assert.equal(calls.keys[0], calls.keys[1]);
  assert.match(calls.keys[0], /^[A-Za-z0-9_-]{1,64}$/);
});

test('no fresh key is minted for a grant while its claim is unconfirmed', async () => {
  const { calls, offer, later } = harness({
    claim: n => (n === 1 ? { error: 'HTTP 502', status: 502 } : n === 2 ? { result: 'unavailable', reason: null, resetsLeft: null, cleared: [] } : { result: 'reset', reason: null, resetsLeft: 0, cleared: [] }),
    usage: stillSpent(),
  });
  await offer();
  later(31 * MIN);
  await offer();
  later(62 * MIN);
  assert.equal((await offer()).redeemed, true);
  assert.equal(calls.claim, 3);
  assert.equal(new Set(calls.keys).size, 1);
});

test('a settled claim lets the next one have a key of its own', async () => {
  const { calls, offer, later } = harness({
    claim: n => (n === 1 ? { error: 'socket hang up', status: null } : { result: n === 2 ? 'not_limited' : 'reset', reason: null, resetsLeft: 0, cleared: [] }),
    // The re-read after not_limited still reads the week spent, so it is claimed again.
    usage: stillSpent(),
  });
  await offer();
  later(31 * MIN);
  await offer();
  later(62 * MIN);
  await offer();
  assert.equal(calls.keys[0], calls.keys[1], 'the replay');
  assert.notEqual(calls.keys[1], calls.keys[2], 'not_limited settled it');
});

// Claude Code's own rule for an unconfirmed claim: once the status stops
// offering its grant as next, the grant was spent or withdrawn, and either way
// the next grant is not ours to claim on top of it until quota has caught up.
test('a claim the status has moved past is settled, and the pool holds off before the next grant', async () => {
  let next = 'grant-a';
  const { calls, offer, later } = harness({
    status: () => ({ block: block({ grants: [rawGrant({ id: 'grant-a' }), rawGrant({ id: 'grant-b' })], next_grant_id: next }) }),
    claim: n => (n === 1 ? { error: 'socket hang up', status: null } : { result: 'reset', reason: null, resetsLeft: 0, cleared: [] }),
    usage: stillSpent(),
  });
  assert.equal((await offer()).redeemed, false);
  next = 'grant-b';
  later(31 * MIN);
  const second = await offer();
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /may have gone through/);
  assert.equal(calls.claim, 1);

  later(62 * MIN);
  assert.equal((await offer()).redeemed, true);
  assert.deepEqual(calls.grants, ['grant-a', 'grant-b']);
  assert.notEqual(calls.keys[0], calls.keys[1]);
});

// A running cooldown means a reset is still being applied, which may be ours:
// the claim stays unconfirmed, and its key stays the one a retry replays.
test('a status mid-cooldown does not settle an unconfirmed claim', async () => {
  /** @type {Record<string, any>} */
  let over = { next_grant_id: 'grant-a' };
  const { calls, offer, later } = harness({
    status: () => ({ block: block({ grants: [rawGrant({ id: 'grant-a' }), rawGrant({ id: 'grant-b' })], ...over }) }),
    claim: n => (n === 1 ? { error: 'socket hang up', status: null } : { result: 'already_used', reason: 'already_used', resetsLeft: 0, cleared: [] }),
    usage: stillSpent(),
  });
  await offer();
  over = { next_grant_id: 'grant-b', cooldown_until: iso(Date.now() + 40 * MIN) };
  later(31 * MIN);
  assert.match((await offer()).reason, /cooldown/);
  over = { next_grant_id: 'grant-a' };
  later(62 * MIN);
  assert.equal((await offer()).redeemed, true, 'already_used on the replay is the earlier claim landing');
  assert.deepEqual(calls.grants, ['grant-a', 'grant-a']);
  assert.equal(calls.keys[0], calls.keys[1]);
});

test('an ineligible answer on a fresh claim spends nothing and holds only that account', async () => {
  const { am, redeemer, calls } = poolHarness({
    accounts: [claude('a'), claude('b')],
    blocks: { a: block({}, { ends_at: iso(Date.now() + 2 * DAY) }) },
    claim: name => (name === 'a' ? { result: 'ineligible', reason: 'ineligible', resetsLeft: null, cleared: [] } : null),
  });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'b']);
});

test('a cooldown answer on a replay may be the earlier claim still landing, so the pool holds', async () => {
  const { calls, offer, later } = harness({
    claim: n => (n === 1 ? { error: 'socket hang up', status: null } : { result: 'cooldown', reason: 'cooldown', resetsLeft: null, cleared: [] }),
    usage: stillSpent(),
  });
  await offer();
  later(31 * MIN);
  assert.equal((await offer()).redeemed, false);
  later(32 * MIN);
  assert.match((await offer()).reason, /cooling down/);
  later(62 * MIN);
  await offer();
  assert.equal(new Set(calls.keys).size, 1, 'still the same unconfirmed claim');
});

test('a 429 on the claim spends nothing, holds that account only, and records no key', async () => {
  const { am, redeemer, calls } = poolHarness({
    accounts: [claude('a'), claude('b')],
    blocks: { a: block({}, { ends_at: iso(Date.now() + 2 * DAY) }) },
    claim: name => (name === 'a' ? { error: 'HTTP 429', status: 429 } : null),
  });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'b']);
});

test('a 401 or 403 on the claim is a login that cannot claim, not a spend', async () => {
  for (const status of [401, 403]) {
    const { am, redeemer, calls } = poolHarness({
      accounts: [claude('a'), claude('b')],
      blocks: { a: block({}, { ends_at: iso(Date.now() + 2 * DAY) }) },
      claim: name => (name === 'a' ? { error: `HTTP ${status}`, status } : null),
    });
    assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true, `HTTP ${status}`);
    assert.deepEqual(calls.claim, ['a', 'b']);
    assert.ok(calls.logs.some(line => /scope/.test(line)), 'the log says why a valid login can be refused here');
    const again = await redeemer.maybeRedeemForPool([am.accounts[0]]);
    assert.match(again.reason, /cooling down/);
  }
});

// ── a claim that may have landed ────────────────────────────────────────────

const LOST = { error: 'socket hang up', status: null };
const RESET = { result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day'] };
const said = (/** @type {string} */ result) => ({ result, reason: result, resetsLeft: null, cleared: [] });

/**
 * Two spent Claude accounts; `a`'s grant ends first, so `a` is always asked
 * first. `status` and `claim` answer per account and per call number, the
 * usage re-read by default still reads the week spent, and `later` moves the
 * redeemer's clock.
 */
function twoSpent({
  status = (/** @type {string} */ name, /** @type {number} */ _n) => ({ block: name === 'a' ? aBlock() : bBlock() }),
  claim = (/** @type {string} */ _name, /** @type {number} */ _n) => /** @type {any} */ (RESET),
  usage = stillSpent,
} = {}) {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  for (const account of am.accounts) weeklySpent(account);
  /** @type {{status: string[], claim: string[], keys: string[], usage: string[], logs: string[]}} */
  const calls = { status: [], claim: [], keys: [], usage: [], logs: [] };
  const nth = (/** @type {string[]} */ list, /** @type {string} */ name) => list.filter(n => n === name).length;
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: (/** @type {string} */ line) => { calls.logs.push(line); },
    statusFn: async (/** @type {any} */ account) => {
      calls.status.push(account.name);
      return status(account.name, nth(calls.status, account.name));
    },
    claimFn: async (/** @type {any} */ account, /** @type {any} */ attempt) => {
      calls.claim.push(account.name);
      calls.keys.push(attempt.requestId);
      return claim(account.name, nth(calls.claim, account.name));
    },
    usageFn: async (/** @type {any} */ account) => { calls.usage.push(account.name); return usage(); },
  });
  const later = (/** @type {number} */ ms) => { redeemer.now = () => Date.now() + ms; };
  return { am, redeemer, calls, later, offer: () => redeemer.maybeRedeemForPool(am.accounts) };
}

function aBlock(over = {}, grantOver = {}) {
  return block(over, { ends_at: iso(Date.now() + 5 * DAY), ...grantOver });
}

function bBlock(over = {}) {
  return block({ grants: [rawGrant({ id: 'grant-b' })], next_grant_id: 'grant-b', ...over });
}

// The replay is upstream answering for the claim that may have landed. Short
// of `spent`, its answer still leaves that claim in doubt — `ineligible` reads
// "your earlier try may have gone through", `not_limited` says the limits are
// clear — so the walk must not go on to spend a sibling's reset over it.
for (const result of ['ineligible', 'not_limited']) {
  test(`a replay answered ${result} settles the claim but holds the pool, and no sibling is spent`, async () => {
    const { am, calls, later, offer } = twoSpent({ claim: (name, n) => (name === 'a' && n === 1 ? LOST : name === 'a' && n === 2 ? said(result) : RESET) });
    assert.equal((await offer()).redeemed, false);
    later(31 * MIN);
    assert.equal((await offer()).redeemed, false);
    assert.deepEqual(calls.claim, ['a', 'a']);
    assert.ok(calls.usage.includes('a'), 'the account the claim may have refilled is re-read');
    later(32 * MIN);
    assert.match((await offer()).reason, /cooling down/);
    assert.deepEqual(calls.claim, ['a', 'a']);

    // Settled: once the hold lapses, a still-spent week is a new claim with a key of its own.
    later(62 * MIN);
    assert.equal((await offer()).redeemed, true);
    assert.deepEqual(calls.claim, ['a', 'a', 'a']);
    assert.equal(calls.keys[0], calls.keys[1]);
    assert.notEqual(calls.keys[1], calls.keys[2]);
    assert.equal(am.accounts[1].quota.unified7d, 1, 'the sibling was never touched');
  });
}

for (const status of [429, 401, 403]) {
  test(`a replay refused with HTTP ${status} leaves the claim in doubt and holds the pool`, async () => {
    const { calls, later, offer } = twoSpent({
      claim: (name, n) => (name === 'a' && n === 1 ? LOST : name === 'a' && n === 2 ? { error: `HTTP ${status}`, status } : RESET),
    });
    await offer();
    later(31 * MIN);
    assert.equal((await offer()).redeemed, false);
    assert.deepEqual(calls.claim, ['a', 'a']);
    later(62 * MIN);
    assert.equal((await offer()).redeemed, true);
    assert.deepEqual(calls.claim, ['a', 'a', 'a'], 'still a replay of the first claim, never the sibling');
    assert.equal(new Set(calls.keys).size, 1);
  });
}

// The lost claim's account is re-read rather than assumed refilled: what the
// quota says is applied, and nothing beyond it is made up.
test('a lost claim re-reads its account, and a week that reads cleared still holds the siblings', async () => {
  const { am, calls, later, offer } = twoSpent({
    claim: name => (name === 'a' ? LOST : RESET),
    usage: () => ({ sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } }),
  });
  assert.equal((await offer()).redeemed, false);
  assert.deepEqual(calls.usage, ['a']);
  assert.equal(am.accounts[0].quota.unified7d, 0);
  later(62 * MIN);
  assert.match((await offer()).reason, /unconfirmed/);
  assert.deepEqual(calls.claim, ['a']);
});

// Whatever keeps the account that holds it from being asked — a status read
// that fails, a status that offers nothing — the claim stays in doubt, and so
// does every sibling's reset.
test('while one account holds an unconfirmed claim, no other account\'s reset is claimed', async () => {
  const { calls, later, offer } = twoSpent({
    status: (name, n) => (name === 'b' ? { block: bBlock() } : n === 1 ? { block: aBlock() } : n === 2 ? { error: 'HTTP 503', status: 503 } : { block: aBlock({ exhausted: ['five_hour'] }) }),
    claim: name => (name === 'a' ? LOST : RESET),
  });
  await offer();
  later(31 * MIN);
  const second = await offer();
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /unconfirmed/);
  later(62 * MIN);
  assert.match((await offer()).reason, /unconfirmed/);
  assert.deepEqual(calls.claim, ['a']);
});

// A claim never confirmed holds the fleet no longer than one that landed.
test('an unconfirmed claim older than the success hold is let go, and the pool moves on', async () => {
  const { am, calls, later, offer } = twoSpent({
    status: (name, n) => (name === 'b' ? { block: bBlock() } : n === 1 ? { block: aBlock() } : { error: 'HTTP 503', status: 503 }),
    claim: name => (name === 'a' ? LOST : RESET),
  });
  await offer();
  later(5 * 60 * MIN);
  assert.match((await offer()).reason, /unconfirmed/);
  later(6 * 60 * MIN + MIN);
  // Its status cannot be read, so only a recent reading can say `a` is still spent.
  am.accounts[0].quota.unified7dSeenAt = Date.now() + 6 * 60 * MIN;
  assert.equal((await offer()).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'b']);
});

test('an unconfirmed claim aged past the success hold is never replayed with its old key', async () => {
  const { calls, later, offer } = twoSpent({ claim: (name, n) => (name === 'a' && n === 1 ? LOST : RESET) });
  await offer();
  later(6 * 60 * MIN + MIN);
  assert.equal((await offer()).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'a']);
  assert.notEqual(calls.keys[0], calls.keys[1]);
});

// Claude Code settles on any block that has stopped naming the grant as next,
// eligible or not; a block that cannot say (`unavailable`) is a read that failed.
test('a status that has moved past the claim settles it even when it is no longer eligible', async () => {
  const { calls, later, offer } = twoSpent({
    status: (name, n) => (name === 'b' ? { block: bBlock() } : { block: n === 1 ? aBlock() : aBlock({ eligible: false, ineligible_reason: 'no_grant', grants: [], next_grant_id: null, exhausted: undefined }) }),
    claim: name => (name === 'a' ? LOST : RESET),
  });
  await offer();
  later(31 * MIN);
  assert.match((await offer()).reason, /may have gone through/);
  later(32 * MIN);
  assert.match((await offer()).reason, /cooling down/);
  assert.deepEqual(calls.claim, ['a']);
});

test('an `unavailable` ineligibility is a read that failed, not a claim settled', async () => {
  const { calls, later, offer } = twoSpent({
    status: (name, n) => (name === 'b' ? { block: bBlock() } : { block: n === 2 ? aBlock({ eligible: false, ineligible_reason: 'unavailable', grants: [], next_grant_id: null }) : aBlock() }),
    claim: (name, n) => (name === 'a' && n === 1 ? LOST : RESET),
  });
  await offer();
  later(31 * MIN);
  assert.match((await offer()).reason, /unconfirmed/);
  later(62 * MIN);
  assert.equal((await offer()).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'a']);
  assert.equal(calls.keys[0], calls.keys[1], 'still unsettled, so still the replay');
});

// A grant that holds several resets stays next after one is spent, so the
// "moved past" rule cannot see it; its count dropping since the claim can.
test('a reset spent from the claimed grant since the claim settles it, and its key is not replayed', async () => {
  const { calls, later, offer } = twoSpent({
    status: (name, n) => (name === 'b' ? { block: bBlock() } : { block: aBlock({}, { resets_left: n === 1 ? 2 : 1 }) }),
    claim: (name, n) => (name === 'a' && n === 1 ? LOST : RESET),
  });
  await offer();
  later(31 * MIN);
  assert.match((await offer()).reason, /may have gone through/);
  later(62 * MIN);
  assert.equal((await offer()).redeemed, true);
  assert.deepEqual(calls.claim, ['a', 'a']);
  assert.notEqual(calls.keys[0], calls.keys[1]);
});

// A fresh claim answered `already_used` or `cooldown` is a reset someone else
// has just spent or started on that account: it is on its way back, so the walk
// stops there instead of spending a sibling's reset on top of it.
for (const result of ['already_used', 'cooldown']) {
  test(`a fresh ${result} holds the pool, re-reads that account, and spends no sibling`, async () => {
    const { am, calls, offer } = twoSpent({ claim: name => (name === 'a' ? said(result) : RESET) });
    const first = await offer();
    assert.equal(first.redeemed, false);
    assert.match(first.reason, new RegExp(result));
    assert.deepEqual(calls.claim, ['a']);
    assert.deepEqual(calls.usage, ['a'], 'the account that may be refilled is re-read');
    assert.match((await offer()).reason, /cooling down/);
    assert.deepEqual(calls.claim, ['a']);
    assert.equal(am.accounts[1].quota.unified7d, 1, 'the sibling was never touched');
  });
}

// The same for a reset in progress on a sibling, seen in its status — started
// by us before a restart, by a person, by another instance.
test('a sibling whose status reports a reset cooldown holds the pool, and nothing is spent', async () => {
  const { calls, offer } = twoSpent({ status: name => ({ block: name === 'a' ? aBlock({ cooldown_until: iso(Date.now() + 5 * MIN) }) : bBlock() }) });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /cooldown/);
  assert.deepEqual(calls.claim, []);
  assert.match((await offer()).reason, /cooling down/, 'the whole pool, not that account alone');
  assert.deepEqual(calls.claim, []);
});

// Rotation's holds outlive what armed them — a 429 hold runs up to an hour, a
// stored `rejected` half of one — and a sibling barred by nothing else may be
// serving again: a reset spent on it by hand, say. Its status is never read
// here (an opted-out account is not a candidate), so only a reading could say,
// and a verdict is not one: a 429 at a real limit carries its own reading.
for (const hold of ['throttled', 'rejected']) {
  test(`a sibling barred only by a ${hold} verdict, with no reading at its limit, still counts as able to serve`, async () => {
    const { am, calls, offer } = twoSpent();
    const a = am.accounts[0];
    a.autoRedeemReset = false;
    a.quota.unified7d = 0.6;
    if (hold === 'throttled') am.markRateLimited(0, 3600);
    else {
      a.quota.unifiedStatus = 'rejected';
      a.quota.unifiedStatusSeenAt = Date.now() - 2 * MIN;
    }
    assert.notEqual(am.unavailableReason(a), null, 'rotation still bars it');
    const result = await offer();
    assert.equal(result.redeemed, false);
    assert.equal(result.reason, 'another Claude account can still serve');
    assert.deepEqual(calls.claim, []);
    assert.deepEqual(calls.status, ['b']);
  });
}

// A spent reading is evidence only while it is recent: a week comes back early
// when a reset is spent on it elsewhere, and nothing here would see that.
test('a sibling\'s spent weekly reading puts it out only while the reading is recent', async () => {
  for (const [ageMs, spent] of /** @type {Array<[number, boolean]>} */ ([[20 * MIN, false], [MIN, true]])) {
    const { am, calls, offer } = twoSpent();
    const a = am.accounts[0];
    a.autoRedeemReset = false;
    a.quota.unified7dSeenAt = Date.now() - ageMs;
    const result = await offer();
    assert.equal(result.redeemed, spent, `a reading ${ageMs / MIN} min old`);
    assert.deepEqual(calls.claim, spent ? ['b'] : []);
  }
});

// Claude Code reads a status with no `exhausted` list as one listing nothing.
test('a sibling whose fresh status leaves out the exhausted list counts as able to serve', async () => {
  const { am, calls, offer } = twoSpent({ status: name => ({ block: name === 'a' ? aBlock({ exhausted: undefined }) : bBlock() }) });
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unifiedStatusSeenAt = Date.now();
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(result.reason, 'another Claude account can still serve');
  assert.deepEqual(calls.claim, []);
});

// An ineligible status may leave the list out for want of anything to say; it
// does not vouch for the account, and the reading in the same payload decides.
test('a sibling whose status is not in the program is judged by its reading, not by a missing list', async () => {
  const { calls, offer } = twoSpent({ status: name => ({ block: name === 'a' ? parseCedarEmber({ eligible: false, ineligible_reason: 'tier' }) : bBlock() }) });
  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.deepEqual(calls.claim, ['b']);
});

// The hold outlives the process: a restart minutes after a claim whose answer
// never came would otherwise spend a sibling's reset on top of it.
test('the pool hold survives a restart, and the saved state names no grant or request', async () => {
  const first = twoSpent({ claim: name => (name === 'a' ? LOST : RESET) });
  assert.equal((await first.offer()).redeemed, false);
  const saved = JSON.parse(JSON.stringify(first.am.exportQuotaState()));
  const text = JSON.stringify(saved);
  assert.equal(text.includes('grant-'), false);
  assert.equal(first.calls.keys.length, 1);
  assert.equal(text.includes(first.calls.keys[0]), false);

  const restarted = twoSpent();
  restarted.am.restoreQuotaState(saved);
  const result = await restarted.offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /cooling down/);
  assert.deepEqual(restarted.calls.status, []);
  assert.deepEqual(restarted.calls.claim, []);
});

// The switches are read again at the last moment: an operator who turns
// auto-redeem off while the token is being refreshed has turned it off before
// the claim, which then never leaves.
for (const off of ['fleet', 'account']) {
  test(`auto-redeem switched off for the ${off} during the token refresh stops the claim unsent`, async () => {
    const config = { ...ARMED };
    const { am, calls, offer } = harness({ config });
    let refreshes = 0;
    am.ensureTokenFresh = async () => {
      // The first refresh is the status read's, the second the claim's.
      if (++refreshes !== 2) return;
      if (off === 'fleet') config.autoRedeemResets = false;
      else am.accounts[0].autoRedeemReset = false;
    };
    const result = await offer();
    assert.equal(result.redeemed, false);
    assert.match(result.reason, /switched off/);
    assert.equal(calls.status, 1);
    assert.equal(calls.claim, 0);
  });
}

test('auto-redeem switched off before a replay stops the replay unsent', async () => {
  const config = { ...ARMED };
  const { am, calls, offer, later } = harness({ config, claim: () => LOST, usage: stillSpent() });
  let refreshes = 0;
  am.ensureTokenFresh = async () => { if (++refreshes === 4) config.autoRedeemResets = false; };
  await offer();
  later(31 * MIN);
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /switched off/);
  assert.equal(calls.claim, 1, 'the replay never left');
});

// Upstream's own word, which the local reading may not have caught up with.
test('a fresh not_limited lifts the account\'s wall, re-reads it, and spends no sibling', async () => {
  const { am, calls, offer } = twoSpent({ claim: name => (name === 'a' ? said('not_limited') : RESET), usage: () => ({}) });
  const a = am.accounts[0];
  am.markRateLimited(0, 600);
  a.quota.unifiedStatus = 'rejected';
  a.quota.unifiedStatusSeenAt = Date.now();
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.deepEqual(calls.claim, ['a']);
  assert.deepEqual(calls.usage, ['a']);
  assert.equal(a.status, 'active');
  assert.equal(a.quota.unifiedStatus, null);
  assert.match((await offer()).reason, /cooling down/);
  assert.deepEqual(calls.claim, ['a']);
});

// The status is a usage reading in its own right: an account whose week has
// come back — by a claim of ours that landed unseen, or a reset spent in
// claude.ai — reads available from it, and the pool is no longer dry.
test('a status read refreshes the account\'s quota, so a refilled account stops a sibling being spent', async () => {
  const payloads = {
    a: { five_hour: { utilization: 10 }, seven_day: { utilization: 40, resets_at: iso(Date.now() + 3 * DAY) }, cedar_ember: rawBlock({ exhausted: undefined }, { ends_at: iso(Date.now() + 5 * DAY) }) },
    b: { five_hour: { utilization: 10 }, seven_day: { utilization: 100, resets_at: iso(Date.now() + 3 * DAY) }, cedar_ember: rawBlock({ grants: [rawGrant({ id: 'grant-b' })], next_grant_id: 'grant-b' }) },
  };
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  for (const account of am.accounts) weeklySpent(account);
  /** @type {string[]} */
  const claimed = [];
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    statusFn: (/** @type {any} */ account, /** @type {any} */ opts) => fetchClaudeResetStatus(account, { ...opts, ...answering(payloads[/** @type {'a'|'b'} */ (account.name)]) }),
    claimFn: async (/** @type {any} */ account) => { claimed.push(account.name); return RESET; },
    usageFn: async () => stillSpent(),
  });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.equal(result.reason, 'another Claude account can still serve');
  assert.deepEqual(claimed, []);
  assert.equal(am.accounts[0].quota.unified7d, 0.4);
  assert.equal(am.unavailableReason(am.accounts[0]), null);
  const stored = JSON.stringify({ quota: am.exportQuotaState(), accounts: am.accounts.map(a => a.quota) });
  assert.equal(stored.includes('grant-'), false, 'the usage is applied, the grant ids are not');
});

// The same when the local view cannot catch up — a stored rejection, a rate
// limit hold — and upstream says outright that nothing on the account is spent.
test('an account whose fresh status lists nothing exhausted counts as able to serve', async () => {
  const { am, calls, offer } = twoSpent({ status: name => ({ block: name === 'a' ? aBlock({ exhausted: [] }) : bBlock() }) });
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unifiedStatusSeenAt = Date.now();
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.equal(result.reason, 'another Claude account can still serve');
  assert.deepEqual(calls.claim, []);
});

// ── the time budget ─────────────────────────────────────────────────────────

/** One budget across refresh, read, claim and re-read, on a clock the test moves by hand. */
function budgeted({ budgetMs = 1000, claimFloorMs = 100, refreshCost = 0, statusCost = 0, claimCost = 0 } = {}) {
  const am = new AccountManager([claude('a')], 0.98);
  const clock = { at: Date.now() };
  weeklySpent(am.accounts[0], clock.at);
  am.ensureTokenFresh = async () => { clock.at += refreshCost; };
  /** @type {{status: number, claim: number, usage: number, statusTimeout: number|null, claimTimeout: number|null, usageTimeout: number|null}} */
  const calls = { status: 0, claim: 0, usage: 0, statusTimeout: null, claimTimeout: null, usageTimeout: null };
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    now: () => clock.at,
    timeoutMs: budgetMs,
    claimFloorMs,
    statusFn: async (/** @type {any} */ _account, /** @type {any} */ opts) => {
      calls.status++;
      calls.statusTimeout = opts.timeoutMs;
      clock.at += statusCost;
      return { block: block() };
    },
    claimFn: async (/** @type {any} */ _account, /** @type {any} */ _attempt, /** @type {any} */ opts) => {
      calls.claim++;
      calls.claimTimeout = opts.timeoutMs;
      clock.at += claimCost;
      return { result: 'reset', reason: null, resetsLeft: 0, cleared: [] };
    },
    usageFn: async (/** @type {any} */ _account, /** @type {any} */ opts) => {
      calls.usage++;
      calls.usageTimeout = opts.timeoutMs;
      return { sevenDay: { utilization: 0, resetAt: clock.at + 7 * DAY } };
    },
  });
  return { am, redeemer, calls, clock, offer: () => redeemer.maybeRedeemForPool([am.accounts[0]]) };
}

test('the budget is 30 seconds, for the whole attempt, and the reads leave the claim its 10', async () => {
  assert.equal(CLAUDE_REDEEM_BUDGET_MS, 30_000);
  const am = new AccountManager([claude('a')], 0.98);
  weeklySpent(am.accounts[0]);
  /** @type {number[]} */
  const timeouts = [];
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    now: () => 0,
    statusFn: async (/** @type {any} */ _a, /** @type {any} */ opts) => { timeouts.push(opts.timeoutMs); return { block: null }; },
  });
  await redeemer.maybeRedeemForPool([am.accounts[0]]);
  assert.deepEqual(timeouts, [20_000]);
});

test('a slow status read leaves the claim and the re-read only what is left of the budget', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, statusCost: 600, claimCost: 300 });
  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.equal(calls.statusTimeout, 900, 'the read never gets the claim\'s share');
  assert.equal(calls.claimTimeout, 400, 'the claim gets the remainder, never the whole budget a second time');
  assert.equal(calls.usageTimeout, 100);
});

test('a refresh that eats the budget stops before the status read', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, refreshCost: 1000 });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.status, 0, 'a call with nothing left to spend is not made at all');
});

test('a budget spent before the claim declines rather than making the irreversible call late', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, statusCost: 1000 });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.claim, 0);
});

// A claim cut off mid-flight may have spent a reset, and that holds the whole
// fleet for half an hour; a claim never started has spent nothing.
test('a claim is not started with less than its share of the budget left', async () => {
  const { redeemer, calls, offer } = budgeted({ budgetMs: 1000, claimFloorMs: 300, statusCost: 800 });
  const result = await offer();
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.statusTimeout, 700);
  assert.equal(calls.claim, 0);
  assert.equal(redeemer.fleetCooldownUntil, 0, 'nothing was sent, so nothing holds the fleet');
});

test('a spent budget arms the cooldown rather than being retried per refusal', async () => {
  const { calls, offer } = budgeted({ budgetMs: 1000, statusCost: 1000 });
  await offer();
  const again = await offer();
  assert.match(again.reason, /cooling down/);
  assert.equal(calls.claim, 0);
});

// The reset is spent by then: running out of time skips only the re-read,
// never the hold release that lets the re-forwarded request through.
test('a claim that eats the budget still lifts the hold, and skips only the re-read', async () => {
  const { am, calls, offer } = budgeted({ budgetMs: 1000, claimCost: 1000 });
  am.markRateLimited(0, 600);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unifiedStatusSeenAt = Date.now();
  const result = await offer();
  assert.equal(result.redeemed, true);
  assert.equal(calls.usage, 0);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
});

test('a token refresh that outlives the budget is left behind, not waited out', async () => {
  const am = new AccountManager([claude('a')], 0.98);
  weeklySpent(am.accounts[0]);
  /** @type {() => void} */
  let finishRefresh = () => {};
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = () => resolve(undefined); });
  const calls = { status: 0, claim: 0 };
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    timeoutMs: 20,
    statusFn: async () => { calls.status++; return { block: block() }; },
    claimFn: async () => { calls.claim++; return { result: 'reset', reason: null, resetsLeft: 0, cleared: [] }; },
    usageFn: async () => ({}),
  });

  const result = await redeemer.maybeRedeemForPool([am.accounts[0]]);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /budget/);
  assert.equal(calls.status, 0, 'nothing is read on a token the attempt never got');

  finishRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.claim, 0, 'a refresh that finished late must not reach the irreversible call');
});

// ── isolation ───────────────────────────────────────────────────────────────

test('no account but a Claude subscription login ever reaches a Claude endpoint', async () => {
  const am = new AccountManager([
    codex('codex', { orgUuid: 'org-codex' }),
    { name: 'key', type: 'apikey', apiKey: 'k', orgUuid: 'org-key' },
    claude('backend', { upstream: 'https://backend.example' }),
  ], 0.98);
  for (const account of am.accounts) weeklySpent(account);
  let touched = 0;
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    statusFn: async () => { touched++; return { block: block() }; },
    claimFn: async () => { touched++; return { result: 'reset', reason: null, resetsLeft: 0, cleared: [] }; },
    usageFn: async () => { touched++; return {}; },
  });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(touched, 0);
});

test('the grant ids a redeemer reads never reach the stored quota', async () => {
  const { am, offer } = harness({ accounts: [claude('a'), claude('b')] });
  await offer();
  const stored = JSON.stringify({ quota: am.exportQuotaState(), accounts: am.accounts.map(a => a.quota) });
  assert.equal(stored.includes('grant-a'), false);
});

test('a fleet nobody armed stops before any request', async () => {
  const { calls, offer } = harness({ config: {} });
  assert.match((await offer()).reason, /auto-redeem is switched off$/);
  assert.equal(calls.status, 0);
});

test('an account that opted out stops there too, even on an armed fleet', async () => {
  const { calls, offer } = harness({ accounts: [claude('a', { autoRedeemReset: false })] });
  assert.match((await offer()).reason, /switched off for this account/);
  assert.equal(calls.status, 0);
});

test('a per-account `true` redeems nothing while the fleet switch is off', async () => {
  const { calls, offer } = harness({ accounts: [claude('a', { autoRedeemReset: true })], config: {} });
  assert.equal((await offer()).redeemed, false);
  assert.equal(calls.claim, 0);
});

test('flipping the fleet switch binds on the next refusal, with no restart', async () => {
  const config = {};
  const { calls, offer } = harness({ config });
  assert.equal((await offer()).redeemed, false);
  config.autoRedeemResets = true;
  assert.equal((await offer()).redeemed, true);
  assert.equal(calls.claim, 1);
});

// ── the pool-dry refusal ────────────────────────────────────────────────────

/** A redeemer over a pool of spent Claude accounts, each with its own status block. */
function poolHarness({ accounts = [claude('a'), claude('b')], blocks = {}, claim = null, config = { ...ARMED }, caughtUp = true, usageFn = null } = {}) {
  const am = new AccountManager(accounts, 0.98);
  for (const account of am.accounts) weeklySpent(account);
  /** @type {{status: string[], claim: string[], logs: string[]}} */
  const calls = { status: [], claim: [], logs: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config,
    log: (/** @type {string} */ line) => { calls.logs.push(line); },
    statusFn: async (/** @type {any} */ account) => {
      calls.status.push(account.name);
      return { block: account.name in blocks ? blocks[account.name] : block() };
    },
    claimFn: async (/** @type {any} */ account) => {
      calls.claim.push(account.name);
      return (typeof claim === 'function' ? claim(account.name) : null) ?? { result: 'reset', reason: null, resetsLeft: 0, cleared: [] };
    },
    // `caughtUp: false` is a re-read that still reports the window spent;
    // `usageFn` replaces it outright, for the re-read that does not answer.
    usageFn: usageFn ?? (async () => ({ sevenDay: { utilization: caughtUp ? 0 : 1, resetAt: Date.now() + 7 * DAY } })),
  });
  return { am, redeemer, calls };
}

test('a dry pool spends the reset that would be lost first, and spends exactly one', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = poolHarness({
    blocks: { a: block({}, { ends_at: iso(now + 20 * DAY) }), b: block({}, { ends_at: iso(now + 10 * DAY) }) },
  });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['b']);
});

test('an account whose status offers nothing is passed over for one that does', async () => {
  const { am, redeemer, calls } = poolHarness({ blocks: { a: block({ eligible: false, ineligible_reason: 'tier' }) } });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.claim, ['b']);
});

test('a status read refused on one account is that account\'s problem, not the pool\'s', async () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  for (const account of am.accounts) weeklySpent(account);
  /** @type {string[]} */
  const claimed = [];
  const redeemer = new ClaudeResetRedeemer(am, {
    config: { ...ARMED },
    log: () => {},
    statusFn: async (/** @type {any} */ account) => (account.name === 'a' ? { error: 'HTTP 403', status: 403 } : { block: block() }),
    claimFn: async (/** @type {any} */ account) => { claimed.push(account.name); return { result: 'reset', reason: null, resetsLeft: 0, cleared: [] }; },
    usageFn: async () => ({ sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } }),
  });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(claimed, ['b']);
});

test('a dry pool holding no reset anywhere spends nothing and says so', async () => {
  const { am, redeemer, calls } = poolHarness({ blocks: { a: block({ next_grant_id: null }), b: block({}, { resets_left: 0 }) } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.deepEqual(calls.claim, []);
});

test('concurrent refusals are one decision, not one claim per refused request', async () => {
  const { am, redeemer, calls } = poolHarness();
  const results = await Promise.all([0, 1, 2, 3].map(() => redeemer.maybeRedeemForPool(am.accounts, { model: 'claude-opus-4-1' })));
  assert.equal(calls.claim.length, 1);
  assert.equal(results.filter(r => r.redeemed).length, 4);
});

test('an unarmed fleet refuses the whole pool without reading a single status', async () => {
  const { am, redeemer, calls } = poolHarness({ config: {} });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.match(result.reason, /auto-redeem is switched off$/);
  assert.deepEqual(calls.status, []);
});

test('a Codex account offered among the candidates never reaches a Claude endpoint', async () => {
  const { am, redeemer, calls } = poolHarness({ accounts: [codex('codex'), claude('b')] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.status, ['b']);
  assert.deepEqual(calls.claim, ['b']);
});

test('a second refusal after a reset that does not read as one is refused by the cooldown', async () => {
  const { am, redeemer, calls } = poolHarness({ accounts: [claude('a')], caughtUp: false });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /cooling down/);
  assert.deepEqual(calls.claim, ['a']);
});

test('a reset whose quota re-read fails still holds every other account', async () => {
  const { am, redeemer, calls } = poolHarness({ usageFn: async () => ({ error: 'HTTP 500' }) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(second.redeemed, false);
  assert.match(second.reason, /cooling down/);
  assert.equal(calls.claim.length, 1, 'one dry pool, one reset');
});

test('a claim whose verdict never arrived stops the walk rather than spending again', async () => {
  const { am, redeemer, calls } = poolHarness({ claim: () => ({ error: 'socket hang up', status: null }) });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /socket hang up/);
  assert.equal(calls.claim.length, 1, 'a POST that may have landed is never answered with a second one');
  const second = await redeemer.maybeRedeemForPool(am.accounts);
  assert.match(second.reason, /cooling down/);
  assert.equal(calls.claim.length, 1);
});

test('an `unavailable` answer is a claim that may have landed, like a lost one', async () => {
  const { am, redeemer, calls } = poolHarness({ claim: () => ({ result: 'unavailable', reason: 'reset_unconfirmed', resetsLeft: null, cleared: [] }) });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.claim.length, 1);
  assert.match((await redeemer.maybeRedeemForPool(am.accounts)).reason, /cooling down/);
});

test('a redemption that returns one account to service stops the sibling spending too', async () => {
  const { am, redeemer, calls } = poolHarness();
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  const sibling = am.accounts.find(a => a.name !== calls.claim[0]);
  assert.ok(sibling);
  redeemer.now = () => Date.now() + 7 * 60 * MIN;
  const second = await redeemer.maybeRedeemForPool([sibling]);
  assert.equal(second.redeemed, false);
  assert.equal(second.reason, 'another Claude account can still serve');
  assert.equal(calls.claim.length, 1);
});

// The pool is judged for the request that was refused: a sibling whose Sonnet
// weekly is spent cannot serve a Sonnet request, whatever it could do for Opus.
test('the dry-pool check asks about the refused request\'s model', async () => {
  for (const [model, redeemed] of /** @type {Array<[string, boolean]>} */ ([['claude-sonnet-4-5', true], ['claude-opus-4-1', false]])) {
    const am = new AccountManager([claude('a'), claude('b')], 0.98);
    weeklySpent(am.accounts[0]);
    am.accounts[1].quota.unified7d = 0.2;
    am.accounts[1].quota.unified7dReset = Date.now() + 3 * DAY;
    am.accounts[1].quota.unified7dSonnet = 1;
    am.accounts[1].quota.unified7dSonnetReset = Date.now() + 3 * DAY;
    am.accounts[1].quota.unified7dSonnetSeenAt = Date.now();
    const redeemer = new ClaudeResetRedeemer(am, {
      config: { ...ARMED },
      log: () => {},
      statusFn: async () => ({ block: block() }),
      claimFn: async () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: [] }),
      usageFn: async () => ({}),
    });
    assert.equal((await redeemer.maybeRedeemForPool([am.accounts[0]], { model })).redeemed, redeemed, model);
  }
});

// ── the pool-dry refusal, through the proxy ─────────────────────────────────

/**
 * One request through a proxy whose Claude pool is dry: every account's weekly
 * window reads spent, so selection refuses before choosing anyone. The hooks
 * stand in for the redeemers; `onRedeem` returning true makes the first
 * candidate selectable, the way a real claim's quota re-read does.
 */
async function forwardOneClaudeRefusal({ onRedeem = null, onCodexRedeem = null, accounts = [claude('a')], path = '/v1/messages', model = 'claude-opus-4-1', reread = true, prepare = weeklySpent } = {}) {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(/** @type {any} */ (upstream.address()).port)));
  const am = new AccountManager(accounts, 0.98);
  for (const account of am.accounts) prepare(account);
  am._nextProbeAt = Date.now() + 60 * 60 * 1000;

  /** @type {string[][]} */
  const asked = [];
  /** @type {any[]} */
  const models = [];
  /** @type {string[][]} */
  const codexAsked = [];
  /** @type {Record<string, any>} */
  const hooks = {};
  if (onRedeem) {
    hooks.redeemClaudeResetForPool = async (/** @type {any[]} */ candidates, /** @type {any} */ opts) => {
      asked.push(candidates.map(a => a.name));
      models.push(opts?.model);
      const redeemed = await onRedeem();
      if (redeemed && reread) am.applyUsageData(candidates[0].index, { sevenDay: { utilization: 0, resetAt: Date.now() + 7 * DAY } });
      return { redeemed, reason: 'test' };
    };
  }
  if (onCodexRedeem) {
    hooks.redeemCodexResetForPool = async (/** @type {any[]} */ candidates) => {
      codexAsked.push(candidates.map(a => a.name));
      return { redeemed: await onCodexRedeem(), reason: 'test' };
    };
  }
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const proxyPort = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(/** @type {any} */ (proxy.address()).port)));
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [], max_tokens: 1 }),
    });
    await res.text();
    return { status: res.status, hits, asked, models, codexAsked, am };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a dry Claude pool asks whether to spend a reset, and serves the request when one was', async () => {
  const r = await forwardOneClaudeRefusal({ onRedeem: async () => true });
  assert.deepEqual(r.asked, [['a']]);
  assert.deepEqual(r.models, ['claude-opus-4-1']);
  assert.equal(r.status, 200);
  assert.equal(r.hits, 1, 'the request selection refused must actually be served afterwards');
});

test('a Claude refusal with nothing to spend is the refusal it always was', async () => {
  const r = await forwardOneClaudeRefusal({ onRedeem: async () => false });
  assert.deepEqual(r.asked, [['a']]);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

test('a Claude redeemer that throws leaves the refusal exactly as it was', async () => {
  const r = await forwardOneClaudeRefusal({ onRedeem: async () => { throw new Error('upstream exploded'); } });
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

test('a reset that leaves the account unselectable costs one re-selection, not a loop', async () => {
  const r = await forwardOneClaudeRefusal({ onRedeem: async () => true, reread: false });
  assert.deepEqual(r.asked, [['a']]);
  assert.equal(r.status, 429);
  assert.equal(r.hits, 0);
});

test('only Claude logins a reset would return to service are offered', async () => {
  const r = await forwardOneClaudeRefusal({
    onRedeem: async () => false,
    accounts: [
      claude('off', { disabled: true }),
      claude('a'),
      claude('capped', { maxUsage: { unified7d: 0.5 } }),
      { name: 'key', type: 'apikey', apiKey: 'k' },
    ],
  });
  assert.deepEqual(r.asked, [['a']]);
});

// The verdict a spent weekly window leaves stored after the 429 that reported
// it: the local reading may still sit just under the line.
test('an account upstream rejected is one a reset can return to service', async () => {
  const r = await forwardOneClaudeRefusal({
    onRedeem: async () => false,
    accounts: [claude('rejected'), claude('a')],
    prepare: account => {
      if (account.name !== 'rejected') return weeklySpent(account);
      account.quota.unified7d = 0.9;
      account.quota.unified7dReset = Date.now() + 3 * DAY;
      account.quota.unifiedStatus = 'rejected';
      account.quota.unifiedStatusSeenAt = Date.now();
      return account;
    },
  });
  assert.equal(r.am.unavailableReason(r.am.accounts[0]), 'upstream-rejected');
  assert.deepEqual(r.asked, [['rejected', 'a']]);
});

test('a dry Claude pool never asks the Codex redeemer, and a dry Codex pool never asks the Claude one', async () => {
  const claudeFleet = await forwardOneClaudeRefusal({ onRedeem: async () => false, onCodexRedeem: async () => true });
  assert.deepEqual(claudeFleet.codexAsked, []);
  assert.deepEqual(claudeFleet.asked, [['a']]);

  const codexFleet = await forwardOneClaudeRefusal({
    onRedeem: async () => true,
    onCodexRedeem: async () => false,
    accounts: [codex('c')],
    path: '/backend-api/codex/responses',
    model: 'gpt-5.6-sol',
  });
  assert.deepEqual(codexFleet.asked, []);
  assert.deepEqual(codexFleet.codexAsked, [['c']]);
});

// One pool holding both: each redeemer is offered only its own provider's dry
// accounts, whichever provider's request was refused.
test('in a mixed pool, each refusal offers only its own provider\'s dry accounts', async () => {
  const accounts = () => [codex('c'), claude('a')];
  const claudeRequest = await forwardOneClaudeRefusal({ onRedeem: async () => false, onCodexRedeem: async () => false, accounts: accounts() });
  assert.deepEqual(claudeRequest.asked, [['a']]);
  assert.deepEqual(claudeRequest.codexAsked, []);

  const codexRequest = await forwardOneClaudeRefusal({
    onRedeem: async () => false,
    onCodexRedeem: async () => false,
    accounts: accounts(),
    path: '/backend-api/codex/responses',
    model: 'gpt-5.6-sol',
  });
  assert.deepEqual(codexRequest.asked, []);
  assert.deepEqual(codexRequest.codexAsked, [['c']]);
});

// ── configuration ───────────────────────────────────────────────────────────

test('the one fleet switch defaults off, for Claude as for Codex', async () => {
  const config = createDefaultConfig();
  assert.equal(config.autoRedeemResets, false);
  const { calls, offer } = harness({ config });
  assert.match((await offer()).reason, /auto-redeem is switched off$/);
  assert.equal(calls.status, 0);
});

test('accounts[].autoRedeemReset only ever vetoes, on a Claude login too', () => {
  const am = new AccountManager([
    claude('default'),
    claude('off', { autoRedeemReset: false }),
    claude('on', { autoRedeemReset: true }),
  ], 0.98);
  assert.deepEqual(am.accounts.map(a => a.autoRedeemReset), [true, false, true]);
});

test('reload applies and clears a Claude opt-out, and the redeemer reads it on the next refusal', async () => {
  const base = claude('a');
  const mem = { accounts: [{ ...base }] };
  const { am, redeemer, calls } = poolHarness({ accounts: mem.accounts });

  await syncAccountsFromDisk({ accounts: [{ ...base, autoRedeemReset: false }] }, mem, am);
  assert.equal(mem.accounts[0].autoRedeemReset, false);
  assert.match((await redeemer.maybeRedeemForPool(am.accounts)).reason, /switched off for this account/);
  assert.deepEqual(calls.status, []);

  await syncAccountsFromDisk({ accounts: [{ ...base }] }, mem, am);
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
});

// The settings screen toggles the shared config object; the Claude redeemer
// must read the same object, or the one kill switch would miss a provider.
test('settings: the one toggle arms the Claude redeemer, and its log names no provider', async () => {
  const am = new AccountManager([claude('a')], 0.98);
  weeklySpent(am.accounts[0]);
  const config = { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [] };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  const row = tui._settingsFields().find((/** @type {any} */ f) => f.id === 'autoRedeemResets');
  const redeemer = new ClaudeResetRedeemer(am, {
    config,
    log: () => {},
    statusFn: async () => ({ block: block() }),
    claimFn: async () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: [] }),
    usageFn: async () => ({}),
  });

  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  await row.right();
  assert.ok(tui.log.some((/** @type {any} */ l) => /^Auto-redeem reset credits: on$/.test(l.msg.replace(/\x1b\[[0-9;]*m/g, ''))));
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
});
