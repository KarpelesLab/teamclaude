// `claude` shell alias — print or install/uninstall.
//
// The alias simply routes plain `claude` through `teamclaude run`, which probes
// the proxy and, when it's down, errors out rather than silently bypassing the
// proxy. All the smarts live in `run`; add `--auto-fallback` to the alias if you
// want plain `claude` to launch directly when the proxy is down instead.
//
// This only affects interactive shells (aliases aren't seen by editors/scripts
// that exec `claude` themselves). It's intentionally lighter than a PATH shim:
// no binary shadowing, one line per rc, trivially reversible.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MARKER = '# teamclaude alias';

/** Basename of the user's login shell, e.g. "zsh". Defaults to bash. */
export function detectShell() {
  return (process.env.SHELL || '').split('/').pop() || 'bash';
}

/** Whether a bare command resolves on the current $PATH. */
function commandOnPath(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, cmd))) return true;
  }
  return false;
}

/**
 * How the alias should invoke teamclaude. Prefer the bare `teamclaude` when it's
 * on $PATH; otherwise embed the absolute path to this CLI (quoted) so the alias
 * still works when teamclaude isn't installed on PATH — e.g. run from a clone.
 */
export function teamclaudeRef() {
  if (commandOnPath('teamclaude')) return 'teamclaude';
  const entry = process.argv[1];
  if (!entry) return 'teamclaude';
  let abs;
  try { abs = realpathSync(entry); } catch { abs = entry; }
  return `"${abs}"`;
}

/** The alias definition for a given shell family. */
export function aliasLine(shell = detectShell(), ref = teamclaudeRef()) {
  const body = `${ref} run --`;
  if (shell === 'fish') return `alias claude '${body}'`;
  return `alias claude='${body}'`;
}

/** The rc file an alias for this shell should live in. */
export function rcPathForShell(shell = detectShell()) {
  const home = homedir();
  switch (shell) {
    case 'zsh':  return join(home, '.zshrc');
    case 'sh':   return join(home, '.profile');
    case 'fish': {
      const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config');
      return join(cfg, 'fish', 'conf.d', 'teamclaude.fish');
    }
    case 'bash':
    default:     return join(home, '.bashrc');
  }
}

export function printAlias({ shell = detectShell() } = {}) {
  const line = aliasLine(shell);
  console.log('# Route plain `claude` through the proxy (errors if the proxy is down;');
  console.log('# append --auto-fallback before `--` to launch claude directly instead).');
  console.log('# Add this to your shell config:');
  console.log('');
  console.log(`  ${line}`);
  console.log('');
  console.log(`# Or install it automatically: teamclaude alias --install`);
  console.log(`#   → writes to ${rcPathForShell(shell)} (override with --shell <bash|zsh|fish|sh>)`);
}

export function installAlias({ shell = detectShell(), rcPath = rcPathForShell(shell) } = {}) {
  const line = aliasLine(shell);
  mkdirSync(dirname(rcPath), { recursive: true });
  let text = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';

  if (text.includes(line)) {
    console.log(`Alias already present in ${rcPath}`);
    return;
  }
  if (text && !text.endsWith('\n')) text += '\n';
  text += `${MARKER}\n${line}\n`;
  writeFileSync(rcPath, text);
  console.log(`Installed alias in ${rcPath}`);
  console.log('Reload your shell (or open a new terminal) to use it.');
}

export function uninstallAlias({ shell = detectShell(), rcPath = rcPathForShell(shell) } = {}) {
  if (!existsSync(rcPath)) {
    console.log(`Nothing to remove (${rcPath} does not exist)`);
    return;
  }
  const text = readFileSync(rcPath, 'utf8');
  // Strip our marked block: the marker comment + the single line after it.
  // Matching by marker (not by exact alias text) makes this robust even if the
  // embedded teamclaude path differs from what's computed now.
  const blockRe = new RegExp(`\\n?${escapeRe(MARKER)}\\n[^\\n]*\\n?`, 'g');
  let cleaned = text.replace(blockRe, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  if (cleaned === text) {
    console.log(`Alias not found in ${rcPath}`);
    return;
  }

  // For the dedicated fish drop-file, remove it entirely if now empty.
  if (rcPath.endsWith('teamclaude.fish') && cleaned.trim() === '') {
    rmSync(rcPath);
    console.log(`Removed ${rcPath}`);
    return;
  }
  writeFileSync(rcPath, cleaned);
  console.log(`Removed alias from ${rcPath}`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
