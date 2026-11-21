import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, atomicConfigUpdate, loadConfigPersistingIds, loadConfigEnsuringIds } from '../src/config.js';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

// A running account finds its config row by entry id when it saves a refreshed
// token. A row written without an id is given a fresh one by every read, so an
// account built from one read pairs with nothing the next read sees, and its
// refreshed tokens never reach the file (#564). The id is minted where a row is
// written, and a reader that builds accounts writes back any id it had to mint.

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

const idsOn = async (/** @type {string} */ path) => JSON.parse(await readFile(path, 'utf8')).accounts.map((/** @type {any} */ a) => a.id);

test('a row added through atomicConfigUpdate is written with an id, and every read sees that id', async () => {
  await withConfig({ accounts: [{ id: 'first', name: 'a', type: 'apikey', apiKey: 'k1' }] }, async (path) => {
    // What `teamclaude login` does: push a new entry built without an id.
    await atomicConfigUpdate(c => { c.accounts.push({ name: 'b', type: 'apikey', apiKey: 'k2' }); });
    const [first, added] = await idsOn(path);
    assert.equal(first, 'first', 'an existing id is kept');
    assert.ok(typeof added === 'string' && added.length > 0, 'the new row carries an id on disk');
    assert.equal((await loadConfig()).accounts[1].id, added);
    assert.equal((await loadConfig()).accounts[1].id, added, 'a second read sees the same one');
  });
});

test('loadConfigPersistingIds writes back an id it minted for a hand-added row', async () => {
  await withConfig({ accounts: [{ id: 'first', name: 'a', type: 'apikey', apiKey: 'k1' }, { name: 'b', type: 'apikey', apiKey: 'k2' }] }, async (path) => {
    const config = await loadConfigPersistingIds();
    const minted = config.accounts[1].id;
    assert.ok(minted);
    assert.deepEqual(await idsOn(path), ['first', minted], 'the id handed out is the one on disk');
    assert.equal((await loadConfig()).accounts[1].id, minted);
  });
});

test('loadConfigPersistingIds leaves a file that already carries every id byte for byte', async () => {
  await withConfig({ accounts: [{ id: 'x', name: 'a', type: 'apikey', apiKey: 'k1' }] }, async (path) => {
    const before = await readFile(path, 'utf8');
    await loadConfigPersistingIds();
    assert.equal(await readFile(path, 'utf8'), before);
  });
});

// loadConfigEnsuringIds decides on a read taken without the lock whether there
// is anything to write. A shared id is as much a missing one as an absent id:
// both are re-minted in memory, and the file has to carry what memory holds.
test('loadConfigEnsuringIds writes a fresh id over one that two rows share', async () => {
  await withConfig({ upstreamProxy: false, accounts: [{ id: 'same', name: 'a', type: 'apikey', apiKey: 'k1' }, { id: 'same', name: 'b', type: 'apikey', apiKey: 'k2' }] }, async (path) => {
    const ids = (await loadConfigEnsuringIds()).accounts.map((/** @type {any} */ a) => a.id);
    assert.equal(ids[0], 'same', 'the first keeps its id');
    assert.notEqual(ids[1], 'same');
    assert.deepEqual(await idsOn(path), ids, 'the ids handed out are the ones on disk');
  });
});

// The copy handed out without the lock is made the way loadConfig makes one.
test('loadConfigEnsuringIds reads a file with no accounts key as an empty list', async () => {
  await withConfig({ upstreamProxy: false }, async () => {
    assert.deepEqual((await loadConfigEnsuringIds()).accounts, []);
  });
});

test('loadConfigPersistingIds answers null when there is no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-config-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'absent.json');
  try {
    assert.equal(await loadConfigPersistingIds(), null);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev;
  }
});

test('a row added while the server runs has its id on disk after the reload that picks it up', async () => {
  // Nothing here sends a request upstream; a closed port makes sure of it.
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port, configPath } = server;
  try {
    // An id-less row, as a hand edit or an older CLI writes it.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.accounts.push({ name: 'b', type: 'apikey', apiKey: 'k2' });
    await writeFile(configPath, JSON.stringify(edited));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.added, 1, 'the reload picked the row up');

    const ids = await idsOn(configPath);
    assert.ok(typeof ids[1] === 'string' && ids[1].length > 0, `the picked-up row carries an id on disk: ${JSON.stringify(ids)}`);
    // A second reload must not mint again: the row's id is settled.
    const again = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(again.status, 200);
    assert.deepEqual(await idsOn(configPath), ids);
  } finally {
    await server.stop();
  }
});
