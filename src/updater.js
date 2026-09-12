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

import { spawn, execFile } from 'node:child_process';
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

/**
 * `npm root -g` (the global modules dir), or null if npm is unavailable.
 *
 * Asynchronous on purpose: this runs inside the headless server, and npm takes
 * up to a second or two to answer. A synchronous spawn parked the event loop
 * for that long, with every client connection waiting behind it.
 */
function npmGlobalRoot() {
  return new Promise((resolve) => {
    try {
      execFile('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        resolve(!err && stdout ? stdout.trim() : null);
      });
    } catch { resolve(null); } // npm missing
  });
}

/** How this copy was installed: 'git', 'global', 'local', or 'unknown'. */
export async function installKind({ root = packageRoot(), globalRoot = npmGlobalRoot } = {}) {
  if (existsSync(join(root, '.git'))) return 'git';
  const norm = root.split('\\').join('/');
  if (!norm.includes('/node_modules/')) return 'unknown';
  const g = await (typeof globalRoot === 'function' ? globalRoot() : globalRoot);
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

/**
 * Whether `v` is a plain release version, the only shape we ever pass to npm.
 *
 * The registry's `dist-tags.latest` is a string from the network, and
 * compareVersions is lenient by design (it parses what it can), so a value like
 * "99.0.0 || npm:evil" reads as newer and would go straight into
 * `npm install -g <name>@<value>`. Only x.y.z is installed; anything else is
 * reported and skipped.
 */
export function isReleaseVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v));
}

/**
 * Install a specific version globally. Resolves true on success. `version` must
 * be a release version (or the literal `latest`), or nothing is spawned.
 *
 * The install is a child process the event loop keeps running beside, never a
 * synchronous wait. `autoUpdate` runs this inside `server --headless`, the one
 * process every client depends on: a synchronous `npm install -g` blocked it
 * for the whole install, so the proxy accepted no connections, `teamclaude
 * status` timed out and `teamclaude run` refused to launch — unattended, on
 * whichever day the daily check found a new version (#353). The result only
 * matters for the log line, and the new version applies on the next start
 * regardless, so nothing is gained by waiting inline.
 *
 * `spawnImpl` is injectable and must return a ChildProcess-shaped emitter
 * ('exit' with a code, or 'error').
 */
export function runUpdate(version = 'latest', { spawnImpl = spawn } = {}) {
  if (version !== 'latest' && !isReleaseVersion(version)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('npm', ['install', '-g', `${PKG_NAME}@${version}`], {
        stdio: 'inherit',
        timeout: 180000,
      });
    } catch { resolve(false); return; }
    if (!child || typeof child.once !== 'function') { resolve(false); return; }
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

// The root warning is printed once per process: autoUpdate runs at startup and
// again at session end, and a daemon would otherwise say it every day.
let rootWarned = false;

/**
 * The automatic path used at startup / session-end. Skips dev checkouts and
 * respects the opt-out; when an update exists it silently installs it for a
 * global install, or just prints a one-line notice otherwise. Cheap in the
 * common case: the expensive `npm root -g` probe only runs when an update is
 * actually available.
 *
 * Never runs as root. `sudo teamclaude server` would otherwise run
 * `npm install -g` as root on a daily schedule, off a version string fetched
 * from the network — the operator can run `teamclaude update` deliberately.
 *
 * `root`, `uid`, `check`, `kind` and `install` are injectable for tests.
 *
 * @param {Object} [opts]
 * @param {{ autoUpdate?: boolean }} [opts.config]
 * @param {boolean} [opts.force]
 * @param {(line: string) => void} [opts.log]
 * @param {string} [opts.root]
 * @param {number|undefined} [opts.uid]
 * @param {Function} [opts.check]
 * @param {Function} [opts.kind]
 * @param {Function} [opts.install]
 */
export async function autoUpdate({
  config = {}, force = false, log = console.error,
  root = packageRoot(), uid = process.getuid?.(),
  check = checkForUpdate, kind = installKind, install = runUpdate,
} = {}) {
  if (existsSync(join(root, '.git'))) return { skipped: 'git' }; // dev checkout — never touch
  if (process.env.TEAMCLAUDE_DISABLE_AUTOUPDATE || config.autoUpdate === false) {
    return { skipped: 'disabled' };
  }
  if (uid === 0) {
    if (!rootWarned) {
      rootWarned = true;
      log('[TeamClaude] Auto-update is disabled when running as root. Update deliberately with: teamclaude update');
    }
    return { skipped: 'root' };
  }
  const info = await check({ force });
  if (!info) return { skipped: 'check-failed' };
  if (!info.updateAvailable) return { ...info, upToDate: true };
  if (!isReleaseVersion(info.latest)) {
    log(`[TeamClaude] Ignoring registry "latest" that is not a release version: ${JSON.stringify(String(info.latest)).slice(0, 80)}`);
    return { ...info, skipped: 'bad-version' };
  }

  if (await kind({ root }) !== 'global') {
    log(`[TeamClaude] Update available: ${info.current} → ${info.latest}. Run: teamclaude update`);
    return { ...info, notified: true };
  }
  log(`[TeamClaude] Updating ${info.current} → ${info.latest}…`);
  const ok = await install(info.latest);
  log(ok
    ? `[TeamClaude] Updated to ${info.latest}. Restart teamclaude to use the new version.`
    : `[TeamClaude] Auto-update failed. Run manually: npm install -g ${PKG_NAME}@latest`);
  return { ...info, updated: ok };
}
