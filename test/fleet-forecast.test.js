import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastFleet, measureRates, STEP_MS, MIN_HISTORY_MS, WEEKLY_PERIOD_MS, FIVE_HOUR_PERIOD_MS } from '../src/fleet-forecast.js';
import { FORECAST_HORIZON_MS } from '../src/forecast.js';
import { fleetForecastText, renderStatus } from '../src/status-renderer.js';
import { renderDashboardHtml } from '../src/dashboard.js';

// Fleet forecast (#550): a forward simulation over the stored quota series.
// Every clock is injected; NOW is an arbitrary fixed instant at 17:00 UTC.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2027, 0, 13, 17, 0, 0);
const TH = { weekly: 0.98, fiveHour: 0.98 };

/**
 * History for one account: a sample every 15 minutes from `NOW - hours` to
 * NOW. `weeklyPerHour(t)` is the weekly spend rate at t; the weekly window
 * resets every 7 days from `weeklyStart`, the 5-hour one every 5 hours from
 * `fiveStart`, both counting up from zero.
 */
function history({ hours, weeklyPerHour = () => 0, fiveHourPerHour = 0, weeklyStart = NOW - 8 * DAY, fiveStart = NOW - 100 * FIVE_HOUR_PERIOD_MS }) {
  const samples = [];
  let weekly = 0;
  let weeklyReset = weeklyStart + WEEKLY_PERIOD_MS;
  for (let t = weeklyStart; t <= NOW; t += 15 * MIN) {
    // Windows are (start, start + period]: the sample on a boundary still
    // reads the window that ends there.
    if (t > weeklyReset) { weekly = 0; weeklyReset += WEEKLY_PERIOD_MS; }
    if (t > weeklyStart) weekly += weeklyPerHour(t - 15 * MIN) * 0.25;
    if (t < NOW - hours * HOUR) continue;
    // Windows are (start, start + 5h]: the sample on a boundary still reads
    // the window that ends there.
    const windowStart = fiveStart + (Math.ceil((t - fiveStart) / FIVE_HOUR_PERIOD_MS) - 1) * FIVE_HOUR_PERIOD_MS;
    samples.push({
      t,
      weekly,
      weeklyResetAt: weeklyReset,
      fiveHour: fiveHourPerHour * (t - windowStart) / HOUR,
      fiveHourResetAt: windowStart + FIVE_HOUR_PERIOD_MS,
    });
  }
  return samples;
}

const flat = rate => () => rate;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) <= STEP_MS, `${msg || ''} ${new Date(actual).toISOString()} vs ${new Date(expected).toISOString()}`);

// ── when it has no answer ─────────────────────────────────────────────────

test('null with less than 48 hours of samples', () => {
  const series = { 'account-a': history({ hours: 47, weeklyPerHour: flat(0.05) }) };
  const accounts = [{ id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 5 * DAY }];
  assert.equal(forecastFleet({ series, accounts, thresholds: { 'account-a': TH }, now: NOW }), null);
  assert.ok(MIN_HISTORY_MS === 48 * HOUR);
});

test('null with no accounts, and with an empty series', () => {
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.05) }) };
  assert.equal(forecastFleet({ series, accounts: [], thresholds: {}, now: NOW }), null);
  assert.equal(forecastFleet({ series: {}, accounts: [{ id: 'account-a', weekly: 0.5 }], thresholds: {}, now: NOW }), null);
});

test('null when nothing runs out within the horizon', () => {
  // No spend at all: nothing is ever blocked.
  const idle = { 'account-a': history({ hours: 72 }) };
  assert.equal(forecastFleet({ series: idle, accounts: [{ id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 5 * DAY }], thresholds: { 'account-a': TH }, now: NOW }), null);
  // A slow rate: every weekly window resets long before it fills.
  const slow = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.001) }) };
  assert.equal(forecastFleet({ series: slow, accounts: [{ id: 'account-a', weekly: 0.1, weeklyResetAt: NOW + 5 * DAY }], thresholds: { 'account-a': TH }, now: NOW }), null);
});

// ── the weekly bucket ─────────────────────────────────────────────────────

test('one account at a flat 1% an hour from 50% is out in 48h and back at its reset', () => {
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.01) }) };
  const f = forecastFleet({ series, accounts: [{ id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 4 * DAY }], thresholds: { 'account-a': TH }, now: NOW });
  assert.ok(f);
  near(f.allOutAt, NOW + 48 * HOUR);
  assert.equal(f.firstBackAt, NOW + 4 * DAY);
  assert.equal(f.boundBy, 'weekly');
  assert.ok(Math.abs(f.ratePerDay - 0.24) < 1e-9, String(f.ratePerDay));
});

