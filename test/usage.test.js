import { test as nodeTest, describe as nodeDescribe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION, schemaVersion } from '../src/usage/schema.js';
import {
  closeUsageStore, guard, openUsageStore, prune, tick, usageStats,
  PRUNE_INTERVAL_MS, RAW_RETENTION_MS, ROLLUP_RETENTION_MS,
} from '../src/usage/db.js';
import { MAX_DIMS, MAX_LABEL_LENGTH, dimId, normalizeLabel, recordRequest } from '../src/usage/record.js';
import { HOURLY_SQL, MEMO_TTL_MS, RAW_SQL, usageSummary, windowBounds } from '../src/usage/query.js';
import { USAGE_STORE_AVAILABLE } from '../src/usage/db.js';

// node:sqlite needs Node 22.5+; on an older Node these skip (the store opens disabled there).
const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;
const describe = USAGE_STORE_AVAILABLE ? nodeDescribe : nodeDescribe.skip;
const DatabaseSync = USAGE_STORE_AVAILABLE ? /** @type {any} */ (process).getBuiltinModule('node:sqlite').DatabaseSync : null;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 19, 12, 0, 0);

const dirs = [];
const stores = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'teamclaude-usage-'));
  dirs.push(dir);
  return dir;
}

function openStore({ path = join(tempDir(), 'usage.db'), at = T0 } = {}) {
  const store = openUsageStore({ path, now: () => at });
  stores.push(store);
  return store;
}

