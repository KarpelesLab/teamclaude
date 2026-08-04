// Run the proxy as a user service — `teamclaude service install`.
//
// npm has no equivalent of `brew services`, and a postinstall hook is the wrong
// place for this (it is skipped under --ignore-scripts, surprises CI, and
// installs system state nobody asked for). So the CLI does it explicitly, the
// same way `teamclaude alias --install` handles the shell alias.
//
// macOS gets a LaunchAgent, Linux a systemd --user unit. Both are per-user: no
// root, no system-wide daemon, and the proxy runs as the user whose accounts and
// config it serves.

import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const LABEL = 'com.karpeleslab.teamclaude';
export const UNIT_NAME = 'teamclaude.service';

/** Which service manager to target, or null where we have nothing to offer. */
export function serviceKind(platform = process.platform) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}

export function launchAgentPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function systemdUnitPath(home = homedir(), xdgConfig = process.env.XDG_CONFIG_HOME) {
  return join(xdgConfig || join(home, '.config'), 'systemd', 'user', UNIT_NAME);
}

export function logPath(home = homedir(), platform = process.platform) {
  return platform === 'darwin'
    ? join(home, 'Library', 'Logs', 'teamclaude.log')
    : join(home, '.local', 'state', 'teamclaude.log');
}

/**
 * The interpreter and script to bake into the unit.
 *
 * `process.execPath` is NOT usable as-is: on a Homebrew install it points into
 * the versioned Cellar directory (…/Cellar/node/26.5.0_1/bin/node), which the
 * next `brew upgrade node` deletes — the service would then fail to start with
 * no obvious connection to the upgrade. Prefer a `node` on PATH that resolves to
 * the same binary, since that is the stable symlink maintained across upgrades.
 *
 * The script is `argv[1]` unresolved for the same reason: the bin symlink
 * survives a package reinstall, the versioned path inside node_modules may not.
 */
export function resolveExec({
  execPath = process.execPath,
  argv1 = process.argv[1],
  pathEnv = process.env.PATH || '',
  realpath = realpathSync,
  exists = existsSync,
} = {}) {
  const same = (candidate) => {
    try { return realpath(candidate) === realpath(execPath); } catch { return false; }
  };
  let node = execPath;
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    if (exists(candidate) && same(candidate)) { node = candidate; break; }
  }
  return { node, entry: argv1 };
}

/**
 * PATH for the service. launchd starts with an empty environment, so without
 * this the background self-update cannot find npm, and any child process the
 * proxy spawns inherits nothing. Built from the directories that actually
 * matter rather than copying the interactive shell's PATH, which is full of
 * per-session entries that mean nothing to a daemon.
 */
