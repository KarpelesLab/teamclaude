import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { applySchema, SchemaTooNewError } from './schema.js';

/**
 * @typedef {Object} DimCache
 * @property {Map<string, number>} byLabel
 * @property {Map<number, string>} byId
 */

/**
 * The handle every usage/*.js function takes as its first argument.
 * `disabled` gates every operation (see `guard`); a disabled store still
 * carries `reason`/`setAside` for `usageStats`, but `db`/`stmts` are never
 * read again once it is set.
 * @typedef {Object} Store
 * @property {string} path
 * @property {() => number} now
 * @property {((label: string, err: Error) => void)|null} onError
 * @property {import('node:sqlite').DatabaseSync|null} db
 * @property {Record<string, import('node:sqlite').StatementSync>} stmts
 * @property {Map<string, DimCache>} dims
 * @property {Map<string, { at: number, value: any }>} memo
 * @property {Map<string, number>} errors
 * @property {{ label: string, message: string, at: number }|null} lastError
 * @property {boolean} disabled
 * @property {string|null} reason
 * @property {string|null} setAside
 * @property {number} lastPruneAt
 * @property {NodeJS.Timeout|null} timer
 */

// node:sqlite is built in from Node 22.13 (22.5 to 22.12 behind
// --experimental-sqlite). Loaded at runtime rather than imported, so on an
// older Node the server still starts and the store opens disabled. And loaded
// on first use rather than when this module is: every command imports this
// file through server.js, and on Node 22 loading node:sqlite prints an
// ExperimentalWarning, which a process that never turned history on (the
// default) must not print.
/** @type {typeof import('node:sqlite')|null|undefined} */
let sqlite;
function loadSqlite() {
  if (sqlite === undefined) {
    try { sqlite = /** @type {any} */ (process).getBuiltinModule?.('node:sqlite') ?? null; } catch { sqlite = null; }
  }
  return sqlite ?? null;
}

/** Whether this Node can open a usage store at all. Loads node:sqlite to find out. */
export function usageStoreAvailable() {
  return loadSqlite() !== null;
}

export const TICK_MS = 60_000;
export const PRUNE_INTERVAL_MS = 86_400_000;
export const RAW_RETENTION_MS = 90 * 86_400_000;
export const ROLLUP_RETENTION_MS = 400 * 86_400_000;
// Caps how many rows ANALYZE samples per index. Without it, analysing a full
// raw table costs 54 ms and the rollup 121 ms; with it, 5 ms and 9 ms for the
// same plans.
const ANALYSIS_LIMIT = 400;

const SIDECARS = ['-wal', '-shm'];

