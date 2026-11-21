// Fleet forecast (#550): when is every account out at once, and when does the
// first one come back?
//
// A forward simulation over the stored quota series (quota-series.js). Each
// bucket has its own measured rate, because in the outages this was built
// from some accounts were blocked on the weekly bucket and others on the
// 5-hour one, and the ratio between the two was not stable enough to derive
// one from the other:
//
//   - weekly: the fleet's summed weekly increase over the trailing 24 hours,
//     or 7 days once the series covers them, shaped by hour of day (UTC). A
//     flat rate taken in the evening and carried through the night calls the
//     wall too early.
//   - 5-hour: the summed 5-hour increase over the trailing 6 hours, flat.
//
// Spend is measured in units of plan size, so a week of a 20x account fills
// a 5x one four times over, and it is shared among the open accounts in
// proportion to their size: their utilization rises together, as rotation
// that spreads sessions keeps it. Replayed against a week of a real
// pool's history, that predicted each account's state a day ahead better
// than pouring all of it into the fullest account. An account is blocked
// while either bucket is at or over its threshold and comes back at that
// bucket's reset. The simulation moves from one event to the next (a
// threshold, a reset, the hour's rate changing), so every time it reports is
// exact and no outage is too short to see.
//
// Pure: everything, the clock included, comes in through the arguments.

import { FORECAST_HORIZON_MS } from './forecast.js';
import { SAMPLE_INTERVAL_MS } from './quota-series.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const WEEKLY_PERIOD_MS = 7 * DAY_MS;
export const FIVE_HOUR_PERIOD_MS = 5 * HOUR_MS;

/** History the series must span before the forecast says anything. */
export const MIN_HISTORY_MS = 48 * HOUR_MS;

/** Trailing window of the 5-hour rate. */
export const FIVE_HOUR_RATE_WINDOW_MS = 6 * HOUR_MS;

/**
 * Two samples further apart than this are a gap: the proxy was not running,
 * or not reading, so the time between them is not covered.
 */
export const MAX_SAMPLE_GAP_MS = 2 * SAMPLE_INTERVAL_MS;

/** Coverage the weekly rate needs inside its window to be trusted. */
export const MIN_WEEKLY_COVERAGE_MS = 6 * HOUR_MS;

/** Coverage the 5-hour rate needs inside its window to be trusted. */
export const MIN_FIVE_HOUR_COVERAGE_MS = 1 * HOUR_MS;

/** Coverage of the last 7 days from which the weekly rate is taken over all 7. */
export const MIN_WEEK_WINDOW_COVERAGE_MS = 6 * DAY_MS;

/** How far ahead the timeline runs. */
export const TIMELINE_MS = WEEKLY_PERIOD_MS;

/** The load of the busier scenario, against the measured one. */
export const BUSIER_LOAD_FACTOR = 1.25;

/**
 * @typedef {import('./quota-series.js').QuotaSample} QuotaSample
 * @typedef {{ id: string, weekly?: number|null, weeklyResetAt?: number|null, fiveHour?: number|null, fiveHourResetAt?: number|null, weight?: number|null }} FleetAccount
 *   An account's current readings, null where it has none, and its plan's
 *   size against the others (1 for Pro, 5 and 20 for the multiples).
 * @typedef {{ weekly: number, fiveHour: number }} BucketThresholds
 * @typedef {{ allOutAt: number, firstBackAt: number|null, boundBy: 'weekly'|'5h', ratePerDay: number }} FleetForecast
 * @typedef {{ at: number, usable: boolean, bucket: 'weekly'|'5h'|null }} AccountState
 * @typedef {{ from: number, to: number|null }} Outage
 * @typedef {{ from: number, to: number, accounts: Record<string, AccountState[]>, outages: Outage[] }} FleetTimeline
 */

/**
 * The increase in one bucket between two readings of one account. A window
 * that started after the earlier reading began again from zero, so the whole
 * later reading is new spend; any other drop is not negative spend and counts
 * as none.
 * @param {number} prevU
 * @param {number|null} prevReset
 * @param {number} prevT
 * @param {number} curU
 * @param {number|null} curReset
 * @param {number} curT
 * @param {number} period
 */
