import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankedResets, fetchUsage, normalizeUsagePayload } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { accountBadges } from '../src/dashboard.js';
import { renderStatus, resetCreditLine } from '../src/status-renderer.js';
import { resetCreditTag } from '../src/tui.js';

// Claude's banked usage-limit resets (issue #493): the claude.ai "Resets"
// offer, read off the same zero-spend usage probe and drawn through the same
// surfaces the Codex reset credits already use.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-04T00:00:00Z');

// The `cedar_ember` block taken from /api/oauth/usage?cedar_ember=1 on a live
// Max account (2026-10-04). Grant `id`s and `next_grant_id` are deliberately
// carried here, so the test below can prove they never reach the reading.
const LIVE_BLOCK = {
  eligible: true,
  ineligible_reason: null,
  at_limit: true,
  exhausted: ['seven_day'],
  grants: [{
    id: 'grant-handle-that-spends-it',
    label: 'Claude Opus 5.5 launch: one usage-limit reset for Pro and Max',
    resets_total: 1,
    resets_left: 1,
    starts_at: '2026-09-22T16:00:00+00:00',
    ends_at: '2026-10-22T16:00:00+00:00',
    clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 0, seven_day: 100, seven_day_overage_included: 0 },
    blocking: [],
    arm: null,
  }],
  next_grant_id: 'next-grant-handle',
  weekly_resets_at: '2026-10-04T12:00:00+00:00',
  cooldown_until: null,
};
const ENDS = Date.parse('2026-10-22T16:00:00+00:00');
const grant = over => ({ ...LIVE_BLOCK.grants[0], ...over });

// ── reading the block ───────────────────────────────────────────────────────

test('the live payload reads as one reset, spendable now, with its expiry', () => {
  assert.deepEqual(bankedResets(LIVE_BLOCK, NOW), { available: 1, applicable: 1, expiresAt: ENDS });
});

test('the probe payload carries the reading beside the quota buckets', () => {
  const u = normalizeUsagePayload({ five_hour: { utilization: 0 }, seven_day: { utilization: 100 }, cedar_ember: LIVE_BLOCK });
  assert.equal(u.sevenDay.utilization, 1);
  assert.equal(u.resetCredits.available, 1);
});

test('the grant ids never leave the parser', () => {
  const text = JSON.stringify(normalizeUsagePayload({ cedar_ember: LIVE_BLOCK }));
  assert.equal(text.includes('grant-handle'), false);
});

test('a block that says nothing usable is no reading, not zero', () => {
  assert.equal(bankedResets(undefined, NOW), null);
  assert.equal(bankedResets(null, NOW), null);
  assert.equal(bankedResets('yes', NOW), null);
  // Ineligibility has so far always been about the caller, not the account.
  assert.equal(bankedResets({ eligible: false, ineligible_reason: 'cli_version', grants: [] }, NOW), null);
  assert.equal(bankedResets({ eligible: false, ineligible_reason: 'surface' }, NOW), null);
  assert.equal(bankedResets({ eligible: true }, NOW), null);
  assert.equal(normalizeUsagePayload({ five_hour: { utilization: 5 } }).resetCredits, null);
});

test('an eligible block with no live grant is a real zero', () => {
  assert.deepEqual(bankedResets({ ...LIVE_BLOCK, grants: [] }, NOW), { available: 0, applicable: 0, expiresAt: null });
  assert.deepEqual(bankedResets({ ...LIVE_BLOCK, grants: [grant({ resets_left: 0 })] }, NOW),
    { available: 0, applicable: 0, expiresAt: null });
});

test('an expired grant is not counted', () => {
  assert.equal(bankedResets(LIVE_BLOCK, ENDS).available, 0);
  assert.equal(bankedResets(LIVE_BLOCK, ENDS - 1).available, 1);
});

test('a grant held but not spendable yet counts as held, not applicable', () => {
  assert.deepEqual(bankedResets({ ...LIVE_BLOCK, grants: [grant({ usable_now: false })] }, NOW),
    { available: 1, applicable: 0, expiresAt: ENDS });
  assert.deepEqual(bankedResets({ ...LIVE_BLOCK, grants: [grant({ paused: true })] }, NOW),
    { available: 1, applicable: 0, expiresAt: ENDS });
});

