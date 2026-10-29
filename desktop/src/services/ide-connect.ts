// One-click "point this editor at the proxy". VS Code-family editors keep user
// settings as JSONC (comments, trailing commas), so their file is edited in
// place: only the text of one top-level key is replaced or inserted, and the
// user's comments and layout survive. Claude Code's own ~/.claude/settings.json
// is plain JSON and is rewritten whole. Zed runs Claude Code as an agent
// server and takes its environment from `agent_servers.claude.env`. JetBrains
// IDEs run the Claude Code CLI, so they follow ~/.claude/settings.json. Before
// the first change a copy of the file is kept next to it; Disconnect removes
// only ANTHROPIC_BASE_URL.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IdeId, IdeTarget } from '../shared/types';

export const VSCODE_KEY = 'claudeCode.environmentVariables';
export const ENV_NAME = 'ANTHROPIC_BASE_URL';
export const BACKUP_SUFFIX = '.teamclaude-backup';

export interface IdeFiles {
  read(path: string): string | null;
  write(path: string, data: string): void;
  exists(path: string): boolean;
  copy(from: string, to: string): void;
}

export const nodeIdeFiles: IdeFiles = {
  read: path => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  },
  exists: existsSync,
  copy: copyFileSync,
};

export const ZED_KEY = 'agent_servers';

const EDITORS: Array<{ id: Exclude<IdeId, 'claude' | 'zed' | 'jetbrains'>; name: string; folder: string; launcher: string }> = [
  { id: 'vscode', name: 'VS Code', folder: 'Code', launcher: 'code' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', folder: 'Code - Insiders', launcher: 'code-insiders' },
  { id: 'cursor', name: 'Cursor', folder: 'Cursor', launcher: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', folder: 'Windsurf', launcher: 'windsurf' },
  { id: 'vscodium', name: 'VSCodium', folder: 'VSCodium', launcher: 'codium' },
];

export interface IdeEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export const currentEnvironment = (): IdeEnvironment => ({ platform: process.platform, env: process.env, home: homedir() });

function configBase(e: IdeEnvironment): string {
  if (e.platform === 'win32') return e.env.APPDATA || join(e.home, 'AppData', 'Roaming');
  if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support');
  return e.env.XDG_CONFIG_HOME || join(e.home, '.config');
}

function zedDir(e: IdeEnvironment): string {
  if (e.platform === 'win32') return join(e.env.APPDATA || join(e.home, 'AppData', 'Roaming'), 'Zed');
  return join(e.env.XDG_CONFIG_HOME || join(e.home, '.config'), 'zed');
}

export function claudeSettingsPath(e: IdeEnvironment): string {
  return join(e.env.CLAUDE_CONFIG_DIR || join(e.home, '.claude'), 'settings.json');
}

// ── JSONC ──────────────────────────────────────────────────────────────

/** Index just past the string that opens at `i`. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  if (j >= text.length) throw new Error('unterminated string in the settings file');
  return j + 1;
}

/** Index just past the comment that opens at `i`, or -1 when none opens there. */
function commentEnd(text: string, i: number): number {
  if (text[i] !== '/') return -1;
  if (text[i + 1] === '/') {
    const n = text.indexOf('\n', i);
    return n === -1 ? text.length : n;
  }
  if (text[i + 1] === '*') {
    const n = text.indexOf('*/', i + 2);
    if (n === -1) throw new Error('unterminated comment in the settings file');
    return n + 2;
  }
  return -1;
}

/** First index at or after `i` that is not whitespace or a comment. */
function significant(text: string, i: number): number {
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) { i++; continue; }
    const end = commentEnd(text, i);
    if (end === -1) return i;
    i = end;
  }
  return i;
}

/** Comments and trailing commas removed, string contents untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== -1) { i = end; continue; }
    if (text[i] === ',' && /[}\]]/.test(text[significant(text, i + 1)] ?? '')) { i++; continue; }
    out += text[i];
    i++;
  }
  return out;
}

export function parseJsonc(text: string): Record<string, unknown> {
  const value: unknown = text.trim() ? JSON.parse(stripJsonc(text)) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the settings file is not a JSON object');
  return value as Record<string, unknown>;
}

/** End (exclusive) of the JSON value that starts at or after `from`. */
function valueEnd(text: string, from: number): number {
  const start = significant(text, from);
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let i = start;
    while (i < text.length && !/[\s,}\]/]/.test(text[i] as string)) i++;
    return i;
  }
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { i = stringEnd(text, i); continue; }
    const end = commentEnd(text, i);
    if (end !== -1) { i = end; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error('unbalanced brackets in the settings file');
}