function increase(prevU, prevReset, prevT, curU, curReset, curT, period) {
  // A window ends at its reset and lasts a period, so the later reading's
  // window started at curReset - period. Without that reset, a passed earlier
  // reset and a lower reading say the same.
  const newWindow = curReset != null
    ? curReset - period >= prevT
    : prevReset != null && prevReset < curT && curU < prevU;
  if (newWindow) return Math.max(0, curU);
  return Math.max(0, curU - prevU);
}

/**
 * The stretches of time the fleet's samples cover: wherever two consecutive
 * samples, of any account, are at most MAX_SAMPLE_GAP_MS apart. Sorted and
 * disjoint.
 * @param {Record<string, QuotaSample[]>} series
 * @returns {Array<[number, number]>}
 */
export function coveredSpans(series) {
  const times = [...new Set(Object.values(series).flatMap(samples => samples.map(s => s.t)))].sort((a, b) => a - b);
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > MAX_SAMPLE_GAP_MS) continue;
    const last = spans[spans.length - 1];
    if (last && last[1] === times[i - 1]) last[1] = times[i];
    else spans.push([times[i - 1], times[i]]);
  }
  return spans;
}

/**
 * How much of [from, to] the spans cover.
 * @param {Array<[number, number]>} spans
 * @param {number} from
 * @param {number} to
 */
function coveredWithin(spans, from, to) {
  let total = 0;
  for (const [a, b] of spans) total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return total;
}

/**
 * Summed increase of one bucket over [start, end]. Each reading is paired with
 * the account's previous reading of that bucket, skipping samples where the
 * bucket was empty (a window the server had cleared at its reset), and the
 * pair's increase counts for the part of it inside the window that the
 * samples cover: across a gap the proxy was not running, and through it spent
 * nothing. `onPair` gets each counted increase with the midpoint of the
 * counted span, for the hour profile.
 * @param {Record<string, QuotaSample[]>} series
 * @param {Array<[number, number]>} spans
 * @param {'weekly'|'fiveHour'} bucket
 * @param {number} start
 * @param {number} end
 * @param {(id: string) => number} weightOf
 * @param {(amount: number, at: number) => void} [onPair]
 */
function summedIncrease(series, spans, bucket, start, end, weightOf, onPair) {
  const resetKey = bucket === 'weekly' ? 'weeklyResetAt' : 'fiveHourResetAt';
  const period = bucket === 'weekly' ? WEEKLY_PERIOD_MS : FIVE_HOUR_PERIOD_MS;
  let total = 0;
  for (const [id, samples] of Object.entries(series)) {
    const weight = weightOf(id);
    /** @type {QuotaSample|null} */
    let prev = null;
    for (const cur of samples) {
      const curU = cur[bucket];
      if (curU == null) continue;
      const p = prev;
      prev = cur;
      if (!p || cur.t <= p.t || cur.t <= start || p.t >= end) continue;
      const inc = increase(/** @type {number} */ (p[bucket]), p[resetKey], p.t, curU, cur[resetKey], cur.t, period);
      if (inc <= 0) continue;
      const from = Math.max(p.t, start);
      const to = Math.min(cur.t, end);
      const amount = weight * inc * coveredWithin(spans, from, to) / (cur.t - p.t);
      if (amount <= 0) continue;
      total += amount;
      onPair?.(amount, (from + to) / 2);
    }
  }
  return total;
}

/**
 * The measured rates: the weekly level per ms with its hour-of-day shape
 * (24 factors averaging 1), and the flat 5-hour rate per ms. Each is the
 * increase over the time the samples cover inside its window, not over the
 * whole window, so a downtime does not read as a quiet fleet. The weekly
 * window is 7 days once the samples cover MIN_WEEK_WINDOW_COVERAGE_MS of
 * them, else 24 hours. Null when either window is covered too thinly to trust:
 * under MIN_WEEKLY_COVERAGE_MS or MIN_FIVE_HOUR_COVERAGE_MS. Rates are in
 * shares of a bucket of weight 1; `weightOf` gives each account's.
 * @param {Record<string, QuotaSample[]>} series
 * @param {number} now
 * @param {(id: string) => number} [weightOf]
 */
