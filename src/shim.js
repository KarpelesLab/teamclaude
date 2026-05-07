// Transparent claude shim — install / uninstall / status.
//
// Drops a tiny bash wrapper at <shim-dir>/claude, ships sh and fish PATH
// loaders alongside, and wires them in via a single source line in each
// detected shell rc (rustup-style — see ~/.cargo/env).
//
// The wrapper probes the proxy port and, if up, applies `teamclaude env`
// before exec'ing the real claude binary; otherwise it execs the real
// claude directly. The shim lives in its own directory, separate from
// where Claude Code's auto-updater rewrites its binary, so it survives
// `claude` self-updates indefinitely.
//
// Zero new dependencies — uses only Node.js built-in modules.

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Comment that pairs with the source line so uninstall can strip both surgically.
const RC_COMMENT = '# teamclaude shim';

// ── embedded scripts ──────────────────────────────────────────

// The bash wrapper. `$var` references are bash; `\${...}` escapes are JS
// template-literal escapes for the same bash references.
const WRAPPER_SCRIPT = `#!/usr/bin/env bash
# claude shim — installed by \`teamclaude shim install\`.
# Routes \`claude\` through the teamclaude proxy when it's running, else direct.
#
# Lives in its own PATH-prepended directory so Claude Code's auto-updater
# (which rewrites the real claude binary on every update) cannot replace it.
#
# Resolution order for the real claude:
#   1. \$CLAUDE_REAL env override
#   2. first \`claude\` on PATH whose realpath != this script's realpath
set -e

realpath_of() {
  if readlink -f "\$1" >/dev/null 2>&1; then readlink -f "\$1"
  else python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "\$1"
  fi
}

SELF_REAL="\$(realpath_of "\$0")"

resolve_real_claude() {
  if [[ -n "\${CLAUDE_REAL:-}" && -x "\$CLAUDE_REAL" ]]; then
    printf '%s' "\$CLAUDE_REAL"; return 0
  fi
  local IFS=:
  for d in \$PATH; do
    local cand="\$d/claude"
    [[ -x "\$cand" ]] || continue
    local cr; cr="\$(realpath_of "\$cand")"
    [[ "\$cr" == "\$SELF_REAL" ]] && continue
    printf '%s' "\$cand"; return 0
  done
  return 1
}

# Read teamclaude proxy port from config (default 3456).
PORT=3456
CFG="\${TEAMCLAUDE_CONFIG:-\${XDG_CONFIG_HOME:-\$HOME/.config}/teamclaude.json}"
if [[ -r "\$CFG" ]]; then
  P=\$(awk -F'[ ,:]+' '/"port"[[:space:]]*:/ {print \$3; exit}' "\$CFG" 2>/dev/null || true)
  [[ "\$P" =~ ^[0-9]+\$ ]] && PORT="\$P"
fi

proxy_up() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 1 127.0.0.1 "\$PORT" >/dev/null 2>&1
  else
    (exec 3<>/dev/tcp/127.0.0.1/"\$PORT") >/dev/null 2>&1
  fi
}

if ! REAL="\$(resolve_real_claude)"; then
  echo "claude-shim: cannot find real claude binary on PATH" >&2
  echo "  set CLAUDE_REAL=/path/to/claude or install Claude Code." >&2
  exit 127
fi

# If the proxy is up, apply teamclaude's env (ANTHROPIC_BASE_URL,
# ANTHROPIC_API_KEY) and exec the real claude. We can't use \`teamclaude run\`
# because it spawns claude from PATH, which would recurse into this shim.
if proxy_up && command -v teamclaude >/dev/null 2>&1; then
  eval "\$(teamclaude env)"
fi

exec "\$REAL" "\$@"
`;

// POSIX sh loader — rustup-style. Idempotent at source time.
function envShScript(shimDirRef) {
  return `#!/bin/sh
# teamclaude-shim shell setup — sourced from your shell rc.
# Adds the shim dir to PATH so plain \`claude\` routes through the proxy
# when it's running. Idempotent: safe to source multiple times.
case ":\${PATH}:" in
    *:"${shimDirRef}":*)
        ;;
    *)
        export PATH="${shimDirRef}:$PATH"
        ;;
esac
`;
}

// Fish loader — separate file because fish syntax differs.
function envFishScript(shimDirRef) {
  return `# teamclaude-shim fish setup — auto-loaded from conf.d.
if not contains "${shimDirRef}" $PATH
    set -gx PATH "${shimDirRef}" $PATH
end
`;
}

