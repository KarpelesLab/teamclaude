import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchDesktop } from '../src/desktop.js';
import { closedPort } from '../test-helpers/spawn-server.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const pexec = promisify(execFile);

/** A server reply: a bare pid stands for a server that does not say its version. */
const srv = (pid, version = null) => (pid == null ? null : { pid, version });

/** A probe that answers each call with the next value, then the last one forever. */
function answers(...values) {
  let calls = 0;
  const replies = values.map(v => (typeof v === 'number' ? srv(v) : v));
  const probe = async () => replies[Math.min(calls++, replies.length - 1)];
  return { probe, calls: () => calls };
}

function fakes() {
  const opened = [];
  const openOpts = [];
  const starts = [];
  let clock = 0;
  return {
    opened, openOpts, starts,
    openUrl: async (url, opts) => { opened.push(url); openOpts.push(opts); },
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
}

const base = { host: '127.0.0.1', port: 4100, logFile: '/logs/teamclaude.log' };

test('a proxy that is already up is not started again; its dashboard is opened', async () => {
  const f = fakes();
  const { probe } = answers(111);
  const res = await launchDesktop({ ...base, probe, start: () => { f.starts.push(1); return { pid: 1, exited: () => null }; }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 111, started: false, replaced: null });
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.opened, ['http://127.0.0.1:4100/teamclaude/dashboard']);
  // desktop exits right after, so the opener must be waited for (on Windows
  // an un-waited `start` is killed with this process).
  assert.deepEqual(f.openOpts, [{ wait: true }]);
});

test('a stopped proxy is started, waited for until it answers with its own pid, then opened', async () => {
  const f = fakes();
  const { probe } = answers(null, null, null, 222);
  const res = await launchDesktop({ ...base, probe, start: logFile => { f.starts.push(logFile); return { pid: 222, exited: () => null }; }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 222, started: true, replaced: null });
  assert.deepEqual(f.starts, ['/logs/teamclaude.log']);
  assert.equal(f.opened.length, 1);
});

