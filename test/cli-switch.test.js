import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// `teamclaude switch` drives the real control endpoint, so these run the CLI
// against a real proxy server rather than a stubbed one.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2' },
];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
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

async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    // Ignore any proxy in the environment: the CLI only ever talks to localhost
    // here, and an inherited HTTPS_PROXY would make the run machine-dependent.
    upstreamProxy: false,
    switchThreshold: 0.98,
    accounts: ACCTS,
  }));
  return path;
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
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

async function withProxy(fn) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  const configPath = await writeConfig(port);
  try {
    await fn(am, configPath);
  } finally {
    proxy.close();
  }
}

test('switch NAME retargets the running server', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'bob@example.com (Acme)']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /bob@example\.com \(Acme\)/);
    assert.equal(am.currentIndex, 1);
  });
});

test('switch with no name lists accounts and marks the current one', async () => {
  await withProxy(async (am, configPath) => {
    am.currentIndex = 1;
    const res = await runCli(configPath, ['switch']);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.split('\n');
    const alice = lines.find(l => l.includes('alice@example.com'));
    const bob = lines.find(l => l.includes('bob@example.com'));
    assert.ok(alice && bob, res.stdout);
    assert.ok(bob.startsWith('*'), `expected the current account marked: ${bob}`);
    assert.ok(!alice.startsWith('*'), `expected other accounts unmarked: ${alice}`);
  });
});

test('an unknown name exits 1 and prints the valid names', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'nobody@example.com']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /nobody@example\.com/);
    assert.match(res.stderr, /alice@example\.com/);
    assert.match(res.stderr, /bob@example\.com \(Acme\)/);
    assert.equal(am.currentIndex, 0, 'a refused switch must not move the current account');
  });
});

test('a down server exits 1 with the same hint as status', async () => {
  const port = await closedPort();
  const configPath = await writeConfig(port);
  for (const cliArgs of [['switch'], ['switch', 'alice@example.com']]) {
    const res = await runCli(configPath, cliArgs);
    assert.equal(res.code, 1, cliArgs.join(' '));
    assert.match(res.stderr, new RegExp(`Cannot connect to proxy at localhost:${port}`));
    assert.match(res.stderr, /Is the server running\?/);
  }
});
