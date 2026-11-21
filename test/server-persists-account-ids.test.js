import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

// The server persists refreshed tokens by re-reading the config and finding the
// account's row by entry id — and by id only, since identity is not one-to-one
// (#203). A config written before ids existed has them in memory only, and the
// re-read would mint a different set, so nothing would pair until a restart and
// refreshed tokens would never reach disk. Startup therefore writes the ids it
// minted, once, so the in-memory ids are the on-disk ids.

// Starts the server on `config`, stops it once it is up, and returns what the
// file holds afterwards — plus the exact bytes the harness wrote before the
// server ran, which is the reference for "the server did not touch the file".
async function runServerOnce(config, dir) {
  const srv = await spawnServer({ config: () => config, dir });
  try {
    return { onDisk: await readFile(srv.configPath, 'utf8'), written: JSON.stringify(srv.config), dir: srv.dir };
  } finally {
    await srv.stop();
  }
}

test('a server started on a config without entry ids writes them to disk, once', async () => {
  const first = await runServerOnce({
    proxy: { apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [
      { name: 'a', type: 'apikey', apiKey: 'k1' },
      { name: 'b', type: 'apikey', apiKey: 'k2', id: 'dup' },
      { name: 'c', type: 'apikey', apiKey: 'k3', id: 'dup' }, // a hand-copied section: re-minted
    ],
  });
  const saved = JSON.parse(first.onDisk);
  const ids = saved.accounts.map(a => a.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), `every row carries an id: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, 'and no two rows share one');
  assert.deepEqual(saved.accounts.map(a => a.name), ['a', 'b', 'c'], 'nothing else about the rows changed');

  // A file that already carries a complete set is left exactly as it is: the
  // ids must be stable, or the next start would break every pairing again.
  // The harness writes the file compact and the server's save is indented, so
  // the bytes still reading as written is the witness for "no rewrite".
  const second = await runServerOnce(saved, first.dir);
  assert.deepEqual(JSON.parse(second.onDisk).accounts.map(a => a.id), ids);
  assert.equal(second.onDisk, second.written, 'no rewrite when the ids are already on disk');
});

// Missing ids are written under the config lock, to the file as it is then.
// The server used to save the copy it read at startup, outside the lock, over
// the whole file, so anything another writer saved after that read was lost:
// here a login adding an account, whose save carries ids, so the server finds
// none left to write. test-helpers/config-race.js stages that save at the
// server's first attempt to take the lock, which is after its opening read.
test('a server started on a file without ids keeps what another writer saved before its locked read', async () => {
  const racePreload = new URL('../test-helpers/config-race.js', import.meta.url).href;
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-ids-race-'));
  const racePath = join(dir, 'server-save.json');
  const rows = () => [{ name: 'a', type: 'apikey', apiKey: 'k1' }, { name: 'b', type: 'apikey', apiKey: 'k2' }];
  const srv = await spawnServer({
    dir,
    config: port => {
      const base = { proxy: { apiKey: 'tc-test', port }, upstream: 'https://api.anthropic.com', upstreamProxy: false };
      // The other writer's save, with ids, as every locked write leaves them.
      const login = { ...base, accounts: [...rows().map(a => ({ ...a, id: `${a.name}-id` })), { id: 'c-id', name: 'c', type: 'apikey', apiKey: 'k3' }] };
      writeFileSync(racePath, JSON.stringify(login));
      return { ...base, accounts: rows() };
    },
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${racePreload}`].filter(Boolean).join(' '),
      TEAMCLAUDE_TEST_RACE_WITH: racePath,
    },
  });
  try {
    assert.equal(existsSync(racePath), false, 'the other save was staged between the read and the lock');
    const saved = JSON.parse(await readFile(srv.configPath, 'utf8'));
    assert.deepEqual(saved.accounts.map(a => `${a.id}:${a.name}`), ['a-id:a', 'b-id:b', 'c-id:c']);
    // And the server runs that read, the one whose ids its token writes pair by.
    const res = await fetch(`http://127.0.0.1:${srv.port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.deepEqual((await res.json()).accounts.map(a => a.name), ['a', 'b', 'c']);
  } finally {
    await srv.stop();
  }
});

// A server started on a file that carries every id has nothing to write at
// startup, and takes no lock for it. Staged the same way: the save renamed in at
// the first attempt to take the lock is still in place once the server answers.
test('a server started on a file that carries every id takes no config lock', async () => {
  const racePreload = new URL('../test-helpers/config-race.js', import.meta.url).href;
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-ids-nolock-'));
  const racePath = join(dir, 'server-save.json');
  const srv = await spawnServer({
    dir,
    config: port => {
      const config = {
        proxy: { apiKey: 'tc-test', port }, upstream: 'https://api.anthropic.com', upstreamProxy: false,
        accounts: [{ id: 'a-id', name: 'a', type: 'apikey', apiKey: 'k1' }, { id: 'b-id', name: 'b', type: 'apikey', apiKey: 'k2' }],
      };
      writeFileSync(racePath, JSON.stringify(config));
      return config;
    },
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${racePreload}`].filter(Boolean).join(' '),
      TEAMCLAUDE_TEST_RACE_WITH: racePath,
    },
  });
  try {
    assert.equal(existsSync(racePath), true, 'the server attempted to take the config lock at startup');
    assert.equal(await readFile(srv.configPath, 'utf8'), JSON.stringify(srv.config), 'and wrote nothing');
  } finally {
    await srv.stop();
  }
});
