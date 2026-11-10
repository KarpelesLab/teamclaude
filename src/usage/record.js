import { guard } from './db.js';

export const MAX_LABEL_LENGTH = 128;
export const UNKNOWN_LABEL = '(unknown)';
export const OVERFLOW_LABEL = '(other)';

// The model label is read from the client's own request body, so an unbounded
// dimension is a client-controlled table and a client-controlled in-memory Map.
// Past the cap everything new folds into one row.
export const MAX_DIMS = { caller: 64, model: 256, account: 64 };

/** @param {unknown} value */
export function normalizeLabel(value) {
  if (value == null) return UNKNOWN_LABEL;
  const text = String(value).trim().slice(0, MAX_LABEL_LENGTH);
  return text || UNKNOWN_LABEL;
}

/** @param {unknown} value */
function whole(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Resolve a dimension label to its integer id, interning it on first sight. The
 * Map is loaded whole at open and every label is one of a handful, so the write
 * path reaches SQLite for a label only when a genuinely new one appears.
 * @param {import('./db.js').Store} store
 * @param {'caller'|'model'|'account'} kind
 * @param {unknown} value
 */
export function dimId(store, kind, value) {
  const dim = store.dims.get(kind);
  const label = normalizeLabel(value);
  const known = dim?.byLabel.get(label);
  if (known !== undefined) return known;

  // the last slot is reserved for OVERFLOW_LABEL, so the dimension holds
  // MAX_DIMS rows and never one more.
  const key = (dim?.byLabel.size ?? 0) < MAX_DIMS[kind] - 1 ? label : OVERFLOW_LABEL;
  const folded = dim?.byLabel.get(key);
  if (folded !== undefined) return folded;

  store.stmts.insertDim.run(kind, key);
  const id = Number(store.stmts.selectDim.get(kind, key)?.id);
  dim?.byLabel.set(key, id);
  dim?.byId.set(id, key);
  return id;
}

/**
 * @typedef {Object} UsageEntry
 * @property {number} [ts]
 * @property {unknown} [caller]
 * @property {unknown} [model]
 * @property {unknown} [account]
 * @property {unknown} [input]
 * @property {unknown} [cacheRead]
 * @property {unknown} [cacheWrite]
 * @property {unknown} [output]
 * @property {number|null} [status]  absent or null is booked as 0: no answer was sent, which is not a success
 */

/**
 * Record one request. Called once, when the stream closes, with the input and
 * cache counts from message_start and the output count from message_delta
 * already summed — so a row is a request, COUNT(*) is a request count, and a
 * refusal is an ordinary row with status 429 and no tokens.
 * @param {import('./db.js').Store} store
 * @param {UsageEntry} [entry]
 */
export function recordRequest(store, entry = {}) {
  return guard(store, 'record', () => {
    const ts = Number.isFinite(entry.ts) ? Math.trunc(/** @type {number} */ (entry.ts)) : store.now();
    const input = whole(entry.input);
    const cacheRead = whole(entry.cacheRead);
    const cacheWrite = whole(entry.cacheWrite);
    const output = whole(entry.output);
    const tokens = input + cacheRead + cacheWrite + output;
    const status = Number.isFinite(entry.status) ? Math.trunc(/** @type {number} */ (entry.status)) : 0;
    const refusal = status === 429 ? 1 : 0;

    const callerId = dimId(store, 'caller', entry.caller);
    const modelId = dimId(store, 'model', entry.model);
    const accountId = dimId(store, 'account', entry.account);
    const hour = Math.floor(ts / 3_600_000);

    store.db?.exec('BEGIN IMMEDIATE');
    try {
      store.stmts.insertUsage.run(ts, callerId, modelId, accountId, tokens, input, cacheRead, cacheWrite, output, status);
      store.stmts.upsertHourly.run(callerId, modelId, accountId, hour, tokens, input, cacheRead, cacheWrite, output, refusal);
      store.db?.exec('COMMIT');
    } catch (err) {
      try { store.db?.exec('ROLLBACK'); } catch { /* the failure already ended the transaction */ }
      throw err;
    }
    return true;
  }, false);
}
