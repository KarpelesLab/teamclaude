import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Live reload (POST /teamclaude/reload → syncAccountsFromDisk) must pick up a
// per-account `upstream`/`modelMap` edit, the same way it already picks up
// credential, priority and enable/disable changes — server.js reads both fields
// off the manager's account object per request. These drive the real server as
// a subprocess against a throwaway TEAMCLAUDE_CONFIG; the stub upstream is the
// witness: it can only receive the request (with the mapped model) if the
// reload actually carried the fields onto the running account.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

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
    // Node does not replay 'exit' to late listeners: a child that died before
    // stop() ran (startup port race, mid-test crash) must not hang the await.
    // No await between the check and the attach, so there is no race window.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.on('exit', resolve));
    }
    clearTimeout(killer);
  };
  return { child, stop, output: () => output };
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

// A recording stand-in for a third-party backend.
function startStubUpstream(hits) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  });
}

// Server harness: global upstream points at a dead port, so a request only
// reaches the stub while the ACCOUNT's upstream override is in force — no
// accidental pass via the fleet default.
async function withServer(fn) {
  const hits = [];
  const stub = startStubUpstream(hits);
  const stubPort = await listen(stub);
  const deadPort = await closedPort();
  const proxyPort = await closedPort();

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reload-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${deadPort}`,
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));

  const server = startServer(configPath);
  try {
    await waitForServer(proxyPort, server.output);
    await fn({ hits, stubPort, proxyPort, configPath });
  } finally {
    await server.stop();
    stub.close();
  }
}

async function reload(proxyPort) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
  assert.equal(res.status, 200, await res.text());
}

// Fire one chat request at the proxy; a destroyed connection (dead upstream)
// reads as null — the stub's hit list is the verdict either way.
async function sendMessage(proxyPort, model) {
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    await res.text();
    return res;
  } catch {
    return null;
  }
}

test('reload picks up upstream and modelMap edits for an existing account', async () => {
  await withServer(async ({ hits, stubPort, proxyPort, configPath }) => {
    // The disk edit a user makes to bolt a third-party backend onto the account.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.accounts[0].upstream = `http://127.0.0.1:${stubPort}`;
    edited.accounts[0].modelMap = { 'claude-test-model': 'mapped-test-model' };
    await writeFile(configPath, JSON.stringify(edited));

    await reload(proxyPort);
    const res = await sendMessage(proxyPort, 'claude-test-model');

    assert.equal(hits.length, 1, `expected the stub upstream to receive the request, got ${hits.length} hit(s)`);
    assert.equal(hits[0].url, '/v1/messages');
    assert.equal(JSON.parse(hits[0].body).model, 'mapped-test-model', 'modelMap from the reloaded config must rewrite the request body');
    assert.equal(res?.status, 200);
  });
});

test('reload also picks up the REMOVAL of upstream and modelMap', async () => {
  await withServer(async ({ hits, stubPort, proxyPort, configPath }) => {
    const withBackend = JSON.parse(await readFile(configPath, 'utf8'));
    withBackend.accounts[0].upstream = `http://127.0.0.1:${stubPort}`;
    withBackend.accounts[0].modelMap = { 'claude-test-model': 'mapped-test-model' };
    await writeFile(configPath, JSON.stringify(withBackend));
    await reload(proxyPort);
    await sendMessage(proxyPort, 'claude-test-model');
    assert.equal(hits.length, 1, 'setup: the override routes to the stub');

    // Reverting the edit on disk must revert the running account too —
    // otherwise the old backend binding sticks until a restart.
    const reverted = JSON.parse(await readFile(configPath, 'utf8'));
    delete reverted.accounts[0].upstream;
    delete reverted.accounts[0].modelMap;
    await writeFile(configPath, JSON.stringify(reverted));
    await reload(proxyPort);
    const res = await sendMessage(proxyPort, 'claude-test-model');

    // Transport detail (destroyed connection today, maybe a graceful 5xx one
    // day) is not the verdict — the stub seeing no further traffic is.
    assert.ok(res === null || res.status >= 500, `with the override gone the request must not succeed, got ${res?.status}`);
    assert.equal(hits.length, 1, `the stub must see no further requests, got ${hits.length}`);
  });
});
