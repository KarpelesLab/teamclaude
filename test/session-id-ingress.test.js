import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener, clientSessionId, codexPromptCachePinKey } from '../src/server.js';

// x-claude-code-session-id is client-supplied and, unvalidated, became a Map
// key in the session tracker (unbounded per client) and a column in the TUI
// (Node's header parser lets C1 control bytes through). It is accepted only in
// a conservative shape now; anything else is treated as no session at all,
// which is what an untagged request already means.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const UUID = '0f6b7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

async function withProxy(fn, opts = {}) {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { account: req.headers['x-api-key'] || req.headers.authorization, body: Buffer.concat(chunks) };
    received.push(entry);
    const response = opts.respond?.(entry, received.length) || {};
    res.writeHead(response.status || 200, { 'content-type': 'application/json', ...response.headers });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager((opts.accounts || [{ name: 'a', type: 'apikey', apiKey: 'k1' }])
    .map(a => ({ ...a, upstream: `http://127.0.0.1:${upstreamPort}` })), 0.98, opts);
  const started = [];
  const config = { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` };
  const hooks = { onRequestStart: (_id, info) => started.push(info.sessionId) };
  const proxy = opts.forcedPin
    ? http.createServer(createProxyRequestListener({ accountManager: am, config, upstream: config.upstream, hooks, forcedPin: opts.forcedPin }))
    : createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn(port, started, am, received);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

// http.request: fetch validates header values against a narrower grammar than
// Node's server accepts, and the point is what the server does with the rest.
function post(port, sessionId) {
  return postWithHeaders(port, { 'x-claude-code-session-id': sessionId });
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

// http.request again, so the header name is sent verbatim.
function postWithHeaders(port, extra, { path = '/v1/messages', method = 'POST', body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] })) } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-api-key': 'k', ...extra },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

// The regression. The Codex CLI tags its turns with `session-id`, not with
// Claude Code's header, so every Codex request arrived untagged: the session
// tracker never saw one, `distributeSessions` had nothing to place, and a pool
// of two Codex subscriptions served every request from whichever account was
// current until it reached the switch threshold.
test('a Codex request is tracked by the session-id header its CLI sends', async () => {
  await withProxy(async (port, started) => {
    assert.equal(await postWithHeaders(port, { 'session-id': UUID, originator: 'codex_cli_rs' }), 200);
    assert.deepEqual(started, [UUID]);
  });
});

test('clientSessionId: the Codex spelling, and which header wins', () => {
  assert.equal(clientSessionId({ 'session-id': UUID }), UUID);
  assert.equal(clientSessionId({ 'session-id': 'a/b' }), null);
  assert.equal(clientSessionId({ 'session-id': ['a', 'b'] }), null);
  // Claude Code's header is the specific one, so it decides when both are set —
  // including when its value is malformed, which is still an answer.
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'sess-1', 'session-id': UUID }), 'sess-1');
  assert.equal(clientSessionId({ 'x-claude-code-session-id': 'a/b', 'session-id': UUID }), null);
});

const CODEX_MODEL = 'gpt-5.6-sol';
const CODEX_PATH = '/backend-api/codex/responses';
const codexOpts = { distributeSessions: true, accounts: ['a', 'b'].map(name => ({ name, type: 'apikey', provider: 'codex', apiKey: `key-${name}` })) };
// Deliberately keep wire formatting and escapes: no parsed object may be sent upstream.
const codexBody = (key = 'alpha') => Buffer.from(`{ "model": "${CODEX_MODEL}", "input": "hi\\n", "prompt_cache_key": "${key}", "previous_response_id": "prev", "store": false }`);

test('body-only Codex turns retain an eligible placement', async t => {
  for (const distributeSessions of [true, false]) await t.test(`distribution ${distributeSessions}`, async () => {
    await withProxy(async (port, started, am, received) => {
      const alpha = codexBody();
      const beta = codexBody('beta');
      assert.equal(await postWithHeaders(port, {}, { body: alpha, path: CODEX_PATH }), 200);
      am.recordSession('fixture-load', 0, CODEX_MODEL);
      assert.equal(await postWithHeaders(port, {}, { body: alpha, path: CODEX_PATH }), 200);
      assert.equal(await postWithHeaders(port, {}, { body: beta, path: CODEX_PATH }), 200);
      assert.deepEqual(received.map(r => r.account), ['Bearer key-a', 'Bearer key-a', distributeSessions ? 'Bearer key-b' : 'Bearer key-a']);
      am.setDisabled(0, true);
      assert.equal(await postWithHeaders(port, {}, { body: alpha, path: CODEX_PATH }), 200);
      assert.equal(received[3].account, 'Bearer key-b');
      assert.deepEqual(started, [null, null, null, null]);
      assert.deepEqual(received.map(r => r.body), [alpha, alpha, beta, alpha]);
    }, { ...codexOpts, distributeSessions });
  });
});

const sessionIds = am => (am.getStatus({ sessionDetail: true }).sessions?.items || []).map(s => s.id);
const key = value => codexPromptCachePinKey(Buffer.from(JSON.stringify({ prompt_cache_key: value })));
const wireKey = json => codexPromptCachePinKey(Buffer.from(json));

test('Codex body keys validate the complete decoded JSON and retain full opaque identity', () => {
  assert.match(key('alpha'), /^codex:prompt-cache:[0-9a-f]{64}$/);
  assert.equal(key('alpha').length, 83);
  assert.equal(key('alpha'), 'codex:prompt-cache:902cf2b465fb076229183b408aad4014266eb9eb72d448754227adc1eeac49b9');
  assert.notEqual(key('alpha'), key('beta'));
  for (const value of [undefined, null, 0, true, {}, [], '', 'x'.repeat(129), 'é'.repeat(64) + 'a']) assert.equal(key(value), null);
  for (const body of [null, undefined, Buffer.alloc(0)]) assert.equal(codexPromptCachePinKey(body), null);
  for (const json of ['null', '[]', '42', 'true', '"alpha"', '{}', '{"nested":{"prompt_cache_key":"alpha"}}',
    '{"prompt_cache_key":"alpha"} trailing', '{"prompt_cache_key":"alpha",}', '{"prompt_cache_key":"alpha"']) {
    assert.equal(wireKey(json), null, json);
  }
  assert.ok(key('x'.repeat(128)));
  assert.ok(key('é'.repeat(64)));
  assert.ok(key('😀'.repeat(32)));
  assert.equal(key('😀'.repeat(32) + 'a'), null);
  for (const bytes of [[0xff], [0xfe], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
    assert.equal(codexPromptCachePinKey(Buffer.concat([Buffer.from('{"prompt_cache_key":"'), Buffer.from(bytes), Buffer.from('"}')])), null);
  }
  assert.ok(key('\ufffd'));
  assert.ok(key(' '));
  assert.equal(wireKey('{"promptCacheKey":"alpha"}'), key('alpha'));
  assert.equal(wireKey('{"prompt_cache_key":"alpha","promptCacheKey":"beta"}'), key('alpha'));
  for (const value of [null, '', false, 7, [], {}, 'x'.repeat(129)]) {
    assert.equal(wireKey(JSON.stringify({ prompt_cache_key: value, promptCacheKey: 'alpha' })), null);
  }
  assert.equal(wireKey('{"prompt_cache_key":"\\u00e9"}'), key('é'));
  assert.equal(wireKey('{"prompt\\u005fcache_key":"alpha"}'), key('alpha'));
  assert.equal(wireKey('{"prompt_cache_key":"beta","prompt_cache_key":"alpha"}'), key('alpha'));
  assert.equal(wireKey('{"prompt_cache_key":"alpha","prompt_cache_key":null}'), null);
  assert.notEqual(key('é'), key('e\u0301'));
  assert.notEqual(key('\ud800'), key('\ud801'));
  assert.notEqual(key('\ud800'), key('\ufffd'));
  const values = Array.from({ length: 32 }, (_, i) => 'prefix'.repeat(18) + String.fromCodePoint(0x100 + i));
  assert.equal(new Set(values.map(key)).size, values.length);
  assert.ok(values.map(key).every(k => k.length === 83));
});

test('supported header presence suppresses body affinity, preserving current header precedence', async t => {
  const cases = [
    [{ 'session-id': 'header-a' }, 'header-a'],
    [{ 'x-claude-code-session-id': 'header-b' }, 'header-b'],
    [{ 'session-id': 'header-a', 'x-claude-code-session-id': 'header-b' }, 'header-b'],
    [{ 'session-id': 'header-a', 'x-claude-code-session-id': 'bad/id' }, null],
    ...['session-id', 'x-claude-code-session-id'].flatMap(h => ['', 'bad/id'].map(v => [{ [h]: v }, null])),
  ];
  for (const [headers, expected] of cases) await t.test(JSON.stringify(headers) + String(expected), async () => {
    await withProxy(async (port, started, am, received) => {
      const body = codexBody();
      assert.equal(await postWithHeaders(port, headers, { body, path: CODEX_PATH }), 200);
      assert.deepEqual(started, [expected]);
      assert.deepEqual(sessionIds(am), expected ? [expected] : []);
      assert.deepEqual(received.map(r => r.body), [body]);
    }, codexOpts);
  });
});

test('body affinity is confined to classified POST Codex Responses after pin stripping', async t => {
  for (const [method, path, accepted] of [
    ['POST', CODEX_PATH, true], ['POST', CODEX_PATH + '?x=1', true],
    ['POST', '/backend-api/codex/%72esponses', true], ['POST', '/backend-api\\codex\\responses', true],
    ['POST', '/tc-acct/b' + CODEX_PATH + '?x=1', true],
    ['PUT', CODEX_PATH, false],
    ...['/v1/responses', '/backend-api/codex/models', CODEX_PATH + '/', CODEX_PATH + '/extra', '/v1/messages'].map(p => ['POST', p, false]),
  ]) await t.test(method + ' ' + path, async () => {
    await withProxy(async (port, started, am, received) => {
      const body = Buffer.from(JSON.stringify({ model: CODEX_MODEL, input: 'x'.repeat(256 * 1024), prompt_cache_key: 'alpha' }));
      assert.equal(await postWithHeaders(port, {}, { body, method, path }), 200);
      assert.deepEqual(sessionIds(am), accepted ? [key('alpha')] : []);
      assert.deepEqual(started, [null]);
      assert.deepEqual(received.map(r => r.body), [body]);
      if (path.startsWith('/tc-acct/')) assert.equal(received[0].account, 'Bearer key-b');
    }, codexOpts);
  });
});

test('body, header and Anthropic conversation identities stay separate on shared API-key capacity', async () => {
  await withProxy(async (port, _started, am, received) => {
    const body = codexBody();
    assert.equal(await postWithHeaders(port, {}, { body, path: CODEX_PATH }), 200);
    assert.equal(await postWithHeaders(port, { 'session-id': 'alpha' }, { body, path: CODEX_PATH }), 200);
    const anthropic = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], prompt_cache_key: 'alpha' }));
    assert.equal(await postWithHeaders(port, { 'session-id': 'alpha' }, { body: anthropic }), 200);
    const ids = sessionIds(am);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes('alpha'));
    assert.ok(ids.includes(key('alpha')));
    assert.ok(ids.some(id => id.startsWith('alpha/')));
    assert.deepEqual(received.map(r => r.body), [body, body, anthropic]);
  }, codexOpts);
});

test('body affinity preserves hard pins and model route eligibility', async t => {
  for (const pin of ['path', 'forced', 'session', 'model', 'body-is-not-session']) await t.test(pin, async () => {
    await withProxy(async (port, _started, am, received) => {
      const body = codexBody();
      // Seed conflicting ordinary affinity without changing the hard-pin owners.
      am.recordSession(key('alpha'), 0, CODEX_MODEL);
      const headers = {};
      let path = CODEX_PATH;
      if (pin === 'path') path = '/tc-acct/b' + path;
      if (pin === 'session') {
        headers['session-id'] = 'operator';
        am.recordSession('operator', 0, CODEX_MODEL);
        am.sessionPins.set('operator', 'b');
      }
      if (pin === 'model') am.setRoutes([{ name: 'codex', match: [CODEX_MODEL], accounts: ['b'] }]);
      if (pin === 'body-is-not-session') am.sessionPins.set(key('alpha'), 'b');
      assert.equal(await postWithHeaders(port, headers, { body, path }), 200);
      assert.equal(received[0].account, pin === 'body-is-not-session' ? 'Bearer key-a' : 'Bearer key-b');
      assert.deepEqual(received[0].body, body);
    }, { ...codexOpts, ...(pin === 'forced' ? { forcedPin: 'b' } : {}) });
  });
});

test('body affinity follows quota retry and retains exact bytes on every attempt', async () => {
  await withProxy(async (port, started, am, received) => {
    const body = codexBody();
    assert.equal(await postWithHeaders(port, {}, { body, path: CODEX_PATH }), 200);
    // A is still held, so routing alone cannot prove the retry recorded B.
    assert.deepEqual(am.sessionTracker.pinnedAccounts(key('alpha')), [1]);
    assert.equal(await postWithHeaders(port, {}, { body, path: CODEX_PATH }), 200);
    assert.deepEqual(received.map(r => r.account), ['Bearer key-a', 'Bearer key-b', 'Bearer key-b']);
    assert.deepEqual(received.map(r => r.body), [body, body, body]);
    assert.deepEqual(started, [null, null]);
  }, { ...codexOpts, respond: (_entry, attempt) => attempt === 1 ? { status: 429, headers: {
    'retry-after': '45', 'x-codex-plan-type': 'pro',
    'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 6 * 3600),
    'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0',
  } } : null });
});

test('invalid body keys do not reject or rewrite the HTTP request', async () => {
  await withProxy(async (port, started, am, received) => {
    const malformed = [0xff, 0xfe].map(byte => Buffer.concat([
      Buffer.from('{"model":"gpt-5.6-sol","prompt_cache_key":"'), Buffer.from([byte]), Buffer.from('"}'),
    ]));
    for (const body of malformed) assert.equal(await postWithHeaders(port, {}, { body, path: CODEX_PATH }), 400);
    assert.deepEqual(sessionIds(am), [], 'invalid UTF-8 must not seed a replacement-character affinity');
    am.recordSession('fixture-load', 0, CODEX_MODEL);
    const control = codexBody('\ufffd');
    assert.equal(await postWithHeaders(port, {}, { body: control, path: CODEX_PATH }), 200);
    assert.equal(received[2].account, 'Bearer key-b', 'valid U+FFFD must receive fresh placement');
    const bodies = ['{"model":"gpt-5.6-sol","prompt_cache_key":"alpha"} trailing',
      '{"model":"gpt-5.6-sol","prompt_cache_key":null,"promptCacheKey":"alpha"}',
      '{"model":"gpt-5.6-sol","prompt_cache_key":""}'].map(s => Buffer.from(s));
    for (const body of bodies) assert.equal(await postWithHeaders(port, {}, { body, path: CODEX_PATH }), 200);
    assert.deepEqual(sessionIds(am).filter(id => id.startsWith('codex:')), [key('\ufffd')]);
    assert.deepEqual(started, Array(6).fill(null));
    assert.deepEqual(received.map(r => r.body), [...malformed, control, ...bodies]);
  }, { ...codexOpts, respond: (_entry, attempt) => attempt <= 2 ? { status: 400 } : null });
});
