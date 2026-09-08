import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config holds every account's OAuth tokens and the proxy key. A save that
// truncates in place leaves nothing behind if the process dies mid-write; a
// save must therefore replace the file whole or not at all, and must not leave
// a half-written copy of the credentials beside it.

async function withConfigDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-atomic-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const cfg = await import('../src/config.js');
    await fn({ dir, cfg, path: process.env.TEAMCLAUDE_CONFIG });
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
}

const onPosix = process.platform !== 'win32';

test('saveConfig writes the whole document and leaves no temp file behind', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    const config = { proxy: { port: 1, apiKey: 'tc-secret' }, accounts: [{ name: 'a', refreshToken: 'rt' }] };
    await cfg.saveConfig(config);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), config);
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'only the config itself is on disk');
    if (onPosix) assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('saveConfig replaces a pre-existing file and tightens its mode', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await writeFile(path, '{"old":true}\n');
    if (onPosix) await chmod(path, 0o644);
    await cfg.saveConfig({ fresh: true });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
    if (onPosix) assert.equal((await stat(path)).mode & 0o777, 0o600, 'a world-readable config becomes 0600 on save');
  });
});

test('saveState is atomic the same way', async () => {
  await withConfigDir(async ({ dir, cfg }) => {
    const statePath = cfg.getStatePath();
    await cfg.saveState({ quota: { a: 1 } });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { quota: { a: 1 } });
    assert.deepEqual(await readdir(dir), ['teamclaude.state.json']);
    if (onPosix) assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  });
});

test('a save that cannot complete leaves the previous config intact and no temp file', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await cfg.saveConfig({ good: true });
    // A BigInt cannot be serialized: the failure happens before anything is
    // written, and the file on disk must still be the last complete document.
    await assert.rejects(cfg.saveConfig({ bad: 1n }), TypeError);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), { good: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'no temp file is left beside the config');
  });
});

test('the round trip through loadConfig reads back what saveConfig wrote', async () => {
  await withConfigDir(async ({ cfg }) => {
    const config = cfg.createDefaultConfig();
    config.accounts.push({ name: 'a', type: 'oauth', accessToken: 'at', refreshToken: 'rt' });
    await cfg.saveConfig(config);
    const loaded = await cfg.loadConfig();
    assert.equal(loaded.proxy.apiKey, config.proxy.apiKey);
    assert.equal(loaded.accounts[0].refreshToken, 'rt');
  });
});
