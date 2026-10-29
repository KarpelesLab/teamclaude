import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { connectAuthorized } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';

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
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
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
    accounts: [{ name: 'codex', type: 'oauth', provider: 'codex', upstream: upstreamUrl }],
  };
  const proxy = createProxyServer(am, config, { reload: async () => ({ added: 0, removed: 0 }) });
  allowLoopbackForward(proxy); // the forward test's destination is the fake upstream on 127.0.0.1
  const port = await listen(proxy);
  try {
    await fn({ port, seen, upstreamUrl });
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

test('a Bearer is not a credential on the control routes: any key sent that way is refused with 401', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const key of [SCOPED_KEY, FULL_KEY]) {
      for (const [method, path] of [
        ['GET', '/teamclaude/status'],
        ['POST', '/teamclaude/reload'],
        ['POST', '/teamclaude/switch'],
        ['GET', '/teamrouter/status'],
      ]) {
        const res = await send(port, { method, path, headers: bearer(key), body: method === 'POST' ? {} : undefined });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    }
    assert.deepEqual(seen, []);
  });
});

test('an inference-scoped key keeps its 403 on the control routes when sent as x-api-key', async () => {
  await withProxy(async ({ port }) => {
    const res = await send(port, { path: '/teamclaude/status', headers: { 'x-api-key': SCOPED_KEY } });
    assert.equal(res.status, 403);
  });
});

test('the shared proxy.apiKey is not a Bearer credential: it presents no key, as an unknown token does', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const [method, path] of [['POST', '/v1/messages'], ['GET', '/teamclaude/status']]) {
      const res = await send(port, { method, path, headers: bearer(SHARED_KEY), body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, path);
    }
    // In x-api-key it is the operator's key, as ever.
    const status = await send(port, { path: '/teamclaude/status', headers: { 'x-api-key': SHARED_KEY } });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).caller.kind, 'operator');
    assert.deepEqual(seen, []);
  });
});

test('the Bearer scheme is matched case-insensitively', async () => {
  await withProxy(async ({ port }) => {
    for (const authorization of [`bearer ${SCOPED_KEY}`, `BEARER ${SCOPED_KEY}`]) {
      assert.equal((await send(port, { ...MESSAGE, headers: { authorization } })).status, 200, authorization);
    }
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
    // On a control route a Bearer is not read at all, so it is the operator.
    const status = await send(port, { path: '/teamclaude/status', headers: bearer(FULL_KEY) });
    assert.equal(JSON.parse(status.text).caller.client, null);
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

// A Bearer presents a proxy key only on the data-plane routes below. Everywhere
// else Authorization is the client's own credential (its claude.ai login on the
// credential paths, its ChatGPT login on chatgpt.com, an arbitrary tool's on a
// forwarded request): it is neither read as a proxy key nor stripped, so the
// proxy relays exactly what it relayed before Bearer keys existed.

const BEARER_CLIENT = bearer(SCOPED_KEY);

test('a Bearer equal to a client key is not accepted on the relayed credential paths, and nothing is relayed', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const [method, path] of [
      ['GET', '/v1/code/sessions'],
      ['GET', '/api/oauth/profile'],
      ['GET', '/v1/mcp_servers'],
      ['GET', '/v1/sessions'],
      ['GET', '/v1/environments/x'],
      ['GET', '/v1/models/'],
      ['POST', '/v1/messages/'],
      ['POST', '/%761/messages'],
    ]) {
      const res = await send(port, { method, path, headers: BEARER_CLIENT, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.deepEqual(seen, []);
  });
});

test('on a credential path from loopback the client\'s own Authorization reaches upstream untouched, as before', async () => {
  await withProxy(async ({ port, seen }) => {
    for (const authorization of [`Bearer ${SCOPED_KEY}`, 'Bearer a-claude-ai-login']) {
      const res = await send(port, { path: '/v1/code/sessions', headers: { authorization } });
      assert.equal(res.status, 200);
      assert.equal(seen.at(-1).authorization, authorization);
    }
    assert.equal(seen.length, 2);
  }, { trustLoopback: true });
});

test('the chatgpt.com passthrough does not take a Bearer as a proxy key and relays the client\'s login as sent', async () => {
  await withProxy(async ({ port, seen }) => {
    const path = '/backend-api/wham/accounts/check';
    const refused = await send(port, { path, headers: { host: 'chatgpt.com', ...BEARER_CLIENT } });
    assert.equal(refused.status, 401);
    assert.deepEqual(seen, []);
  });
  await withProxy(async ({ port, seen }) => {
    // Admitted by the x-api-key, the client's own Authorization rides along.
    const res = await send(port, { path: '/backend-api/wham/accounts/check', headers: { host: 'chatgpt.com', 'x-api-key': SHARED_KEY, authorization: 'Bearer a-chatgpt-login' } });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer a-chatgpt-login');
  });
});

test('a forwarded absolute-form request does not take a Bearer as a proxy key and relays Authorization as sent', async () => {
  await withProxy(async ({ port, seen, upstreamUrl }) => {
    const refused = await send(port, { path: `${upstreamUrl}/anything`, headers: BEARER_CLIENT });
    assert.equal(refused.status, 401);
    assert.deepEqual(seen, []);
  });
  await withProxy(async ({ port, seen, upstreamUrl }) => {
    // Admitted by the x-api-key, the client's own Authorization rides along.
    const res = await send(port, { path: `${upstreamUrl}/anything`, headers: { 'x-api-key': SHARED_KEY, authorization: 'Bearer a-tool-token' } });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer a-tool-token');
  });
});

test('a WebSocket upgrade does not take a Bearer as a proxy key', async () => {
  await withProxy(async ({ port, seen }) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/code/sessions/x/ws',
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...BEARER_CLIENT },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401);
    assert.deepEqual(seen, []);
  });
});

