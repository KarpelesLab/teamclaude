import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/threshold is what the dashboard's "Switch at __ %" control
// sends, and the headless equivalent of `teamclaude threshold <1-100>`. Unlike
// /switch, which only moves the manager's currentIndex, this is a SETTING: it
// goes through the config file and a reload applies it, so the two halves —
// what landed on disk and what the running fleet now uses — are asserted
// separately throughout. Every test points TEAMCLAUDE_CONFIG at a throwaway
// file, so the operator's real config is never touched.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
];

async function writeConfig(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-http-threshold-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    accounts: ACCTS,
    ...extra,
  }));
  return path;
}

async function readStored(path) {
  return JSON.parse(await readFile(path, 'utf-8')).switchThreshold;
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/threshold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * A server whose config file is a throwaway. `reloads` counts the hook calls so
 * a test can tell "saved" from "applied"; pass `reload` to override it.
 */
async function withServer(fn, { configExtra = {}, reload } = {}) {
  const path = await writeConfig(configExtra);
  const previous = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  const reloads = { count: 0 };
  const am = new AccountManager(ACCTS, 0.98);
  const hooks = reload === null ? {} : {
    reload: reload || (async () => { reloads.count++; return 0; }),
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, hooks);
  const port = await listen(proxy);
  try {
    await fn({ port, path, reloads, am });
  } finally {
    proxy.close();
    if (previous === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previous;
  }
}

test('a percentage is stored as a ratio and the running server is reloaded', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const res = await post(port, JSON.stringify({ percent: 91 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.switchThreshold, 0.91);
    assert.deepEqual(res.body.dropped, []);
    assert.equal(await readStored(path), 0.91, 'the setting must survive a restart');
    assert.equal(reloads.count, 1, 'saving alone would leave the fleet on the old number');
  });
});

test('tenths are kept and the answer is the stored number, not the typed one', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ percent: 91.55 }));
    assert.equal(res.status, 200);
    // thresholdRatio quantises to tenths of a percent; the caller is told what
    // was actually stored so a re-save of the echoed value is a no-op.
    assert.equal(res.body.switchThreshold, 0.916);
    assert.equal(await readStored(path), 0.916);
  });
});

test('a percentage given as a string is accepted, as the CLI accepts one', async () => {
  await withServer(async ({ port, path }) => {
    assert.equal((await post(port, JSON.stringify({ percent: '85' }))).body.switchThreshold, 0.85);
    assert.equal(await readStored(path), 0.85);
  });
});

test('one number replaces a per-bucket table and names what it dropped', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ percent: 90 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.switchThreshold, 0.9);
    // The operator who set those buckets should hear they are gone rather than
    // find the number quietly governing everything.
    assert.deepEqual(res.body.dropped, ['unified7d']);
    assert.equal(await readStored(path), 0.9);
  }, { configExtra: { switchThreshold: { default: 0.98, unified7d: 0.8 } } });
});

test('a percentage out of range is refused and nothing is written', async () => {
  for (const percent of [0, 101, -5]) {
    await withServer(async ({ port, path, reloads }) => {
      const res = await post(port, JSON.stringify({ percent }));
      assert.equal(res.status, 400, `${percent} must be refused`);
      assert.equal(res.body.ok, false);
      assert.match(res.body.error, /1 to 100/);
      assert.equal(await readStored(path), 0.95, 'a refused percentage must not be written');
      assert.equal(reloads.count, 0);
    }, { configExtra: { switchThreshold: 0.95 } });
  }
});

test('a percentage that is not a number is refused', async () => {
  for (const percent of ['ninety', true, [95], null, undefined, {}]) {
    await withServer(async ({ port, path }) => {
      const res = await post(port, JSON.stringify({ percent }));
      assert.equal(res.status, 400, `${JSON.stringify(percent)} must be refused`);
      assert.equal(await readStored(path), 0.95);
    }, { configExtra: { switchThreshold: 0.95 } });
  }
});

test('a body that is not JSON is refused before the config lock is taken', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, 'not json');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(await readStored(path), 0.95);
  }, { configExtra: { switchThreshold: 0.95 } });
});

test('the write re-reads from disk, so a concurrent edit is not clobbered', async () => {
  await withServer(async ({ port, path }) => {
    // The server's in-memory config is not what gets written: another writer —
    // the CLI, the TUI, another session — may have edited the file since the
    // server started, and saving the whole in-memory object would undo it.
    const disk = JSON.parse(await readFile(path, 'utf-8'));
    disk.distributeSessions = 'adaptive';
    disk.accounts.push({ name: 'carol@example.com', type: 'apikey', apiKey: 'k3' });
    await writeFile(path, JSON.stringify(disk));

    assert.equal((await post(port, JSON.stringify({ percent: 88 }))).status, 200);

    const after = JSON.parse(await readFile(path, 'utf-8'));
    assert.equal(after.switchThreshold, 0.88);
    assert.equal(after.distributeSessions, 'adaptive', 'a concurrent edit must survive');
    assert.equal(after.accounts.length, 3, 'a concurrently added account must survive');
  });
});

test('a reload failure is reported as saved-but-not-applied', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ percent: 93 }));
    assert.equal(res.status, 500);
    assert.equal(res.body.ok, false);
    // The file has already changed; a bare "failed" would send the caller away
    // believing nothing happened, and the next restart would prove it wrong.
    assert.match(res.body.error, /saved/);
    assert.equal(await readStored(path), 0.93);
  }, { reload: async () => { throw new Error('boom'); } });
});

test('a server with no reload hook says the same thing', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ percent: 93 }));
    assert.equal(res.status, 500);
    assert.match(res.body.error, /saved/);
    assert.equal(await readStored(path), 0.93, 'it still applies on the next start');
  }, { reload: null });
});

test('the endpoint answers only to POST', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/threshold`);
    assert.notEqual(res.status, 200);
  });
});
