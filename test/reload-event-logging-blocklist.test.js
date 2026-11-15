import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

// Live reload (POST /teamclaude/reload → reloadAccounts) must hot-apply
// `eventLogging` and `blockedModels`. server.js reads both per request off the
// shared config object, and the TUI's own save already persists them, but
// reloadAccounts never copied them from disk — so a hand edit or any external
// writer waited for a restart, unlike every other settings-screen field. These
// drive the real server as a subprocess against a throwaway TEAMCLAUDE_CONFIG;
// the stub upstream's hit list is the witness for both gates.

const EVENT_LOG = '/api/event_logging/v2/batch';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Every request this file sends carries the marker, and the proxy relays it
// with the rest of the client's headers. The stub counts only those: its port
// is an ephemeral one that another test file's "dead upstream" may have held a
// moment ago, and a request from that file's proxy is not one of the two gates
// letting something through (seen on CI as 2 hits where 0 were sent).
const MARKER = 'x-reload-test-run';
const RUN = randomUUID();

// A recording stand-in for the upstream API: every request of this run that it
// sees is a hit.
function startStubUpstream(hits) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.headers[MARKER] === RUN) hits.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
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

  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      eventLogging: 'hide',
      blockedModels: [],
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port: proxyPort, configPath } = server;
  try {
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
    headers: { 'content-type': 'application/json', [MARKER]: RUN },
    body: JSON.stringify(body),
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
    assert.deepEqual(hits.map(h => h.url), [], 'setup: both gates answer locally');

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
