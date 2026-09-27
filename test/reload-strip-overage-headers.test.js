import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Live reload (POST /teamclaude/reload → reloadAccounts) must hot-apply
// `stripOverageHeaders`. server.js samples the flag off the shared config
// object when each request is dispatched, so a reload that did not copy it
// from disk would leave the running server on its startup value while every
// unit test in overage-headers.test.js stayed green. Same harness as
// reload-event-logging-blocklist.test.js: the real server as a subprocess
// against a throwaway TEAMCLAUDE_CONFIG, with a stub upstream that answers
// /v1/messages with one overage header and one plan-quota header.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const OVERAGE = 'anthropic-ratelimit-unified-overage-disabled-reason';
const PLAN = 'anthropic-ratelimit-unified-5h-status';

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

function startStubUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', [OVERAGE]: 'org_level_disabled', [PLAN]: 'allowed' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
}

async function editConfig(configPath, mutate) {
  const edited = JSON.parse(await readFile(configPath, 'utf8'));
  mutate(edited);
  await writeFile(configPath, JSON.stringify(edited));
}

async function reload(proxyPort) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(JSON.parse(text).ok, true, text);
}

// The overage and plan header values on the next /v1/messages response.
async function nextMessageHeaders(proxyPort) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return { overage: res.headers.get(OVERAGE), plan: res.headers.get(PLAN) };
}

test('reload hot-applies stripOverageHeaders: false, true, false, then key removed', async () => {
  const stub = startStubUpstream();
  const stubPort = await listen(stub);
  const proxyPort = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reload-strip-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${stubPort}`,
    upstreamProxy: false,
    stripOverageHeaders: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));

  const server = startServer(configPath);
  try {
    await waitForServer(proxyPort, server.output);
    const kept = { overage: 'org_level_disabled', plan: 'allowed' };
    const stripped = { overage: null, plan: 'allowed' };

    assert.deepEqual(await nextMessageHeaders(proxyPort), kept, 'setup: false forwards the overage header');

    await editConfig(configPath, c => { c.stripOverageHeaders = true; });
    await reload(proxyPort);
    assert.deepEqual(await nextMessageHeaders(proxyPort), stripped, 'true strips it on the next request');

    await editConfig(configPath, c => { c.stripOverageHeaders = false; });
    await reload(proxyPort);
    assert.deepEqual(await nextMessageHeaders(proxyPort), kept, 'false forwards it again');

    // A previous true must not survive a config that no longer has the key.
    await editConfig(configPath, c => { c.stripOverageHeaders = true; });
    await reload(proxyPort);
    assert.deepEqual(await nextMessageHeaders(proxyPort), stripped, 'setup: true again');
    await editConfig(configPath, c => { delete c.stripOverageHeaders; });
    await reload(proxyPort);
    assert.deepEqual(await nextMessageHeaders(proxyPort), kept, 'removing the key restores the default (forward)');
  } finally {
    await server.stop();
    stub.close();
  }
});
