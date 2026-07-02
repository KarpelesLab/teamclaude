import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions, installKind, fetchLatestVersion, checkForUpdate, runUpdate, PKG_NAME,
} from '../src/updater.js';

// ── compareVersions ─────────────────────────────────────────

test('compareVersions orders x.y.z numerically and ignores pre-release', () => {
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);   // numeric, not lexical
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.1.1', '1.1.1'), 0);
  assert.equal(compareVersions('1.1.1', '1.1.1-beta.2'), 0); // suffix ignored
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
});

// ── installKind ──────────────────────────────────────────────

test('installKind detects a git checkout by a .git dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-git-'));
  mkdirSync(join(dir, '.git'));
  try {
    assert.equal(installKind({ root: dir, globalRoot: () => '/usr/lib/node_modules' }), 'git');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installKind flags a global npm install and distinguishes a local one', () => {
  const gRoot = '/usr/lib/node_modules';
  const global = `${gRoot}/@karpeleslab/teamclaude`;
  const local = '/home/x/project/node_modules/@karpeleslab/teamclaude';
  assert.equal(installKind({ root: global, globalRoot: () => gRoot }), 'global');
  assert.equal(installKind({ root: local, globalRoot: () => gRoot }), 'local');
});

test('installKind is unknown outside node_modules (e.g. running from source path)', () => {
  assert.equal(installKind({ root: '/opt/teamclaude-src', globalRoot: () => null }), 'unknown');
});

// ── fetchLatestVersion ───────────────────────────────────────

test('fetchLatestVersion reads dist-tags.latest from the registry', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '1.2.3' } }) });
  assert.equal(await fetchLatestVersion({ fetchImpl }), '1.2.3');
});

test('fetchLatestVersion returns null on a non-ok response or a throw', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});

// ── checkForUpdate (throttle + compare) ──────────────────────

function tmpCache() {
  return join(mkdtempSync(join(tmpdir(), 'tc-upd-')), 'update-check.json');
}

test('checkForUpdate fetches when uncached and reports an available update', async () => {
  const cachePath = tmpCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ 'dist-tags': { latest: '2.0.0' } }) }; };
  const info = await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 1_000 });
  assert.deepEqual(info, { current: '1.0.0', latest: '2.0.0', updateAvailable: true });
  assert.equal(calls, 1);
});

test('checkForUpdate does NOT hit the network while the cache is fresh', async () => {
  const cachePath = tmpCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ 'dist-tags': { latest: '2.0.0' } }) }; };
  // First call populates the cache at t=1000.
  await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 1_000 });
  // Second call an hour later: cache still fresh → no fetch, still reports update.
  const info = await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 1_000 + 3_600_000 });
  assert.equal(calls, 1, 'no second network call within the interval');
  assert.equal(info.updateAvailable, true);
});

test('checkForUpdate refetches once the interval elapses, and force overrides', async () => {
  const cachePath = tmpCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ 'dist-tags': { latest: '1.0.0' } }) }; };
  await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 0 });
  await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 25 * 3600_000 }); // > 1 day later
  assert.equal(calls, 2, 'refetched after the interval');
  await checkForUpdate({ current: '1.0.0', cachePath, fetchImpl, now: 25 * 3600_000, force: true });
  assert.equal(calls, 3, 'force bypasses the throttle');
});

test('checkForUpdate reports no update when already on the latest', async () => {
  const cachePath = tmpCache();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '1.1.1' } }) });
  const info = await checkForUpdate({ current: '1.1.1', cachePath, fetchImpl, now: 1 });
  assert.equal(info.updateAvailable, false);
});

// ── runUpdate ────────────────────────────────────────────────

test('runUpdate invokes the global npm install for the requested version', () => {
  const calls = [];
  const spawnImpl = (cmd, argv) => { calls.push([cmd, argv]); return { status: 0 }; };
  const ok = runUpdate('2.3.4', { spawnImpl });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], ['npm', ['install', '-g', `${PKG_NAME}@2.3.4`]]);
});

test('runUpdate returns false when npm fails', () => {
  assert.equal(runUpdate('2.3.4', { spawnImpl: () => ({ status: 1 }) }), false);
  assert.equal(runUpdate('2.3.4', { spawnImpl: () => ({ error: new Error('ENOENT') }) }), false);
});