const STATEMENTS = {
  insertDim: 'INSERT OR IGNORE INTO dim (kind, label) VALUES (?, ?)',
  selectDim: 'SELECT id FROM dim WHERE kind = ? AND label = ?',
  insertUsage: `INSERT INTO usage
      (ts, caller_id, model_id, account_id, tokens, input, cache_read, cache_write, output, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  upsertHourly: `INSERT INTO usage_hourly
      (caller_id, model_id, account_id, hour, req, tokens, input, cache_read, cache_write, output, refusals)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (caller_id, model_id, account_id, hour) DO UPDATE SET
      req         = req + 1,
      tokens      = tokens + excluded.tokens,
      input       = input + excluded.input,
      cache_read  = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write,
      output      = output + excluded.output,
      refusals    = refusals + excluded.refusals`,
  pruneUsage: 'DELETE FROM usage WHERE ts < ?',
  pruneHourly: 'DELETE FROM usage_hourly WHERE hour < ?',
};

/**
 * Open the usage database, or return a disabled store.
 *
 * Nothing here rejects: serving the pool is the instance's job, so every
 * failure mode ends with a store the recorder and the route can call. A
 * database that will not open leaves `disabled` set and every later call a
 * no-op; a corrupt one is renamed aside and recreated, because corruption does
 * not self-heal and losing history beats refusing to serve.
 * @param {{ path: string, now?: () => number, onError?: ((label: string, err: Error) => void)|null }} opts
 * @returns {Store}
 */
export function openUsageStore({ path, now = Date.now, onError = null }) {
  /** @type {Store} */
  const store = {
    path,
    now,
    onError,
    db: null,
    stmts: {},
    dims: new Map([['caller', newDim()], ['model', newDim()], ['account', newDim()]]),
    memo: new Map(),
    errors: new Map(),
    lastError: null,
    disabled: true,
    reason: null,
    setAside: null,
    lastPruneAt: 0,
    timer: null,
  };

  if (!loadSqlite()) return fail(store, Object.assign(new Error('node:sqlite needs Node 22.13 or later'), { code: 'sqlite-unavailable' }));
  /** @type {import('node:sqlite').DatabaseSync} */
  let db;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = connect(path);
  } catch (err) {
    if (!isCorruption(err)) return fail(store, err);
    try {
      store.setAside = moveAside(path, now());
      db = connect(path);
    } catch (err2) {
      return fail(store, err2);
    }
  }

  try {
    store.db = db;
    store.disabled = false;
    for (const [name, sql] of Object.entries(STATEMENTS)) store.stmts[name] = db.prepare(sql);
    loadDims(store);
  } catch (err) {
    return fail(store, err);
  }
  return store;
}

function newDim() {
  return { byLabel: new Map(), byId: new Map() };
}

/**
 * Create the database file owner-only before SQLite opens it. It holds account
 * names (usually email addresses) and client-key names, so it gets the mode the
 * config beside it has; SQLite would create it under the umask, 0644 on most
 * machines. The -wal and -shm files take the main file's mode. A file that is
 * already there is tightened too. Best effort: a filesystem without modes is
 * not a reason to run without history.
 * @param {string} path
 */
function restrictToOwner(path) {
  if (path === ':memory:') return;
  try {
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  } catch { /* SQLite reports a path it cannot open */ }
}

/** @param {string} path */
function connect(path) {
  restrictToOwner(path);
  const db = new (/** @type {typeof import('node:sqlite')} */ (loadSqlite())).DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // No busy wait: every call runs on the event loop, so a lock held by
    // another process fails the write at once (logged and skipped) rather
    // than stalling every request behind it.
    db.exec('PRAGMA busy_timeout = 0');
    db.exec(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT}`);
    // The cheap read that turns a corrupt file into a catchable error here
    // rather than an error on the first recorded request: it faults in page 1
    // and the schema, which is where a truncated or overwritten file breaks.
    db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    applySchema(db);
    db.prepare('SELECT ts FROM usage ORDER BY ts DESC LIMIT 1').get();
    ensureStatistics(db);
    return db;
  } catch (err) {
    try { db.close(); } catch { /* already unusable */ }
    throw err;
  }
}

/**
 * Make sure the planner has the statistics both served queries need. Both
 * aggregates depend on knowing how few distinct callers, models and accounts
 * there are: with that, each is a handful of index ranges; without it, the same
 * index is scanned end to end — 5.4× slower at 5h and 12× at 7d.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureStatistics(db) {
  const present = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()?.n
    && db.prepare("SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = 'usage'").get()?.n;
  if (!present) db.exec('ANALYZE');
}

/**
 * @param {Store} store
 * @param {any} err
 */
function fail(store, err) {
  store.disabled = true;
  store.reason = err instanceof SchemaTooNewError ? 'schema-newer' : (err?.code || err?.errstr || 'open-failed');
  note(store, 'open', err);
  return store;
}

// A version this build cannot write is a decision, not damage, so it must never
// take the recreate path that throws the history away.
/** @param {any} err */
function isCorruption(err) {
  if (err instanceof SchemaTooNewError) return false;
  if (err?.errcode === 11 || err?.errcode === 26) return true;
  return /malformed|not a database|corrupt|encrypted/i.test(err?.message || '');
}

/**
 * @param {string} path
 * @param {number} stamp
 */