test('on the allowlisted data routes the Bearer never reaches upstream', async () => {
  await withProxy(async ({ port, seen }) => {
    const routes = [
      ['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models'],
      ['POST', '/backend-api/codex/responses'], ['GET', '/backend-api/codex/models'],
    ];
    for (const [method, path] of routes) {
      const res = await send(port, { method, path, headers: BEARER_CLIENT, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 200, `${method} ${path}`);
    }
    assert.equal(seen.length, routes.length);
    assert.ok(seen.every(s => !JSON.stringify(s).includes(SCOPED_KEY)));
  });
});

test('a Bearer key never reaches upstream when the client addresses chatgpt.com with an Anthropic-shaped data route', async () => {
  await withProxy(async ({ port, seen }) => {
    // The Host header makes clientPassthroughOrigin relay these as the client's own
    // chatgpt.com traffic, which copies the client's headers: the proxy key the
    // gate consumed must be gone from them.
    const routes = [
      ['POST', '/v1/messages?beta=true'], ['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models'],
    ];
    for (const [method, path] of routes) {
      const res = await send(port, { method, path, headers: { host: 'chatgpt.com', ...BEARER_CLIENT }, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 200, `${method} ${path}`);
    }
    assert.equal(seen.length, routes.length, 'each request was relayed');
    assert.ok(seen.every(s => !JSON.stringify(s).includes(SCOPED_KEY)), 'no request carried the client key');
  });
});

test('a pin-prefixed path is not a data route for a Bearer: a pinned request needs x-api-key', async () => {
  await withProxy(async ({ port, seen }) => {
    const bearerRes = await send(port, { ...MESSAGE, path: '/tc-acct/claude/v1/messages', headers: BEARER_CLIENT });
    assert.equal(bearerRes.status, 401);
    const keyRes = await send(port, { ...MESSAGE, path: '/tc-acct/claude/v1/messages', headers: { 'x-api-key': SCOPED_KEY } });
    assert.equal(keyRes.status, 200);
    assert.equal(seen.length, 1);
  });
});
