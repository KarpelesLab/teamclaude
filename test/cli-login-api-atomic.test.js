import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude login --api` loads the config, waits on the key prompt for as long
// as the user takes, and then saves. A running server may rotate an OAuth
// account's refresh token on disk in between; saving the copy loaded before the
// prompt put the OLD token back, dead by then, and that account was lost on its
// next restart. The save has to re-read the file and add only the new row — and,
// like every other account writer, tell a running server about it, or the new
// key sits unused until the next reload.
//
// The prompt is the synchronisation point: once it shows on stderr the CLI has
// loaded its config and is parked on stdin, so the test rewrites the file the
// way a running server would, and only then types the key.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const baseConfig = (proxyPort) => ({
  proxy: { port: proxyPort, apiKey: 'tc-test' },
  upstream: 'https://api.anthropic.com',
  upstreamProxy: false,
  accounts: [{
    id: 'y-id', name: 'y@example.com', type: 'oauth', accountUuid: 'uy', orgUuid: 'oy',
    accessToken: 'y-at-old', refreshToken: 'y-rt-old', expiresAt: Date.now() + 3_600_000,
  }],
});

async function writeConfig(config) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-login-api-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return path;
}

// A port nothing is listening on: bind one, learn its number, give it back.
function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A stand-in running server that records what the CLI posts to it.
async function fakeServer(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, added: 1 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, port: server.address().port };
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit\n${stdout}\n${stderr}`)); }, 20_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // Settles once the CLI is parked on the key prompt — or fails if it exits first.
  const prompted = new Promise((resolve, reject) => {
    child.stderr.on('data', c => {
      stderr += c;
      if (stderr.includes('Anthropic API key:')) resolve();
    });
    done.then(() => reject(new Error(`CLI exited before prompting\n${stdout}\n${stderr}`)), reject);
  });
  const answer = key => child.stdin.end(`${key}\n`);
  return { prompted, answer, done };
}

test('login --api saves onto a fresh read of the config, not the copy it loaded', async () => {
  const port = await closedPort(); // nothing listens: the reload notify is a no-op
  const configPath = await writeConfig(baseConfig(port));

  const cli = runCli(configPath, ['login', '--api', '--name', 'api-test']);
  await cli.prompted;
  // The CLI has loaded its config and is waiting on the key. Rotate the other
  // account's refresh token the way a running server would...
  const rotated = baseConfig(port);
  rotated.accounts[0].refreshToken = 'y-rt-rotated';
  rotated.accounts[0].accessToken = 'y-at-rotated';
  await writeFile(configPath, JSON.stringify(rotated));
  // ...then type the key.
  cli.answer('sk-ant-test-key');
  const res = await cli.done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Added API key account "api-test"/);

  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  const y = saved.accounts.find(a => a.id === 'y-id');
  // The row the CLI never touched keeps what the "server" wrote — before,
  // y-rt-old came back and killed the account on its next restart.
  assert.equal(y.refreshToken, 'y-rt-rotated');
  assert.equal(y.accessToken, 'y-at-rotated');
  const added = saved.accounts.find(a => a.name === 'api-test');
  assert.equal(added.type, 'apikey');
  assert.equal(added.apiKey, 'sk-ant-test-key');
  assert.equal(saved.accounts.length, 2);
});

test('login --api tells a running server to reload once the key is saved', async (t) => {
  const server = await fakeServer(t);
  const configPath = await writeConfig(baseConfig(server.port));

  const cli = runCli(configPath, ['login', '--api', '--name', 'api-test']);
  await cli.prompted;
  cli.answer('sk-ant-test-key');
  const res = await cli.done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Added API key account "api-test"/);
  assert.match(res.stdout, /Reloaded running server \(\+1 new account\)/);
  assert.deepEqual(server.seen, [{ method: 'POST', url: '/teamclaude/reload', key: 'tc-test' }]);
});
