// Opt-out-able self-update, in the spirit of Claude Code's auto-updater.
//
// We ONLY ever touch a global npm install (`npm install -g @karpeleslab/teamclaude`):
//   - a git checkout (a `.git` at the package root) is a dev tree — never touched;
//   - a local dependency / npx copy is left alone (we only notify).
// Checks hit the npm registry at most once a day (cached in a small file next to
// the config), so the overwhelmingly common invocation does zero network I/O.
// Disable entirely with TEAMCLAUDE_DISABLE_AUTOUPDATE=1 or config.autoUpdate=false.
//
// Every side-effecting dependency (fetch, spawn, the clock, the cache path) is
// injectable so the logic is unit-testable without network or npm.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getConfigPath } from './config.js';

export const PKG_NAME = '@karpeleslab/teamclaude';
const REGISTRY = 'https://registry.npmjs.org';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Package root = one directory above this file's src/ directory. */
function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Installed version, read from the shipped package.json (null if unreadable). */
export function currentVersion(root = packageRoot()) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** Numeric compare of x.y.z (prerelease/build suffix ignored). >0 if a is newer. */
export function compareVersions(a, b) {
  const nums = (v) => String(v).split('+')[0].split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = nums(a), pb = nums(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** `npm root -g` (the global modules dir), or null if npm is unavailable. */
function npmGlobalRoot() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* npm missing */ }
  return null;
}

/** How this copy was installed: 'git', 'global', 'local', or 'unknown'. */
export function installKind({ root = packageRoot(), globalRoot = npmGlobalRoot } = {}) {
  if (existsSync(join(root, '.git'))) return 'git';
  const norm = root.split('\\').join('/');
  if (!norm.includes('/node_modules/')) return 'unknown';
  const g = typeof globalRoot === 'function' ? globalRoot() : globalRoot;
  if (g && norm.startsWith(g.split('\\').join('/'))) return 'global';
  return 'local';
}

/** Fetch the registry's current "latest" version (null on any failure/timeout). */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${REGISTRY}/${PKG_NAME}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json' }, // abbreviated packument (small, has dist-tags)
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json['dist-tags']?.latest || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function defaultCacheFile() {
  return join(dirname(getConfigPath()), 'update-check.json');
}
async function readCache(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}
async function writeCache(path, obj) {
  try { await writeFile(path, JSON.stringify(obj)); } catch { /* best effort */ }
}

/**
 * Throttled version check. Returns { current, latest, updateAvailable } or null
 * if the version is unknown / the registry couldn't be reached and nothing is
 * cached. Only fetches when the cached check is older than `intervalMs` (or
 * `force`), so back-to-back invocations do no network I/O.
 */
export async function checkForUpdate({
  current = currentVersion(),
  cachePath = defaultCacheFile(),
  fetchImpl = fetch,
  now = Date.now(),
  intervalMs = DAY_MS,
  force = false,
} = {}) {
  if (!current) return null;
  const cache = await readCache(cachePath);
  let latest = cache.latest || null;
  const fresh = cache.checkedAt && (now - cache.checkedAt) < intervalMs;
  if (force || !fresh) {
    const fetched = await fetchLatestVersion({ fetchImpl });
    if (fetched) latest = fetched;
    await writeCache(cachePath, { checkedAt: now, latest });
  }
  if (!latest) return null;
  return { current, latest, updateAvailable: compareVersions(latest, current) > 0 };
}

/** Install a specific version globally. Returns true on success. */
export function runUpdate(version = 'latest', { spawnImpl = spawnSync } = {}) {
  const r = spawnImpl('npm', ['install', '-g', `${PKG_NAME}@${version}`], {
    stdio: 'inherit',
    timeout: 180000,
  });
  return !!r && !r.error && r.status === 0;
}

/**
 * The automatic path used at startup / session-end. Skips dev checkouts and
 * respects the opt-out; when an update exists it silently installs it for a
 * global install, or just prints a one-line notice otherwise. Cheap in the
 * common case: the expensive `npm root -g` probe only runs when an update is
 * actually available.
 */
export async function autoUpdate({ config = {}, force = false, log = console.error } = {}) {
  const root = packageRoot();
  if (existsSync(join(root, '.git'))) return { skipped: 'git' }; // dev checkout — never touch
  if (process.env.TEAMCLAUDE_DISABLE_AUTOUPDATE || config.autoUpdate === false) {
    return { skipped: 'disabled' };
  }
  const info = await checkForUpdate({ force });
  if (!info) return { skipped: 'check-failed' };
  if (!info.updateAvailable) return { ...info, upToDate: true };

  if (installKind({ root }) !== 'global') {
    log(`[TeamClaude] Update available: ${info.current} → ${info.latest}. Run: teamclaude update`);
    return { ...info, notified: true };
  }
  log(`[TeamClaude] Updating ${info.current} → ${info.latest}…`);
  const ok = runUpdate(info.latest);
  log(ok
    ? `[TeamClaude] Updated to ${info.latest}. Restart teamclaude to use the new version.`
    : `[TeamClaude] Auto-update failed. Run manually: npm install -g ${PKG_NAME}@latest`);
  return { ...info, updated: ok };
}