export function measureRates(series, now, weightOf = () => 1) {
  const spans = coveredSpans(series);
  const weekCoverage = coveredWithin(spans, now - WEEKLY_PERIOD_MS, now);
  const weeklyWindow = weekCoverage >= MIN_WEEK_WINDOW_COVERAGE_MS ? WEEKLY_PERIOD_MS : DAY_MS;
  const weeklyCoverage = weeklyWindow === WEEKLY_PERIOD_MS ? weekCoverage : coveredWithin(spans, now - DAY_MS, now);
  const fiveHourCoverage = coveredWithin(spans, now - FIVE_HOUR_RATE_WINDOW_MS, now);
  if (weeklyCoverage < MIN_WEEKLY_COVERAGE_MS || fiveHourCoverage < MIN_FIVE_HOUR_COVERAGE_MS) return null;
  const hours = new Array(24).fill(0);
  const weeklyTotal = summedIncrease(series, spans, 'weekly', now - weeklyWindow, now, weightOf, (amount, at) => {
    hours[new Date(at).getUTCHours()] += amount;
  });
  const weeklyPerMs = weeklyTotal / weeklyCoverage;
  // Smoothed with both neighbours: a 24-hour window sees each hour once, and
  // one quiet hour would otherwise forecast that hour as free tomorrow.
  let shape = new Array(24).fill(1);
  if (weeklyTotal > 0) {
    const smooth = hours.map((v, h) => (hours[(h + 23) % 24] + 2 * v + hours[(h + 1) % 24]) / 4);
    const mean = smooth.reduce((a, b) => a + b, 0) / 24;
    shape = smooth.map(v => v / mean);
  }
  const fiveHourPerMs = summedIncrease(series, spans, 'fiveHour', now - FIVE_HOUR_RATE_WINDOW_MS, now, weightOf) / fiveHourCoverage;
  return { weeklyPerMs, shape, fiveHourPerMs };
}

/**
 * A bucket's state at `now` from the current reading, falling back to the
 * account's last sample. A reset that has passed rolls the window forward by
 * whole periods, starting it again at zero. An unknown reset stays unknown
 * until the simulation first spends on the bucket, which is when a window
 * starts.
 * @param {number|null|undefined} u
 * @param {number|null|undefined} reset
 * @param {number} period
 * @param {number} now
 */
function startState(u, reset, period, now) {
  let util = typeof u === 'number' && Number.isFinite(u) ? u : 0;
  let at = typeof reset === 'number' && Number.isFinite(reset) ? reset : null;
  if (at != null && at <= now) {
    util = 0;
    at += Math.ceil((now - at + 1) / period) * period;
  }
  return { util, at };
}

/**
 * The fleet at `now`, with its measured rates, or null when there is no
 * answer: fewer than MIN_HISTORY_MS of samples, samples too thin inside a
 * rate window (see measureRates), or no accounts.
 * @param {{ series: Record<string, QuotaSample[]>, accounts: FleetAccount[], thresholds: Record<string, BucketThresholds>, now: number }} input
 */
function prepare({ series, accounts, thresholds, now }) {
  if (!Number.isFinite(now) || !accounts.length) return null;
  let earliest = Infinity;
  for (const samples of Object.values(series)) {
    for (const s of samples) if (s.t <= now && s.t < earliest) earliest = s.t;
  }
  const span = now - earliest;
  if (!(span >= MIN_HISTORY_MS)) return null;

  // Weights count only when every account has one: one unknown plan would
  // otherwise be read as a size it may not have.
  const weighted = accounts.every(a => typeof a.weight === 'number' && a.weight > 0);
  /** @type {Map<string, number>} */
  const weights = new Map(accounts.map(a => [a.id, weighted ? /** @type {number} */ (a.weight) : 1]));
  const meanWeight = [...weights.values()].reduce((n, w) => n + w, 0) / weights.size;
  // An id in the series but not in the fleet (an account since disabled) spent
  // at a size no one reports any more: the fleet's average stands in for it.
  const rates = measureRates(series, now, id => weights.get(id) ?? meanWeight);
  if (!rates) return null;

  const fleet = accounts.map(a => {
    // Own properties only: an id is operator data, and `__proto__` is one.
    const samples = Object.hasOwn(series, a.id) ? series[a.id] : [];
    const th = Object.hasOwn(thresholds, a.id) ? thresholds[a.id] : { weekly: 1, fiveHour: 1 };
    // A bucket's start comes from the current reading when there is one, else
    // from the last sample that held one, reading and reset together.
    /** @param {'weekly'|'fiveHour'} bucket @param {'weeklyResetAt'|'fiveHourResetAt'} resetKey */
    const latest = (bucket, resetKey) => {
      if (a[bucket] != null) return { u: a[bucket], reset: a[resetKey] ?? null };
      for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i][bucket] != null) return { u: samples[i][bucket], reset: samples[i][resetKey] };
      }
      return { u: null, reset: null };
    };
    const w = latest('weekly', 'weeklyResetAt');
    const f = latest('fiveHour', 'fiveHourResetAt');
    const weekly = startState(w.u, w.reset, WEEKLY_PERIOD_MS, now);
    const fiveHour = startState(f.u, f.reset, FIVE_HOUR_PERIOD_MS, now);
    return { id: a.id, th, weight: /** @type {number} */ (weights.get(a.id)), w: weekly.util, wAt: weekly.at, f: fiveHour.util, fAt: fiveHour.at };
  });
  return { fleet, rates, meanWeight };
}

