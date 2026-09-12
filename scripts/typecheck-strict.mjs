#!/usr/bin/env node
// The strict-mode ratchet.
//
// tsconfig.json checks src/ non-strict and must be clean; `strict: true` is the
// destination, and on this tree it reports a few thousand diagnostics, nearly
// all implicit `any`. This script keeps that number from growing while it is
// worked down, without a baseline file to maintain: it counts the strict
// diagnostics PER FILE on the current tree and on a base commit, and fails when
// any file has more now than it had there, or when a file the base did not
// have carries any at all.
//
//   npm run typecheck:strict                  base = merge-base with origin/master
//   npm run typecheck:strict -- --base <ref>  base = that commit
//
// CI passes the pre-merge commit: for a pull request the checkout is already
// the merge of the branch into master and the base is master's tip, so the two
// counts are exactly "before this merge" and "after it"; for a push to master
// the base is the previous tip. Per file rather than one total, so a change
// cannot add diagnostics in one place by removing some in another. A rename is
// followed (`git diff -M`), so a file carries its count to its new name.
//
// The base is checked out into a throwaway git worktree with this tree's
// node_modules linked in, so the same pinned `typescript` and `@types/node`
// judge both sides. A base that predates tsconfig.strict.json borrows this
// tree's copy.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

function git(...argv) {
  const r = spawnSync('git', argv, { encoding: 'utf8', cwd: root });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Strict diagnostics per file for the tree at `dir`, keyed by `src/...` path. */
function countAt(dir) {
  const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.strict.json'), '--pretty', 'false'], {
    encoding: 'utf8', cwd: dir, maxBuffer: 64 * 1024 * 1024,
  });
  // 2 is "there were diagnostics", the expected outcome. Anything else is tsc
  // itself failing (a bad config, a missing install), which must not read as
  // zero diagnostics.
  if (tsc.error || (tsc.status !== 0 && tsc.status !== 2)) {
    console.error(tsc.stderr || tsc.stdout || String(tsc.error));
    throw new Error(`tsc did not run in ${dir} (status ${tsc.status ?? tsc.error?.code})`);
  }
  /** @type {Record<string, number>} */
  const counts = {};
  for (const line of tsc.stdout.split('\n')) {
    const m = /^(src\/\S+?)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}

const base = baseArg || git('merge-base', 'HEAD', 'origin/master');
const baseSha = git('rev-parse', '--verify', `${base}^{commit}`);

// Renames between base and now, old path -> new path, so a moved file is
// compared with itself rather than read as one deletion and one new file.
/** @type {Record<string, string>} */
const renamed = {};
for (const line of git('diff', '--name-status', '-M', baseSha, 'HEAD', '--', 'src').split('\n')) {
  const m = /^R\d*\t(\S+)\t(\S+)$/.exec(line);
  if (m) renamed[m[1]] = m[2];
}

const work = mkdtempSync(join(tmpdir(), 'tc-strict-base-'));
let before;
try {
  git('worktree', 'add', '--detach', '--quiet', work, baseSha);
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
  for (const f of ['tsconfig.json', 'tsconfig.strict.json']) {
    if (!existsSync(join(work, f))) copyFileSync(join(root, f), join(work, f));
  }
  before = countAt(work);
} finally {
  try { git('worktree', 'remove', '--force', work); } catch { rmSync(work, { recursive: true, force: true }); }
}
const after = countAt(resolve(root));

/** @type {Record<string, number>} */
const was = {};
for (const [file, n] of Object.entries(before)) was[renamed[file] || file] = (was[renamed[file] || file] || 0) + n;

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const worse = [];
let dropped = 0;
for (const file of new Set([...Object.keys(was), ...Object.keys(after)])) {
  const b = was[file] || 0;
  const a = after[file] || 0;
  if (a > b) worse.push({ file, b, a });
  else dropped += b - a;
}

console.log(`typecheck-strict: ${sum(after)} strict-mode diagnostics (base ${baseSha.slice(0, 8)}: ${sum(before)})`);
if (worse.length === 0) {
  if (dropped) console.log(`typecheck-strict: ${dropped} fewer than the base. Nice.`);
  process.exit(0);
}
console.error('typecheck-strict: strict-mode diagnostics GREW in:');
for (const { file, b, a } of worse) console.error(`  ${file}: ${b} -> ${a}`);
console.error('');
console.error('Fix the new ones (see: npx tsc -p tsconfig.strict.json). The count per file');
console.error('may only stay or go down; a new file starts at zero.');
process.exit(1);
