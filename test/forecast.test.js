import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { BurnRateLearner } from '../src/adaptive-distribution.js';
import { forecastWindow } from '../src/forecast.js';
import { forecastText, renderStatus } from '../src/status-renderer.js';
import { renderDashboardHtml } from '../src/dashboard.js';

// Burn-rate forecast (#475): the learned rate per weekly window, and when the
// account reaches its switch threshold at that rate next to when the window
// resets. A read-out only; nulls where there is no answer.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra };
}

// ── forecastWindow ────────────────────────────────────────────────────────

test('at 1% an hour from 50%, a 98% threshold is 48h away', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: NOW + 3 * DAY, now: NOW });
  assert.equal(f.ratePerHour, 0.01);
  assert.equal(f.threshold, 0.98);
  assert.equal(f.reachesThresholdAt, NOW + 48 * HOUR);
  assert.equal(f.resetAt, NOW + 3 * DAY);
});

test('a reach past the reset is still reported; the reader decides it is the good case', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: 0.001 / HOUR, resetAt: NOW + DAY, now: NOW });
  assert.ok(f.reachesThresholdAt > NOW + DAY);
});

test('no learned rate: every derived field is null, the threshold and reset stay', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: null, resetAt: NOW + DAY, now: NOW });
  assert.deepEqual(f, { ratePerHour: null, threshold: 0.98, reachesThresholdAt: null, resetAt: NOW + DAY });
});

test('a rate of zero reaches nothing, and says so with null rather than a far date', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: 0, resetAt: NOW + DAY, now: NOW });
  assert.equal(f.ratePerHour, 0);
  assert.equal(f.reachesThresholdAt, null);
});

test('already at or above the threshold: no reach time', () => {
  for (const utilization of [0.98, 0.99, 1.2]) {
    const f = forecastWindow({ utilization, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: NOW + DAY, now: NOW });
    assert.equal(f.reachesThresholdAt, null, `at ${utilization}`);
  }
});

test('a reset that has passed: the reading is from the old window, so no reach time and no reset', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: NOW - 1, now: NOW });
  assert.equal(f.reachesThresholdAt, null);
  assert.equal(f.resetAt, null);
  assert.equal(f.ratePerHour, 0.01, 'the rate is still the learned rate');
});

test('no known reset: the reach time stands on its own', () => {
  const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: null, now: NOW });
  assert.equal(f.reachesThresholdAt, NOW + 48 * HOUR);
  assert.equal(f.resetAt, null);
});

test('a missing utilization or a negative or non-finite rate gives no reach time', () => {
  assert.equal(forecastWindow({ utilization: null, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: null, now: NOW }).reachesThresholdAt, null);
  for (const ratePerMs of [-1, NaN, Infinity]) {
    const f = forecastWindow({ utilization: 0.5, threshold: 0.98, ratePerMs, resetAt: null, now: NOW });
    assert.equal(f.ratePerHour, null, String(ratePerMs));
    assert.equal(f.reachesThresholdAt, null, String(ratePerMs));
  }
});

// ── BurnRateLearner.learnedRate ───────────────────────────────────────────

test('learnedRate is null until a rate is learned, and never the cold-start assumption', () => {
  const l = new BurnRateLearner();
  assert.equal(l.learnedRate(0, 'unified7d'), null);
  assert.ok(l.burnRate(0, 'unified7d') > 0, 'burnRate() falls back to initialBurnRate');
  l.observeUtilization(0, 'unified7d', 0.5, NOW);
  assert.equal(l.learnedRate(0, 'unified7d'), null, 'one reading is not a rate');
  l.observeUtilization(0, 'unified7d', 0.52, NOW + 5 * 60_000);
  assert.ok(Math.abs(l.learnedRate(0, 'unified7d') - 0.02 / (5 * 60_000)) < 1e-18);
});

// ── AccountManager.forecastStatus ─────────────────────────────────────────

function learn(am, bucket, perHour, index = 0) {
  am.burnRateLearner.observeUtilization(index, bucket, 0.10, NOW);
  am.burnRateLearner.observeUtilization(index, bucket, 0.10 + perHour / 12, NOW + 5 * 60_000);
}