test('the headroom of the whole fleet is spent, and the first reset brings it back', () => {
  const series = {
    'account-a': history({ hours: 72, weeklyPerHour: flat(0.005) }),
    'account-b': history({ hours: 72, weeklyPerHour: flat(0.005) }),
  };
  const accounts = [
    { id: 'account-a', weekly: 0.9, weeklyResetAt: NOW + 5 * DAY },
    { id: 'account-b', weekly: 0.5, weeklyResetAt: NOW + 4 * DAY },
  ];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': TH, 'account-b': TH }, now: NOW });
  assert.ok(f);
  // 0.08 + 0.48 of headroom at a summed 1% an hour.
  near(f.allOutAt, NOW + 56 * HOUR);
  assert.equal(f.firstBackAt, NOW + 4 * DAY);
});

test('spend goes to the fullest open account first, as rotation does', () => {
  // account-b is fuller and resets late; account-a resets in two hours. Filling
  // b first leaves a to restart from zero after its reset: 0.8h on b, a's
  // 0.12 until its reset, then 0.98 from zero, out at 11.8h. Filling a first
  // would spend b's 0.08 last and run out 48 minutes later.
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.1) }) };
  const accounts = [
    { id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 2 * HOUR },
    { id: 'account-b', weekly: 0.9, weeklyResetAt: NOW + 100 * HOUR },
  ];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': TH, 'account-b': TH }, now: NOW });
  assert.ok(f);
  near(f.allOutAt, NOW + 11.8 * HOUR);
  assert.equal(f.firstBackAt, NOW + 100 * HOUR);
});

test('each account is held to its own threshold', () => {
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.01) }) };
  const accounts = [{ id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 4 * DAY }];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': { weekly: 0.8, fiveHour: 0.98 } }, now: NOW });
  assert.ok(f);
  near(f.allOutAt, NOW + 30 * HOUR);
});

test('a fleet already out reports now, and when the first account is back', () => {
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.01) }) };
  const accounts = [
    { id: 'account-a', weekly: 0.99, weeklyResetAt: NOW + 30 * HOUR },
    { id: 'account-b', weekly: 0.98, weeklyResetAt: NOW + 20 * HOUR },
  ];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': TH, 'account-b': TH }, now: NOW });
  assert.ok(f);
  assert.equal(f.allOutAt, NOW);
  assert.equal(f.firstBackAt, NOW + 20 * HOUR);
  assert.equal(f.boundBy, 'weekly');
});

test('a current reading whose reset has passed starts again from zero', () => {
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.01) }) };
  const accounts = [{ id: 'account-a', weekly: 0.97, weeklyResetAt: NOW - HOUR }];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': TH }, now: NOW });
  // From zero at 1% an hour, 98 hours away; the rolled reset is 167h out.
  assert.ok(f);
  near(f.allOutAt, NOW + 98 * HOUR);
  assert.equal(f.firstBackAt, NOW - HOUR + WEEKLY_PERIOD_MS);
});

test('an account with no current reading falls back to its last sample', () => {
  const samples = history({ hours: 72, weeklyPerHour: flat(0.01) });
  const last = samples[samples.length - 1];
  const series = { 'account-a': samples };
  const withReading = forecastFleet({ series, accounts: [{ id: 'account-a', weekly: last.weekly, weeklyResetAt: last.weeklyResetAt }], thresholds: { 'account-a': TH }, now: NOW });
  const fromSample = forecastFleet({ series, accounts: [{ id: 'account-a' }], thresholds: { 'account-a': TH }, now: NOW });
  assert.deepEqual(fromSample, withReading);
});

test('the weekly rate is shaped by hour of day', () => {
  // All spend falls between 08:00 and 16:00 UTC; NOW is 17:00. A flat rate of
  // the same daily total would run the 0.28 of headroom out at about 02:20; the
  // shaped one waits for the next working day.
  const working = t => { const h = new Date(t).getUTCHours(); return h >= 8 && h < 16 ? 0.09 : 0; };
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: working }) };
  const f = forecastFleet({ series, accounts: [{ id: 'account-a', weekly: 0.7, weeklyResetAt: NOW + 5 * DAY }], thresholds: { 'account-a': TH }, now: NOW });
  assert.ok(f);
  assert.ok(f.allOutAt > NOW + 13 * HOUR, `out at ${new Date(f.allOutAt).toISOString()}`);
  assert.ok(f.allOutAt < NOW + 24 * HOUR, `out at ${new Date(f.allOutAt).toISOString()}`);
  assert.ok(Math.abs(f.ratePerDay - 0.72) < 1e-9, String(f.ratePerDay));
});

