import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasLine, rcPathForShell, installAlias, uninstallAlias } from '../src/alias.js';

test('aliasLine uses the right syntax per shell', () => {
  assert.equal(aliasLine('bash'), "alias claude='teamclaude run --'");
  assert.equal(aliasLine('zsh'), "alias claude='teamclaude run --'");
  assert.equal(aliasLine('fish'), "alias claude 'teamclaude run --'");
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
    assert.ok(text.includes("alias claude='teamclaude run --'"));
    assert.ok(text.includes('# existing user content')); // preserved

    // Idempotent: a second install doesn't duplicate the line.
    installAlias({ shell: 'bash', rcPath });
    text = await readFile(rcPath, 'utf8');
    assert.equal(text.match(/alias claude=/g).length, 1);

    // Uninstall restores the original content (no alias, no marker).
    uninstallAlias({ shell: 'bash', rcPath });
    text = await readFile(rcPath, 'utf8');
    assert.ok(!text.includes('alias claude='));
    assert.ok(!text.includes('# teamclaude alias'));
    assert.ok(text.includes('export FOO=1')); // user content intact
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
