import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
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
    // Belt and braces, not load-bearing: Node's global fetch ignores proxy env
    // vars unless NODE_USE_ENV_PROXY is set, so an inherited HTTPS_PROXY does not
    // reach these localhost calls today. Pinned anyway so the test does not start
    // depending on that default.
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

// Same rule as the endpoint: the switch is recorded, but a caller must not be
// told plainly that it worked when no request will ever reach that account.
async function withDisabled(fn) {
  const accts = [
    { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ];
  const am = new AccountManager(accts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: accts,
  }));
  try {
    await fn(am, path);
  } finally {
    proxy.close();
  }
}

test('switching to a disabled account warns instead of reporting a clean success', async () => {
  await withDisabled(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'off@example.com']);
    assert.equal(res.code, 0, 'the switch is still recorded, so this is not a failure');
    const all = res.stdout + res.stderr;
    assert.match(all, /off@example\.com/);
    assert.match(all, /disabled/i, `expected a warning naming the reason: ${all}`);
    assert.match(all, /will not route|not be used|until/i, `expected the consequence spelled out: ${all}`);
  });
});

test('the listing marks a disabled account', async () => {
  await withDisabled(async (am, configPath) => {
    const res = await runCli(configPath, ['switch']);
    assert.equal(res.code, 0, res.stderr);
    const off = res.stdout.split('\n').find(l => l.includes('off@example.com'));
    const alice = res.stdout.split('\n').find(l => l.includes('alice@example.com'));
    assert.match(off, /disabled/i, `expected the disabled account flagged: ${res.stdout}`);
    assert.doesNotMatch(alice, /disabled/i, `expected a healthy account left unflagged: ${res.stdout}`);
  });
});

// A reply from something that is not our proxy, or from a version that predates
// the endpoint, must not be reported as "no server" or as an empty account list.
test('an unexpected reply is reported as such, not as a down server', async () => {
  const impostor = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not teamclaude</html>');
  });
  const port = await listen(impostor);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: ACCTS,
  }));
  try {
    const res = await runCli(path, ['switch']);
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /Is the server running\?/, 'something answered, so this is not a down server');
    assert.doesNotMatch(res.stdout, /No accounts configured/, 'an unparseable reply is not an empty fleet');
    assert.match(res.stderr, /unexpected|not a teamclaude|invalid/i, res.stderr);
  } finally {
    impostor.close();
  }
});

// An old server has no /teamclaude/switch, so the request falls through to the
// proxy path and Anthropic answers with an error OBJECT. Printing it raw yields
// "[object Object]", which tells the user nothing.
test('a non-string error field does not print as [object Object]', async () => {
  const oldServer = http.createServer((req, res) => {
    if (req.url === '/teamclaude/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentAccount: 'alice@example.com', accounts: [{ name: 'alice@example.com' }] }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
  });
  const port = await listen(oldServer);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: ACCTS,
  }));
  try {
    const res = await runCli(path, ['switch', 'alice@example.com']);
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /\[object Object\]/, res.stderr);
  } finally {
    oldServer.close();
  }
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
