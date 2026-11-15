export const SCHEMA_VERSION = 1;

// Group keys precede ts in usage_group so the 5h aggregate reads one index
// range per group instead of building a temporary B-tree. usage_ts is what the
// retention delete ranges over, and the plan the aggregate falls back to on a
// database with no statistics.
const V1 = `
CREATE TABLE IF NOT EXISTS dim (
  id    INTEGER PRIMARY KEY,
  kind  TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (kind, label)
);

CREATE TABLE IF NOT EXISTS usage (
  ts          INTEGER NOT NULL,
  caller_id   INTEGER NOT NULL,
  model_id    INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  input       INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  status      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_group ON usage (caller_id, model_id, account_id, ts, tokens);
CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);

CREATE TABLE IF NOT EXISTS usage_hourly (
  caller_id   INTEGER NOT NULL,
  model_id    INTEGER NOT NULL,
  account_id  INTEGER NOT NULL,
  hour        INTEGER NOT NULL,
  req         INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  input       INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  refusals    INTEGER NOT NULL,
  PRIMARY KEY (caller_id, model_id, account_id, hour)
) WITHOUT ROWID;
`;

// Index i takes a database at user_version i to i+1. Append only: an entry that
// has ever shipped has already run against a file somebody still has.
/** @type {((db: import('node:sqlite').DatabaseSync) => void)[]} */
const MIGRATIONS = [
  (db) => db.exec(V1),
];

export class SchemaTooNewError extends Error {
  /** @param {number} found */
  constructor(found) {
    super(`usage schema version ${found} is newer than ${SCHEMA_VERSION}`);
    this.name = 'SchemaTooNewError';
    this.found = found;
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
}

/**
 * Bring an open database up to SCHEMA_VERSION, returning the version now on
 * disk. A file written by a newer build is left untouched and reported, because
 * writing rows in a shape this build cannot describe is worse than not
 * recording — a rollback to an older release is an ordinary event.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function applySchema(db) {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from);
  if (from === SCHEMA_VERSION) return from;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = from; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
    // user_version is part of the header and rolls back with the transaction,
    // so a half-applied migration cannot claim to be complete.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the failure already ended the transaction */ }
    throw err;
  }
  return SCHEMA_VERSION;
}
