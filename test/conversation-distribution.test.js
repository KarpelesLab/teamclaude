import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The regression this file exists for. `distributeSessions` pinned on the
// client's session id, and one Claude Code session sends ONE id for its own
// turns AND for every subagent it launches — so a fan-out arrived as N
// concurrent requests wearing one tag and pinned all N to one account, where
// they queued behind its ceiling while its siblings idled. That is the
// funnelling of issue #109, re-entered through the tag. The pin is keyed per
// conversation now (see conversation.js), so siblings spread and a
// conversation's own turns still stay put.

const SESSION = '0f6b7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// One account per key, so the key the proxy sent upstream names who served it.
function accounts(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'apikey', apiKey: `k${i}` }));
}

async function withProxy(count, opts, fn) {
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(req.headers['x-api-key'] || req.headers.authorization || null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(count), 0.98, opts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await fn({ port, served, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

// One turn of a conversation. `first` is the opening message — the thing that
// identifies the conversation — and `rest` is however much transcript has piled
// up behind it since.
function post(port, { session = SESSION, first, rest = [] }) {
  const body = JSON.stringify({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'one system prompt, shared by every agent' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: first }, ...rest],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(session ? { 'x-claude-code-session-id': session } : {}) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('a fan-out under one session id spreads across the fleet', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, served }) => {
    // A parent and three subagents: one session id, one system prompt, one tool
    // list, four different opening messages. Before this change all four were
    // one pin and every one of them went to the same account.
    for (const first of ['orchestrate the review', 'review auth', 'review routing', 'review quota']) {
      assert.equal(await post(port, { first }), 200);
    }
    assert.equal(served.length, 4);
    assert.ok(new Set(served).size > 1, `every request went to one account: ${JSON.stringify(served)}`);
  });
});

test('a conversation stays on its account while its transcript grows', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, served }) => {
    // The property the pin exists for. Later turns of one conversation carry
    // more messages behind the same opening, and must not move: moving is a
    // cold prompt cache.
    const rest = [];
    for (let turn = 0; turn < 5; turn++) {
      assert.equal(await post(port, { first: 'the one conversation', rest: [...rest] }), 200);
      rest.push({ role: 'assistant', content: `turn ${turn}` }, { role: 'user', content: 'go on' });
    }
    assert.equal(new Set(served).size, 1, `a conversation was moved mid-flight: ${JSON.stringify(served)}`);
  });
});

test('siblings keep their own accounts as each of them grows', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, served }) => {
    // Two agents of one fan-out, interleaved, each taking three turns. Each has
    // to hold its own account across its own turns — spreading is worth nothing
    // if the pins then wander.
    const rest = { alpha: [], beta: [] };
    const by = { alpha: [], beta: [] };
    for (let turn = 0; turn < 3; turn++) {
      for (const who of ['alpha', 'beta']) {
        const before = served.length;
        assert.equal(await post(port, { first: `task ${who}`, rest: [...rest[who]] }), 200);
        by[who].push(served[before]);
        rest[who].push({ role: 'assistant', content: `turn ${turn}` }, { role: 'user', content: 'next' });
      }
    }
    assert.equal(new Set(by.alpha).size, 1, `alpha wandered: ${JSON.stringify(by.alpha)}`);
    assert.equal(new Set(by.beta).size, 1, `beta wandered: ${JSON.stringify(by.beta)}`);
    assert.notEqual(by.alpha[0], by.beta[0], 'two live agents shared one account');
  });
});

test('the readout names the session a conversation belongs to', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, am }) => {
    await post(port, { first: 'review auth' });
    await post(port, { first: 'review routing' });
    const items = am.getStatus({ sessionDetail: true }).sessions.items;
    // Two conversations, one session: the grain an operator reads is still the
    // session, and the conversation is what tells two of its agents apart.
    assert.equal(items.length, 2);
    assert.deepEqual([...new Set(items.map(i => i.session))], [SESSION]);
    assert.equal(new Set(items.map(i => i.conversation)).size, 2);
  });
});

test('with distribution off, conversations route exactly as before', async () => {
  await withProxy(3, {}, async ({ port, served }) => {
    // The knob is opt-in and this change does not reach past it: with it off,
    // every request follows plain quota-driven rotation onto the current
    // account, conversation or not.
    for (const first of ['review auth', 'review routing', 'review quota']) {
      assert.equal(await post(port, { first }), 200);
    }
    assert.equal(new Set(served).size, 1, `rotation changed with the knob off: ${JSON.stringify(served)}`);
  });
});

test('a request that names no conversation still pins by session', async () => {
  await withProxy(3, { distributeSessions: true }, async ({ port, am }) => {
    // The Responses shape a translating sidecar sends carries no `messages`, so
    // there is no conversation to name and the key degrades to the session id —
    // which is what it keyed on before. Two such requests are one record.
    const send = (body) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    await send({ model: 'gpt-6', instructions: 'be nice', input: 'one' });
    await send({ model: 'gpt-6', instructions: 'be nice', input: 'two' });
    const items = am.getStatus({ sessionDetail: true }).sessions.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, SESSION);
  });
});
