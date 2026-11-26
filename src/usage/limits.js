// A weekly spending limit per client key (`proxy.clientKeys[].weeklyUsd`).
//
// Scope says which routes a key may reach; this says how much it may spend.
// The gate reads an in-memory counter, never the database: node:sqlite is
// synchronous, and a query per request would stall every stream this process
// forwards. A request's cost is known only when its stream closes, so requests
// already in flight when a key crosses its figure are served.

import { guard } from './db.js';

const WEEK_MS = 604_800_000;
// 1 January 1970 was a Thursday; the Monday that opens its week is three days
// earlier. Weeks run from Monday 00:00 UTC: the accounts' own weekly windows
// reset at instants each account sets, so there is no fleet-wide reset to use.
const WEEK_ANCHOR_MS = 259_200_000;
const MICRO_PER_USD = 1_000_000;
// Below a cent the figures in status and in the refusal would read $0.00.
const MIN_USD = 0.01;

/** @param {number} ts */
export function weekIndex(ts) {
  return Math.floor((ts + WEEK_ANCHOR_MS) / WEEK_MS);
}

/** @param {number} index */
export function weekStart(index) {
  return index * WEEK_MS - WEEK_ANCHOR_MS;
}

/**
 * A `clientKeys` entry's limit in micro-dollars, `null` when it sets none, or
 * `'invalid'` when `weeklyUsd` is present but not a number from 0.01 up to
 * about 9 billion (the most whole micro-dollars a double holds exactly).
 * An unreadable figure refuses the key rather than leaving it unlimited, as an
 * unrecognised `scope` narrows a key rather than widening it.
 * @param {any} entry
 * @returns {number | 'invalid' | null}
 */
export function weeklyLimitFor(entry) {
  const figure = entry?.weeklyUsd;
  if (figure === undefined) return null;
  if (typeof figure !== 'number' || !(figure >= MIN_USD)) return 'invalid';
  const micro = Math.round(figure * MICRO_PER_USD);
  return Number.isSafeInteger(micro) ? micro : 'invalid';
}

export class WeeklyLimiter {
  constructor() {
    // week index -> client name -> micro-dollars. Two weeks are kept, so a host
    // clock stepping across a week boundary and back does not lose the week in
    // progress.
    /** @type {Map<number, Map<string, number>>} */
    this.weeks = new Map();
  }

  /**
   * Add a request's cost to its client's week. Every named client is counted,
   * with a limit or not, so a limit added by a reload starts from the week's
   * real spend.
   * @param {string} client
   * @param {number} micro
   * @param {number} ts
   */
  book(client, micro, ts) {
    if (!client || !(micro > 0)) return;
    const week = weekIndex(ts);
    let spend = this.weeks.get(week);
    if (!spend) {
      spend = new Map();
      this.weeks.set(week, spend);
      // The oldest week other than the one being booked: after a clock that
      // ran ahead and came back, this week is the oldest of the three, and
      // dropping it would send its spend to a map nothing reads.
      if (this.weeks.size > 2) this.weeks.delete(Math.min(...[...this.weeks.keys()].filter(k => k !== week)));
    }
    spend.set(client, (spend.get(client) ?? 0) + micro);
  }

  /** @param {string} client @param {number} ts */
  spent(client, ts) {
    return this.weeks.get(weekIndex(ts))?.get(client) ?? 0;
  }

  /**
   * Read the current week's spend back from usage history, so a restart
   * continues the week. History stores the caller label, so a key whose name
   * history folded (over 128 characters, or past its caller cap) is not
   * recovered. A store that is off or fails leaves the counters at zero.
   * @param {import('./db.js').Store} store
   * @param {number} [ts]
   */
  seed(store, ts = store.now()) {
    const week = weekIndex(ts);
    guard(store, 'limit-seed', () => {
      const spend = new Map();
      for (const row of store.stmts.weekSpend.all(weekStart(week), weekStart(week + 1))) {
        const caller = store.dims.get('caller')?.byId.get(Number(row.caller_id));
        const micro = Number(row.micro);
        if (caller && micro > 0) spend.set(caller, micro);
      }
      this.weeks.set(week, spend);
    });
  }
}

/** @param {number} micro */
const usd = micro => `$${(micro / MICRO_PER_USD).toFixed(2)}`;
/** @param {number} micro */
const dollars = micro => Math.round(micro / 10_000) / 100;
/** @param {number} ts */
const resetsAt = ts => new Date(weekStart(weekIndex(ts) + 1)).toISOString();

/** @param {any} proxyConfig */
function limitedKeys(proxyConfig) {
  const keys = Array.isArray(proxyConfig?.clientKeys) ? proxyConfig.clientKeys : [];
  /** @type {{ name: string, limit: number | 'invalid' }[]} */
  const limited = [];
  for (const e of keys) {
    const limit = weeklyLimitFor(e);
    // trimmed, as the key gate names the client it authenticates
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (name && limit !== null) limited.push({ name, limit });
  }
  return limited;
}

/**
 * Every client key with a limit and what it has spent against it, for
 * `/teamclaude/status`.
 * @param {WeeklyLimiter} limiter
 * @param {any} proxyConfig
 * @param {number} [ts]
 */
export function clientLimitStatus(limiter, proxyConfig, ts = Date.now()) {
  return limitedKeys(proxyConfig).map(({ name, limit }) => {
    if (limit === 'invalid') return { name, invalid: true };
    const spent = limiter.spent(name, ts);
    return { name, weeklyUsd: dollars(limit), spentUsd: dollars(spent), remainingUsd: dollars(Math.max(0, limit - spent)), resetsAt: resetsAt(ts) };
  });
}

/**
 * The refusal for a client key at or over its limit, else null. Requests
 * without a named key cannot be limited.
 * @param {WeeklyLimiter} limiter
 * @param {any} proxyConfig
 * @param {string|null|undefined} client
 * @param {number} ts
 * @returns {string|null}
 */
export function limitRefusal(limiter, proxyConfig, client, ts) {
  if (!client) return null;
  const limit = limitedKeys(proxyConfig).find(k => k.name === client)?.limit;
  if (limit == null) return null;
  if (limit === 'invalid') return "this key's weeklyUsd is not a number of at least 0.01, so the key is refused";
  const spent = limiter.spent(client, ts);
  return spent < limit ? null : `weekly spending limit of ${usd(limit)} reached (spent ${usd(spent)}); it resets at ${resetsAt(ts)}`;
}
