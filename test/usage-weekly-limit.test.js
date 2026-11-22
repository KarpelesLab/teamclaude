import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WeeklyLimiter, clientLimitStatus, limitRefusal, weekIndex, weekStart, weeklyLimitFor } from '../src/usage/limits.js';
import { closeUsageStore, openUsageStore, usageStoreAvailable } from '../src/usage/db.js';
import { recordRequest } from '../src/usage/record.js';

const MONDAY = Date.UTC(2026, 10, 16);   // Monday 16 November 2026, 00:00 UTC
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const proxy = (/** @type {any[]} */ ...clientKeys) => ({ clientKeys });

test('a week runs from Monday 00:00 UTC', () => {
  assert.equal(weekStart(weekIndex(MONDAY)), MONDAY);
  assert.equal(weekIndex(MONDAY - 1), weekIndex(MONDAY) - 1);
  assert.equal(weekIndex(MONDAY + WEEK - 1), weekIndex(MONDAY));
});

test('weeklyUsd is a number of at least a cent, absent for no limit', () => {
  assert.equal(weeklyLimitFor({ name: 'a' }), null);
  assert.equal(weeklyLimitFor({ weeklyUsd: 200 }), 200_000_000);
  assert.equal(weeklyLimitFor({ weeklyUsd: 0.01 }), 10_000);
  assert.equal(weeklyLimitFor({ weeklyUsd: 9e9 }), 9e15);
  for (const bad of [0, -1, 0.004, 0.0099999, 1e308, '200', null, NaN, Infinity, {}, { toString: 'bad' }, [5]]) {
    assert.equal(weeklyLimitFor({ weeklyUsd: bad }), 'invalid', JSON.stringify(bad));
  }
});

test('spend is per client and per week', () => {
  const limiter = new WeeklyLimiter();
  limiter.book('agent', 1000, MONDAY);
  limiter.book('agent', 2500, MONDAY + HOUR);
  limiter.book('laptop', 7, MONDAY);
  limiter.book('agent', 9, MONDAY + WEEK);
  limiter.book('', 5, MONDAY);
  limiter.book('agent', -5, MONDAY);
  assert.equal(limiter.spent('agent', MONDAY + 2 * HOUR), 3500);
  assert.equal(limiter.spent('laptop', MONDAY), 7);
  assert.equal(limiter.spent('agent', MONDAY + WEEK), 9);
});

test('a clock stepping back a week keeps the week it left; a third week drops the oldest', () => {
  const limiter = new WeeklyLimiter();
  limiter.book('agent', 100, MONDAY);
  limiter.book('agent', 1, MONDAY + WEEK);
  limiter.book('agent', 50, MONDAY);
  assert.equal(limiter.spent('agent', MONDAY), 150);
  limiter.book('agent', 1, MONDAY + 2 * WEEK);
  assert.equal(limiter.spent('agent', MONDAY), 0);
  assert.equal(limiter.spent('agent', MONDAY + WEEK), 1);
});

test('a key at its limit is refused with the figure, the spend and the reset', () => {
  const limiter = new WeeklyLimiter();
  const config = proxy({ name: 'agent', weeklyUsd: 1 }, { name: 'laptop' });
  limiter.book('agent', 999_999, MONDAY);
  assert.equal(limitRefusal(limiter, config, 'agent', MONDAY), null);
  limiter.book('agent', 1, MONDAY);
  assert.equal(limitRefusal(limiter, config, 'agent', MONDAY),
    'weekly spending limit of $1.00 reached (spent $1.00); it resets at 2026-11-23T00:00:00.000Z');
  assert.equal(limitRefusal(limiter, config, 'agent', MONDAY + WEEK), null, 'the next week starts at zero');
  limiter.book('laptop', 10 ** 12, MONDAY);
  assert.equal(limitRefusal(limiter, config, 'laptop', MONDAY), null, 'no weeklyUsd, no limit');
  assert.equal(limitRefusal(limiter, config, null, MONDAY), null, 'a request without a named key is never limited');
});

test('a key name is matched trimmed, as the key gate names it', () => {
  const limiter = new WeeklyLimiter();
  limiter.book('agent', 10_000, MONDAY);
  assert.match(limitRefusal(limiter, proxy({ name: ' agent ', weeklyUsd: 0.01 }), 'agent', MONDAY) ?? '', /reached/);
});

test('a key whose weeklyUsd cannot be read is refused', () => {
  assert.match(limitRefusal(new WeeklyLimiter(), proxy({ name: 'agent', weeklyUsd: '50' }), 'agent', MONDAY) ?? '', /not a number/);
});

test('status lists each key with a limit and what it has spent', () => {
  const limiter = new WeeklyLimiter();
  limiter.book('agent', 30_004_999, MONDAY);
  limiter.book('loop', 9_000_000, MONDAY);
  const config = proxy({ name: 'agent', weeklyUsd: 200 }, { name: 'loop', weeklyUsd: 5 }, { name: 'laptop' }, { name: 'bad', weeklyUsd: 0 });
  assert.deepEqual(clientLimitStatus(limiter, config, MONDAY + HOUR), [
    { name: 'agent', weeklyUsd: 200, spentUsd: 30, remainingUsd: 170, resetsAt: '2026-11-23T00:00:00.000Z' },
    { name: 'loop', weeklyUsd: 5, spentUsd: 9, remainingUsd: 0, resetsAt: '2026-11-23T00:00:00.000Z' },
    { name: 'bad', invalid: true },
  ]);
});

test('seeding reads the current week back from usage history, and only that week', { skip: !usageStoreAvailable() }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'teamclaude-limit-seed-'));
  const store = openUsageStore({ path: join(dir, 'usage.db'), now: () => MONDAY + 3 * HOUR });
  t.after(() => { closeUsageStore(store); rmSync(dir, { recursive: true, force: true }); });
  const row = (/** @type {number} */ ts, /** @type {string} */ caller, /** @type {number} */ costMicro) =>
    recordRequest(store, { ts, caller, model: 'm', account: 'a', input: 1, costMicro });
  row(MONDAY - 1, 'agent', 1000);
  row(MONDAY, 'agent', 20);
  row(MONDAY + 2 * HOUR, 'agent', 3);
  row(MONDAY + WEEK, 'agent', 4000);
  row(MONDAY + HOUR, 'laptop', 7);

  const limiter = new WeeklyLimiter();
  limiter.seed(store);
  limiter.book('agent', 1, MONDAY + 3 * HOUR);
  assert.equal(limiter.spent('agent', MONDAY + 3 * HOUR), 24);
  assert.equal(limiter.spent('laptop', MONDAY), 7);
});
