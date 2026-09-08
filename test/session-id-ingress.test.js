import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, clientSessionId } from '../src/server.js';

// x-claude-code-session-id is client-supplied and, unvalidated, became a Map
// key in the session tracker (unbounded per client) and a column in the TUI
// (Node's header parser lets C1 control bytes through). It is accepted only in
// a conservative shape now; anything else is treated as no session at all,
// which is what an untagged request already means.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const UUID = '0f6b7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

async function withProxy(fn) {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const started = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, {
    onRequestStart: (_id, info) => started.push(info.sessionId),
  });
  const port = await listen(proxy);
  try {
    await fn(port, started, am);
  } finally {
    proxy.close();
    upstream.close();
  }
}

// http.request: fetch validates header values against a narrower grammar than
// Node's server accepts, and the point is what the server does with the rest.
function post(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': sessionId },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
  });
}

test('a UUID and a plain non-UUID tag are both tracked; malformed ones are not', async () => {
  await withProxy(async (port, started) => {
    assert.equal(await post(port, UUID), 200);
    assert.equal(await post(port, 'sess-1'), 200);
    assert.equal(await post(port, 'a b'), 200);                 // whitespace
    assert.equal(await post(port, 'x'.repeat(129)), 200);       // over the length cap
    assert.equal(await post(port, 'id '), 200);      // C1 bytes survive the header parser
    assert.deepEqual(started, [UUID, 'sess-1', null, null, null]);
  });
});

test('a malformed id leaves no trace in the session tracker', async () => {
  await withProxy(async (port, _started, am) => {
    assert.equal(await post(port, 'x'.repeat(2000)), 200);
    const sessions = am.getStatus({ sessionDetail: true }).sessions;
    const ids = (sessions?.items || []).map(s => s.id);
    assert.ok(!ids.some(id => id && id.length > 128), `an oversized id was tracked: ${JSON.stringify(ids)}`);
  });
});

test('clientSessionId: shape', () => {
  assert.equal(clientSessionId({ 'x-claude-code-session-id': UUID }), UUID);
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'sess_1.a-b' }), 'sess_1.a-b');
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'x'.repeat(128) }), 'x'.repeat(128));
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'x'.repeat(129) }), null);
  assert.equal(clientSessionId({ 'x-claude-code-session-id': '' }), null);
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'a/b' }), null);
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'ab' }), null);
  assert.equal(clientSessionId({ 'x-claude-code-session-id': ['a', 'b'] }), null);
  assert.equal(clientSessionId({}), null);
});
