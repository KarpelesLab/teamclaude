import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, callerView, resolveClientAuth } from '../src/server.js';

// A proxy.clientKeys entry may carry `scope: "inference"`: one of the operator's
// own agents or machines, which should reach the model API and nothing else.
// Such a key is refused every /teamclaude/* control route. The data plane is
// unchanged, and an entry without a scope behaves exactly as it always has.

const SHARED_KEY = 'tc-shared';
const SCOPED_KEY = 'tc-agent-inference';
const FULL_KEY = 'tc-laptop-full';
const ACCT_SECRET = 'sk-ant-fleet-secret';

const CONTROL_ROUTES = [
  ['GET', '/teamclaude/status'],
  ['GET', '/teamclaude/quota'],
  ['POST', '/teamclaude/reload'],
  ['POST', '/teamclaude/switch', { account: 'acct' }],
  ['POST', '/teamclaude/probe'],
  ['POST', '/teamclaude/threshold', { percent: 50 }],
  ['POST', '/teamclaude/priority', { account: 'acct', place: 'first' }],
  ['POST', '/teamclaude/disable', { account: 'acct', disabled: true }],
  ['POST', '/teamclaude/session-pin', {}],
  ['POST', '/teamclaude/drain'],
  ['POST', '/teamclaude/undrain'],
  ['POST', '/teamclaude/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
  ['GET', '/teamclaude/mcp'],
  ['POST', '/teamclaude/no-such-route', {}],
];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A raw request, so the path reaches the wire exactly as written: fetch would
// normalise some of the spellings these tests depend on.
function send(port, { method = 'GET', path, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      ...(key ? { 'x-api-key': key } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// `hits` lists every path that reached the fake upstream: an empty list after a
// request means the proxy answered it itself.
async function withProxy(fn, overrides = {}) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message"}');
    });
  });
  const upstreamPort = await listen(upstream);
  const reloads = { count: 0 };
  const hooks = { reload: async () => { reloads.count++; return { added: 0, removed: 0 }; } };
  const am = new AccountManager([{ name: 'acct', type: 'apikey', apiKey: ACCT_SECRET }], 0.98);
  const config = {
    proxy: {
      apiKey: SHARED_KEY,
      mcp: 'read',
      clientKeys: [
        { name: 'agent', key: SCOPED_KEY, scope: 'inference' },
        { name: 'laptop', key: FULL_KEY },
      ],
      ...overrides,
    },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  };
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  try {
    await fn({ port, hits, reloads });
  } finally {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

const MESSAGE = { method: 'POST', path: '/v1/messages', body: { model: 'x', messages: [] } };

test('an inference key reaches the data plane', async () => {
  await withProxy(async ({ port, hits }) => {
    const res = await send(port, { ...MESSAGE, key: SCOPED_KEY });
    assert.equal(res.status, 200);
    assert.deepEqual(hits, ['/v1/messages']);
  });
});

test('an inference key is refused every control route, and nothing runs', async () => {
  await withProxy(async ({ port, hits, reloads }) => {
    for (const [method, path, body] of CONTROL_ROUTES) {
      const res = await send(port, { method, path, body, key: SCOPED_KEY });
      assert.equal(res.status, 403, `${method} ${path}`);
      const json = JSON.parse(res.text);
      assert.equal(json.ok, false, `${method} ${path}`);
      assert.match(json.error, /scoped to inference/, `${method} ${path}`);
    }
    assert.deepEqual(hits, [], 'a refused control route is never forwarded upstream');
    assert.equal(reloads.count, 0, 'reload did not run');
  });
});

test('the refusal covers encoded and /teamrouter spellings', async () => {
  await withProxy(async ({ port, hits, reloads }) => {
    for (const [method, path] of [
      ['GET', '/%74eamclaude/status'],
      ['POST', '/%74eamclaude/reload'],
      ['GET', '/teamrouter/status'],
      ['POST', '/teamrouter/reload'],
      ['GET', '/%74eamrouter/status'],
      ['POST', '/teamclaude%2Freload'],
      ['POST', '/teamclaude\\reload'],
    ]) {
      const res = await send(port, { method, path, key: SCOPED_KEY });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.match(JSON.parse(res.text).error, /scoped to inference/, `${method} ${path}`);
    }
    assert.deepEqual(hits, [], 'no spelling reached upstream');
    assert.equal(reloads.count, 0, 'no spelling reloaded');
  });
});

test('the dashboard page and the data plane stay open to an inference key', async () => {
  await withProxy(async ({ port, hits }) => {
    const page = await send(port, { path: '/teamclaude/dashboard', key: SCOPED_KEY });
    assert.equal(page.status, 200);
    const res = await send(port, { ...MESSAGE, key: SCOPED_KEY });
    assert.equal(res.status, 200);
    assert.deepEqual(hits, ['/v1/messages']);
  });
});

test('a key with no scope keeps every control route it had', async () => {
  await withProxy(async ({ port, hits, reloads }) => {
    const status = await send(port, { path: '/teamclaude/status', key: FULL_KEY });
    assert.equal(status.status, 200);
    const { caller } = JSON.parse(status.text);
    assert.equal(caller.kind, 'client');
    assert.equal(caller.client, 'laptop');
    assert.equal(caller.scope, undefined, 'the caller view is unchanged for an unscoped key');
    assert.ok(caller.refused.includes('/teamclaude/priority'));

    const reload = await send(port, { method: 'POST', path: '/teamclaude/reload', key: FULL_KEY });
    assert.equal(reload.status, 200);
    assert.equal(reloads.count, 1);

    const mcp = await send(port, { method: 'POST', path: '/teamclaude/mcp', key: FULL_KEY, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(mcp.status, 200);

    const res = await send(port, { ...MESSAGE, key: FULL_KEY });
    assert.equal(res.status, 200);
    assert.deepEqual(hits, ['/v1/messages']);
  });
});

test('the auth result carries the scope of an inference key and nothing for the others', () => {
  const cfg = {
    apiKey: SHARED_KEY,
    clientKeys: [
      { name: 'agent', key: SCOPED_KEY, scope: 'inference' },
      { name: 'laptop', key: FULL_KEY },
      { name: 'explicit', key: 'explicit-key', scope: 'full' },
    ],
  };
  assert.deepEqual(resolveClientAuth(cfg, SCOPED_KEY), { ok: true, client: 'agent', scope: 'inference' });
  assert.deepEqual(resolveClientAuth(cfg, FULL_KEY), { ok: true, client: 'laptop' });
  assert.deepEqual(resolveClientAuth(cfg, 'explicit-key'), { ok: true, client: 'explicit' });
  assert.deepEqual(resolveClientAuth(cfg, SHARED_KEY), { ok: true, client: null });
});

test('callerView reports an inference key as refused every control route', () => {
  assert.deepEqual(callerView('agent', 'inference'), {
    kind: 'client', client: 'agent', scope: 'inference', refused: ['/teamclaude/*'],
  });
  assert.deepEqual(callerView('laptop', 'full'), callerView('laptop'));
  assert.deepEqual(callerView(null, 'inference'), { kind: 'operator', client: null, refused: [] });
});

// A scope we do not recognise is never read as "full": the entry stays usable
// and is treated as inference-only, so a typo narrows a key rather than
// removing it or widening it.
test('an unrecognised scope keeps its key usable, and narrows it to inference', () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const cfg = {
      clientKeys: [
        { name: 'typo', key: 'typo-key', scope: 'inferance' },
        { name: 'nul', key: 'nul-key', scope: null },
        { name: 'ok', key: 'ok-key' },
      ],
    };
    assert.deepEqual(resolveClientAuth(cfg, 'typo-key'), { ok: true, client: 'typo', scope: 'inference' });
    assert.deepEqual(resolveClientAuth(cfg, 'nul-key'), { ok: true, client: 'nul', scope: 'inference' });
    assert.deepEqual(resolveClientAuth(cfg, 'ok-key'), { ok: true, client: 'ok' });
    assert.deepEqual(resolveClientAuth(cfg, 'wrong'), { ok: false, client: null });
    resolveClientAuth(cfg, 'ok-key'); // same array: no second round of warnings
  } finally { console.error = orig; }
  assert.equal(errors.filter(e => /"typo" has an unrecognised scope and is treated as inference-only/.test(e)).length, 1);
  assert.equal(errors.filter(e => /"nul" has an unrecognised scope/.test(e)).length, 1);
  assert.ok(!errors.some(e => e.includes('typo-key') || e.includes('nul-key')), 'a warning never prints a key');
});

test('a typo as the only entry admits its own key, and no other', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const cfg = { clientKeys: [{ name: 'typo', key: 'typo-key', scope: 'inferance' }] };
    assert.deepEqual(resolveClientAuth(cfg, 'anything'), { ok: false, client: null });
    assert.deepEqual(resolveClientAuth(cfg, undefined), { ok: false, client: null });
    assert.deepEqual(resolveClientAuth(cfg, 'typo-key'), { ok: true, client: 'typo', scope: 'inference' });
  } finally { console.error = orig; }
});

test('a typo as the only key does not open the gate, and is refused control routes', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    await withProxy(async ({ port, hits }) => {
      assert.equal((await send(port, { ...MESSAGE, key: 'wrong-key' })).status, 401);
      assert.equal((await send(port, { ...MESSAGE })).status, 401);
      assert.equal((await send(port, { ...MESSAGE, key: 'typo-key' })).status, 200);
      const control = await send(port, { path: '/teamclaude/status', key: 'typo-key' });
      assert.equal(control.status, 403);
      assert.deepEqual(hits, ['/v1/messages'], 'only the data-plane request reached upstream');
    }, { apiKey: undefined, trustLoopback: false, clientKeys: [{ name: 'typo', key: 'typo-key', scope: 'inferance' }] });
  } finally { console.error = orig; }
});