test('status carries quota.forecast per weekly window, in every distribution mode', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.equal(am.distributeSessions, false);
  learn(am, 'unified7d', 0.01);
  const resetAt = Date.now() + 3 * DAY;
  am.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt } });
  const f = am.getStatus().accounts[0].quota.forecast.unified7d;
  assert.ok(Math.abs(f.ratePerHour - 0.01) < 1e-12);
  assert.equal(f.threshold, 0.98);
  assert.equal(f.resetAt, resetAt);
  const hours = (f.reachesThresholdAt - Date.now()) / HOUR;
  assert.ok(hours > 47.9 && hours <= 48, `~48h, got ${hours}`);
});

test('the per-account threshold is the one forecast against', () => {
  const am = new AccountManager([oauth('a', { switchThreshold: { unified7d: 0.9 } })], { default: 0.98 });
  learn(am, 'unified7d', 0.01);
  am.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + 3 * DAY } });
  const f = am.getStatus().accounts[0].quota.forecast.unified7d;
  assert.equal(f.threshold, 0.9);
  const hours = (f.reachesThresholdAt - Date.now()) / HOUR;
  assert.ok(hours > 39.9 && hours <= 40, `~40h, got ${hours}`);
});

test('a window the learner knows nothing about reads null, not the starting rate', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + DAY } });
  const f = am.getStatus().accounts[0].quota.forecast.unified7d;
  assert.equal(f.ratePerHour, null);
  assert.equal(f.reachesThresholdAt, null);
});

test('a family window takes the rate learned under either of its names, once', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  learn(am, 'scoped:fable', 0.02);
  const q = am.accounts[0].quota;
  q.unified7d = 0.3;
  q.unified7dFable = 0.4;
  q.scopedWeekly = { fable: { utilization: 0.4, resetAt: Date.now() + DAY }, opus: { utilization: 0.2, resetAt: Date.now() + DAY } };
  const forecast = am.getStatus().accounts[0].quota.forecast;
  assert.deepEqual(Object.keys(forecast).sort(), ['scoped:opus', 'unified7d', 'unified7dFable']);
  assert.ok(Math.abs(forecast.unified7dFable.ratePerHour - 0.02) < 1e-12);
  assert.equal(forecast.unified7d.ratePerHour, null, 'the family rate does not leak into the shared week');
});

test('an account with no weekly reading has an empty forecast', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.deepEqual(am.getStatus().accounts[0].quota.forecast, {});
});

// ── forecastText ──────────────────────────────────────────────────────────

test('only a window that reaches its threshold before it resets gets a sentence', () => {
  const view = (reachH, resetH, threshold = 0.98) => ({
    ratePerHour: 0.01, threshold, reachesThresholdAt: NOW + reachH * HOUR, resetAt: resetH == null ? null : NOW + resetH * HOUR,
  });
  assert.equal(forecastText({ unified7d: view(31, 40) }, NOW), 'week reaches 98% in ~31h, resets in 40h');
  assert.equal(forecastText({ unified7d: view(31, 52) }, NOW), 'week reaches 98% in ~31h, resets in 2d4h');
  assert.equal(forecastText({ unified7d: view(60, 52) }, NOW), null, 'resets first: the good case');
  assert.equal(forecastText({ unified7d: view(31, null) }, NOW), 'week reaches 98% in ~31h');
  assert.equal(forecastText({
    unified7dFable: view(5, 52, 0.95),
    unified7d: view(31, 100),
    'scoped:opus': view(200, 100),
  }, NOW), 'week reaches 98% in ~31h, resets in 4d4h · Fable week reaches 95% in ~5h, resets in 2d4h');
});

test('no rate, no reach time, or a reach time in the past: nothing', () => {
  assert.equal(forecastText(null, NOW), null);
  assert.equal(forecastText({}, NOW), null);
  assert.equal(forecastText({ unified7d: { ratePerHour: null, threshold: 0.98, reachesThresholdAt: null, resetAt: NOW + DAY } }, NOW), null);
  assert.equal(forecastText({ unified7d: { ratePerHour: 0.1, threshold: 0.98, reachesThresholdAt: NOW - 1, resetAt: NOW + DAY } }, NOW), null);
});

