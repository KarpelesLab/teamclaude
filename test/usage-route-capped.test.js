import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeUsageStore, openUsageStore, usageStoreAvailable } from '../src/usage/db.js';
import { recordRequest } from '../src/usage/record.js';
import { usageSummary } from '../src/usage/query.js';

const USAGE_STORE_AVAILABLE = usageStoreAvailable();
const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);
const HOUR = 3_600_000;

const dirs = [];
const stores = [];

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'teamclaude-capped-'));
  dirs.push(dir);
  const store = openUsageStore({ path: join(dir, 'usage.db'), now: () => T0 });
  stores.push(store);
  return store;
}

after(() => {
  for (const store of stores) closeUsageStore(store);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @param {any[]} rows @param {string} field @param {string} name */
function find(rows, field, name) {
  return rows.find(r => r[field] === name);
}

test('the 5h window sums capped from raw rows', () => {
  const store = openStore();
  recordRequest(store, { ts: T0 - HOUR, caller: 'nightly-agent', model: 'm', account: 'a', status: 403, capped: true });
  recordRequest(store, { ts: T0 - HOUR + 1, caller: 'nightly-agent', model: 'm', account: 'a', status: 403, capped: true });
  recordRequest(store, { ts: T0 - HOUR + 2, caller: 'nightly-agent', model: 'm', account: 'a', input: 5, costMicro: 10 });

  const summary = usageSummary(store, '5h', T0);

  assert.equal(summary.source, 'raw');
  assert.equal(summary.totals.capped, 2);
  assert.equal(find(summary.callers, 'caller', 'nightly-agent').capped, 2);
  assert.equal(find(summary.callerModels, 'caller', 'nightly-agent').capped, 2);
  assert.equal(find(summary.models, 'model', 'm').capped, 2);
});

test('the 7d window sums capped from the rollup', () => {
  const store = openStore();
  recordRequest(store, { ts: T0 - 48 * HOUR, caller: 'nightly-agent', model: 'm', account: 'a', status: 403, capped: true });
  recordRequest(store, { ts: T0 - 24 * HOUR, caller: 'nightly-agent', model: 'm', account: 'a', status: 403, capped: true });

  const summary = usageSummary(store, '7d', T0);

  assert.equal(summary.source, 'hourly');
  assert.equal(summary.totals.capped, 2);
  assert.equal(find(summary.callers, 'caller', 'nightly-agent').capped, 2);
});

test('capped is distinct from refusals', () => {
  const store = openStore();
  // the pool could not serve this one
  recordRequest(store, { ts: T0 - HOUR, caller: 'nightly-agent', model: 'm', account: 'a', status: 429 });
  // this one was over its weekly figure
  recordRequest(store, { ts: T0 - HOUR + 1, caller: 'nightly-agent', model: 'm', account: 'a', status: 403, capped: true });
  // and this upstream 403 is neither
  recordRequest(store, { ts: T0 - HOUR + 2, caller: 'nightly-agent', model: 'm', account: 'a', status: 403 });

  const row = find(usageSummary(store, '5h', T0).callers, 'caller', 'nightly-agent');

  assert.equal(row.refusals, 1);
  assert.equal(row.capped, 1);
  assert.equal(row.requests, 3);
});

test('a caller with no capped rows reports zero rather than undefined', () => {
  const store = openStore();
  recordRequest(store, { ts: T0 - HOUR, caller: 'vasilii', model: 'm', account: 'a', input: 5, costMicro: 10 });

  const summary = usageSummary(store, '5h', T0);

  assert.equal(find(summary.callers, 'caller', 'vasilii').capped, 0);
  assert.equal(summary.totals.capped, 0);
});

test('an unavailable window reports capped as a measure too', () => {
  const store = openStore();
  store.disabled = true;

  const summary = usageSummary(store, '5h', T0);

  assert.equal(summary.available, false);
  assert.equal(summary.totals.capped, 0);
});
