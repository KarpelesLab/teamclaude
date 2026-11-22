import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION, schemaVersion } from '../src/usage/schema.js';
import { closeUsageStore, openUsageStore, usageStoreAvailable } from '../src/usage/db.js';
import { recordRequest } from '../src/usage/record.js';

const USAGE_STORE_AVAILABLE = usageStoreAvailable();

// node:sqlite needs Node 22.5+; on an older Node these skip (the store opens disabled there).
const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;
const DatabaseSync = USAGE_STORE_AVAILABLE ? /** @type {any} */ (process).getBuiltinModule('node:sqlite').DatabaseSync : null;

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

// The schema exactly as version 1 shipped it. Copied rather than imported on
// purpose: MIGRATIONS is append-only, so a file in this shape is one somebody
// still has, and a fixture that tracked the current source could not prove the
// migration runs against it.
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

const dirs = [];
const stores = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'teamclaude-schema-v2-'));
  dirs.push(dir);
  return dir;
}

function openStore({ path, at = T0 } = {}) {
  const store = openUsageStore({ path: path ?? join(tempDir(), 'usage.db'), now: () => at });
  stores.push(store);
  return store;
}

/** A database file in the shape version 1 left behind, with `rows` usage rows. */
function writeV1File(path, { version = 1, rows = 0 } = {}) {
  const db = new DatabaseSync(path);
  db.exec(V1);
  db.exec("INSERT INTO dim (kind, label) VALUES ('caller', 'ci-agent'), ('model', 'claude-opus-5'), ('account', 'acct-a')");
  for (let i = 0; i < rows; i++) {
    db.prepare(`INSERT INTO usage (ts, caller_id, model_id, account_id, tokens, input, cache_read, cache_write, output, status)
      VALUES (?, 1, 2, 3, 30, 10, 0, 0, 20, 200)`).run(T0 + i);
    db.prepare(`INSERT INTO usage_hourly (caller_id, model_id, account_id, hour, req, tokens, input, cache_read, cache_write, output, refusals)
      VALUES (1, 2, 3, ?, 1, 30, 10, 0, 0, 20, 0)
      ON CONFLICT (caller_id, model_id, account_id, hour) DO UPDATE SET req = req + 1`).run(Math.floor((T0 + i) / 3_600_000));
  }
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
  return path;
}

function one(store, sql, ...args) {
  const row = store.db.prepare(sql).get(...args);
  return row ? { ...row } : null;
}

after(() => {
  for (const store of stores) closeUsageStore(store);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('a v1 file gains the columns and keeps its rows', () => {
  const path = writeV1File(join(tempDir(), 'usage.db'), { rows: 3 });

  const store = openStore({ path });

  assert.equal(store.disabled, false);
  assert.equal(schemaVersion(store.db), SCHEMA_VERSION);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM usage').n, 3);
  assert.deepEqual(one(store, 'SELECT cost_micro, capped FROM usage ORDER BY ts LIMIT 1'), { cost_micro: 0, capped: 0 });
  assert.deepEqual(one(store, 'SELECT capped FROM usage_hourly LIMIT 1'), { capped: 0 });
});

test('a v3 file is left alone and reported', () => {
  const path = writeV1File(join(tempDir(), 'usage.db'), { version: SCHEMA_VERSION + 1, rows: 1 });

  const store = openStore({ path });

  assert.equal(store.disabled, true);
  assert.equal(store.reason, 'schema-newer');
  assert.equal(store.setAside, null);

  const db = new DatabaseSync(path);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION + 1);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM usage').get().n), 1);
  db.close();
});

test('a recorded row carries its cost', () => {
  const store = openStore();

  recordRequest(store, { ts: T0, caller: 'ci-agent', model: 'claude-opus-5', account: 'acct-a', input: 10, output: 20, costMicro: 4321 });

  assert.deepEqual(one(store, 'SELECT cost_micro, capped FROM usage LIMIT 1'), { cost_micro: 4321, capped: 0 });
});

test('capped is stored only when it is passed', () => {
  const store = openStore();

  recordRequest(store, { ts: T0, caller: 'a', model: 'm', account: 'acct-a', status: 403 });
  recordRequest(store, { ts: T0 + 1, caller: 'b', model: 'm', account: 'acct-a', status: 403, capped: true });

  assert.equal(one(store, "SELECT capped FROM usage WHERE ts = ?", T0).capped, 0);
  assert.equal(one(store, "SELECT capped FROM usage WHERE ts = ?", T0 + 1).capped, 1);
  assert.equal(one(store, 'SELECT SUM(capped) AS n FROM usage_hourly').n, 1);
});

test('a cost that is not a positive finite number is booked as zero', () => {
  const store = openStore();

  for (const [i, costMicro] of [NaN, Infinity, -5, null, undefined, '12'].entries()) {
    recordRequest(store, { ts: T0 + i, caller: 'a', model: 'm', account: 'acct-a', input: 1, costMicro });
  }

  // '12' is a numeric string, which the existing `whole` helper truncates to 12.
  assert.deepEqual(
    store.db.prepare('SELECT cost_micro FROM usage ORDER BY ts').all().map(r => Number(r.cost_micro)),
    [0, 0, 0, 0, 0, 12],
  );
});
