import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { connectAuthorized } from '../src/mitm.js';

// Codex authenticates to its base URL with `Authorization: Bearer <key>`, never
// x-api-key, so a named proxy.clientKeys key handed to Codex was refused with a
// 401. A named client key now also authenticates when it is the single Bearer
// credential of the request. The Bearer is consumed by the proxy and never sent
// upstream; x-api-key still wins when both are present; the loopback exemption
// and the CONNECT Proxy-Authorization gate are unchanged.

const SHARED_KEY = 'tc-shared';
const SCOPED_KEY = 'tc-agent-inference';
const FULL_KEY = 'tc-laptop-full';
const CLAUDE_TOKEN = 'claude-pool-credential';
const CODEX_TOKEN = 'codex-pool-credential';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// `headers` is passed through untouched, so an array value sends the header
// twice, as a client that repeats Authorization would.
function send(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// `seen` records the credential headers of every request that reached the fake
// upstream: an empty list after a request means the proxy answered it itself.
// Loopback is not exempt unless a test says so, so the key gate is what answers.
async function withProxy(fn, overrides = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message"}');
    });
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: CLAUDE_TOKEN, refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'oauth', provider: 'codex', accessToken: CODEX_TOKEN, refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountId: 'acct-codex', upstream: upstreamUrl },
  ], 0.98);
  const config = {
    proxy: {
      apiKey: SHARED_KEY,
      trustLoopback: false,
      clientKeys: [
        { name: 'agent', key: SCOPED_KEY, scope: 'inference' },
        { name: 'laptop', key: FULL_KEY },
      ],
      ...overrides,
    },
    upstream: upstreamUrl,
  };
  const proxy = createProxyServer(am, config, { reload: async () => ({ added: 0, removed: 0 }) });
  const port = await listen(proxy);
  try {
    await fn({ port, seen });
  } finally {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

const MESSAGE = { method: 'POST', path: '/v1/messages', body: { model: 'x', messages: [] } };
const CODEX = { method: 'POST', path: '/backend-api/codex/responses', body: { model: 'gpt-x', input: [] } };
const bearer = (key) => ({ authorization: `Bearer ${key}` });

test('a named client key as Bearer reaches /v1/messages', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const key of [FULL_KEY, SCOPED_KEY]) {
      const res = await send(port, { ...MESSAGE, headers: bearer(key) });
      assert.equal(res.status, 200, key);
    }
    assert.equal(seen.length, 2);
  });
});

test('a named client key as Bearer reaches the Codex responses route', async () => {
  await withProxy(async ({ port, seen }) => {
    const res = await send(port, { ...CODEX, headers: bearer(SCOPED_KEY) });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.map(s => s.url), ['/backend-api/codex/responses']);
  });
});

test('the Bearer key never reaches upstream, only the pool account\'s credential does', async () => {
  await withProxy(async ({ port, seen }) => {
    await send(port, { ...MESSAGE, headers: bearer(SCOPED_KEY) });
    await send(port, { ...CODEX, headers: bearer(SCOPED_KEY) });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.ok(!JSON.stringify(s).includes(SCOPED_KEY), `${s.url} carried the client key`);
    }
    assert.equal(seen[0].authorization, `Bearer ${CLAUDE_TOKEN}`);
    assert.equal(seen[0].apiKey, undefined);
    assert.equal(seen[1].authorization, `Bearer ${CODEX_TOKEN}`);
    assert.equal(seen[1].apiKey, undefined);
  });
});

test('an inference-scoped Bearer key is refused every control route with 403', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const [method, path] of [
      ['GET', '/teamclaude/status'],
      ['POST', '/teamclaude/reload'],
      ['POST', '/teamclaude/switch'],
      ['GET', '/teamrouter/status'],
    ]) {
      const res = await send(port, { method, path, headers: bearer(SCOPED_KEY), body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    assert.deepEqual(seen, []);
  });
});

test('a full-scope Bearer key is attributed to its name', async () => {
  await withProxy(async ({ port }) => {
    const res = await send(port, { path: '/teamclaude/status', headers: bearer(FULL_KEY) });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).caller.client, 'laptop');
  });
});

test('the shared proxy.apiKey as Bearer behaves exactly as it does in x-api-key', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const headers of [bearer(SHARED_KEY), { 'x-api-key': SHARED_KEY }]) {
      const data = await send(port, { ...MESSAGE, headers });
      assert.equal(data.status, 200);
      const status = await send(port, { path: '/teamclaude/status', headers });
      assert.equal(status.status, 200);
      assert.equal(JSON.parse(status.text).caller.kind, 'operator');
    }
    assert.ok(seen.every(s => !JSON.stringify(s).includes(SHARED_KEY)));
  });
});

