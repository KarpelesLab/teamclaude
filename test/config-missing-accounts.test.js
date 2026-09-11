import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, atomicConfigUpdate } from '../src/config.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// A config.json without an `accounts` key is what an empty or hand-trimmed
// file looks like. The load is where it first enters memory, so the load is
// where a missing list becomes an empty one — every reader downstream, the
// save path included, assumes the list exists (#330).

async function withConfig(raw, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(raw));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  try {
    await fn(path);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev;
  }
}

test('a config with no accounts key loads with an empty list', async () => {
  await withConfig({ proxy: { port: 3456 } }, async () => {
    const config = await loadConfig();
    assert.deepEqual(config.accounts, []);
    assert.equal(config.proxy.port, 3456, 'the rest of the file is untouched');
  });
});

test('an accounts key that is not a list is treated as empty rather than crashing', async () => {
  await withConfig({ accounts: null }, async () => {
    assert.deepEqual((await loadConfig()).accounts, []);
  });
  await withConfig({ accounts: { name: 'not-a-list' } }, async () => {
    assert.deepEqual((await loadConfig()).accounts, []);
  });
});

test('the save path survives a config with no accounts key', async () => {
  await withConfig({ proxy: { port: 3456 } }, async (path) => {
    const inMemory = [{ id: 'i1', name: 'a', type: 'apikey', apiKey: 'k' }];
    await atomicConfigUpdate(disk => {
      disk.accounts = mergeAccountsForSave(inMemory, [], disk.accounts);
    });
    const written = JSON.parse(await readFile(path, 'utf-8'));
    assert.deepEqual(written.accounts.map(a => a.name), ['a']);
    assert.equal(written.proxy.port, 3456);
  });
});
