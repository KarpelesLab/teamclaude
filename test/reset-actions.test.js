import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeResetRedeemer, claudeGrantKind, claimClaudeReset, parseResetStatus } from '../src/claude-resets.js';
import { ResetCreditRedeemer, consumeResetCredit } from '../src/codex-reset-credits.js';
import { createResetActions } from '../src/reset-actions.js';

// Every network boundary is injected: these POSTs spend real, scarce resets.
const NOW = Date.parse('2026-11-13T12:00:00Z');
const HOUR = 3600_000;
const iso = time => new Date(time).toISOString();
const rawGrant = (extra = {}) => ({ id: 'weekly', label: 'Weekly reset', resets_total: 2, resets_left: 1,
  usable_now: true, paused: false, clears: ['seven_day'], ends_at: iso(NOW + 24 * HOUR), ...extra });
const block = (extra = {}) => ({ eligible: true, at_limit: true, exhausted: ['seven_day'], next_grant_id: 'weekly',
  grants: [rawGrant(), rawGrant({ id: 'fable', clears: ['seven_day_overage_included'], label: 'Fable reset' })], ...extra });
const credit = (extra = {}) => ({ id: 'credit-1', title: 'Full reset', status: 'available', supportedByPlan: true,
  expiresAt: NOW + 24 * HOUR, ...extra });

function harness({ provider = 'claude', status = block(), credits = [credit()], claim, consume, extra = {}, armed = false } = {}) {
  const account = { index: 0, name: 'test-account', type: 'oauth', credential: 'fake-token', orgUuid: 'org-1',
    ...(provider === 'codex' ? { provider: 'codex', accountId: 'acct-1' } : {}),
    quota: { unified7d: 1, unified7dReset: NOW + 7 * 24 * HOUR }, ...extra };
  const calls = { tokens: [], statuses: 0, details: 0, claims: [], consumes: [], clear: [], rejected: [], usage: [], logs: [] };
  const am = { accounts: [account],
    ensureTokenFresh: async index => { calls.tokens.push(index); },
    clearRateLimited: index => { calls.clear.push(index); },
    clearUpstreamRejected: index => { calls.rejected.push(index); },
    applyUsageData: (index, usage) => { calls.usage.push({ index, usage }); },
    applyCodexUsageData: (index, usage) => { calls.usage.push({ index, usage }); },
    unavailableReason: () => 'quota',
  };
  const clock = { at: NOW };
  const now = () => clock.at;
  const config = { autoRedeemResets: armed };
  const log = line => calls.logs.push(line);
  const claudeRedeemer = new ClaudeResetRedeemer(am, { config, now, log,
    statusFn: async () => { calls.statuses++; return { reset: parseResetStatus(typeof status === 'function' ? status(calls.statuses) : status), usage: { sevenDay: { utilization: 0 } } }; },
    claimFn: async (account, attempt) => { calls.claims.push(attempt); return claim ? claim(account, attempt, calls.claims.length) : { result: 'reset', resetsLeft: 0, cleared: ['seven_day'] }; },
  });
  const codexRedeemer = new ResetCreditRedeemer(am, { config, now, log,
    detailsFn: async () => { calls.details++; return { credits: typeof credits === 'function' ? credits(calls.details) : credits }; },
    consumeFn: async (account, attempt) => { calls.consumes.push(attempt); return consume ? consume(account, attempt, calls.consumes.length) : { code: 'reset', windowsReset: 2 }; },
    usageFn: async () => ({ sevenDay: { utilization: 0 } }),
  });
  const actions = createResetActions({ accountManager: am, claudeRedeemer, codexRedeemer, now });
  return { actions, account, am, calls, clock, claudeRedeemer, codexRedeemer };
}

test('grant kind follows clears before session type, with weekly as the default', () => {
  assert.equal(claudeGrantKind({ clears: ['five_hour', 'seven_day_overage_included'], type: 'session' }), 'fable');
  assert.equal(claudeGrantKind({ clears: ['seven_day', 'seven_day_overage_included'], type: 'full' }), 'weekly');
  assert.equal(claudeGrantKind({ clears: ['five_hour'], type: 'session' }), 'session');
  assert.equal(claudeGrantKind({}), 'weekly');
});

