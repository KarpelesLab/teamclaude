// Launch-at-login, only when the user turns it on. Windows uses the per-user
// Run key through Electron's setLoginItemSettings (in main/index.ts). Linux
// uses the XDG autostart directory of the user's session; nothing system-wide,
// no root.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AUTOSTART_ARG = '--autostart';
const DESKTOP_FILE = 'teamclaude-desktop.desktop';

export function autostartDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart');
}

/** Quote one argument for a desktop entry's Exec key (Desktop Entry Spec, "Exec key"). */
export function quoteExecArg(arg: string): string {
  if (!/[\s"'\\`$<>|;&*?#()~]/.test(arg)) return arg.replace(/%/g, '%%');
  return `"${arg.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

/**
 * The executable to put in the entry. Inside an AppImage, process.execPath
 * points into a temporary mount that is gone after the app exits; the
 * AppImage runtime exports the image's own path as APPIMAGE.
 */
export function launchCommand(execPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.APPIMAGE || execPath;
}

export function desktopEntry(command: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=TeamClaude Desktop',
    'Comment=Control panel for the local TeamClaude proxy',
    `Exec=${quoteExecArg(command)} ${AUTOSTART_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export interface LinuxAutostartFs {
  write(path: string, data: string): void;
  remove(path: string): void;
}

const nodeFs: LinuxAutostartFs = {
  write: (path, data) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data, { mode: 0o644 });
  },
  remove: path => rmSync(path, { force: true }),
};

export function setLinuxAutostart(enabled: boolean, execPath: string, opts: { env?: NodeJS.ProcessEnv; home?: string; fs?: LinuxAutostartFs } = {}): string {
  const file = join(autostartDir(opts.env, opts.home), DESKTOP_FILE);
  const fs = opts.fs ?? nodeFs;
  if (enabled) fs.write(file, desktopEntry(launchCommand(execPath, opts.env)));
  else fs.remove(file);
  return file;
}
