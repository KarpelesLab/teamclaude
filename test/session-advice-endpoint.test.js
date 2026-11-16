import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// GET /teamclaude/session-advice and POST /teamclaude/session-advice/decline,
// and the cooldown a session-pin starts, through an in-process proxy.

const SESSION = '3f2a1b9c-0000-4000-8000-000000000001';
const OPUS = 'claude-opus-4-1';
const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const apikey = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: `key-${name}` });

/**
 * A proxy over two API-key accounts whose upstream reports 5000 input tokens
 * for a message saying "main task" and 50 for anything else.
 * @param {Record<string, any>} [amOpts] @param {Record<string, any>} [proxyConfig]
 */
async function proxyWith(amOpts = {}, proxyConfig = {}) {
  /** @type {string[]} */
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(/** @type {string} */ (req.headers['x-api-key']));
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = body.includes('main task') ? 5000 : 50;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: input, output_tokens: 1 } }));
    });
  });
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98, amOpts);
  /** @type {any} */
  let proxy = null;
  const log = console.log;
  console.log = () => {};
  const close = () => { console.log = log; proxy?.close(); upstream.close(); };
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(am, { proxy: { apiKey: 'k', ...proxyConfig }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const port = await listen(proxy);
    return { am, port, served, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** @param {number} port @param {string} content */
async function message(port, content) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION },
    body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content }] }),
  });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
}

/** @param {number} port @param {string} query */
async function advice(port, query, key = 'k', prefix = '/teamclaude') {
  const res = await fetch(`http://127.0.0.1:${port}${prefix}/session-advice${query}`, { headers: { 'x-api-key': key } });
  return { status: res.status, body: await res.json() };
}

/** @param {number} port @param {string} path @param {any} body */
async function post(port, path, body, key = 'k') {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET answers one session\'s account, context and advice; off by default', async () => {
  const ctx = await proxyWith();
  try {
    await message(ctx.port, 'main task');
    const { status, body } = await advice(ctx.port, `?session=${SESSION}`);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      session: SESSION, account: 'a', via: 'affinity', context: 5000,
      advice: { enabled: false, ask: false }, recommendation: null, reason: 'disabled',
    });
    assert.deepEqual((await advice(ctx.port, `?session=${SESSION}`, 'k', '/teamrouter')).body, body, 'the /teamrouter/ alias');
    assert.equal((await advice(ctx.port, '?session=not%20a%20session')).status, 400);
    assert.equal((await advice(ctx.port, '')).status, 400);
    assert.equal((await advice(ctx.port, '?session=9d0e4c11')).body.reason, 'disabled');
  } finally {
    ctx.close();
  }
});

test('an unknown session is named as such when the feature is on', async () => {
  const ctx = await proxyWith({ sessionAdvice: { enabled: true } });
  try {
    const { body } = await advice(ctx.port, '?session=9d0e4c11');
    assert.deepEqual([body.account, body.reason, body.recommendation], [null, 'unknown-session', null]);
  } finally {
    ctx.close();
  }
});

test('without sessionDetail, the endpoint names the main conversation\'s account and context (AC6)', async () => {
  const ctx = await proxyWith({ distributeSessions: true });
  try {
    await message(ctx.port, 'sub task');
    await message(ctx.port, 'main task');
    const { body } = await advice(ctx.port, `?session=${SESSION}`);
    assert.equal(body.context, 5000);
    assert.equal(body.via, 'affinity');
    assert.equal(body.account, ctx.served[1].replace('key-', ''), 'the account the main conversation went to');
  } finally {
    ctx.close();
  }
});

test('a client key may neither read the advice nor decline it (AC6c)', async () => {
  const ctx = await proxyWith({ sessionAdvice: { enabled: true } }, { clientKeys: [{ name: 'ci', key: 'ci-key' }] });
  try {
    const read = await advice(ctx.port, `?session=${SESSION}`, 'ci-key');
    assert.equal(read.status, 403);
    assert.equal(read.body.ok, false);
    const decline = await post(ctx.port, 'session-advice/decline', { sessionId: SESSION }, 'ci-key');
    assert.equal(decline.status, 403);
    assert.equal(ctx.am.adviceCooldowns.size, 0);
    assert.equal((await advice(ctx.port, `?session=${SESSION}`)).status, 200, 'the shared proxy key reads it');
  } finally {
    ctx.close();
  }
});

test('a decline holds the advice; with the feature off it records nothing (AC4)', async () => {
  const on = await proxyWith({ sessionAdvice: { enabled: true }, expiryRouting: { enabled: true } });
  try {
    await message(on.port, 'main task');
    assert.equal((await post(on.port, 'session-advice/decline', { sessionId: 'bad id' })).status, 400);
    assert.deepEqual((await post(on.port, 'session-advice/decline', { sessionId: SESSION })).body, { ok: true, recorded: true });
    assert.equal((await advice(on.port, `?session=${SESSION}`)).body.reason, 'cooldown');
  } finally {
    on.close();
  }
  const off = await proxyWith();
  try {
    assert.deepEqual((await post(off.port, 'session-advice/decline', { sessionId: SESSION })).body, { ok: true, recorded: false });
    assert.equal(off.am.adviceCooldowns.size, 0);
  } finally {
    off.close();
  }
});

test('a session-pin starts the cooldown only while the feature is on (AC4)', async () => {
  const on = await proxyWith({ sessionAdvice: { enabled: true }, expiryRouting: { enabled: true } });
  try {
    assert.equal((await post(on.port, 'session-pin', { sessionId: SESSION, account: null })).status, 200);
    assert.equal(on.am.adviceCooldowns.size, 0, 'clearing a pin is not a move');
    assert.equal((await post(on.port, 'session-pin', { sessionId: SESSION, account: 'b' })).status, 200);
    assert.ok(on.am.adviceCooldowns.has(SESSION));
  } finally {
    on.close();
  }
  const off = await proxyWith();
  try {
    assert.equal((await post(off.port, 'session-pin', { sessionId: SESSION, account: 'b' })).status, 200);
    assert.equal(off.am.adviceCooldowns.size, 0);
  } finally {
    off.close();
  }
});
