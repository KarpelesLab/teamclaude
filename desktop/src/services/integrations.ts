// Integrations page support: find the official CLIs on PATH (read-only — the
// app never installs or edits them) and build the environment lines that point
// a client at the proxy. Nothing here writes a shell profile or editor
// settings; the user copies what they want.

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CliToolInfo } from '../shared/types';

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function toolInfo(name: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, exists?: (p: string) => boolean): CliToolInfo {
  const path = findExecutable(name, env, platform, exists);
  return { name, found: path !== null, path };
}

/**
 * Base-URL mode lines (docs/proxy-modes.md). `teamclaude env` remains the
 * authority for the configured mode — MITM adds proxy and CA variables this
 * app does not reproduce — and the UI says so.
 */
export function envSnippets(port: number): { posix: string; powershell: string; cmd: string } {
  const url = `http://localhost:${port}`;
  return {
    posix: `export ANTHROPIC_BASE_URL=${url}`,
    powershell: `$env:ANTHROPIC_BASE_URL = "${url}"`,
    cmd: `set ANTHROPIC_BASE_URL=${url}`,
  };
}

export function vscodeSnippet(port: number): string {
  return JSON.stringify({
    'claudeCode.environmentVariables': [{ name: 'ANTHROPIC_BASE_URL', value: `http://localhost:${port}` }],
  }, null, 2);
}

export interface TerminalCommand {
  command: string;
  args: string[];
}

/**
 * A terminal to open with ANTHROPIC_BASE_URL set (passed through the child's
 * environment, never interpolated into a command line). null when none is found.
 */
export function terminalCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  find: (name: string) => string | null,
): TerminalCommand | null {
  if (platform === 'win32') {
    const wt = find('wt');
    if (wt) return { command: wt, args: ['new-tab', 'powershell.exe', '-NoExit'] };
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    // `start` opens a new console window; the empty string is its window title.
    return { command: comspec, args: ['/d', '/c', 'start', '""', 'powershell.exe', '-NoExit'] };
  }
  const preferred = env.TERMINAL ? [env.TERMINAL] : [];
  for (const name of [...preferred, 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm']) {
    if (name.includes('/') || name.includes(' ')) continue;
    const path = find(name);
    if (path) return { command: path, args: [] };
  }
  return null;
}