// ── path helpers ──────────────────────────────────────────────

export function defaultShimDir() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'teamclaude-shim');
}

// Render an absolute path as `$HOME/...` when it sits under $HOME, else
// return it absolute. Matches rustup's ~/.cargo/env style — portable
// across machines with the same shape of home dir.
function homeRef(absPath) {
  const home = homedir();
  if (absPath === home) return '$HOME';
  if (absPath.startsWith(home + '/')) return '$HOME/' + absPath.slice(home.length + 1);
  return absPath;
}

// All sh-family rc files we'll attempt to wire up. Writing to multiple
// rc files (rather than picking one) is what makes rustup's pattern
// robust to macOS bash login-shell precedence and cross-distro differences.
function shFamilyRcs() {
  const home = homedir();
  return [
    join(home, '.profile'),       // POSIX login shell baseline
    join(home, '.bashrc'),        // bash interactive non-login
    join(home, '.bash_profile'),  // bash login (macOS Terminal default)
    join(home, '.zshrc'),         // zsh interactive
  ];
}

function fishConfDirPath() {
  const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(cfg, 'fish', 'conf.d');
}

function fishConfFilePath() {
  return join(fishConfDirPath(), 'teamclaude-shim.fish');
}

// ── install / uninstall / status ──────────────────────────────

export function install({ shimDir = defaultShimDir(), noRc = false } = {}) {
  mkdirSync(shimDir, { recursive: true });

  const wrapperPath = join(shimDir, 'claude');
  const envShPath = join(shimDir, 'env');
  const envFishPath = join(shimDir, 'env.fish');
  const shimDirRef = homeRef(shimDir);

  writeFileSync(wrapperPath, WRAPPER_SCRIPT, { mode: 0o755 });
  writeFileSync(envShPath, envShScript(shimDirRef), { mode: 0o644 });
  writeFileSync(envFishPath, envFishScript(shimDirRef), { mode: 0o644 });
  console.log(`Wrote shim:    ${wrapperPath}`);
  console.log(`Wrote loader:  ${envShPath}`);
  console.log(`Wrote loader:  ${envFishPath}`);

  if (noRc) {
    console.log('');
    console.log('Add this to your shell rc and reload:');
    console.log(`  . "${homeRef(envShPath)}"          # bash / zsh / sh`);
    console.log(`  source "${homeRef(envFishPath)}"   # fish`);
    return { wrapperPath, envShPath, envFishPath };
  }

  // sh-family: append a one-line source directive to each rc file we recognize.
  // Skip files that don't exist AND don't correspond to the user's $SHELL —
  // creating a .bashrc on a zsh-only system is rude.
  let touched = 0;
  for (const rc of shFamilyRcs()) {
    if (!shouldTouchRc(rc)) continue;
    if (appendSourceLine(rc, envShPath)) {
      console.log(`Updated rc:    ${rc}`);
      touched++;
    }
  }

  // fish: drop a file in conf.d (fish auto-loads everything in that dir).
  // No rc edit needed — this is the canonical fish convention.
  const fishConfPath = fishConfFilePath();
  mkdirSync(dirname(fishConfPath), { recursive: true });
  writeFileSync(fishConfPath, fishConfContent(envFishPath));
  console.log(`Wrote fish:    ${fishConfPath}`);

  console.log('');
  if (touched > 0) {
    console.log('Reload your shell (or open a new terminal) to pick up the change.');
  } else {
    console.log('No sh-family rc files were modified. Add this to your rc manually:');
    console.log(`  . "${homeRef(envShPath)}"`);
  }
  console.log('');
  console.log('Verify:');
  console.log(`  which claude     # should print ${wrapperPath}`);

  return { wrapperPath, envShPath, envFishPath };
}

export function uninstall({ shimDir = defaultShimDir() } = {}) {
  const wrapperPath = join(shimDir, 'claude');
  const envShPath = join(shimDir, 'env');
  const envFishPath = join(shimDir, 'env.fish');

  for (const f of [wrapperPath, envShPath, envFishPath]) {
    if (existsSync(f)) {
      rmSync(f);
      console.log(`Removed:       ${f}`);
    }
  }
  try { rmdirSync(shimDir); } catch { /* not empty or doesn't exist */ }

  // sh-family: strip our source line from each rc.
  for (const rc of shFamilyRcs()) {
    if (!existsSync(rc)) continue;
    if (stripSourceLine(rc, envShPath)) {
      console.log(`Cleaned rc:    ${rc}`);
    }
  }

  // fish: remove the conf.d drop-file.
  const fishConfPath = fishConfFilePath();
  if (existsSync(fishConfPath)) {
    rmSync(fishConfPath);
    console.log(`Removed fish:  ${fishConfPath}`);
  }

  console.log('');
  console.log('Reload your shell to drop the PATH entry.');
}

