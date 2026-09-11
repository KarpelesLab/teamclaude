import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions, installKind, fetchLatestVersion, checkForUpdate, runUpdate, autoUpdate, isReleaseVersion, PKG_NAME,
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

test('installKind detects a git checkout by a .git dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-git-'));
  mkdirSync(join(dir, '.git'));
  try {
    assert.equal(await installKind({ root: dir, globalRoot: () => '/usr/lib/node_modules' }), 'git');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installKind flags a global npm install and distinguishes a local one', async () => {
  const gRoot = '/usr/lib/node_modules';
  const global = `${gRoot}/@karpeleslab/teamclaude`;
  const local = '/home/x/project/node_modules/@karpeleslab/teamclaude';
  assert.equal(await installKind({ root: global, globalRoot: () => gRoot }), 'global');
  assert.equal(await installKind({ root: local, globalRoot: () => gRoot }), 'local');
  // `npm root -g` is asked asynchronously now, so a probe that answers later is
  // the shape the real one has.
  assert.equal(await installKind({ root: global, globalRoot: async () => gRoot }), 'global');
});

test('installKind is unknown outside node_modules (e.g. running from source path)', async () => {
  assert.equal(await installKind({ root: '/opt/teamclaude-src', globalRoot: () => null }), 'unknown');
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

// A fake `spawn`: a ChildProcess-shaped emitter that settles on the next tick
// with an exit code, or with an 'error' when `error` is given.
function fakeSpawn(calls, { code = 0, error = null } = {}) {
  return (cmd, argv, opts) => {
    calls.push([cmd, argv, opts]);
    const child = new EventEmitter();
    setImmediate(() => { if (error) child.emit('error', error); else child.emit('exit', code); });
    return child;
  };
}

test('runUpdate invokes the global npm install for the requested version', async () => {
  const calls = [];
  const ok = await runUpdate('2.3.4', { spawnImpl: fakeSpawn(calls) });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ['npm', ['install', '-g', `${PKG_NAME}@2.3.4`]]);
});

test('runUpdate resolves false when npm fails', async () => {
  assert.equal(await runUpdate('2.3.4', { spawnImpl: fakeSpawn([], { code: 1 }) }), false);
  assert.equal(await runUpdate('2.3.4', { spawnImpl: fakeSpawn([], { error: new Error('ENOENT') }) }), false);
  assert.equal(await runUpdate('2.3.4', { spawnImpl: () => { throw new Error('ENOENT'); } }), false);
});

// The install runs inside `server --headless`, the one process every client
// depends on. A synchronous spawn parked the event loop for the whole install
// (#353); the child must run beside it.
test('runUpdate does not block the event loop while npm runs', async () => {
  const calls = [];
  let child;
  const spawnImpl = (cmd, argv, opts) => { calls.push([cmd, argv, opts]); child = new EventEmitter(); return child; };
  const pending = runUpdate('2.3.4', { spawnImpl });
  // The install is "running": the loop must still turn.
  let ticks = 0;
  await new Promise(r => { const t = setInterval(() => { if (++ticks === 3) { clearInterval(t); r(); } }, 1); });
  assert.equal(ticks, 3, 'timers ran while the install was in flight');
  assert.equal(calls[0][2].stdio, 'inherit');
  assert.equal(calls[0][2].timeout, 180000, 'a hung npm is still bounded');
  child.emit('exit', 0);
  assert.equal(await pending, true);
});

// ── the registry's "latest" is a string from the network ─────

// compareVersions parses what it can, so "99.0.0 || npm:evil" reads as newer
// than anything installed and used to go straight into `npm install -g`.
test('isReleaseVersion accepts only x.y.z', () => {
  for (const v of ['1.2.3', '0.0.1', '10.20.30']) assert.equal(isReleaseVersion(v), true, v);
  for (const v of ['99.0.0 || npm:evil', '1.2', '1.2.3-beta.1', 'latest', ' 1.2.3', '1.2.3\n', '', null, undefined, 'v1.2.3']) {
    assert.equal(isReleaseVersion(v), false, String(v));
  }
});

test('runUpdate spawns nothing for a version that is not a release version', async () => {
  const calls = [];
  const spawnImpl = fakeSpawn(calls);
  assert.equal(await runUpdate('99.0.0 || npm:evil', { spawnImpl }), false);
  assert.equal(await runUpdate('1.2.3-beta.1', { spawnImpl }), false);
  assert.equal(calls.length, 0);
  // The literal tag the manual fallback uses is still fine.
  assert.equal(await runUpdate('latest', { spawnImpl }), true);
});

// ── autoUpdate guards ────────────────────────────────────────

/** A package root that is not a git checkout, so autoUpdate gets past its first check. */
function nonGitRoot() {
  return mkdtempSync(join(tmpdir(), 'tc-root-'));
}

test('autoUpdate skips a malformed registry version with a log line and installs nothing', async () => {
  const root = nonGitRoot();
  const logs = [];
  let installed = 0;
  try {
    const res = await autoUpdate({
      root, uid: 1000, log: (m) => logs.push(m),
      check: async () => ({ current: '1.0.0', latest: '99.0.0 || npm:evil', updateAvailable: true }),
      kind: () => 'global',
      install: () => { installed++; return true; },
    });
    assert.equal(res.skipped, 'bad-version');
    assert.equal(installed, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /not a release version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('autoUpdate still installs a well-formed newer version for a global install', async () => {
  const root = nonGitRoot();
  const installs = [];
  try {
    const res = await autoUpdate({
      root, uid: 1000, log: () => {},
      check: async () => ({ current: '1.0.0', latest: '2.0.0', updateAvailable: true }),
      kind: async () => 'global',
      install: async (v) => { installs.push(v); return true; },
    });
    assert.equal(res.updated, true);
    assert.deepEqual(installs, ['2.0.0']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// `sudo teamclaude server` would otherwise run `npm install -g` as root every
// day, off a version string fetched from the network.
test('autoUpdate never runs as root, and says so once', async () => {
  const root = nonGitRoot();
  const logs = [];
  let checked = 0;
  try {
    const opts = {
      root, uid: 0, log: (m) => logs.push(m),
      check: async () => { checked++; return { current: '1.0.0', latest: '2.0.0', updateAvailable: true }; },
      kind: () => 'global',
      install: () => { throw new Error('must not install as root'); },
    };
    assert.equal((await autoUpdate(opts)).skipped, 'root');
    assert.equal((await autoUpdate(opts)).skipped, 'root');
    assert.equal(checked, 0, 'the registry is not even consulted');
    assert.equal(logs.filter(l => /root/.test(l)).length, 1, 'warned exactly once across calls');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
