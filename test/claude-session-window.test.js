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
    Object.assign(q, staleSession());
    assert.equal(am.unavailableReason(am.accounts[0]), 'quota', `${label}: the old reading gates`);

    am.applyUsageData(0, normalizeUsagePayload(payload));

    assert.equal(q.sessionWindowStated, false, label);
    assert.equal(q.unified5h, null, label);
    assert.equal(q.unified5hReset, null, label);
    assert.equal(q.unified5hSeenAt, null, `${label}: no reading, no age`);
    assert.equal(q.unified7d, 0.4, label);
    assert.equal(q.weeklyWindowStated, true, label);
    assert.equal(am.unavailableReason(am.accounts[0]), null, `${label}: nothing is left to gate on`);
  }
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