export function servicePath({ node, entry }) {
  const dirs = [dirname(node), dirname(entry), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderLaunchAgent({ node, entry, log, path, configPath = null }) {
  const args = [node, entry, 'server', '--headless'];
  const env = [`    <key>PATH</key>\n    <string>${xmlEscape(path)}</string>`];
  if (configPath) env.push(`    <key>TEAMCLAUDE_CONFIG</key>\n    <string>${xmlEscape(configPath)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ node, entry, path, configPath = null }) {
  const environment = [`Environment=PATH=${path}`];
  if (configPath) environment.push(`Environment=TEAMCLAUDE_CONFIG=${configPath}`);
  return `[Unit]
Description=TeamClaude multi-account Claude proxy
Documentation=https://github.com/KarpelesLab/teamclaude
After=network-online.target

[Service]
ExecStart=${node} ${entry} server --headless
Restart=always
RestartSec=5
${environment.join('\n')}

[Install]
WantedBy=default.target
`;
}

/** Run a command, returning { code, stdout, stderr }. Injected in tests. */
function runCommand(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** `gui/<uid>` — the launchd domain a per-user agent lives in. */
const guiDomain = (uid = process.getuid?.() ?? 0) => `gui/${uid}`;

export async function installService({
  kind = serviceKind(), home = homedir(), platform = process.platform,
  exec = resolveExec(), run = runCommand, configPath = null, log = console.log,
  xdgConfig = process.env.XDG_CONFIG_HOME,
} = {}) {
  if (!kind) return { ok: false, error: `No service integration for ${platform}` };
  const logFile = logPath(home, platform);
  const path = servicePath(exec);

  if (kind === 'launchd') {
    const plist = launchAgentPath(home);
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(dirname(logFile), { recursive: true });
    await writeFile(plist, renderLaunchAgent({ ...exec, log: logFile, path, configPath }), { mode: 0o644 });
    // Replace any previous registration first: bootstrap fails outright when the
    // label is already loaded, and an install that reports success while the old
    // definition keeps running is worse than a loud failure.
    run('launchctl', ['bootout', `${guiDomain()}/${LABEL}`]);
    const boot = run('launchctl', ['bootstrap', guiDomain(), plist]);
    if (boot.code !== 0) return { ok: false, error: boot.stderr.trim() || `launchctl bootstrap exited ${boot.code}`, file: plist };
    log(`[TeamClaude] Service installed: ${plist}`);
    log(`[TeamClaude] Logs: ${logFile}`);
    return { ok: true, file: plist, logFile };
  }

  const unit = systemdUnitPath(home, xdgConfig);
  await mkdir(dirname(unit), { recursive: true });
  await writeFile(unit, renderSystemdUnit({ ...exec, path, configPath }), { mode: 0o644 });
  run('systemctl', ['--user', 'daemon-reload']);
  const enable = run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  if (enable.code !== 0) return { ok: false, error: enable.stderr.trim() || `systemctl exited ${enable.code}`, file: unit };
  log(`[TeamClaude] Service installed: ${unit}`);
  log('[TeamClaude] Logs: journalctl --user --unit teamclaude.service --follow');
  // Without lingering the unit dies with the last login session, which is not
  // what "install a service" is expected to mean.
  log('[TeamClaude] To keep it running with no session open: loginctl enable-linger $USER');
  return { ok: true, file: unit, logFile: null };
}

export async function uninstallService({
  kind = serviceKind(), home = homedir(), run = runCommand, log = console.log,
  xdgConfig = process.env.XDG_CONFIG_HOME,
} = {}) {
  if (!kind) return { ok: false, error: 'No service integration for this platform' };
  if (kind === 'launchd') {
    const plist = launchAgentPath(home);
    run('launchctl', ['bootout', `${guiDomain()}/${LABEL}`]);
    await rm(plist, { force: true });
    log(`[TeamClaude] Service removed: ${plist}`);
    return { ok: true, file: plist };
  }
  const unit = systemdUnitPath(home, xdgConfig);
  run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  await rm(unit, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  log(`[TeamClaude] Service removed: ${unit}`);
  return { ok: true, file: unit };
}

export async function serviceStatus({
  kind = serviceKind(), home = homedir(), run = runCommand,
  xdgConfig = process.env.XDG_CONFIG_HOME,
} = {}) {
  if (!kind) return { installed: false, running: false, detail: 'unsupported platform' };
  if (kind === 'launchd') {
    const plist = launchAgentPath(home);
    const installed = existsSync(plist);
    const r = run('launchctl', ['print', `${guiDomain()}/${LABEL}`]);
    const pid = /\bpid = (\d+)/.exec(r.stdout)?.[1] || null;
    return { installed, running: r.code === 0 && !!pid, pid, file: plist, detail: r.code === 0 ? 'loaded' : 'not loaded' };
  }
  const unit = systemdUnitPath(home, xdgConfig);
  const r = run('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return { installed: existsSync(unit), running: r.stdout.trim() === 'active', file: unit, detail: r.stdout.trim() || r.stderr.trim() };
}

/** The unit file contents, for `service print` — inspect before installing. */
export function renderService({ kind = serviceKind(), home = homedir(), platform = process.platform, exec = resolveExec(), configPath = null } = {}) {
  if (!kind) return null;
  const path = servicePath(exec);
  return kind === 'launchd'
    ? renderLaunchAgent({ ...exec, log: logPath(home, platform), path, configPath })
    : renderSystemdUnit({ ...exec, path, configPath });
}

/** Read back what is installed, for diffing against what we would write now. */
export async function readInstalled({
  kind = serviceKind(), home = homedir(), xdgConfig = process.env.XDG_CONFIG_HOME,
} = {}) {
  if (!kind) return null;
  const file = kind === 'launchd' ? launchAgentPath(home) : systemdUnitPath(home, xdgConfig);
  return readFile(file, 'utf8').catch(() => null);
}
