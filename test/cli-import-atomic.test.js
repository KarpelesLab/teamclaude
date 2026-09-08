import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude import` (and `login`) load the config, spend a while on the
// network — a browser flow can take minutes — and then save. A running server
// may rotate another account's refresh token on disk in between; saving the
// copy loaded before that put the OLD refresh token back, which is dead by then,
// and that account was lost on its next restart. The save has to re-read the
// file and touch only the account being added.
//
// The window is made deterministic here: the CLI's profile fetch is routed
// through a fake CONNECT proxy (config.upstreamProxy), and that proxy plays the
// running server — it rewrites the config while the CLI is between its load and
// its save, then fails the fetch. `--name` keeps the import going without a
// profile, exactly as it does for a real machine that cannot reach Anthropic.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const baseConfig = (proxyPort) => ({
  proxy: { port: 3, apiKey: 'tc-test' }, // nothing listens on 3: the reload notify is a no-op
  upstream: 'https://api.anthropic.com',
  upstreamProxy: `http://127.0.0.1:${proxyPort}`,
  accounts: [{
    id: 'y-id', name: 'y@example.com', type: 'oauth', accountUuid: 'uy', orgUuid: 'oy',
    accessToken: 'y-at-old', refreshToken: 'y-rt-old', expiresAt: Date.now() + 3_600_000,
  }],
});

function runCli(configPath, cliArgs) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  // A NO_PROXY naming api.anthropic.com would send the fetch around the fake
  // proxy — and around the synchronisation point this test is built on.
  delete env.NO_PROXY; delete env.no_proxy;
  const child = spawn(process.execPath, [cliPath, ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit\n${stdout}\n${stderr}`)); }, 20_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('import saves onto a fresh read of the config, not the copy it loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-import-'));
  const configPath = join(dir, 'config.json');

  let connects = 0;
  const proxy = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
  proxy.on('connect', (req, socket) => {
    connects++;
    // The CLI has loaded its config by now and is about to save. Rotate the
    // other account's refresh token the way a running server would...
    const rotated = baseConfig(proxy.address().port);
    rotated.accounts[0].refreshToken = 'y-rt-rotated';
    rotated.accounts[0].accessToken = 'y-at-rotated';
    writeFile(configPath, JSON.stringify(rotated)).then(() => {
      // ...then fail the profile fetch; the named import carries on without it.
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));

  try {
    await writeFile(configPath, JSON.stringify(baseConfig(proxy.address().port)));
    const creds = JSON.stringify({ accessToken: 'z-at', refreshToken: 'z-rt', expiresAt: Date.now() + 3_600_000 });
    const res = await runCli(configPath, ['import', '--json', creds, '--name', 'z']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(connects >= 1, 'the profile fetch went through the fake proxy');
    assert.match(res.stdout, /Added account "z"/);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    const y = saved.accounts.find(a => a.id === 'y-id');
    // The row the CLI never touched keeps what the "server" wrote — before,
    // y-rt-old came back and killed the account on its next restart.
    assert.equal(y.refreshToken, 'y-rt-rotated');
    assert.equal(y.accessToken, 'y-at-rotated');
    const z = saved.accounts.find(a => a.name === 'z');
    assert.equal(z.type, 'oauth');
    assert.equal(z.accessToken, 'z-at');
    assert.equal(z.refreshToken, 'z-rt');
    assert.equal(z.source, 'import');
    assert.equal(saved.accounts.length, 2);
  } finally {
    proxy.close();
  }
});