test('a wrong Bearer is refused with 401, as a wrong x-api-key is', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const headers of [bearer('nope'), { 'x-api-key': 'nope' }, { authorization: 'Bearer' }, { authorization: 'Basic ' + SCOPED_KEY }, { authorization: SCOPED_KEY }, {}]) {
      const res = await send(port, { ...MESSAGE, headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
    }
    assert.deepEqual(seen, []);
  });
});

test('two Authorization headers are refused with 401, even when one is valid', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const authorization of [[`Bearer ${SCOPED_KEY}`, 'Bearer nope'], ['Bearer nope', `Bearer ${SCOPED_KEY}`], [`Bearer ${SCOPED_KEY}`, `Bearer ${SCOPED_KEY}`]]) {
      const res = await send(port, { ...MESSAGE, headers: { authorization } });
      assert.equal(res.status, 401, authorization.join(' | '));
    }
    assert.deepEqual(seen, []);
  });
});

test('x-api-key wins when both credentials are present', async () => {
  await withProxy(async ({ port, seen }) => {
    // A valid x-api-key is not undone by a bad Bearer, and it is the identity.
    const ok = await send(port, { path: '/teamclaude/status', headers: { 'x-api-key': FULL_KEY, ...bearer('nope') } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).caller.client, 'laptop');
    // A bad x-api-key is not rescued by a valid Bearer.
    const bad = await send(port, { ...MESSAGE, headers: { 'x-api-key': 'nope', ...bearer(FULL_KEY) } });
    assert.equal(bad.status, 401);
    // The x-api-key scope applies even when the Bearer names a wider key.
    const scoped = await send(port, { path: '/teamclaude/status', headers: { 'x-api-key': SCOPED_KEY, ...bearer(FULL_KEY) } });
    assert.equal(scoped.status, 403);
    assert.deepEqual(seen, []);
  });
});

test('the loopback exemption is unchanged: a keyless or non-matching Bearer from loopback still passes, unattributed', async () => {
  await withProxy(async ({ port, seen }) => {
    // A Codex client logged in to its own ChatGPT account sends a Bearer that is
    // not a proxy key; on loopback that passes by the exemption, as before.
    for (const headers of [{}, bearer('a-chatgpt-login-token')]) {
      const res = await send(port, { ...MESSAGE, headers });
      assert.equal(res.status, 200);
    }
    const status = await send(port, { path: '/teamclaude/status', headers: bearer('a-chatgpt-login-token') });
    assert.equal(JSON.parse(status.text).caller.client, null);
    // A matching Bearer from loopback is attributed to its key.
    const named = await send(port, { path: '/teamclaude/status', headers: bearer(FULL_KEY) });
    assert.equal(JSON.parse(named.text).caller.client, 'laptop');
    assert.equal(seen.length, 2);
  }, { trustLoopback: true });
});

test('a forwarding header removes the loopback exemption for a Bearer too', async () => {
  await withProxy(async ({ port, seen }) => {
    const refused = await send(port, { ...MESSAGE, headers: { 'x-forwarded-for': '203.0.113.9', ...bearer('nope') } });
    assert.equal(refused.status, 401);
    const allowed = await send(port, { ...MESSAGE, headers: { 'x-forwarded-for': '203.0.113.9', ...bearer(SCOPED_KEY) } });
    assert.equal(allowed.status, 200);
    assert.equal(seen.length, 1);
  }, { trustLoopback: true });
});

test('trustLoopback:false still refuses a keyless request, Bearer or not', async () => {
  await withProxy(async ({ port, seen }) => {
    assert.equal((await send(port, MESSAGE)).status, 401);
    assert.equal((await send(port, { ...MESSAGE, headers: bearer('a-chatgpt-login-token') })).status, 401);
    assert.deepEqual(seen, []);
  });
});

test('CONNECT Proxy-Authorization is unchanged: Authorization is not read, the shared key is', () => {
  const remote = { remoteAddress: '203.0.113.9' };
  const connect = (headers) => connectAuthorized({ headers }, remote, SHARED_KEY);
  assert.equal(connect({ 'proxy-authorization': `Bearer ${SHARED_KEY}` }), true);
  assert.equal(connect({ 'proxy-authorization': 'Bearer nope' }), false);
  assert.equal(connect({ authorization: `Bearer ${SHARED_KEY}` }), false);
  assert.equal(connect({}), false);
});
