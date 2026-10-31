import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaSeries, loadQuotaSeries, saveQuotaSeries, SAMPLE_INTERVAL_MS, SERIES_MAX_AGE_MS, SERIES_MAX_SAMPLES } from '../src/quota-series.js';
import { AccountManager } from '../src/account-manager.js';

// The stored quota series behind the fleet forecast (#550): its own file, a
// sample per account per interval, pruned by age, by a hard cap, and to the
// accounts that still exist. Every clock is injected.

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;
const reading = { weekly: 0.5, weeklyResetAt: NOW + 50 * HOUR, fiveHour: 0.2, fiveHourResetAt: NOW + 2 * HOUR };

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'tc-quota-series-'));
}

// ── QuotaSeries ───────────────────────────────────────────────────────────

test('one sample per account per interval', () => {
  const s = new QuotaSeries();
  assert.equal(s.record('account-a', reading, NOW), true);
  assert.equal(s.record('account-a', reading, NOW + SAMPLE_INTERVAL_MS - 1), false);
  assert.equal(s.record('account-b', reading, NOW + 1), true, 'the interval is per account');
  assert.equal(s.record('account-a', reading, NOW + SAMPLE_INTERVAL_MS), true);
  assert.equal(s.samples('account-a').length, 2);
  assert.deepEqual(s.samples('account-a')[0], { t: NOW, ...reading });
});

test('a missing reading is stored as null, never as a number', () => {
  const s = new QuotaSeries();
  s.record('account-a', { weekly: 0.4, weeklyResetAt: undefined, fiveHour: NaN }, NOW);
  assert.deepEqual(s.samples('account-a')[0], { t: NOW, weekly: 0.4, weeklyResetAt: null, fiveHour: null, fiveHourResetAt: null });
});

test('prune drops samples older than 7 days', () => {
  const s = new QuotaSeries();
  s.record('account-a', reading, NOW - SERIES_MAX_AGE_MS - SAMPLE_INTERVAL_MS);
  s.record('account-a', reading, NOW - SERIES_MAX_AGE_MS);
  s.record('account-a', reading, NOW);
  assert.equal(s.prune(['account-a'], NOW), true);
  assert.deepEqual(s.samples('account-a').map(x => x.t), [NOW - SERIES_MAX_AGE_MS, NOW]);
  assert.equal(s.prune(['account-a'], NOW), false, 'nothing left to drop');
});

test('prune drops the history of an account that is gone', () => {
  const s = new QuotaSeries();
  s.record('account-a', reading, NOW);
  s.record('account-b', reading, NOW);
  s.prune(['account-b'], NOW);
  assert.deepEqual(Object.keys(s.all()), ['account-b']);
});

test('a clock that went back: future samples are pruned and do not block sampling', () => {
  const s = new QuotaSeries();
  s.record('account-a', reading, NOW + 10 * HOUR);
  assert.equal(s.record('account-a', reading, NOW), true, 'a last sample in the future does not hold the interval');
  s.prune(['account-a'], NOW);
  assert.deepEqual(s.samples('account-a').map(x => x.t), [NOW]);
});

test('the per-account cap holds whatever the timestamps say', () => {
  // More rows than the cap, all inside the age window: as a file written by a
  // clock that ran fast, or edited by hand, would have them.
  const rows = [];
  for (let i = 0; i < SERIES_MAX_SAMPLES + 300; i++) rows.push([NOW - i * MIN, 0.1, null, null, null]);
  const s = QuotaSeries.fromJSON({ version: 1, accounts: { 'account-a': rows } });
  assert.equal(s.samples('account-a').length, SERIES_MAX_SAMPLES);
  assert.equal(s.samples('account-a').at(-1).t, NOW, 'the newest are kept');
  // And recording past the cap keeps it there.
  s.record('account-a', reading, NOW + SAMPLE_INTERVAL_MS);
  assert.equal(s.samples('account-a').length, SERIES_MAX_SAMPLES);
  assert.equal(s.samples('account-a').at(-1).t, NOW + SAMPLE_INTERVAL_MS);
});