after(() => {
  for (const store of stores) closeUsageStore(store);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// node:sqlite hands back null-prototype rows; the tests compare against plain
// object literals, so they are normalised on the way in.
function raw(store, sql, ...args) {
  return store.db.prepare(sql).all(...args).map(row => ({ ...row }));
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CALLERS = ['laptop', 'ci-runner', 'sandbox', 'build-box'];
const MODELS = ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
const ACCOUNTS = ['acct-a1b2c3d4', 'acct-e5f6a7b8'];

function seed(store, { count, from, to, rng = mulberry32(7) }) {
  for (let i = 0; i < count; i++) {
    const refused = rng() < 0.02;
    const ts = Math.floor(from + (to - from) * (i / count));
    recordRequest(store, {
      ts,
      caller: CALLERS[Math.floor(rng() * CALLERS.length)],
      model: MODELS[Math.floor(rng() * MODELS.length)],
      account: ACCOUNTS[Math.floor(rng() * ACCOUNTS.length)],
      input: refused ? 0 : Math.floor(rng() * 900),
      cacheRead: refused ? 0 : Math.floor(rng() * 260000),
      cacheWrite: refused ? 0 : Math.floor(rng() * 30000),
      output: refused ? 0 : Math.floor(rng() * 9000),
      status: refused ? 429 : 200,
    });
  }
}

describe('schema', () => {
  test('a fresh database is created at the current version, in WAL', () => {
    const store = openStore();
    assert.equal(store.disabled, false);
    assert.equal(schemaVersion(store.db), SCHEMA_VERSION);
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const tables = raw(store, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    assert.deepEqual(tables, ['dim', 'usage', 'usage_hourly']);
    const indexes = raw(store, "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map(r => r.name);
    assert.deepEqual(indexes, ['usage_group', 'usage_ts']);
  });

  test('reopening keeps the rows, the version and the interned labels', () => {
    const path = join(tempDir(), 'usage.db');
    const first = openStore({ path });
    recordRequest(first, { ts: T0, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 10, output: 5 });
    const dimRows = raw(first, 'SELECT id, kind, label FROM dim ORDER BY id');
    closeUsageStore(first);

    const second = openStore({ path });
    assert.equal(second.disabled, false);
    assert.equal(schemaVersion(second.db), SCHEMA_VERSION);
    assert.equal(raw(second, 'SELECT count(*) AS n FROM usage')[0].n, 1);
    assert.deepEqual(raw(second, 'SELECT id, kind, label FROM dim ORDER BY id'), dimRows);
    // the cache came back from the table rather than being rebuilt by inserting again
    assert.equal(dimId(second, 'caller', 'ci-runner'), dimRows.find(r => r.kind === 'caller').id);
    assert.equal(raw(second, 'SELECT count(*) AS n FROM dim')[0].n, dimRows.length);
  });

  test('a database written by a newer build is left alone and recording is disabled', () => {
    const path = join(tempDir(), 'usage.db');
    closeUsageStore(openStore({ path }));
    const bare = new DatabaseSync(path);
    bare.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    bare.close();

    const store = openStore({ path });
    assert.equal(store.disabled, true);
    assert.equal(store.reason, 'schema-newer');
    assert.equal(store.setAside, null);
    assert.ok(existsSync(path));
    assert.equal(new DatabaseSync(path).prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION + 1);
  });
});

describe('recording', () => {
  test('a request round-trips through both tables', () => {
    const store = openStore();
    const ts = T0 + 1234;
    assert.equal(recordRequest(store, {
      ts, caller: 'laptop', model: 'claude-opus-4-5-20251101', account: 'acct-a1b2c3d4',
      input: 700, cacheRead: 120_000, cacheWrite: 4_000, output: 900, status: 200,
    }), true);

    const rows = raw(store, `SELECT u.ts, u.tokens, u.input, u.cache_read, u.cache_write, u.output, u.status,
        c.label AS caller, m.label AS model, a.label AS account
      FROM usage u JOIN dim c ON c.id = u.caller_id JOIN dim m ON m.id = u.model_id JOIN dim a ON a.id = u.account_id`);
    assert.deepEqual(rows, [{
      ts, tokens: 125_600, input: 700, cache_read: 120_000, cache_write: 4_000, output: 900, status: 200,
      caller: 'laptop', model: 'claude-opus-4-5-20251101', account: 'acct-a1b2c3d4',
    }]);

    const hourly = raw(store, 'SELECT hour, req, tokens, input, cache_read, cache_write, output, refusals FROM usage_hourly');
    assert.deepEqual(hourly, [{
      hour: Math.floor(ts / HOUR), req: 1, tokens: 125_600,
      input: 700, cache_read: 120_000, cache_write: 4_000, output: 900, refusals: 0,
    }]);
    assert.deepEqual(raw(store, "SELECT kind, label FROM dim ORDER BY kind"), [
      { kind: 'account', label: 'acct-a1b2c3d4' },
      { kind: 'caller', label: 'laptop' },
      { kind: 'model', label: 'claude-opus-4-5-20251101' },
    ]);
  });

  test('a refusal is an ordinary row with no tokens', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', status: 429 });
    assert.deepEqual(raw(store, 'SELECT tokens, status FROM usage'), [{ tokens: 0, status: 429 }]);
    assert.deepEqual(raw(store, 'SELECT req, tokens, refusals FROM usage_hourly'), [{ req: 1, tokens: 0, refusals: 1 }]);
  });

  test('requests in one hour accumulate into one rollup row', () => {
    const store = openStore();
    for (let i = 0; i < 5; i++) {
      recordRequest(store, { ts: T0 + i * 1000, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 10, output: 1 });
    }
    assert.deepEqual(raw(store, 'SELECT req, tokens, input, output FROM usage_hourly'),
      [{ req: 5, tokens: 55, input: 50, output: 5 }]);
  });

  test('labels are normalised, and absent ones are recorded as unknown', () => {
    assert.equal(normalizeLabel(null), '(unknown)');
    assert.equal(normalizeLabel('   '), '(unknown)');
    assert.equal(normalizeLabel('  build-box  '), 'build-box');
    assert.equal(normalizeLabel('x'.repeat(500)).length, MAX_LABEL_LENGTH);

    const store = openStore();
    recordRequest(store, { ts: T0, input: 1 });
    assert.deepEqual(raw(store, 'SELECT DISTINCT label FROM dim'), [{ label: '(unknown)' }]);
  });

  test('a client inventing labels cannot grow the dimension without bound', () => {
    const store = openStore();
    for (let i = 0; i < MAX_DIMS.model + 40; i++) {
      recordRequest(store, { ts: T0, caller: 'build-box', model: `model-${i}`, account: 'acct-a', input: 1 });
    }
    assert.equal(raw(store, "SELECT count(*) AS n FROM dim WHERE kind = 'model'")[0].n, MAX_DIMS.model);
    assert.equal(raw(store, "SELECT count(*) AS n FROM dim WHERE kind = 'model' AND label = '(other)'")[0].n, 1);
    const models = usageSummary(store, '5h', T0 + 1).models.map(m => m.model);
    assert.ok(models.includes('(other)'));
  });

  test('interning a known label never reaches the database again', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 1 });

    const explode = () => { throw new Error('dim statement used'); };
    store.stmts.insertDim = { run: explode };
    store.stmts.selectDim = { get: explode };

    for (let i = 0; i < 5; i++) {
      assert.equal(recordRequest(store, { ts: T0 + i, caller: 'build-box', model: 'opus', account: 'acct-a', input: 1 }), true);
    }
    assert.equal(raw(store, 'SELECT count(*) AS n FROM usage')[0].n, 6);

    // the spy is live: an unseen label does reach it, and the failure is swallowed
    assert.equal(recordRequest(store, { ts: T0, caller: 'someone-new', model: 'opus', account: 'acct-a', input: 1 }), false);
    assert.equal(store.errors.get('record'), 1);
  });

  test('a write failure is swallowed rather than reaching the caller', () => {
    const store = openStore();
    store.stmts.insertUsage = { run: () => { throw new Error('disk I/O error'); } };
    assert.equal(recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 1 }), false);
    assert.equal(store.errors.get('record'), 1);
    // the transaction was rolled back, so the connection is still usable
    store.stmts.insertUsage = store.db.prepare(`INSERT INTO usage
      (ts, caller_id, model_id, account_id, tokens, input, cache_read, cache_write, output, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    assert.equal(recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 1 }), true);
    assert.equal(raw(store, 'SELECT count(*) AS n FROM usage')[0].n, 1);
  });
});

describe('aggregates', () => {
  test('the rollup agrees with a raw aggregate over the same span', () => {
    const store = openStore({ at: T0 });
    seed(store, { count: 4000, from: T0 - 20 * DAY, to: T0 });

    for (const window of ['7d', '30d']) {
      const summary = usageSummary(store, window, T0);
      assert.equal(summary.source, 'hourly');
      const { bound } = windowBounds(window, T0);
      const rows = raw(store, RAW_SQL, bound * HOUR);
      const totals = rows.reduce((acc, r) => ({
        requests: acc.requests + r.requests, tokens: acc.tokens + r.tokens,
        input: acc.input + r.input, cacheRead: acc.cacheRead + r.cache_read,
        cacheWrite: acc.cacheWrite + r.cache_write, output: acc.output + r.output,
        refusals: acc.refusals + r.refusals,
      }), { requests: 0, tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, refusals: 0 });
      assert.ok(totals.requests > 0, `${window} covered no rows`);
      assert.deepEqual(summary.totals, totals);

      const rawByCaller = new Map();
      for (const r of rows) {
        const label = store.dims.get('caller').byId.get(r.caller_id);
        rawByCaller.set(label, (rawByCaller.get(label) || 0) + r.tokens);
      }
      assert.deepEqual(
        new Map(summary.callers.map(c => [c.caller, c.tokens])),
        rawByCaller,
      );
    }
  });

  test('the 5h window is served from raw rows and cuts at the exact millisecond', () => {
    const store = openStore();
    recordRequest(store, { ts: T0 - 5 * HOUR, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 100 });
    recordRequest(store, { ts: T0 - 5 * HOUR - 1, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 7 });
    const summary = usageSummary(store, '5h', T0);
    assert.equal(summary.source, 'raw');
    assert.equal(summary.since, T0 - 5 * HOUR);
    assert.equal(summary.totals.requests, 1);
    assert.equal(summary.totals.tokens, 100);
  });

  test('an hour boundary splits the rollup without moving the total', () => {
    const store = openStore();
    const hourStart = Math.ceil(T0 / HOUR) * HOUR;
    recordRequest(store, { ts: hourStart - 1, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 11 });
    recordRequest(store, { ts: hourStart, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 22 });
    recordRequest(store, { ts: hourStart + 1, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 33 });

    assert.deepEqual(raw(store, 'SELECT hour, req, tokens FROM usage_hourly ORDER BY hour'), [
      { hour: hourStart / HOUR - 1, req: 1, tokens: 11 },
      { hour: hourStart / HOUR, req: 2, tokens: 55 },
    ]);

    const at = hourStart + 2;
    const summary = usageSummary(store, '7d', at);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.tokens, 66);
    // the reported span is exactly the buckets that were read
    assert.equal(summary.since % HOUR, 0);
    assert.equal(summary.since, (Math.floor(at / HOUR) - 167) * HOUR);
  });

  test('the summary carries the shape the page renders', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 100, cacheRead: 300, output: 100 });
    recordRequest(store, { ts: T0, caller: 'ci-runner', model: 'sonnet', account: 'acct-b', input: 400, cacheWrite: 100 });
    recordRequest(store, { ts: T0, caller: 'ci-runner', model: 'opus', account: 'acct-a', status: 429 });

    const summary = usageSummary(store, '5h', T0 + 1);
    assert.equal(summary.available, true);
    assert.equal(summary.until, T0 + 1);
    assert.deepEqual(summary.totals, {
      requests: 3, tokens: 1000, input: 500, cacheRead: 300, cacheWrite: 100, output: 100, refusals: 1,
    });
    // equal tokens, so the tie falls to the busier caller
    assert.deepEqual(summary.callers.map(c => [c.caller, c.tokens, c.requests, c.refusals, c.share]), [
      ['ci-runner', 500, 2, 1, 0.5],
      ['build-box', 500, 1, 0, 0.5],
    ]);
    assert.deepEqual(summary.models.map(m => [m.model, m.tokens, m.requests]), [['opus', 500, 2], ['sonnet', 500, 1]]);
    assert.deepEqual(summary.accounts.map(a => [a.account, a.tokens, a.requests]), [['acct-a', 500, 2], ['acct-b', 500, 1]]);
  });

  test('spend splits by caller and model together', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'opus', input: 100, output: 10 });
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'opus', input: 50, output: 5 });
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'haiku', input: 20, output: 2 });
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', input: 7, output: 1 });

    const { callerModels } = usageSummary(store, '5h', T0 + 1);
    assert.deepEqual(
      callerModels.map((r) => [r.caller, r.model, r.requests, r.tokens]),
      [['laptop', 'opus', 2, 165], ['laptop', 'haiku', 1, 22], ['build-box', 'opus', 1, 8]],
    );
    closeUsageStore(store);
  });

  test('a caller-model pair sums to the same tokens as its caller row', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'opus', input: 100, output: 10 });
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'haiku', input: 20, output: 2 });

    const { callers, callerModels } = usageSummary(store, '5h', T0 + 1);
    const mine = callerModels.filter((r) => r.caller === 'laptop');
    assert.equal(mine.reduce((n, r) => n + r.tokens, 0), callers[0].tokens);
    closeUsageStore(store);
  });

  test('an unavailable window carries no caller-model rows', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'laptop', model: 'opus', input: 10 });
    usageSummary(store, '5h', T0);
    store.stmts.summaryRaw = { all: () => { throw new Error('database disk image is malformed'); } };

    const summary = usageSummary(store, '5h', T0 + MEMO_TTL_MS);
    assert.deepEqual(summary.callerModels, []);
    closeUsageStore(store);
  });

  test('the served plans reach the rows through an index, not a full scan', () => {
    const path = join(tempDir(), 'usage.db');
    const first = openStore({ path });
    seed(first, { count: 3000, from: T0 - 20 * DAY, to: T0 });
    closeUsageStore(first);

    // a real boot opens a database that already holds rows, which is when the
    // statistics both aggregates depend on get written
    const store = openStore({ path });
    assert.ok(raw(store, "SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = 'usage'")[0].n > 0);

    const explain = (sql, arg) => raw(store, `EXPLAIN QUERY PLAN ${sql}`, arg).map(r => r.detail);
    const rawPlan = explain(RAW_SQL, windowBounds('5h', T0).bound);
    const hourlyPlan = explain(HOURLY_SQL, windowBounds('30d', T0).bound);
    assert.match(rawPlan.join(' | '), /SEARCH usage USING INDEX usage_group/);
    assert.match(hourlyPlan.join(' | '), /SEARCH usage_hourly USING PRIMARY KEY/);
    for (const plan of [rawPlan, hourlyPlan]) {
      assert.ok(!plan.some(line => line.includes('TEMP B-TREE')), plan.join(' | '));
    }
  });

  test('an unrecognised window is refused rather than answered', () => {
    const store = openStore();
    assert.equal(usageSummary(store, '1h', T0), null);
    assert.equal(usageSummary(store, '', T0), null);
    assert.equal(usageSummary(store, '__proto__', T0), null);
    assert.equal(usageSummary(store, 'toString', T0), null);
    assert.equal(usageSummary(store, 'constructor', T0), null);
    assert.equal(usageSummary(store, 'hasOwnProperty', T0), null);
  });

  test('a window is memoised for ten seconds', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 10 });
    const first = usageSummary(store, '5h', T0);
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 90 });

    assert.equal(usageSummary(store, '5h', T0 + MEMO_TTL_MS - 1), first);
    assert.equal(usageSummary(store, '5h', T0 + MEMO_TTL_MS - 1).totals.tokens, 10);
    // a second window is memoised on its own key
    assert.equal(usageSummary(store, '7d', T0 + 1).totals.tokens, 100);
    assert.equal(usageSummary(store, '5h', T0 + MEMO_TTL_MS).totals.tokens, 100);
  });

  test('a failed read reports the window as unavailable instead of as idle', () => {
    const store = openStore();
    recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 10 });
    usageSummary(store, '5h', T0);
    store.stmts.summaryRaw = { all: () => { throw new Error('database disk image is malformed'); } };

    const summary = usageSummary(store, '5h', T0 + MEMO_TTL_MS);
    assert.equal(summary.available, false);
    assert.deepEqual(summary.callers, []);
    assert.equal(summary.totals.tokens, 0);
    assert.equal(store.errors.get('query'), 1);
    // the failure is memoised too, so a refresh loop cannot re-run it per request
    assert.equal(usageSummary(store, '5h', T0 + MEMO_TTL_MS + 1).available, false);
    assert.equal(store.errors.get('query'), 1);
  });
});

describe('retention', () => {
  test('a prune drops rows past retention and nothing else', () => {
    const store = openStore();
    const ages = [401 * DAY, 399 * DAY, 91 * DAY, 89 * DAY, HOUR];
    for (const age of ages) {
      recordRequest(store, { ts: T0 - age, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 1 });
    }

    const removed = prune(store, T0);
    assert.deepEqual(removed, { usage: 3, usageHourly: 1 });

    assert.deepEqual(raw(store, 'SELECT ts FROM usage ORDER BY ts').map(r => T0 - r.ts), [89 * DAY, HOUR]);
    assert.deepEqual(
      raw(store, 'SELECT hour FROM usage_hourly ORDER BY hour').map(r => r.hour),
      [399 * DAY, 91 * DAY, 89 * DAY, HOUR].map(age => Math.floor((T0 - age) / HOUR)),
    );
    assert.equal(RAW_RETENTION_MS, 90 * DAY);
    assert.equal(ROLLUP_RETENTION_MS, 400 * DAY);
  });

  test('the tick checkpoints every time and prunes once a day', () => {
    const store = openStore();
    recordRequest(store, { ts: T0 - 200 * DAY, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 1 });

    tick(store, T0);
    assert.equal(raw(store, 'SELECT count(*) AS n FROM usage')[0].n, 0);
    assert.equal(store.lastPruneAt, T0);

    recordRequest(store, { ts: T0 - 200 * DAY, caller: 'ci-runner', model: 'opus', account: 'acct-a', input: 1 });
    tick(store, T0 + PRUNE_INTERVAL_MS - 1);
    assert.equal(raw(store, 'SELECT count(*) AS n FROM usage')[0].n, 1);

    tick(store, T0 + PRUNE_INTERVAL_MS);
    assert.equal(raw(store, 'SELECT count(*) AS n FROM usage')[0].n, 0);
  });
});

describe('failure isolation', () => {
  test('a database that cannot be opened leaves a store every caller can use', () => {
    const dir = tempDir();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const store = openStore({ path: join(blocker, 'usage.db') });

    assert.equal(store.disabled, true);
    assert.ok(['EEXIST', 'ENOTDIR'].includes(store.reason), store.reason);
    assert.equal(recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 1 }), false);

    const summary = usageSummary(store, '30d', T0);
    assert.equal(summary.available, false);
    assert.deepEqual(summary.models, []);
    assert.equal(prune(store, T0), null);
    assert.equal(guard(store, 'anything', () => { throw new Error('never runs'); }, 'fallback'), 'fallback');
    tick(store, T0);
    closeUsageStore(store);
    assert.equal(usageStats(store).enabled, false);
  });

  test('a corrupt database is renamed aside and recreated', () => {
    const path = join(tempDir(), 'usage.db');
    const garbage = Buffer.alloc(8192, 0x5a);
    writeFileSync(path, garbage);
    writeFileSync(`${path}-wal`, 'stale wal');

    const store = openStore({ path });
    assert.equal(store.disabled, false);
    assert.equal(store.setAside, `${path}.corrupt-${T0}`);
    assert.deepEqual(readFileSync(store.setAside), garbage);
    // whatever became of the stale sidecar, the fresh database did not adopt it
    assert.notEqual(existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`, 'utf8') : null, 'stale wal');
    assert.equal(store.errors.size, 0);

    assert.equal(recordRequest(store, { ts: T0, caller: 'build-box', model: 'opus', account: 'acct-a', input: 42 }), true);
    assert.equal(usageSummary(store, '5h', T0 + 1).totals.tokens, 42);
    assert.equal(schemaVersion(store.db), SCHEMA_VERSION);
  });

  test('a truncated database is corruption too, not an open failure', () => {
    const path = join(tempDir(), 'usage.db');
    const store = openStore({ path });
    seed(store, { count: 200, from: T0 - DAY, to: T0 });
    closeUsageStore(store);

    const whole = readFileSync(path);
    writeFileSync(path, whole.subarray(0, 6000));

    const reopened = openStore({ path });
    assert.equal(reopened.disabled, false);
    assert.ok(reopened.setAside);
    assert.equal(raw(reopened, 'SELECT count(*) AS n FROM usage')[0].n, 0);
  });
});