test('reset status preserves the new grant fields and sanitizes text', () => {
  const parsed = parseResetStatus(block({ weekly_resets_at: iso(NOW + HOUR), grants: [rawGrant({
    label: '\x1b[31mWeekly\nreset' + 'x'.repeat(100), resets_total: 3, starts_at: iso(NOW - HOUR),
    type: 'full', gives_back_weekly: true, use_requires_limit: false,
    percent_used: { seven_day: 75, five_hour: 0, invalid: 101, fraction: 0.5, string: '10' },
    blocking: ['seven_day', 10, 'x'.repeat(65)], unavailable_reason: 'upstream\nreason' + 'x'.repeat(40),
  })] }));
  const g = parsed.grants[0];
  assert.equal(parsed.weeklyResetsAt, NOW + HOUR);
  assert.equal(g.resetsTotal, 3);
  assert.equal(g.startsAt, NOW - HOUR);
  assert.equal(g.type, 'full');
  assert.equal(g.givesBackWeekly, true);
  assert.equal(g.useRequiresLimit, false);
  assert.deepEqual(g.percentUsed, { seven_day: 75, five_hour: 0 });
  assert.deepEqual(g.blocking, ['seven_day']);
  assert.ok(g.label.startsWith('Weekly reset'));
  assert.ok(g.label.length <= 64);
  assert.ok(g.unavailableReason.startsWith('upstream reason'));
  assert.ok(g.unavailableReason.length <= 32);
});

test('invalid and absent added grant fields use safe defaults', () => {
  const parsed = parseResetStatus(block({ weekly_resets_at: 123, grants: [rawGrant({
    label: {}, resets_total: -1, starts_at: 'bad', type: 'unknown', gives_back_weekly: 'yes',
    use_requires_limit: 'no', percent_used: [], blocking: {}, unavailable_reason: 123,
  })] }));
  const g = parsed.grants[0];
  assert.equal(parsed.weeklyResetsAt, null);
  assert.equal(g.label, null);
  assert.equal(g.resetsTotal, null);
  assert.equal(g.startsAt, null);
  assert.equal(g.type, null);
  assert.equal(g.givesBackWeekly, false);
  assert.equal(g.useRequiresLimit, null);
  assert.equal(g.percentUsed, null);
  assert.deepEqual(g.blocking, []);
  assert.equal(g.unavailableReason, null);
});

test('claim verdict carries the weekly reset date', async () => {
  const result = await claimClaudeReset({ credential: 'fake', orgUuid: 'org' }, { grantId: 'weekly', requestId: 'req' }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'reset', weekly_resets_at: iso(NOW + HOUR) }) }),
  });
  assert.equal(result.weeklyResetsAt, NOW + HOUR);
});

test('Claude detail read names all grants, the next one and the weekly date', async () => {
  const { actions, account, calls } = harness({ status: block({ weekly_resets_at: iso(NOW + HOUR) }) });
  const details = await actions.read(account);
  assert.deepEqual(calls.tokens, [0]);
  assert.equal(details.provider, 'claude');
  assert.equal(details.error, null);
  assert.equal(details.ineligibleReason, null);
  assert.equal(details.atLimit, true);
  assert.deepEqual(details.exhausted, ['seven_day']);
  assert.equal(details.cooldownUntil, null);
  assert.equal(details.weeklyResetsAt, NOW + HOUR);
  assert.equal(details.fleetHoldUntil, null);
  assert.deepEqual(details.grants[0], { id: 'weekly', kind: 'weekly', label: 'Weekly reset', resetsLeft: 1, resetsTotal: 2,
    clears: ['seven_day'], endsAt: NOW + 24 * HOUR, next: true, blocked: null, warnings: [] });
  assert.equal(details.grants[1].kind, 'fable');
  assert.equal(details.grants[1].next, false);
});