/** Where a top-level member sits, from its key to the end of its value. */
export function findTopLevel(text: string, key: string): { keyStart: number; valueEnd: number } | null {
  const quoted = JSON.stringify(key);
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (depth === 1 && text.slice(i, end) === quoted) {
        const colon = significant(text, end);
        if (text[colon] === ':') return { keyStart: i, valueEnd: valueEnd(text, colon + 1) };
      }
      i = end;
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== -1) { i = end; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

/** Set a top-level member, keeping everything else in the text as it is. */
export function setTopLevel(text: string, key: string, value: unknown): string {
  const member = `${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`;
  if (!text.trim()) return `{\n  ${member}\n}\n`;
  const span = findTopLevel(text, key);
  if (span) return text.slice(0, span.keyStart) + member + text.slice(span.valueEnd);
  const open = significant(text, 0);
  if (text[open] !== '{') throw new Error('the settings file is not a JSON object');
  const hasMembers = Object.keys(parseJsonc(text)).length > 0;
  return `${text.slice(0, open + 1)}\n  ${member}${hasMembers ? ',' : '\n'}${text.slice(open + 1)}`;
}

/** Remove a top-level member and the comma that went with it. */
export function removeTopLevel(text: string, key: string): string {
  const span = findTopLevel(text, key);
  if (!span) return text;
  let start = span.keyStart;
  let end = span.valueEnd;
  const after = /^\s*,/.exec(text.slice(end));
  if (after) {
    end += after[0].length;
    // Take the member's own line with it.
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    if (text[start - 1] === '\n') start--;
  } else {
    const before = /,\s*$/.exec(text.slice(0, start));
    if (before) start -= before[0].length;
  }
  return text.slice(0, start) + text.slice(end);
}

// ── targets ────────────────────────────────────────────────────────────

const normalizeUrl = (u: string) => u.trim().replace('://127.0.0.1', '://localhost').replace(/\/+$/, '');

function envEntries(value: unknown): Array<{ name: string; value: string }> {
  return Array.isArray(value)
    ? value.filter((e): e is { name: string; value: string } => !!e && typeof e === 'object' && typeof e.name === 'string' && typeof e.value === 'string')
    : [];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

function currentUrl(id: IdeId, settings: Record<string, unknown>): string | null {
  let v: unknown;
  if (id === 'claude') v = record(settings.env)[ENV_NAME];
  else if (id === 'zed') v = record(record(record(settings[ZED_KEY]).claude).env)[ENV_NAME];
  else return envEntries(settings[VSCODE_KEY]).find(e => e.name === ENV_NAME)?.value ?? null;
  return typeof v === 'string' ? v : null;
}

function describeTarget(id: IdeId, name: string, path: string, installed: boolean, url: string, files: IdeFiles, launcher: string | null = null): IdeTarget {
  const base = { id, name, installed, settingsPath: path, via: null, launcher };
  const text = files.read(path);
  if (text === null) return { ...base, status: 'not-connected', current: null };
  try {
    const current = currentUrl(id, parseJsonc(text));
    const status = current === null ? 'not-connected' : normalizeUrl(current) === normalizeUrl(url) ? 'connected' : 'other';
    return { ...base, status, current };
  } catch {
    return { ...base, status: 'unreadable', current: null };
  }
}

export function proxyUrl(port: number): string {
  return `http://localhost:${port}`;
}

export interface ListOptions {
  env?: IdeEnvironment;
  files?: IdeFiles;
  claudeFound?: boolean;
  /** Finds a command on PATH (integrations.findExecutable); none are looked up when omitted. */
  find?: (name: string) => string | null;
}

export function listIdeTargets(port: number, opts: ListOptions = {}): IdeTarget[] {
  const e = opts.env ?? currentEnvironment();
  const files = opts.files ?? nodeIdeFiles;
  const find = opts.find ?? (() => null);
  const url = proxyUrl(port);
  const claudePath = claudeSettingsPath(e);
  const claude = describeTarget('claude', 'Claude Code', claudePath, !!opts.claudeFound || files.exists(dirname(claudePath)), url, files);
  const targets = [claude];
  const base = configBase(e);
  for (const ed of EDITORS) {
    targets.push(describeTarget(ed.id, ed.name, join(base, ed.folder, 'User', 'settings.json'), files.exists(join(base, ed.folder)), url, files, find(ed.launcher)));
  }
  const zed = zedDir(e);
  targets.push(describeTarget('zed', 'Zed', join(zed, 'settings.json'), files.exists(zed), url, files, find('zed')));
  // JetBrains keeps no setting of its own here: its Claude Code plugin runs the CLI.
  targets.push({ ...claude, id: 'jetbrains', name: 'JetBrains IDEs', installed: files.exists(join(base, 'JetBrains')), via: 'claude', launcher: null });
  return targets;
}

/** The new file text with ANTHROPIC_BASE_URL set to `url`, or removed when `url` is null. */
export function editSettings(id: IdeId, text: string | null, url: string | null): string {
  const source = text ?? '';
  const settings = parseJsonc(source);
  if (id === 'claude') {
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? { ...(settings.env as Record<string, unknown>) } : {};
    if (url) env[ENV_NAME] = url;
    else delete env[ENV_NAME];
    const next: Record<string, unknown> = { ...settings, env };
    if (!Object.keys(env).length) delete next.env;
    return `${JSON.stringify(next, null, 2)}\n`;
  }
  if (id === 'zed') {
    const servers = record(settings[ZED_KEY]);
    const claude = record(servers.claude);
    const env = record(claude.env);
    if (url) env[ENV_NAME] = url;
    else delete env[ENV_NAME];
    if (Object.keys(env).length) claude.env = env;
    else delete claude.env;
    if (Object.keys(claude).length) servers.claude = claude;
    else delete servers.claude;
    return Object.keys(servers).length ? setTopLevel(source, ZED_KEY, servers) : removeTopLevel(source, ZED_KEY);
  }
  const others = envEntries(settings[VSCODE_KEY]).filter(e => e.name !== ENV_NAME);
  if (url) return setTopLevel(source, VSCODE_KEY, [...others, { name: ENV_NAME, value: url }]);
  return others.length ? setTopLevel(source, VSCODE_KEY, others) : removeTopLevel(source, VSCODE_KEY);
}

/** Connect (url) or disconnect (null) one target. Throws with a readable message. */
export function applyIde(target: IdeTarget, url: string | null, files: IdeFiles = nodeIdeFiles): void {
  const text = files.read(target.settingsPath);
  const next = editSettings(target.via ?? target.id, text, url);
  // The result must still parse, or nothing is written.
  parseJsonc(next);
  if (text === next) return;
  const backup = target.settingsPath + BACKUP_SUFFIX;
  if (text !== null && !files.exists(backup)) files.copy(target.settingsPath, backup);
  files.write(target.settingsPath, next);
}