test('the trailing 24 hours set the rate until the series spans 7 days, then 7 days do', () => {
  // 1% an hour, except the last day at 5%.
  const rate = t => (t >= NOW - DAY ? 0.05 : 0.01);
  const short = measureRates({ 'account-a': history({ hours: 72, weeklyPerHour: rate }) }, NOW);
  assert.ok(Math.abs(short.weeklyPerMs * DAY - 1.2) < 1e-9, String(short.weeklyPerMs * DAY));
  const long = measureRates({ 'account-a': history({ hours: 7 * 24, weeklyPerHour: rate }) }, NOW);
  assert.ok(Math.abs(long.weeklyPerMs * DAY - (6 * 0.24 + 1.2) / 7) < 1e-9, String(long.weeklyPerMs * DAY));
});

test('a window reset in the series is not negative spend', () => {
  // The weekly window resets 12h before NOW: the reading drops from ~0.84 to 0.
  const withReset = history({ hours: 72, weeklyPerHour: flat(0.01), weeklyStart: NOW - 12 * HOUR - WEEKLY_PERIOD_MS });
  const r = measureRates({ 'account-a': withReset }, NOW);
  assert.ok(Math.abs(r.weeklyPerMs * DAY - 0.24) < 1e-9, String(r.weeklyPerMs * DAY));
  // A drop with no reset (a reading that came back lower) counts as none.
  const noisy = history({ hours: 72, weeklyPerHour: flat(0.01) });
  noisy[noisy.length - 2] = { ...noisy[noisy.length - 2], weekly: noisy[noisy.length - 2].weekly + 0.2 };
  // The rise into the high reading counts (0.2 more), the fall out of it does
  // not, and the quarter hour after it (0.0025) is hidden under the fall.
  const n = measureRates({ 'account-a': noisy }, NOW);
  assert.ok(Math.abs(n.weeklyPerMs * DAY - (0.24 + 0.2 - 0.0025)) < 1e-9, String(n.weeklyPerMs * DAY));
});

// ── the 5-hour bucket ─────────────────────────────────────────────────────

test('the 5-hour bucket can run the fleet out before the weekly does', () => {
  const series = {
    'account-a': history({ hours: 72, weeklyPerHour: flat(0.005), fiveHourPerHour: 0.2 }),
    'account-b': history({ hours: 72, weeklyPerHour: flat(0.005), fiveHourPerHour: 0.2 }),
  };
  const accounts = [
    { id: 'account-a', weekly: 0.1, weeklyResetAt: NOW + 5 * DAY, fiveHour: 0.5, fiveHourResetAt: NOW + 4 * HOUR },
    { id: 'account-b', weekly: 0.1, weeklyResetAt: NOW + 5 * DAY, fiveHour: 0.5, fiveHourResetAt: NOW + 3 * HOUR },
  ];
  const f = forecastFleet({ series, accounts, thresholds: { 'account-a': TH, 'account-b': TH }, now: NOW });
  assert.ok(f);
  // 0.96 of 5-hour headroom at a summed 40% an hour.
  near(f.allOutAt, NOW + 2.4 * HOUR);
  assert.equal(f.firstBackAt, NOW + 3 * HOUR);
  assert.equal(f.boundBy, '5h');
});

test('the 5-hour rate is the trailing 6 hours, flat', () => {
  const r = measureRates({ 'account-a': history({ hours: 72, fiveHourPerHour: 0.3 }) }, NOW);
  assert.ok(Math.abs(r.fiveHourPerMs * HOUR - 0.3) < 1e-9, String(r.fiveHourPerMs * HOUR));
  assert.equal(r.weeklyPerMs, 0);
});

test('boundBy names the bucket that blocks most of the fleet', () => {
  const series = { 'account-a': history({ hours: 72 }) };
  const accounts = [
    { id: 'account-a', weekly: 0.99, weeklyResetAt: NOW + 50 * HOUR },
    { id: 'account-b', weekly: 0.2, weeklyResetAt: NOW + 50 * HOUR, fiveHour: 0.99, fiveHourResetAt: NOW + 2 * HOUR },
    { id: 'account-c', weekly: 0.2, weeklyResetAt: NOW + 50 * HOUR, fiveHour: 0.99, fiveHourResetAt: NOW + 3 * HOUR },
  ];
  const thresholds = { 'account-a': TH, 'account-b': TH, 'account-c': TH };
  const f = forecastFleet({ series, accounts, thresholds, now: NOW });
  assert.ok(f);
  assert.equal(f.allOutAt, NOW);
  assert.equal(f.boundBy, '5h');
  assert.equal(f.firstBackAt, NOW + 2 * HOUR);
});