test('Claude auto policy objections are warnings, not hard blocks', async () => {
  const { actions, account, claudeRedeemer } = harness({ status: block({ at_limit: false, exhausted: ['five_hour'],
    cooldown_until: iso(NOW + HOUR) }) });
  claudeRedeemer._holdFleet(account, NOW + HOUR);
  const details = await actions.read(account);
  assert.equal(details.cooldownUntil, NOW + HOUR);
  assert.equal(details.fleetHoldUntil, NOW + HOUR);
  const g = details.grants[0];
  assert.equal(g.blocked, null);
  assert.ok(g.warnings.some(w => w.includes('not at a usage limit')));
  assert.ok(g.warnings.some(w => w.includes('no weekly limit')));
  assert.ok(g.warnings.some(w => w.includes('does not clear five_hour')));
  assert.ok(g.warnings.some(w => w.includes('cooldown')));
  assert.ok(g.warnings.some(w => w.includes('0 min ago')));
  assert.equal((await actions.redeem(account, g.id)).redeemed, true);
});

test('a grant that needs no usage limit does not warn about not being at one', async () => {
  const { actions, account } = harness({ status: block({ at_limit: false, exhausted: [],
    grants: [rawGrant({ use_requires_limit: false })] }) });
  assert.deepEqual((await actions.read(account)).grants[0].warnings, ['no weekly limit is exhausted']);
});

test('Claude hard blocks stop the claim on a fresh read', async () => {
  for (const [grant, status, extra, reason] of [
    [{ resets_left: 0 }, {}, {}, /no resets left/],
    [{ paused: true }, {}, {}, /paused/],
    [{ usable_now: false, unavailable_reason: 'future' }, {}, {}, /not usable now \(future\)/],
    [{ ends_at: iso(NOW) }, {}, {}, /expired/],
    [{}, { eligible: false, ineligible_reason: 'tier' }, {}, /not eligible.*tier/],
    [{}, {}, { disabled: true }, /disabled/],
    [{}, {}, { orgUuid: null }, /organization/],
  ]) {
    const h = harness({ status: block({ ...status, grants: [rawGrant(grant)] }), extra });
    const read = await h.actions.read(h.account);
    assert.match(read.grants[0].blocked, reason);
    const result = await h.actions.redeem(h.account, 'weekly');
    assert.equal(result.redeemed, false);
    assert.equal(result.uncertain, false);
    assert.match(result.message, reason);
    assert.equal(h.calls.claims.length, 0);
  }
});

test('unsupported account types and Claude backends never read or spend a reset', async () => {
  for (const extra of [{ type: 'api-key' }, { upstream: 'https://example.invalid' }]) {
    const { actions, account, calls } = harness({ extra });
    const details = await actions.read(account);
    assert.match(details.error, /not an OAuth/);
    assert.deepEqual(details.grants, []);
    assert.match((await actions.redeem(account, 'weekly')).message, /not an OAuth/);
    assert.equal(calls.statuses + calls.details + calls.claims.length + calls.consumes.length, 0);
  }
});

test('manual Claude claim sends a non-next grant id on the wire and re-applies quota', async () => {
  let body;
  const h = harness({ claim: (account, attempt) => claimClaudeReset(account, attempt, {
    fetchImpl: async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ result: 'reset', resets_left: 0, cleared: ['seven_day_overage_included'] }) }; },
  }) });
  const result = await h.actions.redeem(h.account, 'fable');
  assert.equal(body.grant_id, 'fable');
  assert.ok(body.request_id);
  assert.deepEqual(result, { redeemed: true, uncertain: false, message: 'Manually redeemed a claude reset on "test-account" (reset)',
    result: 'reset', resetsLeft: 0, cleared: ['seven_day_overage_included'] });
  assert.deepEqual(h.calls.clear, [0]);
  assert.deepEqual(h.calls.rejected, [0]);
  assert.equal(h.calls.usage.length, 1);
  assert.equal(h.calls.statuses, 2);
  assert.equal(h.account.quota.claudeResetHoldUntil, NOW + HOUR);
  assert.equal(h.claudeRedeemer.fleetHoldUntil, NOW + HOUR);
  assert.ok(h.calls.logs.every(line => line.toLowerCase().includes('manual')));
});

test('manual ignores the auto opt-out and the existing fleet hold', async () => {
  for (const provider of ['claude', 'codex']) {
    const h = harness({ provider, extra: { autoRedeemReset: false } });
    if (provider === 'claude') h.claudeRedeemer._holdFleet(h.account, NOW + HOUR);
    else h.codexRedeemer._holdFleet(NOW + HOUR);
    const result = await h.actions.redeem(h.account, provider === 'claude' ? 'weekly' : 'credit-1');
    assert.equal(result.redeemed, true, provider);
  }
});

