import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { normalizeUsagePayload } from '../src/oauth.js';
import { renderStatus } from '../src/status-renderer.js';
import { Warmer } from '../src/warmer.js';

// Anthropic is removing the 5-hour limit from its Ultra plan (the former Max
// 20x), one verified account at a time, while the weekly limit stays (customer
// email and pricing page, 2026-10-30). A pool therefore holds Claude accounts
// that meter a session window beside ones that no longer do, and the fact
// Codex already records (`sessionWindowStated`) has to be recorded for Claude
// too: otherwise a row draws an empty Session bar forever, keep-warm spends
// quota starting a timer that does not exist, and a session reading left from
// before the change keeps gating selection until its own reset.
//
// The wire shape once the limit is gone is NOT observed on a live account. The
// fixtures below assume what the existing parsers would see if the window were
// simply dropped: `five_hour` null, omitted or with a null utilization on the
// usage endpoint, and no `anthropic-ratelimit-unified-5h-*` header on a
// response that still states the weekly one.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra };
}
const seconds = (/** @type {number} */ ms) => String(Math.floor(ms / 1000));

// The header set a subscription response carries today, as in the live capture
// in unified-status-family.test.js.
function bothWindows(now = Date.now()) {
  return {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-5h-reset': seconds(now + 3 * HOUR),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-reset': seconds(now + 3 * DAY),
    'anthropic-ratelimit-unified-status': 'allowed',
  };
}
// The same set with every 5-hour header gone: the assumed Ultra shape.
function weeklyOnly(now = Date.now()) {
  return Object.fromEntries(Object.entries(bothWindows(now)).filter(([k]) => !k.includes('-5h-')));
}
// A session reading taken before the change, spent and resetting in an hour.
const staleSession = () => ({ unified5h: 0.99, unified5hReset: Date.now() + HOUR, unified5hSeenAt: Date.now() - 60_000, sessionWindowStated: true });
const week = () => ({ utilization: 40, resets_at: new Date(Date.now() + 3 * DAY).toISOString() });

// ── the usage probe ──────────────────────────────────────────────────────────

test('a probe that states a weekly window and no five-hour one records it and clears the old session reading', () => {
  // Each way the payload could say it. `{utilization: null}` normalizes to a
  // truthy bucket with no reading, so the rule keys on the utilization.
  for (const [label, payload] of [
    ['five_hour null', { five_hour: null, seven_day: week() }],
    ['five_hour omitted', { seven_day: week() }],
    ['five_hour without a utilization', { five_hour: { utilization: null, resets_at: null }, seven_day: week() }],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98);
    const q = am.accounts[0].quota;
    // The spent reading came with upstream's `rejected` verdict, as a 5-hour
    // rejection does.
    Object.assign(q, staleSession(), { unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() - 60_000 });
    assert.equal(am.unavailableReason(am.accounts[0]), 'quota', `${label}: the old reading gates`);

    am.applyUsageData(0, normalizeUsagePayload(payload));

    assert.equal(q.sessionWindowStated, false, label);
    assert.equal(q.unified5h, null, label);
    assert.equal(q.unified5hReset, null, label);
    assert.equal(q.unified5hSeenAt, null, `${label}: no reading, no age`);
    assert.equal(q.unified7d, 0.4, label);
    assert.equal(q.weeklyWindowStated, true, label);
    assert.equal(q.unifiedStatus, null, `${label}: the 5-hour rejection goes with its reading`);
    assert.equal(am.unavailableReason(am.accounts[0]), null, `${label}: nothing is left to gate on`);
  }
});

