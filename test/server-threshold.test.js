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
 * a test can tell "saved" from "applied"; pass `reload` to override it, and
 * `proxy` to give the running server a different proxy section (client keys).
 */
async function withServer(fn, { configExtra = {}, reload, proxy = { apiKey: 'tc-test' } } = {}) {
  const path = await writeConfig(configExtra);
  const previous = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  const reloads = { count: 0 };
  const am = new AccountManager(ACCTS, 0.98);
  const hooks = reload === null ? {} : {
    reload: reload || (async () => { reloads.count++; return 0; }),
  };
  const server = createProxyServer(am, { proxy, upstream: 'https://api.anthropic.com' }, hooks);
  const port = await listen(server);
  try {
    await fn({ port, path, reloads, am });
  } finally {
    server.close();
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

test('a server with no reload hook refuses up front and writes nothing', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ percent: 93 }));
    // Saved-but-never-applied is worse than refused: the file would claim a
    // number the running fleet ignored. Same answer /probe gives with no prober.
    assert.equal(res.status, 501);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /not supported/);
    assert.equal(await readStored(path), 0.95, 'nothing may be written when it cannot be applied');
  }, { reload: null, configExtra: { switchThreshold: 0.95 } });
});

// A client key names a tenant of the proxy, not its operator. It may spend
// quota and read status, but a setting that governs every account — and can
// take the whole fleet out of rotation — is the operator's alone. The shared
// proxy key is the operator's own and stays allowed, as does the key-exempt
// loopback caller every other test here uses.
test('a client key is refused; the shared proxy key is not', async () => {
  const send = (port, key) => fetch(`http://127.0.0.1:${port}/teamclaude/threshold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ percent: 50 }),
  });
  await withServer(async ({ port, path, reloads }) => {
    const refused = await send(port, 'ci-key');
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /client key/);
    assert.equal(await readStored(path), 0.95, 'a refused request must not have written the file');
    assert.equal(reloads.count, 0, 'a refused request must not have been applied');

    const allowed = await send(port, 'tc-test');
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).switchThreshold, 0.5);
    assert.equal(await readStored(path), 0.5);
    assert.equal(reloads.count, 1);
  }, {
    configExtra: { switchThreshold: 0.95 },
    proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] },
  });
});

test('the endpoint answers only to POST', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/threshold`);
    // An unclaimed control route: the server's catch-all, not a method error.
    assert.equal(res.status, 404);
  });
});
