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
// `eventLogging` and `blockedModels`. server.js reads both per request off the
// shared config object, and the TUI's own save already persists them, but
// reloadAccounts never copied them from disk — so a hand edit or any external
// writer waited for a restart, unlike every other settings-screen field. These
// drive the real server as a subprocess against a throwaway TEAMCLAUDE_CONFIG;
// the stub upstream's hit list is the witness for both gates.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const EVENT_LOG = '/api/event_logging/v2/batch';

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

// A recording stand-in for the upstream API: every request it sees is a hit.
function startStubUpstream(hits) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
}

// Server harness: the fleet upstream IS the stub, so a request that is not
// answered locally by one of the two gates must show up in `hits`.
async function withServer(fn) {
  const hits = [];
  const stub = startStubUpstream(hits);
  const stubPort = await listen(stub);
  const proxyPort = await closedPort();

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reload-gates-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${stubPort}`,
    upstreamProxy: false,
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));

  const server = startServer(configPath);
  try {
    await waitForServer(proxyPort, server.output);
    await fn({ hits, proxyPort, configPath });
  } finally {
    await server.stop();
    stub.close();
  }
}

// The disk edit a user (or another writer) makes, then the reload that must
// carry it onto the running server.
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

async function statusOf(proxyPort) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`);
  assert.equal(res.status, 200);
  return res.json();
}

async function post(proxyPort, path, body) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const postEventLog = proxyPort => post(proxyPort, EVENT_LOG, { events: [] });
const sendMessage = (proxyPort, model) => post(proxyPort, '/v1/messages', { model, max_tokens: 1, messages: [] });

test('reload hot-applies an eventLogging edit', async () => {
  await withServer(async ({ hits, proxyPort, configPath }) => {
    // 'hide' (the default) still forwards telemetry; it only stays out of the log.
    let res = await postEventLog(proxyPort);
    assert.equal(res.status, 200);
    assert.equal(hits.length, 1, 'setup: hide forwards telemetry to the stub');

    await editConfig(configPath, c => { c.eventLogging = 'block'; });
    await reload(proxyPort);
    res = await postEventLog(proxyPort);
    assert.equal(res.status, 200, 'block answers 200 locally');
    assert.equal(hits.length, 1, `block must not forward, but the stub saw ${hits.length} hit(s)`);

    // And back: the reload must apply a loosening edit too, not just a tightening one.
    await editConfig(configPath, c => { c.eventLogging = 'show'; });
    await reload(proxyPort);
    res = await postEventLog(proxyPort);
    assert.equal(res.status, 200);
    assert.equal(hits.length, 2, 'show forwards again');
    assert.equal(hits[1].url, EVENT_LOG);
  });
});

test('reload hot-applies a blockedModels edit', async () => {
  await withServer(async ({ hits, proxyPort, configPath }) => {
    let res = await sendMessage(proxyPort, 'claude-zz-blocked');
    assert.equal(res.status, 200);
    assert.equal(hits.length, 1, 'setup: an empty blocklist forwards the model');
    assert.equal(JSON.parse(hits[0].body).model, 'claude-zz-blocked');

    await editConfig(configPath, c => { c.blockedModels = ['*zz-blocked*']; });
    await reload(proxyPort);
    res = await sendMessage(proxyPort, 'claude-zz-blocked');
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.type, 'error');
    assert.equal(res.body.error.type, 'invalid_request_error');
    assert.equal(res.body.error.message, 'Model "claude-zz-blocked" is blocked by teamclaude (matched "*zz-blocked*").');
    assert.equal(hits.length, 1, `a blocked model must not be forwarded, but the stub saw ${hits.length} hit(s)`);

    // The status echo reads the same live object, so it must agree with the gate.
    const status = await statusOf(proxyPort);
    assert.deepEqual(status.blockedModels, ['*zz-blocked*']);
  });
});

test('reload restores the defaults when both keys are removed from disk', async () => {
  await withServer(async ({ hits, proxyPort, configPath }) => {
    await editConfig(configPath, c => { c.eventLogging = 'block'; c.blockedModels = ['*zz-blocked*']; });
    await reload(proxyPort);
    await postEventLog(proxyPort);
    let res = await sendMessage(proxyPort, 'claude-zz-blocked');
    assert.equal(res.status, 400, 'setup: the blocklist is engaged');
    assert.equal(hits.length, 0, 'setup: both gates answer locally');

    // A hand-trimmed config has neither key; the running server must fall back
    // to the defaults (hide, nothing blocked) rather than keep the old values.
    await editConfig(configPath, c => { delete c.eventLogging; delete c.blockedModels; });
    await reload(proxyPort);
    res = await postEventLog(proxyPort);
    assert.equal(res.status, 200);
    res = await sendMessage(proxyPort, 'claude-zz-blocked');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(hits.map(h => h.url), [EVENT_LOG, '/v1/messages'], 'both reach the stub again');
    const status = await statusOf(proxyPort);
    assert.deepEqual(status.blockedModels, []);
  });
});