// A rejection the weekly window still explains is not the 5-hour reading's,
// so the probe clearing that reading leaves the verdict for its own expiry.
test('a probe clearing the session reading keeps a rejection a spent window still explains', () => {
  for (const [label, seven_day, extra] of [
    ['shared weekly at its threshold', { ...week(), utilization: 99 }, {}],
    ['Fable weekly at its threshold', week(), { unified7dFable: 0.99, unified7dFableReset: Date.now() + DAY, unified7dFableSeenAt: Date.now() }],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98);
    const q = am.accounts[0].quota;
    Object.assign(q, staleSession(), extra, { unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() - 60_000 });
    am.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day }));
    assert.equal(q.unified5h, null, label);
    assert.equal(q.unifiedStatus, 'rejected', label);
  }
  // A verdict other than `rejected` is never touched.
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  Object.assign(q, staleSession(), { unifiedStatus: 'allowed_warning', unifiedStatusSeenAt: Date.now() - 60_000 });
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day: week() }));
  assert.equal(q.unifiedStatus, 'allowed_warning');
});

// Whether a weekly window explains the rejection is judged on the payload's
// own readings: a spent Fable reading the same payload reports as open again
// explains nothing.
test('a probe judges the rejection on the family readings it brings, not the ones it replaces', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  Object.assign(q, staleSession(), {
    unified7dFable: 1, unified7dFableReset: Date.now() + DAY, unified7dFableSeenAt: Date.now() - 60_000,
    unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() - 60_000,
  });
  am.applyUsageData(0, normalizeUsagePayload({
    five_hour: null,
    seven_day: week(),
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: week().resets_at, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    ],
  }));
  assert.equal(q.unified7dFable, 0);
  assert.equal(q.unifiedStatus, null);
  assert.equal(am.unavailableReason(am.accounts[0]), null);
});

// The probe returning a gated account to rotation is the same event as the
// gating reading running out (see the expiry tests below), whichever removes it.
test('a probe clearing a gating session reading raises the session-reset event; a non-gating one does not', () => {
  for (const [label, unified5h, expected, extra] of [
    ['gating', 0.99, true, {}],
    ['not gating', 0.5, false, {}],
    ['at a maxUsage cap', 0.7, true, { maxUsage: 0.6 }],
    // A bare 0 is no cap (capExceeded reads it so), so it holds nothing out.
    ['maxUsage 0 is no cap', 0.3, false, { maxUsage: 0 }],
  ]) {
    const am = new AccountManager([oauth('a', extra)], 0.98);
    const account = am.accounts[0];
    Object.assign(account.quota, staleSession(), { unified5h });
    am.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day: week() }));
    assert.equal(account.quota.unified5h, null, label);
    assert.equal(Boolean(account.sessionResetPending), expected, label);
  }
});

// The probe names the session window in two places: `five_hour` and the
// `limits` list's `session` entry (both in the captured payloads in
// quota-probe.test.js and scoped-weekly.test.js). Either one naming it without
// a utilization is a partial reading, the probe's counterpart of a response
// carrying a 5-hour reset with no utilization, not an absence: clearing on it
// could put a spent account back in rotation.
test('a probe that names the five-hour window without a reading concludes nothing', () => {
  const sessionEntry = { kind: 'session', group: 'session', percent: 99, scope: null };
  const weeklyEntry = { kind: 'weekly_all', group: 'weekly', percent: 40, scope: null };
  for (const [label, payload] of [
    ['five_hour with a reset and no utilization',
      { five_hour: { utilization: null, resets_at: new Date(Date.now() + HOUR).toISOString() }, seven_day: week() }],
    ['five_hour null, limits lists a session entry',
      { five_hour: null, seven_day: week(), limits: [sessionEntry, weeklyEntry] }],
    ['five_hour omitted, limits lists a session entry without a percent',
      { seven_day: week(), limits: [{ ...sessionEntry, percent: null }, weeklyEntry] }],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98);
    const q = am.accounts[0].quota;
    const before = staleSession();
    Object.assign(q, before);
    am.applyUsageData(0, normalizeUsagePayload(payload));
    assert.equal(q.sessionWindowStated, true, label);
    assert.equal(q.unified5h, before.unified5h, label);
    assert.equal(q.unified5hSeenAt, before.unified5hSeenAt, label);
    assert.notEqual(q.unified5hReset, null, label);
    assert.equal(q.unified7d, 0.4, `${label}: the weekly reading still lands`);
    assert.equal(am.unavailableReason(am.accounts[0]), 'quota', `${label}: the spent reading still gates`);
  }

  // A list that names no session entry beside a missing five_hour is the
  // whole payload agreeing: the window is gone.
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  Object.assign(q, staleSession());
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day: week(), limits: [weeklyEntry] }));
  assert.equal(q.sessionWindowStated, false);
  assert.equal(q.unified5h, null);
  assert.equal(q.unified5hReset, null);
});