test('short spans read in minutes', () => {
  assert.equal(forecastText({ unified7d: { ratePerHour: 1, threshold: 0.98, reachesThresholdAt: NOW + 20 * 60_000, resetAt: NOW + 90 * 60_000 } }, NOW),
    'week reaches 98% in ~20m, resets in 2h');
});

test('teamclaude status prints the Forecast line only when there is a warning', () => {
  const status = (forecast) => ({
    accounts: [{ name: 'a', type: 'oauth', quota: { unified7d: 0.5, forecast }, usage: {} }],
  });
  const warn = { unified7d: { ratePerHour: 0.01, threshold: 0.98, reachesThresholdAt: Date.now() + 31 * HOUR, resetAt: Date.now() + 52 * HOUR } };
  const calm = { unified7d: { ratePerHour: 0.001, threshold: 0.98, reachesThresholdAt: Date.now() + 99 * HOUR, resetAt: Date.now() + 52 * HOUR } };
  assert.match(renderStatus(status(warn)), /Forecast week reaches 98% in ~31h, resets in 2d4h/);
  assert.doesNotMatch(renderStatus(status(calm)), /Forecast/);
});

test('the dashboard page carries the same forecastText', () => {
  assert.ok(renderDashboardHtml().includes(forecastText.toString()));
});

// ── review follow-ups ─────────────────────────────────────────────────────

test('the projection starts when the reading was taken, so an old reading counts down', () => {
  const base = { utilization: 0.5, threshold: 0.98, ratePerMs: 0.01 / HOUR, resetAt: NOW + 3 * DAY };
  assert.equal(forecastWindow({ ...base, seenAt: NOW - 10 * HOUR, now: NOW }).reachesThresholdAt, NOW + 38 * HOUR);
  assert.equal(forecastWindow({ ...base, seenAt: NOW - 50 * HOUR, now: NOW }).reachesThresholdAt, NOW - 2 * HOUR, 'past: the reader shows nothing');
  assert.equal(forecastWindow({ ...base, seenAt: NOW + HOUR, now: NOW }).reachesThresholdAt, NOW + 48 * HOUR, 'a future stamp is not trusted');
});

test('status anchors the dedicated weekly at unified7dSeenAt', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  learn(am, 'unified7d', 0.01);
  am.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + 3 * DAY } });
  am.accounts[0].quota.unified7dSeenAt = Date.now() - 10 * HOUR;
  const f = am.getStatus().accounts[0].quota.forecast.unified7d;
  const hours = (f.reachesThresholdAt - Date.now()) / HOUR;
  assert.ok(hours > 37.9 && hours <= 38, `~38h, got ${hours}`);
});

test('a scoped family is forecast against the shared weekly threshold, the one that gates it', () => {
  const am = new AccountManager([oauth('a', { switchThreshold: { unified7d: 0.9 } })], { default: 0.98 });
  const q = am.accounts[0].quota;
  q.scopedWeekly = { opus: { utilization: 0.5, resetAt: Date.now() + 3 * DAY } };
  assert.equal(am.getStatus().accounts[0].quota.forecast['scoped:opus'].threshold, 0.9);
});

test('a scoped family with no stamp of its own is anchored at the learner reading', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const t0 = Date.now() - 10 * HOUR;
  am.burnRateLearner.observeUtilization(0, 'scoped:opus', 0.40, t0 - 5 * 60_000);
  am.burnRateLearner.observeUtilization(0, 'scoped:opus', 0.40 + 0.01 / 12, t0);
  am.accounts[0].quota.scopedWeekly = { opus: { utilization: 0.5, resetAt: Date.now() + 3 * DAY } };
  const f = am.getStatus().accounts[0].quota.forecast['scoped:opus'];
  const hours = (f.reachesThresholdAt - Date.now()) / HOUR;
  assert.ok(hours > 37.9 && hours <= 38.1, `~38h, got ${hours}`);
});

test('reach and reset that round alike still say the threshold comes first', () => {
  assert.equal(forecastText({ unified7d: { ratePerHour: 0.01, threshold: 0.98, reachesThresholdAt: NOW + 52 * HOUR, resetAt: NOW + 52 * HOUR + 10 * 60_000 } }, NOW),
    'week reaches 98% in ~2d4h, just before it resets');
});
