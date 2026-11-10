import { guard } from './db.js';

/** @typedef {import('./db.js').Store} Store */

export const MEMO_TTL_MS = 10_000;
const HOUR_MS = 3_600_000;

// 5h comes from raw rows because an hourly bucket cannot answer a five-hour
// boundary without over-scanning, and five hours of rows is a trivial range.
// The longer windows come from the rollup, which is what keeps a 30-day
// aggregate off the multi-hundred-millisecond scale that a synchronous query in
// a single-process proxy cannot afford.
/** @type {Record<string, { hours: number, source: 'raw'|'hourly' }>} */
export const WINDOWS = {
  '5h': { hours: 5, source: 'raw' },
  '7d': { hours: 168, source: 'hourly' },
  '30d': { hours: 720, source: 'hourly' },
};

export const WINDOW_KEYS = Object.keys(WINDOWS);

export const RAW_SQL = `SELECT caller_id, model_id, account_id,
    COUNT(*) AS requests,
    SUM(tokens) AS tokens,
    SUM(input) AS input,
    SUM(cache_read) AS cache_read,
    SUM(cache_write) AS cache_write,
    SUM(output) AS output,
    SUM(status = 429) AS refusals
  FROM usage WHERE ts >= ?
  GROUP BY caller_id, model_id, account_id`;

export const HOURLY_SQL = `SELECT caller_id, model_id, account_id,
    SUM(req) AS requests,
    SUM(tokens) AS tokens,
    SUM(input) AS input,
    SUM(cache_read) AS cache_read,
    SUM(cache_write) AS cache_write,
    SUM(output) AS output,
    SUM(refusals) AS refusals
  FROM usage_hourly WHERE hour >= ?
  GROUP BY caller_id, model_id, account_id`;

const MEASURES = ['requests', 'tokens', 'input', 'cacheRead', 'cacheWrite', 'output', 'refusals'];

/**
 * The span a window actually covers. A rollup window is snapped to whole hours,
 * so the number served is exactly the sum of the buckets read rather than a raw
 * span approximated by them.
 * @param {string} window
 * @param {number} at
 */
export function windowBounds(window, at) {
  const spec = WINDOWS[window];
  if (spec.source === 'raw') {
    const since = at - spec.hours * HOUR_MS;
    return { since, bound: since };
  }
  const bound = Math.floor(at / HOUR_MS) - spec.hours + 1;
  return { since: bound * HOUR_MS, bound };
}

/** @returns {Record<string, number>} */
function blank() {
  /** @type {Record<string, number>} */
  const row = {};
  for (const measure of MEASURES) row[measure] = 0;
  return row;
}

/**
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} row
 */
function add(entry, row) {
  entry.requests += Number(row.requests) || 0;
  entry.tokens += Number(row.tokens) || 0;
  entry.input += Number(row.input) || 0;
  entry.cacheRead += Number(row.cache_read) || 0;
  entry.cacheWrite += Number(row.cache_write) || 0;
  entry.output += Number(row.output) || 0;
  entry.refusals += Number(row.refusals) || 0;
  return entry;
}

/**
 * @param {Map<string, Record<string, any>>} map
 * @param {string} field
 * @param {string} name
 * @param {Record<string, any>} row
 */
function fold(map, field, name, row) {
  let entry = map.get(name);
  if (!entry) { entry = { [field]: name, ...blank() }; map.set(name, entry); }
  return add(entry, row);
}

// Labels carry whatever a client sent, so the pair is joined on a byte no label
// can hold, and held in a Map where a name like __proto__ is an ordinary key
// rather than a route to Object.prototype.
/**
 * @param {Map<string, Record<string, any>>} map
 * @param {string} caller
 * @param {string} model
 * @param {Record<string, any>} row
 */
function foldPair(map, caller, model, row) {
  const key = `${caller}\u0000${model}`;
  let entry = map.get(key);
  if (!entry) { entry = { caller, model, ...blank() }; map.set(key, entry); }
  return add(entry, row);
}

/**
 * @param {Store} store
 * @param {string} kind
 * @param {unknown} id
 */
function labelOf(store, kind, id) {
  return store.dims.get(kind)?.byId.get(Number(id)) ?? `#${id}`;
}

/**
 * @param {Store} store
 * @param {string} key
 * @param {string} sql
 */
function statement(store, key, sql) {
  return (store.stmts[key] ||= /** @type {import('node:sqlite').StatementSync} */ (store.db?.prepare(sql)));
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
const byTokens = (a, b) => b.tokens - a.tokens || b.requests - a.requests;

/**
 * @param {Store} store
 * @param {string} window
 * @param {number} at
 */
function compute(store, window, at) {
  const spec = WINDOWS[window];
  const { since, bound } = windowBounds(window, at);
  const rows = spec.source === 'raw'
    ? statement(store, 'summaryRaw', RAW_SQL).all(bound)
    : statement(store, 'summaryHourly', HOURLY_SQL).all(bound);

  const callers = new Map();
  const models = new Map();
  const accounts = new Map();
  const callerModels = new Map();
  const totals = blank();

  for (const row of rows) {
    const caller = labelOf(store, 'caller', row.caller_id);
    const model = labelOf(store, 'model', row.model_id);
    fold(callers, 'caller', caller, row);
    fold(models, 'model', model, row);
    fold(accounts, 'account', labelOf(store, 'account', row.account_id), row);
    foldPair(callerModels, caller, model, row);
    add(totals, row);
  }

  const callerRows = [...callers.values()].sort(byTokens);
  for (const row of callerRows) row.share = totals.tokens ? row.tokens / totals.tokens : 0;

  const callerRank = new Map(callerRows.map((row, i) => [row.caller, i]));

  return {
    window,
    available: true,
    source: spec.source,
    since,
    until: at,
    totals,
    callers: callerRows,
    callerModels: [...callerModels.values()]
      .sort((a, b) => (callerRank.get(a.caller) ?? 0) - (callerRank.get(b.caller) ?? 0) || byTokens(a, b)),
    models: [...models.values()].sort(byTokens),
    accounts: [...accounts.values()].sort(byTokens),
  };
}

// Only reached when the database is disabled or the read failed, so the zeros
// are labelled as absent data rather than as an idle pool.
/**
 * @param {Store} store
 * @param {string} window
 * @param {number} at
 */
function empty(store, window, at) {
  return {
    window,
    available: false,
    source: WINDOWS[window].source,
    since: windowBounds(window, at).since,
    until: at,
    totals: blank(),
    callers: [],
    callerModels: [],
    models: [],
    accounts: [],
  };
}

/**
 * Aggregate one window, per caller, per model and per account. Returns null for
 * an unrecognised window so the route can answer 400 rather than invent a span.
 *
 * The memo bounds the one coupling a try/catch cannot break: the query runs on
 * the event loop that forwards streams, so several viewers on a refresh loop
 * must not multiply into it. A failed or disabled read is memoised too, so a
 * broken database is asked once every ten seconds rather than once a refresh.
 * @param {Store} store
 * @param {string} window
 * @param {number} [at]
 */
export function usageSummary(store, window, at = store.now()) {
  if (!Object.hasOwn(WINDOWS, window)) return null;
  const cached = store.memo.get(window);
  if (cached && at >= cached.at && at - cached.at < MEMO_TTL_MS) return cached.value;
  const value = guard(store, 'query', () => compute(store, window, at), null) ?? empty(store, window, at);
  store.memo.set(window, { at, value });
  return value;
}
