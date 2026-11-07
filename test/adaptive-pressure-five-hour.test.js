// adaptiveDistribution.pressureFiveHour (#628): under scoring "pressure", scale
//
//   score = P x h5 / (1 + load),   h5 = (T5 - 5h use) / T5
//
// T5 is the lower of the account's 5-hour cap and switch threshold. Expected
// values are worked out by hand from that formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { ADAPTIVE_DEFAULTS, fiveHourHeadroomFraction, scoreCandidate, validateAdaptiveConfig } from '../src/adaptive-distribution.js';

const H = 3600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const OPUS = 'claude-opus-5';

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
}

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

// Same band. A: capped at 0.7, weekly 0.4 resetting in 10 h, so P = 0.3 / 36000 =
// 8.33e-6. B: uncapped, weekly 0.5 resetting in 40 h, so P is at most
// 0.5 / 144000 = 3.47e-6 and at least 0.48 / 144000 = 3.33e-6. A leads by P alone.
function twoAccounts(pressureFiveHour) {
  const am = new AccountManager([oauth('A', { maxUsage: { unified5h: 0.7, unified7d: 0.7 } }), oauth('B')], 0.98, {
    distributeSessions: 'adaptive',
    adaptive: validateAdaptiveConfig({ scoring: 'pressure', ...(pressureFiveHour === undefined ? {} : { pressureFiveHour }) }),
    expiryRouting: { enabled: true, tolerance: 100, preempt: false },
  });
  Object.assign(am.accounts[0].quota, { unified7d: 0.4, unified7dReset: Date.now() + 10 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.5, unified7dReset: Date.now() + 40 * H });
  return am;
}

const firstPlacement = am => am.getActiveAccount(null, OPUS, null, 'new-session').name;

test('pressureFiveHour defaults off and must be a boolean', () => {
  assert.equal(ADAPTIVE_DEFAULTS.pressureFiveHour, false);
  assert.deepEqual(validateAdaptiveConfig({ pressureFiveHour: true }), { pressureFiveHour: true });
  for (const bad of ['true', 1, null]) {
    assert.throws(() => validateAdaptiveConfig({ pressureFiveHour: bad }), /adaptiveDistribution\.pressureFiveHour must be true or false/);
  }
});

test('the fraction runs from 1 untouched to 0 at the limit, and stays in range', () => {
  assert.equal(fiveHourHeadroomFraction(0, 0.7), 1);
  assert.equal(fiveHourHeadroomFraction(0.35, 0.7), 0.5);
  assert.equal(fiveHourHeadroomFraction(0.7, 0.7), 0);
  assert.equal(fiveHourHeadroomFraction(0.9, 0.7), 0);
  assert.equal(fiveHourHeadroomFraction(0.1, 0), 0);
});

test('the score is multiplied by the factor, and absent means unscaled', () => {
  const opts = { ...ADAPTIVE_DEFAULTS, scoring: 'pressure' };
  const base = { pressure: 8e-6, load: 1 };
  assert.equal(scoreCandidate(base, opts).score, 4e-6);
  assert.equal(scoreCandidate({ ...base, fiveHourFactor: 0.5 }, opts).score, 2e-6);
  assert.equal(scoreCandidate({ ...base, fiveHourFactor: 0 }, opts).score, 0);
});

test('with the flag on, a busy 5-hour window hands a new session to the other account', (t) => {
  freezeClock(t);
  // h5 = (0.7 - 0.5) / 0.7 = 0.2857, so A scores 2.38e-6 against B's 3.33e-6 or more.
  const on = twoAccounts(true);
  Object.assign(on.accounts[0].quota, { unified5h: 0.5, unified5hReset: Date.now() + H });
  assert.equal(firstPlacement(on), 'B');
});

test('with the flag on, a quiet 5-hour window leaves the ranking alone', (t) => {
  freezeClock(t);
  // h5 = (0.7 - 0.1) / 0.7 = 0.857, so A scores 7.14e-6.
  const on = twoAccounts(true);
  Object.assign(on.accounts[0].quota, { unified5h: 0.1, unified5hReset: Date.now() + H });
  assert.equal(firstPlacement(on), 'A');
});

test('off or absent, the same busy window changes nothing', (t) => {
  freezeClock(t);
  for (const flag of [false, undefined]) {
    const am = twoAccounts(flag);
    Object.assign(am.accounts[0].quota, { unified5h: 0.5, unified5hReset: Date.now() + H });
    assert.equal(firstPlacement(am), 'A', String(flag));
  }
});

test('a reading whose reset has passed, or that has none, does not scale', (t) => {
  freezeClock(t);
  const now = Date.now();
  const am = twoAccounts(true);
  const a = am.accounts[0];
  a.quota.unified5h = 0.5;
  a.quota.unified5hReset = null;
  assert.equal(am._fiveHourFactor(a, now), 1);
  a.quota.unified5hReset = now - 1;
  assert.equal(am._fiveHourFactor(a, now), 1);
  a.quota.unified5h = null;
  a.quota.unified5hReset = now + H;
  assert.equal(am._fiveHourFactor(a, now), 1);
});

test('the limit is the lower of the 5-hour cap and the switch threshold', (t) => {
  freezeClock(t);
  const now = Date.now();
  const am = twoAccounts(true);
  Object.assign(am.accounts[0].quota, { unified5h: 0.35, unified5hReset: now + H });
  assert.equal(am._fiveHourFactor(am.accounts[0], now), 0.5);
  // B has no cap, so its limit is the fleet threshold of 0.98.
  Object.assign(am.accounts[1].quota, { unified5h: 0.49, unified5hReset: now + H });
  assert.equal(am._fiveHourFactor(am.accounts[1], now), 0.5);
});