test('manual retries replay per-grant keys after errors, even when another grant is chosen between', async () => {
  const h = harness({ claim: (_account, _attempt, n) => n < 3 ? { error: 'socket hang up' } : { result: 'already_used', resetsLeft: 0, cleared: ['seven_day'] } });
  const first = await h.actions.redeem(h.account, 'weekly');
  assert.equal(first.redeemed, false);
  assert.equal(first.uncertain, true);
  assert.match(first.message, /test-account.*may still have gone through/);
  assert.equal(h.claudeRedeemer.fleetHoldUntil, NOW + HOUR / 2);
  await h.actions.redeem(h.account, 'fable');
  const result = await h.actions.redeem(h.account, 'weekly');
  assert.equal(result.redeemed, true);
  assert.equal(h.calls.claims[0].requestId, h.calls.claims[2].requestId);
  assert.notEqual(h.calls.claims[0].requestId, h.calls.claims[1].requestId);
  assert.equal(h.claudeRedeemer.fleetHoldUntil, NOW + HOUR);
});

test('manual claims refresh details instead of trusting the previous read', async () => {
  const h = harness({ status: n => block({ grants: [rawGrant({ resets_left: n === 1 ? 1 : 0 })] }) });
  assert.equal((await h.actions.read(h.account)).grants[0].blocked, null);
  assert.match((await h.actions.redeem(h.account, 'weekly')).message, /no resets left/);
  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.tokens, [0, 0]);
});

test('missing grants and failed reads spend nothing, and failed reads return an empty list', async () => {
  const h = harness();
  assert.match((await h.actions.redeem(h.account, 'missing')).message, /no longer listed/);
  h.claudeRedeemer.statusFn = async () => ({ error: 'HTTP 503' });
  const details = await h.actions.read(h.account);
  assert.equal(details.error, 'HTTP 503');
  assert.deepEqual(details.grants, []);
  assert.match((await h.actions.redeem(h.account, 'weekly')).message, /HTTP 503/);
  assert.equal(h.calls.claims.length, 0);
});

test('failed token refresh and thrown detail reads are reported without spending', async () => {
  const h = harness();
  h.am.ensureTokenFresh = async () => { throw new Error('token failed'); };
  assert.match((await h.actions.read(h.account)).error, /token failed/);
  assert.match((await h.actions.redeem(h.account, 'weekly')).message, /token failed/);
  assert.equal(h.calls.statuses + h.calls.claims.length, 0);
  h.am.ensureTokenFresh = async () => {};
  h.claudeRedeemer.statusFn = async () => { throw new Error('read failed'); };
  assert.match((await h.actions.read(h.account)).error, /read failed/);
  assert.equal(h.calls.claims.length, 0);
});

test('manual decline clears the request key and sets no fleet hold', async () => {
  for (const provider of ['claude', 'codex']) {
    const h = harness({ provider, claim: () => ({ result: 'not_limited' }), consume: () => ({ code: 'nothing_to_reset' }) });
    const id = provider === 'claude' ? 'weekly' : 'credit-1';
    const result = await h.actions.redeem(h.account, id);
    assert.equal(result.redeemed, false);
    assert.equal(result.uncertain, false);
    assert.match(result.message, /upstream declined/);
    assert.equal((await h.actions.read(h.account)).fleetHoldUntil, null);
    await h.actions.redeem(h.account, id);
    const attempts = provider === 'claude' ? h.calls.claims : h.calls.consumes;
    const key = provider === 'claude' ? 'requestId' : 'redeemRequestId';
    assert.notEqual(attempts[0][key], attempts[1][key]);
  }
});

test('refuse manual redemption while that provider has an auto attempt in flight', async () => {
  for (const provider of ['claude', 'codex']) {
    const h = harness({ provider, armed: true });
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    if (provider === 'claude') h.claudeRedeemer.statusFn = async () => { started(); await pending; return { reset: parseResetStatus(block()) }; };
    else h.codexRedeemer.detailsFn = async () => { started(); await pending; return { credits: [credit()] }; };
    const redeemer = provider === 'claude' ? h.claudeRedeemer : h.codexRedeemer;
    const attempt = redeemer.maybeRedeemForPool([h.account]);
    await ready;
    assert.match((await h.actions.redeem(h.account, provider === 'claude' ? 'weekly' : 'credit-1')).message, /automatic reset is in progress/);
    assert.equal(h.calls.claims.length + h.calls.consumes.length, 0);
    release();
    assert.equal((await attempt).redeemed, true);
  }
});