test('several grants sum, and the soonest expiry is the one reported', () => {
  const sooner = '2026-10-10T00:00:00+00:00';
  const r = bankedResets({ ...LIVE_BLOCK, grants: [grant({}), grant({ ends_at: sooner, usable_now: false })] }, NOW);
  assert.deepEqual(r, { available: 2, applicable: 1, expiresAt: Date.parse(sooner) });
});

test('malformed or hostile counts cannot reach the display rows', () => {
  const r = bankedResets({ ...LIVE_BLOCK, grants: [
    grant({ resets_left: 'lots' }), grant({ resets_left: -3 }), null, 'x',
    grant({ resets_left: 1e9 }), grant({ resets_left: 1.7, ends_at: undefined }),
  ] }, NOW);
  assert.equal(r.available, 99);
  assert.equal(r.expiresAt, ENDS);
});

// ── asking for it ───────────────────────────────────────────────────────────

test('the probe asks for the block as a client the endpoint answers', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ cedar_ember: LIVE_BLOCK }) };
  };
  const u = await fetchUsage('tok', null, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/oauth\/usage\?cedar_ember=1$/);
  // Gated on the User-Agent alone: claude-cli >= 2.1.280 is eligible.
  const [, version] = /^claude-cli\/(\d+\.\d+\.\d+) \(external, cli\)$/.exec(calls[0].init.headers['User-Agent']) || [];
  assert.ok(version, 'a claude-cli User-Agent');
  const [maj, min, patch] = version.split('.').map(Number);
  assert.ok(maj > 2 || (maj === 2 && (min > 1 || (min === 1 && patch >= 280))), `claude-cli ${version} is below the 2.1.280 floor`);
  assert.equal(u.resetCredits.available, 1);
});

// ── storing it ──────────────────────────────────────────────────────────────

function manager() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
}

test('a probe stores the reading stamped, and a silent payload leaves it alone', () => {
  const am = manager();
  am.applyUsageData(0, normalizeUsagePayload({ cedar_ember: LIVE_BLOCK }));
  const held = am.accounts[0].quota.resetCredits;
  assert.equal(held.available, 1);
  assert.ok(Number.isFinite(held.seenAt));

  am.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 10 } }));
  assert.equal(am.accounts[0].quota.resetCredits, held);

  am.applyUsageData(0, normalizeUsagePayload({ cedar_ember: { ...LIVE_BLOCK, grants: [] } }));
  assert.equal(am.accounts[0].quota.resetCredits.available, 0);
});

// ── what the operator sees ──────────────────────────────────────────────────

const paint = { dim: s => s, cyan: s => s, gray: s => s };
const quota = (over = {}) => ({ resetCredits: { available: 1, applicable: 1, expiresAt: NOW + 19 * DAY, seenAt: NOW - 60_000, ...over } });

test('every surface shows a held reset, with when it lapses', () => {
  assert.equal(resetCreditTag(quota(), NOW), 'RC1');
  assert.match(resetCreditLine({ quota: quota() }, paint, NOW), /1 free rate-limit reset credit — expires 19d/);
  const badges = accountBadges({ name: 'a', provider: 'anthropic', quota: quota() }, 'a', null, NOW);
  assert.ok(badges.some(b => /^1 reset credit · expires /.test(b.text)));

  const account = { name: 'a', type: 'oauth', status: 'active', quota: { unified5h: 0, unified7d: 1, ...quota() }, usage: {}, sessions: 0 };
  const out = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [account] }, { color: false, now: NOW });
  assert.match(out, /Reset\s+1 free rate-limit reset credit/);
});

test('a reset past its expiry is gone from every surface', () => {
  const past = quota({ expiresAt: NOW - 1 });
  assert.equal(resetCreditTag(past, NOW), '');
  assert.equal(resetCreditLine({ quota: past }, paint, NOW), null);
  assert.equal(accountBadges({ name: 'a', provider: 'anthropic', quota: past }, 'a', null, NOW)
    .some(b => /reset credit/.test(b.text)), false);
});

test('a Codex reading without an expiry reads as it did before', () => {
  const codex = { resetCredits: { available: 2, applicable: 2, seenAt: NOW - 60_000 } };
  assert.equal(/expires/.test(resetCreditLine({ quota: codex }, paint, NOW)), false);
  assert.ok(accountBadges({ name: 'a', provider: 'codex', quota: codex }, 'a', null, NOW)
    .some(b => b.text === '2 reset credits'));
});
