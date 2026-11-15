// adaptiveDistribution.fiveHourSoftMargin (#628): under scoring "pressure", a new
// session stays off an account whose live 5-hour use has reached its own cap, or
// a full window, less the margin, while another account of its priority can take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { ADAPTIVE_DEFAULTS, validateAdaptiveConfig } from '../src/adaptive-distribution.js';

const H = 3600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const OPUS = 'claude-opus-5';

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
}

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

// A leads by expiry pressure: capped at 0.7, weekly 0.4 resetting in 10 h, so
// 0.3 / 36000 = 8.33e-6, against B's 0.5 / 144000 = 3.47e-6 at most.
function twoAccounts({ margin = 0.15, scoring = 'pressure', bPriority = 0 } = {}) {
  const am = new AccountManager([oauth('A', { maxUsage: { unified5h: 0.7, unified7d: 0.7 } }), oauth('B', { priority: bPriority })], 0.98, {
    distributeSessions: 'adaptive',
    adaptive: validateAdaptiveConfig({ scoring, fiveHourSoftMargin: margin }),
    expiryRouting: { enabled: true, tolerance: 100, preempt: false },
  });
  Object.assign(am.accounts[0].quota, { unified7d: 0.4, unified7dReset: Date.now() + 10 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.5, unified7dReset: Date.now() + 40 * H });
  return am;
}

const fiveHour = (account, use) => Object.assign(account.quota, { unified5h: use, unified5hReset: Date.now() + H });
const firstPlacement = am => am.getActiveAccount(null, OPUS, null, 'new-session').name;

test('the margin defaults off and must be a fraction', () => {
  assert.equal(ADAPTIVE_DEFAULTS.fiveHourSoftMargin, 0);
  assert.deepEqual(validateAdaptiveConfig({ fiveHourSoftMargin: 0.15 }), { fiveHourSoftMargin: 0.15 });
  for (const bad of [-0.1, 1.5]) {
    assert.throws(() => validateAdaptiveConfig({ fiveHourSoftMargin: bad }), /adaptiveDistribution\.fiveHourSoftMargin must be a fraction/);
  }
  assert.throws(() => validateAdaptiveConfig({ fiveHourSoftMargin: 'x' }), /adaptiveDistribution\.fiveHourSoftMargin must be a finite number/);
});

test('a new session leaves an account past its own cap less the margin', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  fiveHour(am.accounts[0], 0.56); // the threshold is 0.7 - 0.15 = 0.55
  assert.equal(firstPlacement(am), 'B');
});

test('below that point the ranking is untouched', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  fiveHour(am.accounts[0], 0.5);
  assert.equal(firstPlacement(am), 'A');
});

test('with no cap the threshold is a full window less the margin', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  fiveHour(am.accounts[1], 0.86);
  const held = am._withoutFiveHourSoft(null, OPUS);
  assert.deepEqual([...held], [1]);
  fiveHour(am.accounts[1], 0.8);
  assert.equal(am._withoutFiveHourSoft(null, OPUS), null);
});

test('off by default, and read only under pressure', (t) => {
  freezeClock(t);
  const off = twoAccounts({ margin: 0 });
  fiveHour(off.accounts[0], 0.56);
  assert.equal(firstPlacement(off), 'A');

  const burndown = twoAccounts({ scoring: 'burndown' });
  fiveHour(burndown.accounts[0], 0.56);
  assert.equal(burndown._withoutFiveHourSoft(null, OPUS), null);
});

test('with every account past it the preference gives way', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  fiveHour(am.accounts[0], 0.56);
  fiveHour(am.accounts[1], 0.9);
  assert.equal(am._withoutFiveHourSoft(null, OPUS), null);
  assert.ok(am.getActiveAccount(null, OPUS, null, 'new-session'));
});

test('it never sends a session to a lower priority', (t) => {
  freezeClock(t);
  const am = twoAccounts({ bPriority: 100 });
  fiveHour(am.accounts[0], 0.56);
  assert.equal(firstPlacement(am), 'A');
});

test('a reading with no live reset does not count', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  Object.assign(am.accounts[0].quota, { unified5h: 0.56, unified5hReset: null });
  assert.equal(am._withoutFiveHourSoft(null, OPUS), null);
});

test('a pinned session stays, and status shows the account as not competing', (t) => {
  freezeClock(t);
  const am = twoAccounts();
  am.recordSession('running', 0, OPUS);
  fiveHour(am.accounts[0], 0.56);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'running').name, 'A');

  const rows = am._adaptiveStatsFor(OPUS, 'anthropic', am.accounts);
  assert.equal(rows[0].competing, false);
  assert.equal(rows[0].next, false);
  assert.equal(rows[1].competing, true);
  assert.equal(rows[1].next, true);
});