test('--no-open starts the proxy without opening anything', async () => {
  const f = fakes();
  const { probe } = answers(null, 333);
  const res = await launchDesktop({ ...base, open: false, probe, start: () => ({ pid: 333, exited: () => null }), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.started, true);
  assert.deepEqual(f.opened, []);
});

test('another server answering while the child still runs is not taken for it', async () => {
  const f = fakes();
  // A second launch's server comes up first; ours then loses the port and
  // exits, and only after that is the other one the server to open.
  let probes = 0;
  const probe = async () => (probes++ === 0 ? null : srv(999));
  const exited = () => (probes >= 3 ? 'exit code 1' : null);
  const res = await launchDesktop({ ...base, probe, start: () => ({ pid: 444, exited }), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 999, started: false, replaced: null });
  assert.equal(probes, 4, 'kept waiting while the child was alive');
  assert.equal(f.opened.length, 1);
});

test('a child that exits before answering fails at once, naming the log', async () => {
  const f = fakes();
  const { probe } = answers(null);
  await assert.rejects(
    launchDesktop({ ...base, probe, start: () => ({ pid: 555, exited: () => 'exit code 1' }), openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /stopped while starting \(exit code 1\)\. See the log: \/logs\/teamclaude\.log/,
  );
  assert.equal(f.now(), 0, 'did not wait for the deadline');
  assert.deepEqual(f.opened, []);
});

test('a child that never answers fails once the wait runs out, naming the log', async () => {
  const f = fakes();
  const { probe } = answers(null);
  await assert.rejects(
    launchDesktop({ ...base, timeoutMs: 20_000, probe, start: () => ({ pid: 666, exited: () => null }), openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /did not answer within 20 s of starting\. See the log: \/logs\/teamclaude\.log/,
  );
  assert.equal(f.now(), 20_000);
  assert.deepEqual(f.opened, []);
});

test('an older proxy already up is stopped, and this version started in its place', async () => {
  const f = fakes();
  const stopped = [];
  // The old one answers, then is gone once stopped, then ours answers.
  const { probe } = answers(srv(111, '1.1.26'), srv(111, '1.1.26'), null, srv(222, '1.1.27'));
  const res = await launchDesktop({ ...base, version: '1.1.27', probe, stop: pid => { stopped.push(pid); }, start: () => { f.starts.push(1); return { pid: 222, exited: () => null }; }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(stopped, [111]);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 222, started: true, replaced: { pid: 111, version: '1.1.26' } });
  assert.equal(f.opened.length, 1);
});

test('a proxy of the same or a newer version, or one that does not say, is left running', async () => {
  for (const running of ['1.1.27', '1.1.30', null]) {
    const f = fakes();
    const { probe } = answers(srv(111, running));
    const res = await launchDesktop({ ...base, version: '1.1.27', probe, stop: () => { throw new Error('must not stop it'); }, start: () => { throw new Error('must not start'); }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
    assert.equal(res.pid, 111, `running ${running}`);
    assert.equal(res.replaced, null);
  }
});

test('without its own version, desktop replaces nothing', async () => {
  const f = fakes();
  const { probe } = answers(srv(111, '0.0.1'));
  const res = await launchDesktop({ ...base, probe, stop: () => { throw new Error('must not stop it'); }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.pid, 111);
});

test('an older proxy that cannot be stopped is reported, and nothing is opened', async () => {
  const f = fakes();
  const { probe } = answers(srv(111, '1.1.26'));
  const denied = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  await assert.rejects(
    launchDesktop({ ...base, version: '1.1.27', probe, stop: denied, openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /older TeamClaude \(1\.1\.26, pid 111\) is running on port 4100, and it could not be stopped \(operation not permitted\)/,
  );
  assert.deepEqual(f.opened, []);
});

test('an older proxy that already exited before it was stopped is not an error', async () => {
  const f = fakes();
  const { probe } = answers(srv(111, '1.1.26'), null, srv(222, '1.1.27'));
  const gone = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  const res = await launchDesktop({ ...base, version: '1.1.27', probe, stop: gone, start: () => ({ pid: 222, exited: () => null }), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.started, true);
});

test('an older proxy put straight back by a service is reported instead of opened', async () => {
  const f = fakes();
  // Stopped, then a new pid of the same old version takes the port.
  const { probe } = answers(srv(111, '1.1.26'), srv(333, '1.1.26'));
  await assert.rejects(
    launchDesktop({ ...base, version: '1.1.27', probe, stop: () => {}, start: () => { throw new Error('must not start'); }, openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /older TeamClaude \(1\.1\.26, pid 333\) keeps running on port 4100.*teamclaude service uninstall/,
  );
  assert.deepEqual(f.opened, []);
});

test('an older proxy that wins the port back from the started copy is reported', async () => {
  const f = fakes();
  let probes = 0;
  // Old one answers; stopped and gone; our child starts, loses the port to
  // the old version coming back, and exits.
  const replies = [srv(111, '1.1.26'), null, null, srv(333, '1.1.26')];
  const probe = async () => replies[Math.min(probes++, replies.length - 1)];
  const exited = () => (probes >= 3 ? 'exit code 1' : null);
  await assert.rejects(
    launchDesktop({ ...base, version: '1.1.27', probe, stop: () => {}, start: () => ({ pid: 222, exited }), openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /keeps running on port 4100/,
  );
  assert.deepEqual(f.opened, []);
});

test('an older proxy that does not stop in time is reported', async () => {
  const f = fakes();
  const { probe } = answers(srv(111, '1.1.26'));
  await assert.rejects(
    launchDesktop({ ...base, version: '1.1.27', timeoutMs: 20_000, probe, stop: () => {}, openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /did not stop within 20 s/,
  );
  assert.equal(f.now(), 20_000);
});

test('an IPv6 bind is bracketed in the dashboard address', async () => {
  const f = fakes();
  const res = await launchDesktop({ ...base, host: '::1', probe: async () => srv(1), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.url, 'http://[::1]:4100/teamclaude/dashboard');
});

/** `teamclaude desktop --no-open` as a person runs it, against a throwaway home. */
function runDesktop(dir, configPath) {
  const env = {
    ...process.env,
    HOME: dir, XDG_STATE_HOME: join(dir, 'state'),
    TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
  };
  // The detached server inherits this environment too: see test/README.md.
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  return pexec(process.execPath, [cliPath, 'desktop', '--no-open'], { env, encoding: 'utf8' });
}

test('desktop starts a real detached server once and finds it the second time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-desktop-'));
  const configPath = join(dir, 'config.json');
  /** @type {number|null} */
  let serverPid = null;
  try {
    let first;
    // A port this test picked can be taken by a neighbouring test's server
    // before the child binds it; that server then reads as "already running".
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = await closedPort();
      await writeFile(configPath, JSON.stringify({ proxy: { port }, upstreamProxy: false, autoUpdate: false }));
      first = await runDesktop(dir, configPath);
      if (/^Started the proxy/m.test(first.stdout)) break;
    }
    const started = /^Started the proxy \(pid (\d+)\)/m.exec(first.stdout);
    assert.ok(started, `desktop did not start a server:\n${first.stdout}${first.stderr}`);
    serverPid = Number(started[1]);

    const log = await readFile(join(dir, 'state', 'teamclaude.log'), 'utf8');
    assert.match(log, /No accounts configured yet/, 'the server wrote its output to the log');

    const second = await runDesktop(dir, configPath);
    assert.match(second.stdout, new RegExp(`^The proxy is already running \\(pid ${serverPid}\\)`, 'm'));
  } finally {
    if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