test('one manual redeem at a time, and auto cannot race its fresh read', async () => {
  const h = harness({ armed: true });
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  h.am.ensureTokenFresh = async () => { started(); await pending; };
  const first = h.actions.redeem(h.account, 'weekly');
  await ready;
  assert.match((await h.actions.redeem(h.account, 'fable')).message, /manual reset is in progress/);
  assert.match((await h.claudeRedeemer.maybeRedeemForPool([h.account])).reason, /manual reset is in progress/);
  const codex = { ...h.account, provider: 'codex', accountId: 'codex' };
  assert.match((await h.actions.redeem(codex, 'credit-1')).message, /manual reset is in progress/);
  release();
  assert.equal((await first).redeemed, true);
  assert.equal(h.calls.claims.length, 1);
});

test('Codex detail read maps credits, expiry, plan blocks and weekly exhaustion', async () => {
  const h = harness({ provider: 'codex', credits: [credit(), credit({ id: 'spent', status: 'redeemed' }),
    credit({ id: 'plan', supportedByPlan: false }), credit({ id: 'expired', expiresAt: NOW })] });
  const details = await h.actions.read(h.account);
  assert.equal(details.provider, 'codex');
  assert.equal(details.atLimit, true);
  assert.deepEqual(details.exhausted, ['weekly']);
  assert.equal(details.weeklyResetsAt, h.account.quota.unified7dReset);
  assert.deepEqual(details.grants[0], { id: 'credit-1', kind: 'codex', label: 'Full reset', resetsLeft: 1,
    resetsTotal: null, clears: [], endsAt: NOW + 24 * HOUR, next: false, blocked: null, warnings: [] });
  assert.match(details.grants[1].blocked, /redeemed/);
  assert.match(details.grants[2].blocked, /plan/);
  assert.match(details.grants[3].blocked, /expired/);
  for (const id of ['spent', 'plan', 'expired']) assert.equal((await h.actions.redeem(h.account, id)).redeemed, false);
  assert.equal(h.calls.consumes.length, 0);
  h.account.quota.unified7d = 0.5;
  assert.deepEqual((await h.actions.read(h.account)).grants[0].warnings, ['weekly window is not exhausted']);
});

test('Codex manual consume sends the chosen credit id and refreshes quota', async () => {
  let body;
  const h = harness({ provider: 'codex', consume: (account, attempt) => consumeResetCredit(account, attempt, {
    fetchImpl: async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ code: 'reset', windows_reset: 2 }) }; },
  }) });
  h.account.quota.unified7d = 0.5;
  const result = await h.actions.redeem(h.account, 'credit-1');
  assert.equal(result.redeemed, true);
  assert.equal(result.result, 'reset');
  assert.equal(body.credit_id, 'credit-1');
  assert.ok(body.redeem_request_id);
  assert.equal(h.calls.details, 1);
  assert.equal(h.calls.usage.length, 1);
  assert.equal(h.codexRedeemer.fleetCooldownUntil, NOW + 6 * HOUR);
});

test('Codex unread verdict arms the fleet hold and replays the key after a fresh read', async () => {
  const h = harness({ provider: 'codex', consume: (_account, _attempt, n) => n === 1 ? { error: 'network failed' } : { code: 'already_redeemed' } });
  const first = await h.actions.redeem(h.account, 'credit-1');
  assert.equal(first.uncertain, true);
  assert.equal(first.redeemed, false);
  assert.equal(h.codexRedeemer.fleetCooldownUntil, NOW + HOUR / 2);
  assert.equal((await h.actions.read(h.account)).fleetHoldUntil, NOW + HOUR / 2);
  assert.equal((await h.actions.redeem(h.account, 'credit-1')).redeemed, true);
  assert.equal(h.calls.consumes[0].redeemRequestId, h.calls.consumes[1].redeemRequestId);
  assert.equal(h.codexRedeemer.fleetCooldownUntil, NOW + 6 * HOUR);
});

