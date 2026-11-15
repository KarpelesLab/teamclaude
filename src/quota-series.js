// The stored quota series behind the fleet forecast (#550): one sample per
// account every SAMPLE_INTERVAL_MS, holding the weekly and 5-hour utilization
// the proxy has already read and when each window resets.
//
// Kept in a file of its own beside the state file, never inside it. It is the
// one piece of state that grows with time, so it carries its own bounds: a
// sample older than SERIES_MAX_AGE_MS is pruned, and so is anything past
// SERIES_MAX_SAMPLES per account, whatever the clock says. A clock that jumped
// forward and back would otherwise leave samples "in the future" that no age
// cut ever reaches; those are pruned too.
//
// No sample costs an upstream call: `record` is handed readings the proxy
// already holds, and only for accounts it reads.

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './config.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How often an account is sampled. */
export const SAMPLE_INTERVAL_MS = 15 * MINUTE_MS;

/** How long a sample is kept. */
export const SERIES_MAX_AGE_MS = 7 * DAY_MS;

/**
 * The hard cap on samples per account. Seven days at the interval is 672; the
 * slack covers samples a restart put closer together than the interval.
 */
export const SERIES_MAX_SAMPLES = 800;

/** On-disk format version. A file with any other version reads as empty. */
const FORMAT_VERSION = 1;

/**
 * One sample. Utilization is 0-1 as in the account quota, times are ms epoch;
 * any reading the account did not have at `t` is null.
 * @typedef {{
 *   t: number,
 *   weekly: number|null,
 *   weeklyResetAt: number|null,
 *   fiveHour: number|null,
 *   fiveHourResetAt: number|null,
 * }} QuotaSample
 */

/** @param {unknown} v */
const numOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A sample from its on-disk row `[t, weekly, weeklyResetAt, fiveHour,
 * fiveHourResetAt]`, or null when the row is not one.
 * @param {unknown} row
 * @returns {QuotaSample|null}
 */
function sampleFromRow(row) {
  if (!Array.isArray(row) || row.length !== 5) return null;
  const t = numOrNull(row[0]);
  if (t == null) return null;
  return { t, weekly: numOrNull(row[1]), weeklyResetAt: numOrNull(row[2]), fiveHour: numOrNull(row[3]), fiveHourResetAt: numOrNull(row[4]) };
}

export class QuotaSeries {
  constructor() {
    /** @type {Map<string, QuotaSample[]>} samples per account id, oldest first */
    this._byAccount = new Map();
    /** Bumped on every change, so a reader can cache what it derives. */
    this.revision = 0;
  }

  /**
   * A series from a parsed file. Anything that is not the expected shape reads
   * as empty history rather than throwing; a row that is not a sample is
   * skipped, and the bounds are applied on the next prune.
   * @param {unknown} value
   */
  static fromJSON(value) {
    const series = new QuotaSeries();
    const v = /** @type {Record<string, any>|null} */ (value && typeof value === 'object' ? value : null);
    if (!v || v.version !== FORMAT_VERSION || !v.accounts || typeof v.accounts !== 'object') return series;
    for (const [id, rows] of Object.entries(v.accounts)) {
      if (!id || !Array.isArray(rows)) continue;
      /** @type {QuotaSample[]} */
      const samples = [];
      for (const row of rows) {
        const s = sampleFromRow(row);
        if (s) samples.push(s);
      }
      samples.sort((a, b) => a.t - b.t);
      if (samples.length) series._byAccount.set(id, samples.slice(-SERIES_MAX_SAMPLES));
    }
    return series;
  }

  /** The on-disk form: one compact row per sample. */
  toJSON() {
    // No prototype: an id is operator data, and `__proto__` is one.
    /** @type {Record<string, Array<Array<number|null>>>} */
    const accounts = Object.create(null);
    for (const [id, samples] of this._byAccount) {
      accounts[id] = samples.map(s => [s.t, s.weekly, s.weeklyResetAt, s.fiveHour, s.fiveHourResetAt]);
    }
    return { version: FORMAT_VERSION, accounts };
  }

  /** Every account's samples, oldest first. Read-only by convention. */
  all() {
    /** @type {Record<string, QuotaSample[]>} */
    const out = Object.create(null);
    for (const [id, samples] of this._byAccount) out[id] = samples;
    return out;
  }

  /** @param {string} id */
  samples(id) {
    return this._byAccount.get(id) || [];
  }

  /**
   * Record a sample for `id` at `now`, unless the account's last sample is
   * less than SAMPLE_INTERVAL_MS old. Returns whether one was recorded.
   * @param {string} id
   * @param {{ weekly?: number|null, weeklyResetAt?: number|null, fiveHour?: number|null, fiveHourResetAt?: number|null }} reading
   * @param {number} now
   */
  record(id, reading, now) {
    if (!id || !Number.isFinite(now)) return false;
    const samples = this._byAccount.get(id) || [];
    const last = samples[samples.length - 1];
    // A last sample "in the future" is a clock that went back; prune drops it,
    // and until then it must not stop this account being sampled.
    if (last && last.t <= now && now - last.t < SAMPLE_INTERVAL_MS) return false;
    samples.push({
      t: now,
      weekly: numOrNull(reading.weekly),
      weeklyResetAt: numOrNull(reading.weeklyResetAt),
      fiveHour: numOrNull(reading.fiveHour),
      fiveHourResetAt: numOrNull(reading.fiveHourResetAt),
    });
    if (samples.length > SERIES_MAX_SAMPLES) samples.splice(0, samples.length - SERIES_MAX_SAMPLES);
    this._byAccount.set(id, samples);
    this.revision++;
    return true;
  }

  /**
   * Drop the samples of every account not in `liveIds`, every sample older
   * than SERIES_MAX_AGE_MS or later than `now`, and anything past the per-
   * account cap. Returns whether anything was dropped.
   * @param {Iterable<string>} liveIds
   * @param {number} now
   */
  prune(liveIds, now) {
    const live = new Set(liveIds);
    let changed = false;
    for (const [id, samples] of [...this._byAccount]) {
      if (!live.has(id)) {
        this._byAccount.delete(id);
        changed = true;
        continue;
      }
      const kept = samples.filter(s => s.t <= now && now - s.t <= SERIES_MAX_AGE_MS).slice(-SERIES_MAX_SAMPLES);
      if (kept.length === samples.length) continue;
      changed = true;
      if (kept.length) this._byAccount.set(id, kept);
      else this._byAccount.delete(id);
    }
    if (changed) this.revision++;
    return changed;
  }
}

/**
 * Read the series file. A missing, unreadable or corrupt file is empty
 * history: the forecast then has nothing to say until samples accumulate.
 * @param {string} path
 */
export async function loadQuotaSeries(path) {
  try {
    return QuotaSeries.fromJSON(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return new QuotaSeries();
  }
}

/**
 * Write the series file atomically, like the state file beside it. Compact
 * rather than indented: a week of a fleet is thousands of rows.
 * @param {string} path
 * @param {QuotaSeries} series
 */
export async function saveQuotaSeries(path, series) {
  await writeJsonAtomic(path, series.toJSON(), { space: 0 });
}