test('a round trip through toJSON keeps every sample', () => {
  const s = new QuotaSeries();
  s.record('account-a', reading, NOW);
  s.record('account-a', { weekly: 0.6 }, NOW + SAMPLE_INTERVAL_MS);
  const copy = QuotaSeries.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.all(), s.all());
});

test('anything not shaped like a series reads as empty history; a bad row is skipped', () => {
  for (const bad of [null, 'x', 42, [], {}, { version: 2, accounts: { 'account-a': [[NOW, 0.1, null, null, null]] } }, { version: 1, accounts: 'x' }]) {
    assert.deepEqual({ ...QuotaSeries.fromJSON(bad).all() }, {}, JSON.stringify(bad));
  }
  const s = QuotaSeries.fromJSON({ version: 1, accounts: { 'account-a': [[NOW, 0.1, null, null, null], ['x'], [null, 0.2, 1, 2, 3], 'row', [NOW + 1, 'x', null, null, null]] } });
  assert.deepEqual(s.samples('account-a'), [
    { t: NOW, weekly: 0.1, weeklyResetAt: null, fiveHour: null, fiveHourResetAt: null },
    { t: NOW + 1, weekly: null, weeklyResetAt: null, fiveHour: null, fiveHourResetAt: null },
  ]);
});

test('every change bumps the revision, and only a change', () => {
  const s = new QuotaSeries();
  const r0 = s.revision;
  s.record('account-a', reading, NOW);
  assert.ok(s.revision > r0);
  const r1 = s.revision;
  s.record('account-a', reading, NOW + 1);
  s.prune(['account-a'], NOW + 1);
  assert.equal(s.revision, r1);
});

// ── the file ──────────────────────────────────────────────────────────────