test('auto and manual paths share the unread request key in both directions', async () => {
  for (const provider of ['claude', 'codex']) {
    for (const manualFirst of [false, true]) {
      const h = harness({ provider, armed: true,
        claim: (_account, _attempt, n) => n === 1 ? { error: 'lost verdict' } : { result: 'already_used' },
        consume: (_account, _attempt, n) => n === 1 ? { error: 'lost verdict' } : { code: 'already_redeemed' },
      });
      const redeemer = provider === 'claude' ? h.claudeRedeemer : h.codexRedeemer;
      const id = provider === 'claude' ? 'weekly' : 'credit-1';
      const auto = () => redeemer.maybeRedeemForPool([h.account]);
      const manual = () => h.actions.redeem(h.account, id);
      await (manualFirst ? manual() : auto());
      h.clock.at += 31 * 60_000;
      assert.equal((await (manualFirst ? auto() : manual())).redeemed, true);
      const attempts = provider === 'claude' ? h.calls.claims : h.calls.consumes;
      const key = provider === 'claude' ? 'requestId' : 'redeemRequestId';
      assert.equal(attempts[0][key], attempts[1][key]);
    }
  }
});

test('Codex auto preserves its logical-attempt replay when fresh rows name another credit', async () => {
  const h = harness({ provider: 'codex', armed: true,
    credits: n => [credit({ id: n === 1 ? 'original-credit' : 'new-credit' })],
    consume: (_account, _attempt, n) => n === 1 ? { error: 'lost verdict' } : { code: 'already_redeemed' },
  });
  await h.codexRedeemer.maybeRedeemForPool([h.account]);
  h.clock.at += 7 * HOUR;
  assert.equal((await h.codexRedeemer.maybeRedeemForPool([h.account])).redeemed, true);
  assert.equal(h.calls.consumes[0].creditId, 'original-credit');
  assert.equal(h.calls.consumes[1].creditId, 'new-credit');
  assert.equal(h.calls.consumes[0].redeemRequestId, h.calls.consumes[1].redeemRequestId);
});

test('a manual outcome that spent or may have spent holds the next automatic attempt', async () => {
  for (const provider of ['claude', 'codex']) {
    for (const uncertain of [false, true]) {
      const h = harness({ provider, armed: true,
        ...(uncertain ? { claim: () => ({ error: 'lost verdict' }), consume: () => ({ error: 'lost verdict' }) } : {}),
      });
      await h.actions.redeem(h.account, provider === 'claude' ? 'weekly' : 'credit-1');
      const redeemer = provider === 'claude' ? h.claudeRedeemer : h.codexRedeemer;
      assert.equal((await redeemer.maybeRedeemForPool([h.account])).redeemed, false);
      assert.equal(h.calls.claims.length + h.calls.consumes.length, 1);
    }
  }
});

test('expired fleet holds are hidden, and an expired grant found after a slow read is blocked', async () => {
  const h = harness();
  h.claudeRedeemer._holdFleet(h.account, NOW + HOUR);
  h.clock.at = NOW + HOUR;
  assert.equal((await h.actions.read(h.account)).fleetHoldUntil, null);
  h.claudeRedeemer.statusFn = async () => {
    h.clock.at += 24 * HOUR;
    return { reset: parseResetStatus(block()) };
  };
  assert.match((await h.actions.redeem(h.account, 'weekly')).message, /expired/);
  assert.equal(h.calls.claims.length, 0);
});

test('claim exceptions are uncertain, while refresh exceptions after success keep the success', async () => {
  for (const provider of ['claude', 'codex']) {
    const fail = () => { throw new Error('lost connection'); };
    const h = harness({ provider, claim: fail, consume: fail });
    const id = provider === 'claude' ? 'weekly' : 'credit-1';
    assert.equal((await h.actions.redeem(h.account, id)).uncertain, true);
    if (provider === 'claude') {
      h.claudeRedeemer.claimFn = async () => ({ result: 'reset' });
      h.am.applyUsageData = () => { throw new Error('quota failed'); };
    } else {
      h.codexRedeemer.consumeFn = async () => ({ code: 'reset' });
      h.am.applyCodexUsageData = () => { throw new Error('quota failed'); };
    }
    assert.equal((await h.actions.redeem(h.account, id)).redeemed, true);
  }
});