test('a probe that reads a five-hour window says so, the idle shape included', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  q.sessionWindowStated = false;
  // An idle metered account today: 0% used, no window running, so no reset.
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 0, resets_at: null }, seven_day: week() }));
  assert.equal(q.sessionWindowStated, true);
  assert.equal(q.unified5h, 0);
});

test('a probe that states no weekly reading changes nothing', () => {
  for (const [label, usage] of [
    ['failed', { error: 'HTTP 500' }],
    ['empty', {}],
    ['both null', normalizeUsagePayload({ five_hour: null, seven_day: null })],
    ['resets only', normalizeUsagePayload({ five_hour: { utilization: null }, seven_day: { utilization: null, resets_at: new Date(Date.now() + DAY).toISOString() } })],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98);
    const q = am.accounts[0].quota;
    const before = staleSession();
    Object.assign(q, before);
    am.applyUsageData(0, usage);
    assert.equal(q.sessionWindowStated, true, label);
    assert.equal(q.unified5h, before.unified5h, label);
    assert.equal(q.unified5hReset, before.unified5hReset, label);
    assert.equal(q.unified5hSeenAt, before.unified5hSeenAt, label);
  }
});

// ── response headers ─────────────────────────────────────────────────────────

test('a response stating the weekly window and no five-hour one records it but leaves the reading', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  const before = staleSession();
  Object.assign(q, before);
  am.updateQuota(0, weeklyOnly());
  assert.equal(q.sessionWindowStated, false);
  // One response's headers are weaker evidence of absence than the whole
  // usage payload, so the reading stays and still gates until its reset or a
  // probe (the same rule the Codex header path keeps).
  assert.equal(q.unified5h, before.unified5h);
  assert.equal(q.unified5hReset, before.unified5hReset);
  assert.equal(q.unified5hSeenAt, before.unified5hSeenAt);
  assert.equal(am.unavailableReason(am.accounts[0]), 'quota');
});

test('a response that names the five-hour window at all is no evidence it is gone', () => {
  const now = Date.now();
  for (const [label, extra] of [
    ['status only', { 'anthropic-ratelimit-unified-5h-status': 'allowed' }],
    ['reset only', { 'anthropic-ratelimit-unified-5h-reset': seconds(now + HOUR) }],
    ['unparseable utilization', { 'anthropic-ratelimit-unified-5h-utilization': 'n/a' }],
  ]) {
    const am = new AccountManager([oauth('a')], 0.98);
    am.updateQuota(0, { ...weeklyOnly(now), ...extra });
    assert.equal(am.accounts[0].quota.sessionWindowStated, null, label);
  }
});

test('a response with no shared weekly reading leaves the fact alone', () => {
  const now = Date.now();
  for (const [label, headers] of [
    ['nothing', {}],
    ['Fable only', { 'anthropic-ratelimit-unified-7d_oi-utilization': '0.5', 'anthropic-ratelimit-unified-7d_oi-reset': seconds(now + DAY) }],
    ['weekly reset only', { 'anthropic-ratelimit-unified-7d-reset': seconds(now + DAY) }],
    ['verdict only', { 'anthropic-ratelimit-unified-status': 'allowed' }],
    ['overage only', { 'anthropic-ratelimit-unified-overage-status': 'rejected', 'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled' }],
  ]) {
    for (const start of [null, true, false]) {
      const am = new AccountManager([oauth('a')], 0.98);
      am.accounts[0].quota.sessionWindowStated = start;
      am.updateQuota(0, headers);
      assert.equal(am.accounts[0].quota.sessionWindowStated, start, `${label}, from ${start}`);
    }
  }
});