/**
 * @typedef {NonNullable<ReturnType<typeof prepare>>['fleet'][number]} SimAccount
 */

/** @param {SimAccount} acc */
const usable = acc => acc.w < acc.th.weekly && acc.f < acc.th.fiveHour;

/**
 * Runs the fleet forward from `now` to `end` at `loadFactor` times the
 * measured rates, calling `visit` at every event with the time and the
 * accounts open then; `visit` returns true to stop. Each event comes after
 * the resets due at it, so an account back at that moment counts as open.
 * @param {NonNullable<ReturnType<typeof prepare>>} prepared
 * @param {number} now
 * @param {number} end
 * @param {number} loadFactor
 * @param {(t: number, fleet: SimAccount[], open: SimAccount[]) => boolean|void} visit
 */
function simulate(prepared, now, end, loadFactor, visit) {
  const fleet = prepared.fleet.map(acc => ({ ...acc }));
  const { weeklyPerMs, shape, fiveHourPerMs } = prepared.rates;
  let t = now;
  // A guard, not a limit the fleet reaches: a week has under 200 hour marks,
  // and each account adds a threshold and a reset or two per window.
  for (let guard = 0; t <= end && guard < 100_000; guard++) {
    for (const acc of fleet) {
      if (acc.wAt != null && acc.wAt <= t) {
        acc.w = 0;
        acc.wAt += Math.ceil((t - acc.wAt + 1) / WEEKLY_PERIOD_MS) * WEEKLY_PERIOD_MS;
      }
      if (acc.fAt != null && acc.fAt <= t) {
        acc.f = 0;
        acc.fAt += Math.ceil((t - acc.fAt + 1) / FIVE_HOUR_PERIOD_MS) * FIVE_HOUR_PERIOD_MS;
      }
    }
    const open = fleet.filter(usable);
    if (visit(t, fleet, open)) return;
    // The next moment anything changes without spend: a reset, or the hour's
    // rate. With no account open, nothing else can.
    let next = Math.min(end + 1, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS);
    for (const acc of fleet) {
      if (acc.wAt != null) next = Math.min(next, acc.wAt);
      if (acc.fAt != null) next = Math.min(next, acc.fAt);
    }
    if (!open.length) { t = next; continue; }
    const weeklyRate = weeklyPerMs * shape[new Date(t).getUTCHours()] * loadFactor;
    const fiveHourRate = fiveHourPerMs * loadFactor;
    // Shared by size, every open account's utilization rises at the same
    // pace, until the first of them reaches a threshold.
    const capacity = open.reduce((n, acc) => n + acc.weight, 0);
    const weeklyPace = weeklyRate / capacity;
    const fiveHourPace = fiveHourRate / capacity;
    let dt = next - t;
    for (const acc of open) {
      if (acc.wAt == null && weeklyPace > 0) acc.wAt = t + WEEKLY_PERIOD_MS;
      if (acc.fAt == null && fiveHourPace > 0) acc.fAt = t + FIVE_HOUR_PERIOD_MS;
      if (weeklyPace > 0) dt = Math.min(dt, (acc.th.weekly - acc.w) / weeklyPace);
      if (fiveHourPace > 0) dt = Math.min(dt, (acc.th.fiveHour - acc.f) / fiveHourPace);
    }
    for (const acc of open) {
      acc.w += weeklyPace * dt;
      acc.f += fiveHourPace * dt;
      // Filled by the division above, an account can land a rounding error
      // under its threshold, open forever on a spend too small to matter.
      if (acc.th.weekly - acc.w < 1e-9) acc.w = Math.max(acc.w, acc.th.weekly);
      if (acc.th.fiveHour - acc.f < 1e-9) acc.f = Math.max(acc.f, acc.th.fiveHour);
    }
    t += dt;
  }
}

