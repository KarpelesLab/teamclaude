// `teamclaude desktop`: start the proxy in the background if it is not
// running, then open the dashboard. It is what the Windows installer's
// TeamClaude.exe runs, so one double-click gives a person with no terminal a
// running proxy and the page to set it up from. It works the same on macOS and
// Linux.
//
// Running it again while the proxy is up only opens the page. A second copy
// started at the same moment loses the port to the first, and this then opens
// the page of whichever one won.
//
// A proxy that is up but reports an older version than this copy is stopped
// and replaced. Without that, a new TeamClaude.exe opened the dashboard of
// whatever older copy was still running from an earlier install, so the
// person saw the old version's features and had no sign of why.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './login-flow.js';
import { compareVersions } from './updater.js';

const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * @typedef {object} StartedServer
 * @property {number|undefined} pid
 * @property {() => string|null} exited  why the child is gone, or null while it runs
 */

/**
 * @typedef {object} RunningServer
 * @property {number} pid
 * @property {string|null} version  what its package.json says, null if it does not report one
 */

/**
 * The pid and version a TeamClaude server on `host:port` reports, or null
 * when nothing answers there, the answer is not a status reply, or it takes
 * over 2 s.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} [apiKey]
 * @returns {Promise<RunningServer|null>}
 */
export async function probeServer(host, port, apiKey) {
  try {
    const res = await fetch(`http://${urlHost(host)}:${port}/teamclaude/status`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) { await res.arrayBuffer(); return null; }
    const server = (await res.json())?.server;
    if (!Number.isInteger(server?.pid)) return null;
    return { pid: server.pid, version: typeof server.version === 'string' ? server.version : null };
  } catch {
    return null;
  }
}

/**
 * Whether `running` is older than `own`. Unknown on either side is not older:
 * a server that does not say its version is left alone rather than stopped
 * on a guess.
 *
 * @param {string|null|undefined} running
 * @param {string|null|undefined} own
 */
export function isOlderVersion(running, own) {
  return !!running && !!own && compareVersions(running, own) < 0;
}

/** @param {number} pid */
function stopProcess(pid) {
  process.kill(pid);
}

/**
 * `server --headless` as a detached child with no window, writing to
 * `logFile`, that keeps running after this process exits.
 *
 * @param {string} logFile
 * @returns {StartedServer}
 */
export function startDetachedServer(logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  /** @type {string|null} */
  let gone = null;
  try {
    const child = spawn(process.execPath, [ENTRY, 'server', '--headless'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.once('exit', (code, signal) => { gone = signal ? `signal ${signal}` : `exit code ${code}`; });
    child.once('error', err => { gone = err.message; });
    child.unref();
    return { pid: child.pid, exited: () => gone };
  } finally {
    closeSync(fd);
  }
}

/**
 * Make sure a server is up on `host:port`, starting one if not, and open its
 * dashboard unless `open` is false.
 *
 * Readiness after a start is a status reply carrying the started child's own
 * pid. Another server answering means a second launch won the port; once the
 * child has exited on that, the other server is the one to open.
 *
 * A server already up that reports a version older than `version` (this
 * copy's) is stopped first, and this copy is started in its place. One that
 * is the same version or newer, or does not say, is opened as it is.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} [opts.apiKey]
 * @param {string} opts.logFile
 * @param {string|null} [opts.version]  this copy's version; without it nothing is replaced
 * @param {boolean} [opts.open]
 * @param {number} [opts.timeoutMs]
 * @param {() => Promise<RunningServer|null>} [opts.probe]
 * @param {(logFile: string) => StartedServer} [opts.start]
 * @param {(pid: number) => void} [opts.stop]
 * @param {(url: string, opts?: { wait?: boolean }) => Promise<void>} [opts.openUrl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<{ url: string, pid: number, started: boolean, replaced: RunningServer|null }>}
 */
export async function launchDesktop({
  host, port, apiKey, logFile, version = null, open = true, timeoutMs = 20_000,
  probe = () => probeServer(host, port, apiKey),
  start = startDetachedServer,
  stop = stopProcess,
  openUrl = openBrowser,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const url = `http://${urlHost(host)}:${port}/teamclaude/dashboard`;
  let running = await probe();
  /** @type {RunningServer|null} */
  let replaced = null;
  if (running && isOlderVersion(running.version, version)) {
    replaced = running;
    running = await stopOlder(running, { port, version, stop, probe, sleep, now, timeoutMs });
  }
  let started = false;
  if (running == null) {
    const child = start(logFile);
    running = await waitForServer(child, { probe, sleep, now, timeoutMs, logFile });
    started = running.pid === child.pid;
    // Our child lost the port to another server. Opening it is right unless
    // it is the old version again, put back by whatever runs it.
    if (!started && replaced && isOlderVersion(running.version, version)) throw comesBack(running, port);
  }
  if (open) await openUrl(url, { wait: true });
  return { url, pid: running.pid, started, replaced };
}

/**
 * Stop `old` and wait for the port to be free. Returns null once nothing
 * answers, or the server that answers in its place if that one is current.
 *
 * @param {RunningServer} old
 * @param {{ port: number, version: string|null, stop: (pid: number) => void, probe: () => Promise<RunningServer|null>, sleep: (ms: number) => Promise<void>, now: () => number, timeoutMs: number }} opts
 * @returns {Promise<RunningServer|null>}
 */
async function stopOlder(old, { port, version, stop, probe, sleep, now, timeoutMs }) {
  try {
    stop(old.pid);
  } catch (err) {
    // ESRCH: it exited on its own between the probe and now, which is fine.
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ESRCH') {
      throw new Error(`An older TeamClaude (${old.version}, pid ${old.pid}) is running on port ${port}, and it could not be stopped (${err instanceof Error ? err.message : String(err)}). Stop it, then open this one again.`);
    }
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const answer = await probe();
    if (answer == null) return null;
    if (answer.pid !== old.pid) {
      if (isOlderVersion(answer.version, version)) throw comesBack(answer, port);
      return answer;
    }
    if (now() >= deadline) throw new Error(`An older TeamClaude (${old.version}, pid ${old.pid}) on port ${port} did not stop within ${Math.round(timeoutMs / 1000)} s. Stop it, then open this one again.`);
    await sleep(250);
  }
}

/**
 * The old version answering again after it was stopped: a service or another
 * install restarts it, and stopping it again would only loop.
 *
 * @param {RunningServer} server
 * @param {number} port
 */
function comesBack(server, port) {
  return new Error(`An older TeamClaude (${server.version}, pid ${server.pid}) keeps running on port ${port}, so it is probably started by a service or another install. Remove that copy (for a service: teamclaude service uninstall), then open this one again.`);
}

/**
 * @param {StartedServer} child
 * @param {{ probe: () => Promise<RunningServer|null>, sleep: (ms: number) => Promise<void>, now: () => number, timeoutMs: number, logFile: string }} opts
 * @returns {Promise<RunningServer>}
 */
async function waitForServer(child, { probe, sleep, now, timeoutMs, logFile }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    // Read before the probe: a pid that answers after the child has gone is
    // the other launch's server, and a match before then is the child itself.
    const gone = child.exited();
    const answer = await probe();
    if (answer != null && (answer.pid === child.pid || gone)) return answer;
    if (gone) throw new Error(`The proxy stopped while starting (${gone}). See the log: ${logFile}`);
    if (now() >= deadline) throw new Error(`The proxy did not answer within ${Math.round(timeoutMs / 1000)} s of starting. See the log: ${logFile}`);
    await sleep(250);
  }
}

/** @param {string} host */
function urlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}
