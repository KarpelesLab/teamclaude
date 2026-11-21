import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real server as a subprocess, on a port that is verifiably its own.
//
// Tests that drive `src/index.js server --headless` used to each pick a port
// with closedPort(), write it into a throwaway config and poll
// /teamclaude/status until something answered. `node --test` runs files in
// parallel, so between the probe closing and the child's listen() another test
// (or anything else on the machine) could take the port. Two outcomes, both
// seen in CI and locally under load: the child exits with "Port N is already
// in use" and the test times out with a confusing error; or, worse, ANOTHER
// server answers on that port — a neighbouring test's in-process
// createProxyServer, say, which has no hooks.reload — the 200 satisfies the
// poll, and the test then talks to the wrong server (reload → 501). Readiness
// here is a status reply whose `server.pid` is the child's own, and a child
// that lost the port to a neighbour is respawned on a fresh one.
//
// This file lives outside test/ on purpose: node's default test glob includes
// `**/test/**/*.js`, so anything under test/ is run as a test file.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

// How many ports to try before giving up. Losing one race is expected under
// load; losing ten in a row means something else is wrong.
const MAX_ATTEMPTS = 10;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A port nothing is listening on: bind one, learn its number, give it back.
 *
 * Fine for a DEAD upstream (a stand-in for a backend that refuses). Not fine
 * on its own for the proxy's own port — see spawnServer for why.
 * @returns {Promise<number>}
 */
export function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One GET /teamclaude/status, parsed; null when nothing answered, when the
 * reply was not a 200, or when the request timed out. Bounded per attempt so
 * an accepted-but-unanswered connection cannot wedge a polling loop.
 * @param {number} port
 * @returns {Promise<any|null>}
 */
async function fetchStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) { await res.arrayBuffer(); return null; }
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Poll /teamclaude/status on `port` until a reply satisfies `predicate`, or
 * until `stopWhen()` says there is no point waiting any longer (the child
 * exited). No overall deadline of its own: a child that hangs at startup
 * without listening is what the runner's --test-timeout is for, and the
 * `signal` a test hands spawnServer is what then ends this wait.
 * @param {number} port
 * @param {(status: any) => boolean} [predicate]
 * @param {{ stopWhen?: () => boolean }} [opts]
 * @returns {Promise<any|null>} the matching status, or null when stopWhen fired
 */
export async function waitForStatus(port, predicate = () => true, { stopWhen } = {}) {
  for (;;) {
    const status = await fetchStatus(port);
    // A matching reply wins even if the child has meanwhile exited: it was the
    // child that answered, and whatever killed it afterwards is the test's to
    // notice.
    if (status && predicate(status)) return status;
    if (stopWhen?.()) return null;
    await sleep(75);
  }
}

/**
 * Spawn the real server on a port that is verifiably its own.
 *
 * Picks a candidate port, writes `config(port)` (with `proxy.port` set) to
 * `<dir>/config.json` as compact `JSON.stringify` — so a test can tell the
 * server's own 2-space save from this write by the bytes — and spawns
 * `src/index.js server --headless` on it. Resolves once the child answers
 * status with its own pid. If the child instead exits because the port was
 * taken, it is respawned on a fresh port; any other exit throws with the
 * child's output.
 *
 * `signal` (a test's t.signal) ends a startup that never finishes. The runner's
 * timeout fails a test whose child never answers, but does not end the wait
 * here, and the wait and the child would keep the file from ever exiting on
 * Node 24 and later (test/README.md, "Clean up in finally"). When the signal
 * aborts before spawnServer has resolved, even as the child's ready reply
 * arrives, the child is stopped, which ends the wait as its exit does, and the
 * promise rejects with the signal's reason instead of respawning or resolving.
 *
 * @param {object} opts
 * @param {(port: number) => object} opts.config  builds the config for a candidate port (proxy.port is set by the helper; the callback may read the port for other fields)
 * @param {string} [opts.dir]        directory for the config file (mkdtemp'd when absent)
 * @param {Record<string, string>} [opts.env]  extra environment for the child
 * @param {string[]} [opts.args]     extra CLI args after `server --headless`
 * @param {AbortSignal} [opts.signal] stops the child and rejects when it aborts before spawnServer resolves
 * @returns {Promise<{ port: number, pid: number, configPath: string, dir: string, config: object, child: import('node:child_process').ChildProcess, output: () => string, stop: () => Promise<void> }>}
 */
export async function spawnServer({ config: buildConfig, dir, env = {}, args = [], signal }) {
  dir ??= await mkdtemp(join(tmpdir(), 'teamclaude-spawn-'));
  const configPath = join(dir, 'config.json');
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await closedPort();
    const config = buildConfig(port);
    config.proxy = { ...(config.proxy || {}), port };
    await writeFile(configPath, JSON.stringify(config));

    signal?.throwIfAborted();
    const { child, exited, output } = spawnChild(configPath, env, args);
    let done = false;
    exited.then(() => { done = true; });
    const onAbort = () => { void stop(child, exited); };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Readiness is a status reply carrying the child's OWN pid. A 200 from a
    // server with a different pid is the wrong-server case: keep polling — the
    // child cannot come up on a taken port, so it will exit and end the wait.
    const status = await waitForStatus(port, s => s?.server?.pid === child.pid, { stopWhen: () => done });
    signal?.removeEventListener('abort', onAbort);
    // An abort that came as the child's ready reply arrived has begun stopping
    // it: reject rather than hand back a child on its way out.
    if (signal?.aborted) { await stop(child, exited); signal.throwIfAborted(); }
    if (status) {
      return {
        port, pid: child.pid, configPath, dir, config, child, output,
        stop: () => stop(child, exited),
      };
    }

    const { code, signal: killedBy } = await exited;
    const report = `attempt ${attempt} on port ${port}: exited (code ${code}, signal ${killedBy})\n${output()}`;
    if (!/already in use/.test(output())) {
      throw new Error(`server exited before answering status\n${report}`);
    }
    failures.push(report);
  }
  throw new Error(`server lost the port race ${MAX_ATTEMPTS} times\n${failures.join('\n')}`);
}

function spawnChild(configPath, extraEnv, args) {
  // The child must not inherit a proxy from the shell: see test/README.md.
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1', ...extraEnv };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const child = spawn(process.execPath, [cliPath, 'server', '--headless', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  // Attached at spawn, not at stop(): Node does not replay 'exit' to late
  // listeners, so a child that died before stop() ran (startup port race,
  // mid-test crash) would otherwise hang the await. 'close' rather than 'exit'
  // so the pipes have drained and output() is complete — the "already in use"
  // line is what the retry decision reads. 'error' covers a spawn that never
  // started, which fires neither.
  const exited = new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', err => resolve({ code: null, signal: null, error: err }));
  });
  return { child, exited, output: () => output };
}

// SIGTERM, escalate to SIGKILL after a few seconds, await exit. Safe on a
// child that has already exited: kill() is a no-op and `exited` is settled.
async function stop(child, exited) {
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killer);
}
