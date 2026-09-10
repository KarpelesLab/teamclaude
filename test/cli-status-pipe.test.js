import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude status --json` is read through a pipe by anything that is not a
// terminal (`| jq`, a script), and process.stdout.write is asynchronous on a
// pipe: the process.exit that follows the write used to cut the payload to its
// first few hundred bytes. The status served here is bigger than any pipe
// buffer, so a truncated write cannot hide behind a lucky synchronous flush.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function bigStatus() {
  const reset = Date.now() + 3_600_000;
  const accounts = Array.from({ length: 400 }, (_, i) => ({
    name: `account-${i}@example.com`, type: 'oauth', orgName: `Org ${i}`, priority: 0, disabled: false,
    status: 'active', sessions: 0,
    quota: { unified5h: 0.4, unified5hReset: reset, unified7d: 0.2, unified7dReset: reset },
    usage: { totalRequests: i }, rateLimitedUntil: null, pausedUntil: null,
  }));
  return {
    server: { startedAt: new Date(reset - 3_600_000).toISOString(), uptimeSeconds: 42, port: 3456 },
    probe: { enabled: false, intervalSeconds: 0, running: false, accounts: [] },
    warm: { enabled: false, intervalSeconds: 0, running: false, accounts: [] },
    currentAccount: accounts[0].name,
    switchThreshold: 0.98,
    sessions: { active: 0, known: 0, distribute: false, perAccount: {} },
    routes: [],
    accounts,
  };
}

async function fakeControlPlane(status) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
    if (req.method !== 'GET' || req.url !== '/teamclaude/status') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return { seen, port: server.address().port, close };
}

async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-status-pipe-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));
  return { dir, path };
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('status --json through a pipe delivers the whole payload before exiting', async () => {
  const status = bigStatus();
  const expected = JSON.stringify(status, null, 2);
  assert.ok(Buffer.byteLength(expected) > 64 * 1024, 'fixture must outgrow the pipe buffer to prove anything');

  const fake = await fakeControlPlane(status);
  const config = await writeConfig(fake.port);
  try {
    const res = await runCli(config.path, ['status', '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(fake.seen, [{ method: 'GET', url: '/teamclaude/status', key: 'tc-test' }]);
    assert.equal(res.stdout.length, expected.length + 1, `got ${res.stdout.length} of ${expected.length + 1} bytes`);
    assert.deepEqual(JSON.parse(res.stdout), status);
  } finally {
    await fake.close();
    await rm(config.dir, { recursive: true, force: true });
  }
});
