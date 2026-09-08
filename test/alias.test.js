import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasLine, rcPathForShell, teamclaudeRef, installAlias, uninstallAlias } from '../src/alias.js';

test('aliasLine uses the right syntax per shell (explicit ref)', () => {
  assert.equal(aliasLine('bash', 'teamclaude'), "alias claude='teamclaude run --'");
  assert.equal(aliasLine('zsh', 'teamclaude'), "alias claude='teamclaude run --'");
  assert.equal(aliasLine('fish', 'teamclaude'), "alias claude 'teamclaude run --'");
});

test('aliasLine embeds a quoted absolute path when teamclaude is not on PATH', () => {
  assert.equal(aliasLine('bash', '"/opt/tc/index.js"'), `alias claude='"/opt/tc/index.js" run --'`);
  assert.equal(aliasLine('fish', '"/opt/tc/index.js"'), `alias claude '"/opt/tc/index.js" run --'`);
});

// A `'` in the embedded path used to terminate the single-quoted alias body:
// alias claude='"/home/o'brien/tc/src/index.js" run --' is a broken alias.
test("aliasLine survives a ' in the embedded path, in bash and in fish", () => {
  const ref = `"/home/o'brien/tc/index.js"`;
  assert.equal(aliasLine('bash', ref), `alias claude='"/home/o'"'"'brien/tc/index.js" run --'`);
  assert.equal(aliasLine('fish', ref), `alias claude '"/home/o'"'"'brien/tc/index.js" run --'`);
});

// The proof is the shell: define the alias, run it, and see the script at the
// awkward path receive the arguments.
test('an alias with a quote and a space in the path runs the script under bash', async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-o'brien has space-"));
  try {
    const script = join(dir, 'index.js');
    writeFileSync(script, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
    chmodSync(script, 0o755);
    const ref = `"${script.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
    const line = aliasLine('bash', ref);
    const result = spawnSync('bash', ['-O', 'expand_aliases', '-c', `${line}\nclaude one "two words"`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'run|--|one|two words|');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaudeRef escapes what the shell reads inside double quotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-path-'));
  const prev = { PATH: process.env.PATH, argv1: process.argv[1] };
  try {
    process.env.PATH = dir; // no teamclaude on PATH → embed argv[1]
    process.argv[1] = '/opt/we$ird"dir\\x/index.js';
    assert.equal(teamclaudeRef(), '"/opt/we\\$ird\\"dir\\\\x/index.js"');
  } finally {
    process.env.PATH = prev.PATH;
    process.argv[1] = prev.argv1;
    await rm(dir, { recursive: true, force: true });
  }
});

// The rc file is replaced by rename, so a crash mid-write cannot leave a
// truncated .bashrc — and the file keeps its mode.
test('install and uninstall replace the rc file whole, keeping its mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-alias-'));
  const rcPath = join(dir, '.bashrc');
  await writeFile(rcPath, 'export FOO=1\n');
  chmodSync(rcPath, 0o600);
  try {
    const before = statSync(rcPath).ino;
    installAlias({ shell: 'bash', rcPath });
    assert.notEqual(statSync(rcPath).ino, before, 'a new inode: written beside and renamed over');
    assert.equal(statSync(rcPath).mode & 0o777, 0o600);
    assert.match(await readFile(rcPath, 'utf8'), /alias claude=/);
    uninstallAlias({ shell: 'bash', rcPath });
    assert.equal(statSync(rcPath).mode & 0o777, 0o600);
    assert.equal(await readFile(rcPath, 'utf8'), 'export FOO=1\n');
    // No temp file left behind either way.
    assert.deepEqual(readdirSync(dir), ['.bashrc']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaudeRef returns the bare command when it is on PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-path-'));
  const prev = process.env.PATH;
  try {
    const bin = join(dir, 'teamclaude');
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    process.env.PATH = dir;
    assert.equal(teamclaudeRef(), 'teamclaude');
  } finally {
    process.env.PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaudeRef falls back to a quoted absolute path when not on PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-path-'));
  const prev = process.env.PATH;
  try {
    process.env.PATH = dir; // empty dir → no teamclaude
    const ref = teamclaudeRef();
    assert.match(ref, /^".*"$/);          // quoted
    assert.ok(ref.includes('/'));          // an absolute-ish path, not the bare command
    assert.notEqual(ref, 'teamclaude');
  } finally {
    process.env.PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('rcPathForShell maps shells to their rc files', () => {
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = '/home/u';
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(rcPathForShell('bash'), '/home/u/.bashrc');
    assert.equal(rcPathForShell('zsh'), '/home/u/.zshrc');
    assert.equal(rcPathForShell('sh'), '/home/u/.profile');
    assert.equal(rcPathForShell('fish'), '/home/u/.config/fish/conf.d/teamclaude.fish');
  } finally {
    process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test('install adds the alias, is idempotent, and uninstall removes it cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-alias-'));
  const rcPath = join(dir, '.bashrc');
  await writeFile(rcPath, '# existing user content\nexport FOO=1\n');
  try {
    installAlias({ shell: 'bash', rcPath });
    let text = await readFile(rcPath, 'utf8');
    assert.match(text, /alias claude=.*run --/);
    assert.ok(text.includes('# teamclaude alias'));
    assert.ok(text.includes('# existing user content')); // preserved

    // Idempotent: a second install doesn't duplicate the line.
    installAlias({ shell: 'bash', rcPath });
    text = await readFile(rcPath, 'utf8');
    assert.equal(text.match(/alias claude=/g).length, 1);

    // Uninstall removes our block; user content stays intact.
    uninstallAlias({ shell: 'bash', rcPath });
    text = await readFile(rcPath, 'utf8');
    assert.ok(!text.includes('alias claude='));
    assert.ok(!text.includes('# teamclaude alias'));
    assert.ok(text.includes('export FOO=1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uninstall removes our block even if the embedded path differs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-alias-'));
  const rcPath = join(dir, '.bashrc');
  // Simulate a previously-installed alias with an absolute path that no longer
  // matches what teamclaudeRef() would compute now.
  await writeFile(rcPath, 'export FOO=1\n# teamclaude alias\nalias claude=\'"/old/path/index.js" run --\'\n');
  try {
    uninstallAlias({ shell: 'bash', rcPath });
    const text = await readFile(rcPath, 'utf8');
    assert.ok(!text.includes('alias claude='));
    assert.ok(!text.includes('# teamclaude alias'));
    assert.ok(text.includes('export FOO=1'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uninstall of a dedicated fish drop-file removes the file when empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-alias-'));
  const rcPath = join(dir, 'teamclaude.fish');
  try {
    installAlias({ shell: 'fish', rcPath });
    assert.ok(existsSync(rcPath));
    uninstallAlias({ shell: 'fish', rcPath });
    assert.ok(!existsSync(rcPath)); // emptied → removed
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