// A refusal is no evidence about the plan's shape. A weekly-rejection 429 on a
// metered account can carry the 7d headers alone (the shape the failover
// fixtures in extra-usage-fallback and mitm-integration send), and recording
// `false` from it would drop the Session row and keep-warm for days, persisted,
// until the next response with 5h headers.
test('a refused response stating only the weekly window leaves the fact alone', () => {
  const now = Date.now();
  const rejection = {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '1.0',
    'anthropic-ratelimit-unified-7d-reset': seconds(now + 3 * DAY),
  };
  for (const [label, headers, status] of [
    ['weekly-rejection 429', rejection, 429],
    ['the same set, status unknown', rejection, undefined],
    ['verdict rejected on a 200 (served on overage)', { ...weeklyOnly(now), 'anthropic-ratelimit-unified-status': 'rejected' }, 200],
    ['weekly status rejected alone', { ...weeklyOnly(now), 'anthropic-ratelimit-unified-7d-status': 'rejected' }, undefined],
    ['a 429 whose window is allowed (a throttle)', weeklyOnly(now), 429],
    ['a 5xx', weeklyOnly(now), 529],
  ]) {
    for (const start of [null, true]) {
      const am = new AccountManager([oauth('a')], 0.98);
      am.accounts[0].quota.sessionWindowStated = start;
      am.updateQuota(0, headers, null, status);
      assert.equal(am.accounts[0].quota.sessionWindowStated, start, `${label}, from ${start}`);
    }
  }
  // The weekly reading itself still lands: only the shape inference is skipped.
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, rejection, null, 429);
  assert.equal(am.accounts[0].quota.unified7d, 1);

  // And a 5-hour reading on a refusal still says the window is there.
  const metered = new AccountManager([oauth('a')], 0.98);
  metered.accounts[0].quota.sessionWindowStated = false;
  metered.updateQuota(0, { ...rejection, 'anthropic-ratelimit-unified-5h-utilization': '0.3' }, null, 429);
  assert.equal(metered.accounts[0].quota.sessionWindowStated, true);
});

// The server hands updateQuota the upstream status, so the rule above sees an
// error even when its headers carry no rejection.
test('server: only a served response records the fact from headers', async () => {
  const { createProxyServer } = await import('../src/server.js');
  const http = await import('node:http');
  let answer = 400;
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(answer, { 'content-type': 'application/json', ...weeklyOnly() });
    res.end(answer === 200
      ? '{"type":"message","content":[]}'
      : '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const am = new AccountManager([oauth('a')], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstream.address().port}` });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const log = console.log;
  console.log = () => {};
  const send = async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    return res.status;
  };
  try {
    assert.equal(await send(), 400);
    assert.equal(am.accounts[0].quota.unified7d, 0.4, 'the weekly reading still lands');
    assert.equal(am.accounts[0].quota.sessionWindowStated, null, 'an error says nothing about the plan');
    answer = 200;
    assert.equal(await send(), 200);
    assert.equal(am.accounts[0].quota.sessionWindowStated, false);
  } finally {
    console.log = log;
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections?.();
  }
});

test('a five-hour reading coming back flips the fact back, from either path', () => {
  const headers = new AccountManager([oauth('a')], 0.98);
  headers.updateQuota(0, weeklyOnly());
  assert.equal(headers.accounts[0].quota.sessionWindowStated, false);
  headers.updateQuota(0, bothWindows());
  assert.equal(headers.accounts[0].quota.sessionWindowStated, true);
  assert.equal(headers.accounts[0].quota.unified5h, 0.2);

  const probe = new AccountManager([oauth('a')], 0.98);
  probe.applyUsageData(0, normalizeUsagePayload({ five_hour: null, seven_day: week() }));
  assert.equal(probe.accounts[0].quota.sessionWindowStated, false);
  probe.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 10, resets_at: new Date(Date.now() + HOUR).toISOString() }, seven_day: week() }));
  assert.equal(probe.accounts[0].quota.sessionWindowStated, true);
  assert.equal(probe.accounts[0].quota.unified5h, 0.1);
});