/**
 * The fleet forecast, or null when there is no answer: no fleet to simulate
 * (see prepare), or nothing runs out within FORECAST_HORIZON_MS.
 *
 * `allOutAt` is the first moment every account is blocked (now, when they all
 * already are); `firstBackAt` the first moment after it that one is usable
 * again; `boundBy` the bucket that blocks most of the fleet at `allOutAt`
 * (the weekly one on a tie); `ratePerDay` the measured weekly rate, in shares
 * of an average account's week per day. Times are ms epoch.
 *
 * @param {{
 *   series: Record<string, QuotaSample[]>,
 *   accounts: FleetAccount[],
 *   thresholds: Record<string, BucketThresholds>,
 *   now: number,
 * }} input
 * @returns {FleetForecast|null}
 */
export function forecastFleet(input) {
  const prepared = prepare(input);
  if (!prepared) return null;
  const { now } = input;
  const ratePerDay = prepared.rates.weeklyPerMs * DAY_MS / prepared.meanWeight;
  /** @type {number|null} */
  let allOutAt = null;
  /** @type {number|null} */
  let firstBackAt = null;
  /** @type {'weekly'|'5h'} */
  let boundBy = 'weekly';
  let past = false;
  // Past the horizon only to find the way back: a weekly window resets within
  // a period, so the first account is usable again within one.
  simulate(prepared, now, now + FORECAST_HORIZON_MS + WEEKLY_PERIOD_MS, 1, (t, fleet, open) => {
    if (allOutAt != null) {
      if (!open.length) return false;
      firstBackAt = Math.round(t);
      return true;
    }
    if (t - now > FORECAST_HORIZON_MS) { past = true; return true; }
    if (open.length) return false;
    // The simulation steps to the instant a threshold is crossed, a fraction
    // of a millisecond; what leaves this module is a whole ms epoch, as it
    // always was for the readers of `status --json`.
    allOutAt = Math.round(t);
    const weeklyBlocked = fleet.filter(acc => acc.w >= acc.th.weekly).length;
    boundBy = weeklyBlocked * 2 >= fleet.length ? 'weekly' : '5h';
    return false;
  });
  if (past || allOutAt == null) return null;
  return { allOutAt, firstBackAt, boundBy, ratePerDay };
}

/**
 * The week ahead from the same simulation: every account's state from `now`
 * on, as the changes to it, and every stretch in which no account is open.
 * `loadFactor` scales the measured rates, for a busier or quieter scenario.
 * An outage still running at the end of the timeline has `to: null`. Null
 * when there is no fleet to simulate (see prepare); unlike forecastFleet it
 * answers when nothing runs out.
 *
 * @param {{
 *   series: Record<string, QuotaSample[]>,
 *   accounts: FleetAccount[],
 *   thresholds: Record<string, BucketThresholds>,
 *   now: number,
 *   loadFactor?: number,
 * }} input
 * @returns {FleetTimeline|null}
 */
export function fleetTimeline(input) {
  const prepared = prepare(input);
  if (!prepared) return null;
  const { now, loadFactor = 1 } = input;
  const end = now + TIMELINE_MS;
  /** @type {Record<string, AccountState[]>} */
  const accounts = Object.create(null);
  /** @type {Outage[]} */
  const outages = [];
  simulate(prepared, now, end, loadFactor, (t, fleet, open) => {
    for (const acc of fleet) {
      const states = accounts[acc.id] ??= [];
      const ok = usable(acc);
      // A change of what blocks it is a change too: blocked on both, an
      // account whose weekly window resets first is then held by the 5-hour one.
      const bucket = ok ? null : acc.w >= acc.th.weekly ? 'weekly' : '5h';
      const prev = states[states.length - 1];
      if (prev && prev.usable === ok && prev.bucket === bucket) continue;
      states.push({ at: Math.round(t), usable: ok, bucket });
    }
    const last = outages[outages.length - 1];
    if (!open.length && (!last || last.to != null)) outages.push({ from: Math.round(t), to: null });
    if (open.length && last && last.to == null) last.to = Math.round(t);
    return false;
  });
  return { from: now, to: end, accounts, outages };
}
