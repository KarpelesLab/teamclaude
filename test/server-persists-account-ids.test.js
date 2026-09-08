import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The server persists refreshed tokens by re-reading the config and finding the
// account's row by entry id — and by id only, since identity is not one-to-one
// (#203). A config written before ids existed has them in memory only, and the
// re-read would mint a different set, so nothing would pair until a restart and
// refreshed tokens would never reach disk. Startup therefore writes the ids it
// minted, once, so the in-memory ids are the on-disk ids.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(configPath) {
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const stop = async () => {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.on('exit', resolve));
    }
    clearTimeout(killer);
  };
  return { stop, output: () => output };
}

async function waitForServer(port, childOutput) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${childOutput()}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function runServerOnce(configPath, port) {
  const srv = startServer(configPath);
  try {
    await waitForServer(port, srv.output);
  } finally {
    await srv.stop();
  }
  return JSON.parse(await readFile(configPath, 'utf8'));
}

test('a server started on a config without entry ids writes them to disk, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-ids-'));
  const configPath = join(dir, 'config.json');
  const port = await closedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [
      { name: 'a', type: 'apikey', apiKey: 'k1' },
      { name: 'b', type: 'apikey', apiKey: 'k2', id: 'dup' },
      { name: 'c', type: 'apikey', apiKey: 'k3', id: 'dup' }, // a hand-copied section: re-minted
    ],
  }));

  const first = await runServerOnce(configPath, port);
  const ids = first.accounts.map(a => a.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), `every row carries an id: ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, 'and no two rows share one');
  assert.deepEqual(first.accounts.map(a => a.name), ['a', 'b', 'c'], 'nothing else about the rows changed');

  // A file that already carries a complete set is left exactly as it is: the
  // ids must be stable, or the next start would break every pairing again.
  const before = (await stat(configPath)).mtimeMs;
  const second = await runServerOnce(configPath, port);
  assert.deepEqual(second.accounts.map(a => a.id), ids);
  assert.equal((await stat(configPath)).mtimeMs, before, 'no rewrite when the ids are already on disk');
});
