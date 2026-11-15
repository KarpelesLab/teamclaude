import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createDrainState } from '../src/drain.js';

// Drain for maintenance, in process. A draining proxy refuses a NEW request
// through the forwarding listener with a 503, while a stream already open runs
// to its end. The control routes stay open to the operator and closed to any
// client key. The upstream here is a fake that holds an SSE stream until the
// test lets it finish, so nothing in this file depends on timing.

const OPERATOR_KEY = 'tc-operator';
const LAPTOP_KEY = 'tc-laptop';
const AGENT_KEY = 'tc-agent-inference';

const START = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function readRest(reader, decoder, text = '') {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

async function fixture(t) {
  const drain = createDrainState();
  // One entry per request the upstream was asked to hold open.
  const held = [];
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.on('error', () => {});
    req.resume();
    if (req.headers['x-test-hold']) {
      const hold = { finish: deferred() };
      held.push(hold);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(START);
      hold.finish.promise.then(() => { if (!res.destroyed) res.end(STOP); });
      return;
    }
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message"}');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const am = new AccountManager([{ name: 'acct', type: 'apikey', apiKey: 'sk-fake' }], 0.98);
  const config = {
    proxy: {
      apiKey: OPERATOR_KEY,
      clientKeys: [{ name: 'laptop', key: LAPTOP_KEY }, { name: 'agent', key: AGENT_KEY, scope: 'inference' }],
    },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  };
  const proxy = createProxyServer(am, config, {}, null, null, null, { drain });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  const url = `http://127.0.0.1:${port}`;
  t.after(() => {
    for (const h of held) h.finish.resolve();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });

  // hold: the upstream keeps the stream open until the test resolves finish.
  function message({ key = OPERATOR_KEY, hold = false, signal } = {}) {
    return fetch(`${url}/v1/messages`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, ...(hold ? { 'x-test-hold': '1' } : {}) },
      body: JSON.stringify({ model: 'claude-test', stream: hold, messages: [] }),
    });
  }
  async function control(path, { key = OPERATOR_KEY, method = 'POST', headers = {} } = {}) {
    const res = await fetch(`${url}${path}`, { method, headers: { 'x-api-key': key, ...headers } });
    return { status: res.status, body: await res.json() };
  }
  return { url, port, drain, held, message, control, upstreamHits: () => upstreamHits };
}

test('a draining proxy refuses a new request with a 503, and an open stream runs to its end', async t => {
  const f = await fixture(t);
  const open = await f.message({ hold: true });
  assert.equal(open.status, 200);
  const reader = open.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /message_start/);

  const drained = await f.control('/teamclaude/drain');
  assert.equal(drained.status, 200);
  assert.equal(drained.body.draining, true);

  const refused = await f.message();
  assert.equal(refused.status, 503);
  assert.match(refused.headers.get('retry-after') ?? '', /^\d+$/, 'retry-after is a number of seconds');
  assert.equal(refused.headers.get('connection'), 'close');
  const body = await refused.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'overloaded_error');
  assert.match(body.error.message, /draining/);
  assert.equal(body.error.details.error_code, 'draining');
  assert.equal(f.upstreamHits(), 1, 'the refused request never reached the upstream');
  assert.equal(f.drain.status().inFlight, 1, 'a refused request is not counted as in flight');

  f.held[0].finish.resolve();
  const rest = await readRest(reader, decoder, first);
  assert.match(rest, /message_stop/, 'the stream that was open before the drain completed normally');
});

test('undrain restores admission for new requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.control('/teamclaude/drain')).status, 200);
  const refused = await f.message();
  assert.equal(refused.status, 503);
  await refused.text();

  const back = await f.control('/teamclaude/undrain');
  assert.equal(back.status, 200);
  assert.equal(back.body.draining, false);

  const admitted = await f.message();
  assert.equal(admitted.status, 200);
  await admitted.text();
  assert.equal(f.upstreamHits(), 1, 'the admitted request reached the upstream');
});

test('status reports draining, since and the in-flight count', async t => {
  const f = await fixture(t);
  const idle = await f.control('/teamclaude/status', { method: 'GET' });
  assert.deepEqual(idle.body.drain, { draining: false, since: null, inFlight: 0 });

  const open = await f.message({ hold: true });
  const reader = open.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();

  await f.control('/teamclaude/drain');
  const during = await f.control('/teamclaude/status', { method: 'GET' });
  assert.equal(during.body.drain.draining, true);
  assert.ok(!Number.isNaN(Date.parse(during.body.drain.since)), 'since is a timestamp');
  assert.equal(during.body.drain.inFlight, 1);

  f.held[0].finish.resolve();
  await readRest(reader, decoder);
  assert.equal(await f.drain.waitForIdle(Infinity), true);
  const after = await f.control('/teamclaude/status', { method: 'GET' });
  assert.equal(after.body.drain.inFlight, 0);
  assert.equal(after.body.drain.since, during.body.drain.since, 'the drain keeps the time it began');
});

test('a client key, scoped or not, cannot drain or undrain, and the operator is not overruled', async t => {
  const f = await fixture(t);
  for (const key of [LAPTOP_KEY, AGENT_KEY]) {
    for (const path of ['/teamclaude/drain', '/teamclaude/undrain']) {
      const res = await f.control(path, { key });
      assert.equal(res.status, 403, `${path} with a client key`);
      assert.equal(res.body.ok, false);
    }
  }
  assert.equal((await f.control('/teamclaude/status', { method: 'GET' })).body.drain.draining, false);

  await f.control('/teamclaude/drain');
  const refusedUndrain = await f.control('/teamclaude/undrain', { key: LAPTOP_KEY });
  assert.equal(refusedUndrain.status, 403);
  assert.equal((await f.control('/teamclaude/status', { method: 'GET' })).body.drain.draining, true,
    'a client key cannot lift the operator\'s drain');
});

test('drain is refused to a web page, the same as every other control POST', async t => {
  const f = await fixture(t);
  const res = await fetch(`${f.url}/teamclaude/drain`, {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_KEY, Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /cross-origin/);
  assert.equal(f.drain.status().draining, false);
});

test('a client that disconnects mid-stream leaves nothing in flight', async t => {
  const f = await fixture(t);
  const ac = new AbortController();
  const open = await f.message({ hold: true, signal: ac.signal });
  assert.equal(open.status, 200);
  await open.body.getReader().read();
  assert.equal(f.drain.status().inFlight, 1);

  ac.abort();
  assert.equal(await f.drain.waitForIdle(Infinity), true, 'the request ends when its client is gone');
  assert.equal(f.drain.status().inFlight, 0);
});
