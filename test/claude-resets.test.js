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

function fableSpent(account, resetIn) {
  Object.assign(account.quota, { unified5h: 0.1, unified7d: 0.5, unified7dFable: 1, unified7dFableReset: Date.now() + resetIn });
  return account;
}

function harness({ accounts = [oauth('a')], status = () => block(), claim = () => ({ result: 'reset', reason: null, resetsLeft: 0, cleared: ['five_hour', 'seven_day', 'seven_day_overage_included'], cooldownUntil: null }), config = { ...ARMED } } = {}) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => fableSpent(a, (i + 1) * DAY));
  const calls = { status: 0, claim: [], keys: [] };
  const redeemer = new ClaudeResetRedeemer(am, {
    config, log: () => {},
    statusFn: async (account) => { calls.status++; const b = status(account, calls); return { reset: parseResetStatus(b), usage: { fiveHour: { utilization: 0 }, sevenDay: { utilization: 0 }, sevenDayFable: { utilization: 0 } } }; },
    claimFn: async (account, c) => { calls.claim.push(account.name); calls.keys.push(c.requestId); return claim(calls.claim.length, c); },
  });
  am.ensureTokenFresh = async () => {};
  return { am, redeemer, calls };
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

test('a Codex row or a third-party backend is never a Claude candidate', async () => {
  const { am, redeemer, calls } = harness({ accounts: [oauth('cx', { provider: 'codex', accountId: 'x' }), oauth('nano', { upstream: 'https://api.nano-gpt.com/api' })] });
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, false);
  assert.equal(calls.status + calls.claim.length, 0);
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