test('a time past the horizon is never reported as allOutAt', () => {
  // Exactly enough headroom to last past 14 days at the measured rate, with
  // no reset in sight that the simulation could reach first.
  const series = { 'account-a': history({ hours: 72, weeklyPerHour: flat(0.0001) }) };
  const f = forecastFleet({ series, accounts: [{ id: 'account-a', weekly: 0.9 }], thresholds: { 'account-a': TH }, now: NOW });
  // 0.08 at 0.01% an hour is 800 hours, past the 336-hour horizon.
  assert.equal(f, null);
  assert.equal(FORECAST_HORIZON_MS, 14 * DAY);
});

// ── the read-outs ─────────────────────────────────────────────────────────

test('fleetForecastText: one line, or nothing', () => {
  assert.equal(fleetForecastText(null, NOW), null);
  assert.equal(fleetForecastText({ allOutAt: null }, NOW), null);
  assert.equal(fleetForecastText({ allOutAt: NOW + 31 * HOUR, firstBackAt: NOW + 35 * HOUR, boundBy: 'weekly', ratePerDay: 1.4 }, NOW),
    'all accounts out in ~31h (weekly), first back 4h later');
  assert.equal(fleetForecastText({ allOutAt: NOW, firstBackAt: NOW + 2 * HOUR, boundBy: '5h', ratePerDay: 1.4 }, NOW),
    'all accounts out now (5h), first back in 2h');
  assert.equal(fleetForecastText({ allOutAt: NOW + 3 * DAY + 5 * HOUR, firstBackAt: null, boundBy: 'weekly', ratePerDay: 1 }, NOW),
    'all accounts out in ~3d5h (weekly)');
});

test('teamclaude status shows the fleet line only when there is a forecast', () => {
  const base = { accounts: [], switchThreshold: 0.98 };
  const withForecast = renderStatus({ ...base, fleetForecast: { allOutAt: NOW + 31 * HOUR, firstBackAt: NOW + 35 * HOUR, boundBy: 'weekly', ratePerDay: 1.4 } }, { color: false, now: NOW });
  assert.match(withForecast, /Fleet\s+all accounts out in ~31h \(weekly\), first back 4h later/);
  assert.doesNotMatch(renderStatus({ ...base, fleetForecast: null }, { color: false, now: NOW }), /Fleet/);
});

test('the dashboard page carries the same fleetForecastText and reads fleetForecast', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes(fleetForecastText.toString()));
  assert.ok(html.includes('fleetForecastText(s.fleetForecast'));
});

// ── review follow-ups ─────────────────────────────────────────────────────

test('a downtime gap does not dilute the rate: it is measured over the time the samples cover', () => {
  // 1% an hour while the proxy runs; down, with nothing spent, for 10 hours
  // inside the last day.
  const down = t => t >= NOW - 20 * HOUR && t < NOW - 10 * HOUR;
  const full = history({ hours: 72, weeklyPerHour: t => (down(t) ? 0 : 0.01) });
  const gapped = full.filter(s => !(s.t > NOW - 20 * HOUR && s.t < NOW - 10 * HOUR));
  const r = measureRates({ 'account-a': gapped }, NOW);
  assert.ok(r, 'enough coverage for an answer');
  assert.ok(Math.abs(r.weeklyPerMs * DAY - 0.24) < 0.24 * 0.05, String(r.weeklyPerMs * DAY));
});

test('two days of samples ending days ago and half an hour of fresh ones: no answer, never "safe"', () => {
  const old = history({ hours: 7 * 24, weeklyPerHour: flat(0.05) }).filter(s => s.t >= NOW - 7 * DAY && s.t <= NOW - 5 * DAY);
  const fresh = history({ hours: 1, weeklyPerHour: flat(0.05) }).filter(s => s.t >= NOW - 30 * MIN);
  const series = { 'account-a': [...old, ...fresh] };
  assert.equal(measureRates(series, NOW), null);
  const f = forecastFleet({ series, accounts: [{ id: 'account-a', weekly: 0.5, weeklyResetAt: NOW + 5 * DAY }], thresholds: { 'account-a': TH }, now: NOW });
  assert.equal(f, null);
});

test('spend after a reset counts even when the sample at the reset had the bucket cleared', () => {
  // The server clears a bucket whose reset passed before it samples, so the
  // first sample of a new 5-hour window can hold null for it.
  const samples = history({ hours: 72, fiveHourPerHour: 0.3 });
  const cleared = samples.map(s => {
    const age = s.t - (s.fiveHourResetAt - FIVE_HOUR_PERIOD_MS);
    return age > 0 && age <= 15 * MIN ? { ...s, fiveHour: null, fiveHourResetAt: null } : s;
  });
  assert.ok(cleared.some(s => s.fiveHour === null), 'the fixture has cleared samples');
  const r = measureRates({ 'account-a': cleared }, NOW);
  assert.ok(r);
  assert.ok(Math.abs(r.fiveHourPerMs * HOUR - 0.3) < 1e-9, String(r.fiveHourPerMs * HOUR));
});
