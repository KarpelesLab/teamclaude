import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, requestThread } from '../src/server.js';

// A message-thread continue carries only the turn's delta, and Anthropic keeps
// the thread with the account that created it: a continue served by any other
// account is answered 404 `thread_not_found`, and Claude Code then resends the
// whole conversation as a fresh create. The conversation key is a digest of the
// body's first message, which for a continue is the delta rather than the
// conversation's opening, so every continue looked like a new conversation and
// session-aware routing sent it wherever a new one would go.

const SESSION = '0f6b7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// An upstream that keeps threads the way Anthropic does: per account, keyed by
// the id of the message a continue follows.
function threadKeepingUpstream({ stream }) {
  const threads = new Map();   // message id -> the key of the account that answered it
  const served = [];           // { key, thread, first } per request
  let next = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const key = req.headers['x-api-key'];
    served.push({ key, thread: body.thread?.type ?? null, first: body.messages?.[0] });
    if (body.thread?.type === 'continue' && threads.get(body.thread.previous_message_id) !== key) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'No thread state', details: { error_code: 'thread_not_found' } } }));
      return;
    }
    const id = `msg_${++next}`;
    if (body.thread) threads.set(id, key);
    const usage = { input_tokens: 10, output_tokens: 1 };
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], usage } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`);
      res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', content: [], usage }));
    }
  });
  return { server, served };
}

async function withProxy({ stream = false, distributeSessions = true } = {}, fn) {
  const { server: upstream, served } = threadKeepingUpstream({ stream });
  const upstreamPort = await listen(upstream);
  const accounts = Array.from({ length: 3 }, (_, i) => ({ name: `a${i}`, type: 'apikey', apiKey: `k${i}` }));
  const am = new AccountManager(accounts, 0.98, { distributeSessions });
  // The mock upstream keeps thread state, which is what `messageThreads` declares.
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, messageThreads: true });
  const port = await listen(proxy);
  try {
    await fn({ port, served, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

// One request; resolves to the status and the message id the response carried.
function post(port, payload, session = SESSION) {
  const body = JSON.stringify({ model: 'claude-opus-5', system: [{ type: 'text', text: 'shared' }], ...payload });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': session },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const id = /"id":"(msg_\d+)"/.exec(text)?.[1] ?? null;
        resolve({ status: res.statusCode, id });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const create = (port, opening) => post(port, {
  thread: { type: 'create' },
  messages: [{ role: 'user', content: opening }],
});

// The delta Claude Code sends after a tool call: the result, then a directive.
const cont = (port, previous, session = SESSION) => post(port, {
  thread: { type: 'continue', previous_message_id: previous },
  messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    { role: 'system', content: [{ type: 'text', text: 'directive' }] },
  ],
}, session);

for (const stream of [false, true]) {
  test(`a continue reaches the account holding its thread (${stream ? 'streamed' : 'buffered'})`, async () => {
    await withProxy({ stream }, async ({ port, served }) => {
      // Two agents, so the fleet has a busy account besides alpha's and a
      // continue routed as a new conversation lands on neither.
      const alpha = await create(port, 'task alpha');
      const beta = await create(port, 'task beta');
      assert.equal(alpha.status, 200);
      assert.equal(beta.status, 200);
      const alphaKey = served[0].key;

      let previous = alpha.id;
      for (let turn = 0; turn < 3; turn++) {
        const before = served.length;
        const r = await cont(port, previous);
        assert.equal(r.status, 200, `turn ${turn} was answered ${r.status} by ${served[before]?.key}, the thread is on ${alphaKey}`);
        assert.equal(served[before].key, alphaKey);
        previous = r.id;
      }
    });
  });
}

test('the continue reaches upstream with the delta it was sent', async () => {
  await withProxy({}, async ({ port, served }) => {
    const alpha = await create(port, 'task alpha');
    await cont(port, alpha.id);
    // The tool_result answers a tool_use held in the thread upstream; stripping
    // it as an orphan left the system directive first, which Anthropic rejects.
    assert.equal(served[1].first?.content?.[0]?.type, 'tool_result');
  });
});

for (const distributeSessions of [true, false]) {
  test(`a continue is counted as its own conversation, not a new one (distribution ${distributeSessions ? 'on' : 'off'})`, async () => {
    await withProxy({ distributeSessions }, async ({ port, am }) => {
      let { id } = await create(port, 'task alpha');
      for (let turn = 0; turn < 3; turn++) ({ id } = await cont(port, id));
      const items = am.getStatus({ sessionDetail: true }).sessions.items;
      assert.equal(items.length, 1, `conversations: ${JSON.stringify(items.map(i => i.conversation))}`);
    });
  });
}

test('a continue the proxy cannot place is filed under its session alone', async () => {
  await withProxy({}, async ({ port, am }) => {
    // After a restart, or once its conversation was forgotten, nothing names
    // the message a continue follows. Its delta names no conversation either,
    // so it pins by session, as a request without an opening does.
    await cont(port, 'msg_from_before_a_restart');
    const items = am.getStatus({ sessionDetail: true }).sessions.items;
    assert.deepEqual(items.map(i => [i.session, i.conversation]), [[SESSION, null]]);
  });
});

test('a message id from another client session does not move a continue', async () => {
  await withProxy({}, async ({ port, am }) => {
    // The id is client-supplied: it can find a conversation of the session that
    // sent it, never file a request under someone else's.
    const alpha = await create(port, 'task alpha');
    await cont(port, alpha.id, 'another-session');
    const items = am.getStatus({ sessionDetail: true }).sessions.items;
    const other = items.filter(i => i.session === 'another-session');
    assert.deepEqual(other.map(i => i.conversation), [null]);
    assert.equal(items.filter(i => i.session === SESSION).length, 1);
  });
});

test('requestThread names the message a continue follows', () => {
  const b = (o) => Buffer.from(JSON.stringify(o));
  assert.equal(requestThread(b({ messages: [] })), null);
  assert.deepEqual(requestThread(b({ thread: { type: 'create' } })), { continues: null });
  assert.deepEqual(requestThread(b({ thread: { type: 'continue', previous_message_id: 'msg_1' } })), { continues: 'msg_1' });
  // A create whose text is the word "continue" is parsed and still a create.
  assert.deepEqual(requestThread(b({ thread: { type: 'create' }, messages: [{ role: 'user', content: 'continue' }] })), { continues: null });
  assert.deepEqual(requestThread(b({ thread: { type: 'continue' } })), { continues: null });
  assert.equal(requestThread(Buffer.from('{"thread":"continue"')), null);
  assert.equal(requestThread(null), null);
});