test('a missing file and a corrupt one are both empty history', async () => {
  const dir = tempDir();
  try {
    assert.deepEqual({ ...(await loadQuotaSeries(join(dir, 'absent.json'))).all() }, {});
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{"version":1,"accounts":{"account-a":[[1,');
    assert.deepEqual({ ...(await loadQuotaSeries(corrupt)).all() }, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved atomically and compact, and loaded back', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'teamclaude.quota-series.json');
    const s = new QuotaSeries();
    s.record('account-a', reading, NOW);
    await saveQuotaSeries(path, s);
    assert.deepEqual(readdirSync(dir), ['teamclaude.quota-series.json'], 'no temp file left behind');
    const text = readFileSync(path, 'utf-8');
    assert.equal(text.trim().split('\n').length, 1, 'one line, not one number per line');
    assert.deepEqual((await loadQuotaSeries(path)).all(), s.all());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sampling from the account manager ────────────────────────────────────

test('only accounts the proxy reads get samples', () => {
  const now = Date.now();
  const m = new AccountManager([
    oauth('account-a', { id: 'id-a' }),
    oauth('account-b', { id: 'id-b' }),
    oauth('account-c', { id: 'id-c', disabled: true }),
    { name: 'account-d', type: 'apikey', apiKey: 'sk-test', id: 'id-d' },
    oauth('account-e', { id: 'id-e', provider: 'codex' }),
  ]);
  for (const a of m.accounts) {
    if (a.name === 'account-b') continue; // never read
    Object.assign(a.quota, { unified7d: 0.4, unified7dReset: now + 50 * HOUR, unified7dSeenAt: now, unified5h: 0.1, unified5hReset: now + 2 * HOUR, unified5hSeenAt: now });
  }
  assert.equal(m.sampleQuotaSeries(now), true);
  assert.deepEqual(Object.keys(m.quotaSeries.all()), ['id-a']);
  assert.deepEqual(m.quotaSeries.samples('id-a')[0], { t: now, weekly: 0.4, weeklyResetAt: now + 50 * HOUR, fiveHour: 0.1, fiveHourResetAt: now + 2 * HOUR });
  assert.equal(m.sampleQuotaSeries(now + MIN), false, 'nothing new inside the interval, so nothing to write');
});

test('a removed account loses its history at the next sample', () => {
  const now = Date.now();
  const m = new AccountManager([oauth('account-a', { id: 'id-a' }), oauth('account-b', { id: 'id-b' })]);
  for (const a of m.accounts) Object.assign(a.quota, { unified7d: 0.4, unified7dReset: now + 50 * HOUR, unified7dSeenAt: now });
  m.sampleQuotaSeries(now);
  assert.deepEqual(Object.keys(m.quotaSeries.all()).sort(), ['id-a', 'id-b']);
  m.removeAccount(0);
  assert.equal(m.sampleQuotaSeries(now + MIN), true, 'the prune is a change worth writing');
  assert.deepEqual(Object.keys(m.quotaSeries.all()), ['id-b']);
});

test('status carries fleetForecast: null on an empty series, the forecast once there is history', () => {
  const now = Date.now();
  const m = new AccountManager([oauth('account-a', { id: 'id-a' })]);
  assert.equal(m.getStatus().fleetForecast, null);
  // Swapped in as the server does with the file it loaded: the cached null
  // from the empty series must not stand in for it.
  // 72 hours at a flat 1% an hour, now at 50% with the reset 4 days out.
  const rows = [];
  for (let t = now - 72 * HOUR, u = 0.5 - 0.72; t <= now; t += SAMPLE_INTERVAL_MS, u += 0.0025) rows.push([t, u, now + 96 * HOUR, null, null]);
  m.quotaSeries = QuotaSeries.fromJSON({ version: 1, accounts: { 'id-a': rows } });
  Object.assign(m.accounts[0].quota, { unified7d: 0.5, unified7dReset: now + 96 * HOUR, unified7dSeenAt: now });
  const f = m.fleetForecastStatus(now);
  assert.ok(f);
  assert.ok(Math.abs(f.allOutAt - (now + 48 * HOUR)) <= 10 * MIN, new Date(f.allOutAt).toISOString());
  assert.equal(f.firstBackAt, now + 96 * HOUR);
  assert.equal(f.boundBy, 'weekly');
  // The switch threshold is the account's own. A minute later, past the cache.
  m.accounts[0].switchThreshold = 0.8;
  const lower = m.fleetForecastStatus(now + MIN);
  assert.ok(lower && lower.allOutAt < f.allOutAt);
});

test('an account id of __proto__ is stored, saved and read back like any other', () => {
  const s = new QuotaSeries();
  s.record('__proto__', reading, NOW);
  const all = s.all();
  assert.ok(Object.hasOwn(all, '__proto__'));
  assert.equal(all['__proto__'].length, 1);
  const copy = QuotaSeries.fromJSON(JSON.parse(JSON.stringify(s)));
  assert.equal(copy.samples('__proto__').length, 1);
  assert.ok(Object.hasOwn(copy.all(), '__proto__'));
});

test('the forecast covers an account whose id is __proto__', () => {
  const now = Date.now();
  const m = new AccountManager([oauth('account-a', { id: '__proto__', switchThreshold: 0.8 })]);
  const rows = [];
  for (let t = now - 72 * HOUR, u = 0.5 - 0.72; t <= now; t += SAMPLE_INTERVAL_MS, u += 0.0025) rows.push([t, u, now + 96 * HOUR, null, null]);
  m.quotaSeries = QuotaSeries.fromJSON(JSON.parse(`{"version":1,"accounts":{"__proto__":${JSON.stringify(rows)}}}`));
  Object.assign(m.accounts[0].quota, { unified7d: 0.5, unified7dReset: now + 96 * HOUR, unified7dSeenAt: now });
  const f = m.fleetForecastStatus(now);
  assert.ok(f, 'the account is in the forecast');
  // Its own 80% threshold: 30 hours at 1% an hour.
  assert.ok(Math.abs(f.allOutAt - (now + 30 * HOUR)) <= 10 * MIN, new Date(f.allOutAt).toISOString());
});
