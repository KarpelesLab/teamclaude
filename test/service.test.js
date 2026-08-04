import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  serviceKind, launchAgentPath, systemdUnitPath, logPath, resolveExec, servicePath,
  renderLaunchAgent, renderSystemdUnit, installService, uninstallService, serviceStatus, LABEL,
} from '../src/service.js';

// Records every command a call would run, and answers each with a canned result.
function recorder(results = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = Object.keys(results).find(k => [cmd, ...args].join(' ').includes(k));
    return results[key] || { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('service kind follows the platform', () => {
  assert.equal(serviceKind('darwin'), 'launchd');
  assert.equal(serviceKind('linux'), 'systemd');
  assert.equal(serviceKind('win32'), null);
});

test('unit files land in the per-user locations', () => {
  assert.equal(launchAgentPath('/Users/x'), `/Users/x/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(systemdUnitPath('/home/x', null), '/home/x/.config/systemd/user/teamclaude.service');
  assert.equal(systemdUnitPath('/home/x', '/cfg'), '/cfg/systemd/user/teamclaude.service');
  assert.equal(logPath('/Users/x', 'darwin'), '/Users/x/Library/Logs/teamclaude.log');
});

// The regression this guards: process.execPath on a Homebrew node points into
// the versioned Cellar directory, which the next `brew upgrade node` deletes.
// The PATH symlink survives upgrades and is what belongs in a unit file.
test('resolveExec prefers a PATH symlink over the versioned real path', () => {
  const exec = resolveExec({
    execPath: '/opt/homebrew/Cellar/node/26.5.0_1/bin/node',
    argv1: '/opt/homebrew/bin/teamclaude',
    pathEnv: '/usr/bin:/opt/homebrew/bin',
    exists: (p) => p === '/opt/homebrew/bin/node',
    realpath: (p) => (p === '/opt/homebrew/bin/node' ? '/opt/homebrew/Cellar/node/26.5.0_1/bin/node' : p),
  });
  assert.equal(exec.node, '/opt/homebrew/bin/node');
  assert.equal(exec.entry, '/opt/homebrew/bin/teamclaude');
});

test('resolveExec keeps the real path when no PATH entry matches it', () => {
  const exec = resolveExec({
    execPath: '/usr/local/n/versions/node/24/bin/node',
    argv1: '/usr/local/bin/teamclaude',
    pathEnv: '/usr/bin',
    exists: () => false,
    realpath: (p) => p,
  });
  assert.equal(exec.node, '/usr/local/n/versions/node/24/bin/node');
});

// A different node on PATH must not be substituted for the one actually running.
test('resolveExec ignores a PATH node that is a different binary', () => {
  const exec = resolveExec({
    execPath: '/opt/homebrew/Cellar/node/26.5.0_1/bin/node',
    argv1: '/x/teamclaude',
    pathEnv: '/usr/bin',
    exists: () => true,
    realpath: (p) => (p === '/usr/bin/node' ? '/usr/bin/node-18' : p),
  });
  assert.equal(exec.node, '/opt/homebrew/Cellar/node/26.5.0_1/bin/node');
});

// launchd starts with an empty environment — an inherited-looking PATH is not
// inherited at all, so the unit has to carry one or self-update can't find npm.
test('the service PATH covers both binaries and the system directories', () => {
  const p = servicePath({ node: '/opt/homebrew/bin/node', entry: '/opt/homebrew/bin/teamclaude' });
  assert.match(p, /^\/opt\/homebrew\/bin:/);
  assert.match(p, /\/usr\/bin/);
  assert.equal(p.split(':').filter(d => d === '/opt/homebrew/bin').length, 1); // deduped
});

test('the LaunchAgent asks for restart-on-exit and headless mode', () => {
  const plist = renderLaunchAgent({
    node: '/opt/homebrew/bin/node', entry: '/opt/homebrew/bin/teamclaude',
    log: '/Users/x/Library/Logs/teamclaude.log', path: '/opt/homebrew/bin:/usr/bin',
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.karpeleslab\.teamclaude<\/string>/);
  assert.match(plist, /<string>server<\/string>\s*<string>--headless<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('paths with XML metacharacters are escaped, not injected', () => {
  const plist = renderLaunchAgent({
    node: '/n', entry: '/opt/a&b/<teamclaude>', log: '/l', path: '/p',
  });
  assert.match(plist, /&amp;b\/&lt;teamclaude&gt;/);
  assert.ok(!plist.includes('/opt/a&b/<teamclaude>'));
});

test('the systemd unit restarts and starts at login', () => {
  const unit = renderSystemdUnit({
    node: '/usr/bin/node', entry: '/usr/bin/teamclaude', path: '/usr/bin',
  });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/usr\/bin\/teamclaude server --headless/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Environment=PATH=\/usr\/bin/);
});

test('an optional config path is carried into both unit formats', () => {
  const opts = { node: '/n', entry: '/e', log: '/l', path: '/p', configPath: '/cfg/teamclaude.json' };
  assert.match(renderLaunchAgent(opts), /TEAMCLAUDE_CONFIG<\/key>\s*<string>\/cfg\/teamclaude\.json/);
  assert.match(renderSystemdUnit(opts), /Environment=TEAMCLAUDE_CONFIG=\/cfg\/teamclaude\.json/);
});

test('installing on launchd writes the plist and loads it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const { run, calls } = recorder();
    const res = await installService({
      kind: 'launchd', home, platform: 'darwin', run, log: () => {},
      exec: { node: '/opt/homebrew/bin/node', entry: '/opt/homebrew/bin/teamclaude' },
    });
    assert.equal(res.ok, true);
    const written = await readFile(launchAgentPath(home), 'utf8');
    assert.match(written, /teamclaude/);
    // bootout before bootstrap: bootstrap fails outright if the label is loaded.
    assert.match(calls[0], /^launchctl bootout gui\/\d+\/com\.karpeleslab\.teamclaude$/);
    assert.match(calls[1], /^launchctl bootstrap gui\/\d+ /);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a failed load is reported as a failure, not a silent success', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const { run } = recorder({ bootstrap: { code: 5, stdout: '', stderr: 'Load failed: 5: Input/output error' } });
    const res = await installService({
      kind: 'launchd', home, platform: 'darwin', run, log: () => {},
      exec: { node: '/n', entry: '/e' },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Load failed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('installing on systemd reloads the daemon before enabling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const { run, calls } = recorder();
    // xdgConfig: null keeps the unit under `home`. Without it the call honours
    // the ambient XDG_CONFIG_HOME — set on CI and on plenty of desktops — and
    // the test would write a real unit file into the developer's own config dir
    // while asserting against a temp path that was never written.
    const res = await installService({
      kind: 'systemd', home, platform: 'linux', run, log: () => {}, xdgConfig: null,
      exec: { node: '/usr/bin/node', entry: '/usr/bin/teamclaude' },
    });
    assert.equal(res.ok, true);
    assert.match(await readFile(systemdUnitPath(home, null), 'utf8'), /ExecStart=/);
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user enable --now teamclaude.service',
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// XDG_CONFIG_HOME wins over ~/.config for the unit's location — that is where a
// systemd --user unit belongs on a machine that sets it. Asserted explicitly
// because the same knob decides whether a test can reach the real config dir.
test('the systemd unit follows XDG_CONFIG_HOME when one is set', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const xdg = join(home, 'xdg');
    const { run } = recorder();
    const res = await installService({
      kind: 'systemd', home, platform: 'linux', run, log: () => {}, xdgConfig: xdg,
      exec: { node: '/usr/bin/node', entry: '/usr/bin/teamclaude' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.file, join(xdg, 'systemd', 'user', 'teamclaude.service'));
    assert.match(await readFile(res.file, 'utf8'), /ExecStart=/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('uninstall unloads before deleting the unit file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const { run, calls } = recorder();
    await installService({
      kind: 'launchd', home, platform: 'darwin', run, log: () => {},
      exec: { node: '/n', entry: '/e' },
    });
    calls.length = 0;
    const res = await uninstallService({ kind: 'launchd', home, run, log: () => {} });
    assert.equal(res.ok, true);
    assert.match(calls[0], /launchctl bootout/);
    await assert.rejects(readFile(launchAgentPath(home), 'utf8'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('status reports loaded-but-not-running distinctly from running', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-svc-'));
  try {
    const loaded = recorder({ print: { code: 0, stdout: 'state = running\n\tpid = 4242\n', stderr: '' } });
    const running = await serviceStatus({ kind: 'launchd', home, run: loaded.run });
    assert.equal(running.running, true);
    assert.equal(running.pid, '4242');

    const idle = recorder({ print: { code: 0, stdout: 'state = not running\n', stderr: '' } });
    assert.equal((await serviceStatus({ kind: 'launchd', home, run: idle.run })).running, false);

    const absent = recorder({ print: { code: 113, stdout: '', stderr: 'Could not find service' } });
    const gone = await serviceStatus({ kind: 'launchd', home, run: absent.run });
    assert.equal(gone.running, false);
    assert.equal(gone.detail, 'not loaded');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an unsupported platform refuses instead of writing anything', async () => {
  const res = await installService({ kind: null, platform: 'win32', log: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /win32/);
});