function moveAside(path, stamp) {
  const target = `${path}.corrupt-${stamp}`;
  renameSync(path, target);
  for (const suffix of SIDECARS) {
    if (existsSync(path + suffix)) {
      try { renameSync(path + suffix, target + suffix); } catch { /* the main file is what matters */ }
    }
  }
  return target;
}

/** @param {Store} store */
function loadDims(store) {
  guard(store, 'load-dims', () => {
    for (const row of store.db?.prepare('SELECT id, kind, label FROM dim').all() || []) {
      const dim = store.dims.get(/** @type {string} */ (row.kind));
      if (!dim) continue;
      dim.byLabel.set(/** @type {string} */ (row.label), /** @type {number} */ (row.id));
      dim.byId.set(/** @type {number} */ (row.id), /** @type {string} */ (row.label));
    }
  });
}

/**
 * @param {Store} store
 * @param {string} label
 * @param {any} err
 */
function note(store, label, err) {
  store.errors.set(label, (store.errors.get(label) || 0) + 1);
  store.lastError = { label, message: err?.message || String(err), at: store.now() };
  try { store.onError?.(label, err); } catch { /* a reporting hook must not take the caller down */ }
}

/**
 * Run a database call so that no failure of it can reach the proxy path. A
 * disabled store skips straight to the fallback, so callers need no branch of
 * their own.
 * @template T
 * @template [F=null]
 * @param {Store} store
 * @param {string} label
 * @param {() => T} fn
 * @param {F} [fallback]
 * @returns {T|F}
 */
export function guard(store, label, fn, fallback = /** @type {F} */ (null)) {
  if (store.disabled) return fallback;
  try {
    return fn();
  } catch (err) {
    note(store, label, err);
    return fallback;
  }
}

/** @param {Store} store */
export function checkpoint(store) {
  return guard(store, 'checkpoint', () => {
    store.db?.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return true;
  }, false);
}

/**
 * Drop rows past retention. Raw rows go at 90 days and rollup rows at 400, so
 * the rollup — the thing actually served for 7d and 30d — can be rebuilt from
 * nothing but itself after a bug in the aggregation.
 * @param {Store} store
 * @param {number} [at]
 */
export function prune(store, at = store.now()) {
  return guard(store, 'prune', () => {
    const raw = store.stmts.pruneUsage.run(at - RAW_RETENTION_MS);
    const rollup = store.stmts.pruneHourly.run(Math.floor((at - ROLLUP_RETENTION_MS) / 3_600_000));
    store.lastPruneAt = at;
    return { usage: Number(raw.changes), usageHourly: Number(rollup.changes) };
  }, null);
}

/**
 * @param {Store} store
 * @param {number} [at]
 */
export function tick(store, at = store.now()) {
  checkpoint(store);
  if (at - store.lastPruneAt < PRUNE_INTERVAL_MS) return;
  prune(store, at);
  // Costs nothing while the statistics still describe the tables, and re-runs
  // the bounded ANALYZE when they stop doing so — which is what stops the plans
  // decaying as the database fills.
  guard(store, 'optimize', () => store.db?.exec('PRAGMA optimize'));
}

/**
 * Start the background tick. One timer carries both duties: the checkpoint that
 * bounds host-crash exposure to a minute, and the retention sweep, which is
 * driven off elapsed time rather than its own interval so a box rebooted daily
 * still prunes.
 * @param {Store} store
 * @param {number} [intervalMs]
 */
export function startTicks(store, intervalMs = TICK_MS) {
  if (store.disabled || store.timer) return store.timer;
  store.timer = setInterval(() => tick(store), intervalMs);
  store.timer.unref?.();
  return store.timer;
}

/** @param {Store} store */
export function closeUsageStore(store) {
  if (store.timer) { clearInterval(store.timer); store.timer = null; }
  guard(store, 'close', () => {
    store.db?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.db?.close();
  });
  store.disabled = true;
  store.stmts = {};
  store.memo.clear();
}

/** @param {Store} store */
export function usageStats(store) {
  return {
    enabled: !store.disabled,
    reason: store.reason,
    setAside: store.setAside,
    errors: Object.fromEntries(store.errors),
    lastError: store.lastError,
  };
}