export function status({ shimDir = defaultShimDir() } = {}) {
  const wrapperPath = join(shimDir, 'claude');
  const envShPath = join(shimDir, 'env');
  const envFishPath = join(shimDir, 'env.fish');

  console.log(`Shim dir:      ${shimDir}`);
  console.log(`Wrapper:       ${existsSync(wrapperPath) ? `installed (mode ${(statSync(wrapperPath).mode & 0o777).toString(8)})` : 'missing'}`);
  console.log(`sh loader:     ${existsSync(envShPath) ? 'installed' : 'missing'}`);
  console.log(`fish loader:   ${existsSync(envFishPath) ? 'installed' : 'missing'}`);

  const pathDirs = (process.env.PATH || '').split(':');
  const onPath = pathDirs.includes(shimDir);
  console.log(`On PATH:       ${onPath ? 'yes' : 'no'}`);

  console.log('');
  console.log('Wired into:');
  let any = false;
  for (const rc of shFamilyRcs()) {
    if (!existsSync(rc)) continue;
    const text = readFileSync(rc, 'utf8');
    if (text.includes(`. "${homeRef(envShPath)}"`) || text.includes(`. "${envShPath}"`)) {
      console.log(`  ${rc}`);
      any = true;
    }
  }
  const fishConfPath = fishConfFilePath();
  if (existsSync(fishConfPath)) {
    console.log(`  ${fishConfPath}`);
    any = true;
  }
  if (!any) console.log('  (nothing — run `teamclaude shim install`)');
}

// ── rc-edit primitives ────────────────────────────────────────

// Should we add a source line to this rc file? Yes if:
//   1. The file already exists (user uses this shell), OR
//   2. The file matches the user's current $SHELL (so first install creates it).
// This avoids creating .bashrc on a zsh-only machine.
function shouldTouchRc(rcPath) {
  if (existsSync(rcPath)) return true;
  const shell = (process.env.SHELL || '').split('/').pop();
  const base = rcPath.split('/').pop();
  if (shell === 'zsh' && base === '.zshrc') return true;
  if (shell === 'bash' && (base === '.bashrc' || base === '.bash_profile')) return true;
  return false;
}

function sourceLineFor(envShPath) {
  return `. "${homeRef(envShPath)}"`;
}

function appendSourceLine(rcPath, envShPath) {
  const line = sourceLineFor(envShPath);
  const altLine = `. "${envShPath}"`; // legacy/absolute form for detection
  let text = '';
  try { text = readFileSync(rcPath, 'utf8'); } catch { /* file may not exist */ }

  if (text.includes(line) || text.includes(altLine)) return false; // already wired

  const block = `\n${RC_COMMENT}\n${line}\n`;
  if (text && !text.endsWith('\n')) text += '\n';
  text += block;
  writeFileSync(rcPath, text);
  return true;
}

function stripSourceLine(rcPath, envShPath) {
  const text = readFileSync(rcPath, 'utf8');
  const line = sourceLineFor(envShPath);
  const altLine = `. "${envShPath}"`;
  if (!text.includes(line) && !text.includes(altLine)) return false;

  // Match: optional leading newline, our comment line, the source line,
  // optional trailing newline. Keep the rest intact.
  const re = new RegExp(
    `\\n?${escapeRe(RC_COMMENT)}\\n(?:${escapeRe(line)}|${escapeRe(altLine)})\\n?`,
    'g'
  );
  let cleaned = text.replace(re, '\n');
  // Belt-and-suspenders: also strip a bare source line not preceded by our comment.
  const bareRe = new RegExp(`\\n?(?:${escapeRe(line)}|${escapeRe(altLine)})\\n?`, 'g');
  cleaned = cleaned.replace(bareRe, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  writeFileSync(rcPath, cleaned);
  return true;
}

function fishConfContent(envFishPath) {
  return `${RC_COMMENT}\nsource "${homeRef(envFishPath)}"\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