// A third-party backend can answer in Anthropic's header names; what it meters
// is its own business and says nothing about an Anthropic plan.
test('only an Anthropic subscription records the fact from headers', () => {
  const am = new AccountManager([
    oauth('backend', { upstream: 'https://api.example.com/anthropic' }),
    { name: 'key', type: 'apikey', apiKey: 'sk-test' },
  ], 0.98);
  am.updateQuota(0, weeklyOnly());
  am.updateQuota(1, weeklyOnly());
  assert.equal(am.accounts[0].quota.sessionWindowStated, null);
  assert.equal(am.accounts[1].quota.sessionWindowStated, null);
});

// ── what reads the fact ──────────────────────────────────────────────────────

test('an account with no five-hour window is selectable and rotates on its weekly window alone', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.updateQuota(0, weeklyOnly());
  assert.equal(am.unavailableReason(am.accounts[0]), null);
  am.updateQuota(0, { ...weeklyOnly(), 'anthropic-ratelimit-unified-7d-utilization': '0.99' });
  assert.equal(am.unavailableReason(am.accounts[0]), 'quota');
});

test('the fact survives a restart, and a returning five-hour reading still flips it', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am1.updateQuota(0, weeklyOnly());
  const saved = JSON.parse(JSON.stringify(am1.exportQuotaState()));
  assert.equal(saved[0].quota.sessionWindowStated, false);

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(saved);
  assert.equal(am2.accounts[0].quota.sessionWindowStated, false);
  am2.updateQuota(0, bothWindows());
  assert.equal(am2.accounts[0].quota.sessionWindowStated, true);
});

test('status publishes the fact and leaves out the Session row', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, weeklyOnly(now));
  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.sessionWindowStated, false);
  const output = renderStatus(status, { color: false, now });
  assert.doesNotMatch(output, /^\s+Session\s/m);
  assert.match(output, /^\s+Weekly\s+\[.*\] 40%/m);
});

