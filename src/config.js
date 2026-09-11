import { readFile, open, mkdir, chmod, rename, unlink, realpath } from 'node:fs/promises';
import { openSync, writeSync, closeSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveUpstreamProxy, setUpstreamProxy } from './upstream-proxy.js';
import { ensureAccountIds } from './account-id.js';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

/**
 * Path to the runtime state file (a sibling of the config). This holds volatile
 * data learned at runtime — e.g. quota utilization observed passively from
 * traffic — kept out of the hand-editable config so config stays clean and
 * isn't rewritten on every state save.
 */
export function getStatePath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.state.json') : cfg + '.state';
}

/**
 * Path to the crash log (a sibling of the config), where a fatal error is
 * recorded before the process exits.
 */
export function getCrashLogPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '-crash.log') : cfg + '-crash.log';
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(getStatePath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveState(state) {
  await writeJsonAtomic(getStatePath(), state);
}

/**
 * Write a JSON document so that the file at `path` is, at every instant, either
 * the previous complete document or the new one.
 *
 * A plain writeFile truncates first and fills in afterwards. The config holds
 * every account's OAuth tokens and the proxy key; a crash or power loss in that
 * gap left an empty or half-written file, and the next start threw on
 * JSON.parse with the credentials gone. So the document goes to a sibling
 * temp file, is fsynced so it is on disk before it is named, and is renamed
 * over the target — rename replaces atomically on POSIX and, in Node, on
 * Windows too (same scheme mitm.js uses for the leaf key).
 *
 * The temp file is created 0600 and chmod'ed before the rename, so the
 * "enforce 0600 on every save" behaviour of the old code holds: a config that
 * was once world-readable becomes 0600 on the next save, and the tokens are
 * never on disk under a looser mode even for an instant.
 */
async function writeJsonAtomic(path, value) {
  // A rename replaces the NAME, so a config that is a symlink (a dotfiles
  // checkout, say) would silently become a regular file where the old in-place
  // write followed the link. Resolve it first; a dangling or absent path is
  // written where it is.
  path = await realpath(path).catch(() => path);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(value, null, 2) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    // `open`'s mode is masked by the umask; make the mode exact regardless.
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
  } catch (err) {
    // Never leave a half-written copy of the credentials lying beside the config.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    holdSeconds: 0,
    distributeSessions: false,
    sessionTitles: { enabled: false, width: 18 },
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    const config = JSON.parse(await readFile(path, 'utf-8'));
    // A file with no `accounts` key is what an empty or hand-trimmed config
    // looks like. Every reader treats the list as always present, and the first
    // one to trip was the save path — so the failure arrived while writing,
    // long after the read that could have explained it (#330). A missing list
    // is an empty one.
    if (!Array.isArray(config.accounts)) config.accounts = [];
    // Everything downstream pairs config entries to running accounts by entry id,
    // so a config written before the field existed — or edited by hand — is given
    // ids here, before anything can read one. The next save persists them.
    ensureAccountIds(config.accounts);
    applyUpstreamProxy(config);
    return config;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publish the config's egress proxy to the process-wide setting.
 *
 * Done here, in the one place every command loads its config, rather than at
 * each of the sixteen call sites: `login`, `import`, `accounts`, `probe` and the
 * server all reach the network, and a proxy that applied to only some of them
 * would be worse than none — the account list would refresh while logging in
 * failed, or vice versa.
 *
 * A bad value is fatal on purpose. Falling back to a direct connection on a host
 * that has no route to the internet would turn one clear error into a pile of
 * ETIMEDOUTs pointing nowhere near the typo that caused them.
 */
function applyUpstreamProxy(config) {
  try {
    setUpstreamProxy(resolveUpstreamProxy(config));
  } catch (err) {
    console.error(`[TeamClaude] Bad proxy setting in ${getConfigPath()}: ${err.message}`);
    process.exit(1);
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
    // loadConfig applies this only when a file already existed — it returns
    // early on ENOENT. Without it here, the FIRST run of a network command
    // (`login` on a fresh install) leaves the process-wide setting unset, and
    // the lazy fallback resolves it from the environment against an EMPTY
    // config. That fallback has no listener to compare against, so the
    // self-proxy guard cannot fire: an operator whose HTTPS_PROXY points at
    // their own TeamClaude gets a CONNECT back into the proxy and a timeout,
    // on the one run where there is no config to explain it.
    applyUpstreamProxy(config);
  }
  return config;
}

// Every writer of the config — the server rotating a refresh token, a CLI
// command, a GUI client — does its own read-modify-write with a temp+rename.
// Two of them racing keep only the later write, and the edit that is lost is
// as likely as not a freshly rotated refresh token, which costs a re-login.
// The lock below is the coordination point. It is advisory and file-based so
// that clients outside this package can honour it with no shared code:
//
//   path     <configPath>.lock
//   acquire  open(O_CREAT|O_EXCL, 0600), then write {"pid":<pid>,"at":<ms epoch>}
//   stale    `at` older than 10 s, or the pid no longer alive: unlink and retry
//   busy     poll every 25 ms for at most 2 s, then write WITHOUT the lock
//   release  unlink
//
// The 2 s cap is deliberate: a writer must never hang on a lock, so contention
// past it degrades to today's behaviour (a possible lost update) plus one
// warning line, rather than to a stuck server or CLI.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;

function lockIsStale(lockPath) {
  let pid, at;
  try {
    ({ pid, at } = JSON.parse(readFileSync(lockPath, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return false; // released under us; the retry takes it
    // Empty or garbled: the holder is between its open and its write, or died
    // there. Only the file's age can tell those apart.
    try { return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
  if (Date.now() - at > LOCK_STALE_MS) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}

/** True when the lock is ours; false when we gave up and proceed without it. */
async function acquireConfigLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`[TeamClaude] Cannot create ${lockPath} (${err.code || err.message}); writing the config without it`);
        return false;
      }
    }
    if (lockIsStale(lockPath)) {
      await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      console.error(`[TeamClaude] ${lockPath} is still held by another process after ${LOCK_WAIT_MS}ms; writing the config without it`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
  }
}

// One queue per lock path inside this process: same-process callers (the TUI
// saving while a token refresh runs) would otherwise spin against their own
// live lock file for the full 2 s.
const lockQueues = new Map();

/**
 * Run `fn` while holding the advisory lock for `configPath` (protocol above).
 * Same-process callers are queued; other processes are held off by the file.
 * The lock is released whether `fn` resolves or throws.
 */
export function withConfigLock(configPath, fn) {
  const lockPath = `${configPath}.lock`;
  const run = async () => {
    await mkdir(dirname(lockPath), { recursive: true });
    const held = await acquireConfigLock(lockPath);
    try {
      return await fn();
    } finally {
      if (held) await unlink(lockPath).catch(() => {});
    }
  };
  const prev = lockQueues.get(lockPath) || Promise.resolve();
  const result = prev.then(run, run);
  lockQueues.set(lockPath, result.then(() => {}, () => {}));
  return result;
}

export async function saveConfig(config) {
  const path = getConfigPath();
  // The proxy apiKey and every account's tokens live here: see writeJsonAtomic
  // for why this is not a plain writeFile.
  await withConfigLock(path, () => writeJsonAtomic(path, config));
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs), and
 * holds the config lock across the read and the write so a concurrent writer —
 * in this process or another — waits its turn instead of clobbering the update.
 */
export function atomicConfigUpdate(updater) {
  const path = getConfigPath();
  return withConfigLock(path, async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await writeJsonAtomic(path, config);
    return config;
  });
}