test('keep-warm skips an account that meters no five-hour window, and takes it back when one returns', async () => {
  const am = new AccountManager([oauth('ultra'), oauth('max')], 0.98);
  am.updateQuota(0, weeklyOnly());
  const calls = [];
  const warmer = new Warmer(am, {
    intervalMs: 0, port: 3456, apiKey: 'tc-key', log: () => {},
    spawnFn: async (/** @type {any} */ spec) => { calls.push(spec); return 0; },
  });
  await warmer.warmAll();
  assert.equal(calls.length, 1, 'only the metered account is warmed');
  assert.ok(calls[0].env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/max'), calls[0].env.ANTHROPIC_BASE_URL);
  assert.equal(warmer.getStatus().accounts.find((/** @type {any} */ r) => r.name === 'ultra').status, 'not-applicable');

  // A response stating the window again (a downgrade, or the limit restored),
  // already reset so nothing is running: a target again.
  am.updateQuota(0, { ...bothWindows(), 'anthropic-ratelimit-unified-5h-reset': seconds(Date.now() - 1000) });
  calls.length = 0;
  await warmer.warmAll();
  assert.ok(calls.some(spec => spec.env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/ultra')));
});

// ── the expiry sweep ─────────────────────────────────────────────────────────

// An idle metered account reads 0% with no reset today (no window running),
// so a reading can sit on an account with nothing that would ever expire it.
// Once a response says the plan meters no session window, that reading cannot
// gate anything and, with the probe off, nothing else clears it: the Session
// row would read 0% forever. The sweep clears it. A reading WITH a reset is
// left to that reset, since header evidence stays weaker than the probe.
test('the sweep clears a session reading with no reset once the plan meters no five-hour window', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  am.applyUsageData(0, normalizeUsagePayload({ five_hour: { utilization: 0, resets_at: null }, seven_day: week() }));
  assert.equal(q.unified5h, 0, 'the idle reading lands');
  assert.equal(q.unified5hReset, null);
  am.sweepExpiredQuotas();
  assert.equal(q.unified5h, 0, 'a metered account keeps its idle reading');

  am.updateQuota(0, weeklyOnly(now));
  assert.equal(q.sessionWindowStated, false);
  am.sweepExpiredQuotas();
  assert.equal(q.unified5h, null);
  assert.equal(q.unified5hSeenAt, null);
  assert.equal(am.accounts[0].sessionResetPending, undefined, 'no window reset, so no reset event');
  assert.equal(q.unified7d, 0.4, 'the weekly reading is untouched');

  const output = renderStatus(am.getStatus(), { color: false, now });
  assert.doesNotMatch(output, /^\s+Session\s/m);
  const summary = am.getQuotaSummary();
  assert.equal(summary.accounts[0].buckets.fiveHour, null);
});

test('the sweep leaves a session reading with a future reset in place on a plan with no five-hour window', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  const before = staleSession();
  Object.assign(q, before, { sessionWindowStated: false });
  am.sweepExpiredQuotas();
  assert.equal(q.unified5h, before.unified5h);
  assert.equal(q.unified5hReset, before.unified5hReset);
  assert.equal(am.unavailableReason(am.accounts[0]), 'quota');
});

// A reading left from before the change runs out like any other. On a plan
// with no session window that is a session reset only when the reading was
// gating the account: its expiry then returns the account to rotation exactly
// as a reset does, and the switch is what moves traffic onto its sooner-lapsing
// weekly. A reading below the threshold kept nothing out, so its expiry
// changes nothing the switch could act on.
test('a session reading expiring on a plan with no five-hour window fires the switch only when it was gating', () => {
  const build = (/** @type {boolean} */ stated, /** @type {number} */ used, /** @type {any} */ extra = {}) => {
    const am = new AccountManager([oauth('a', extra), oauth('b')], 0.98);
    const [a, b] = am.accounts;
    Object.assign(a.quota, { unified5h: used, unified5hReset: Date.now() - 1000, unified7d: 0.5, unified7dReset: Date.now() + 6 * HOUR, sessionWindowStated: stated });
    Object.assign(b.quota, { unified5h: 0.2, unified5hReset: Date.now() + 4 * HOUR, unified7d: 0.1, unified7dReset: Date.now() + 58 * HOUR });
    am.currentIndex = 1;
    return am;
  };
  const log = console.log;
  console.log = () => {};
  try {
    const metered = build(true, 0.5);
    metered.refreshExpiredQuotas();
    assert.equal(metered.currentIndex, 0, 'control: a metered account switches on its session reset');

    // Spent before the change: the reading held the account out of rotation.
    const gated = build(false, 0.99);
    gated.getStatus();
    assert.equal(gated.accounts[0].quota.unified5h, null, 'the expired reading is cleared');
    assert.equal(gated.accounts[0].sessionResetPending, true, 'a read does not swallow the event');
    gated.refreshExpiredQuotas();
    assert.equal(gated.currentIndex, 0, 'the account is back, so the switch runs');

    // A `maxUsage` cap below the threshold gates the same way.
    const capped = build(false, 0.7, { maxUsage: { unified5h: 0.6 } });
    capped.refreshExpiredQuotas();
    assert.equal(capped.currentIndex, 0, 'a capped reading was gating too');

    // Below the threshold: the account was in rotation all along.
    const idle = build(false, 0.5);
    idle.getStatus();
    assert.equal(idle.accounts[0].quota.unified5h, null, 'the expired reading is still cleared');
    assert.notEqual(idle.accounts[0].sessionResetPending, true);
    idle.refreshExpiredQuotas();
    assert.equal(idle.currentIndex, 1);
  } finally {
    console.log = log;
  }
});
