import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener, clientPassthroughOrigin } from '../src/server.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// With Codex accounts in the pool the MITM intercepts all of chatgpt.com, but the
// request path routes by its PATH alone: /backend-api/codex/* is Codex and
// everything else is Anthropic. So every other request a Codex client makes on
// chatgpt.com — codex-cli 0.156's workspace discovery before each turn, its
// plugin, MCP and settings calls — went to api.anthropic.com with a pooled Claude
// token and drew a 404, and 0.156 refused to start on that (#492). None of it is
// inference and all of it belongs to the client's own ChatGPT login, so it is
// passed through to the host the client asked for, as sent.

const claude = (name) => ({ name, type: 'oauth', accessToken: 'T-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
const codex = (name, extra = {}) => ({ ...claude(name), provider: 'codex', accountId: 'acct-' + name, ...extra });

// ── the decision ─────────────────────────────────────────────

test('a non-Codex request on the intercepted chatgpt.com goes to chatgpt.com; everything else stays ours', () => {
  const config = { upstream: 'https://api.anthropic.com', accounts: [claude('a'), codex('c')] };
  const origin = (authority, url, cfg = config, accounts = []) => clientPassthroughOrigin({ authority, url, config: cfg, accounts });
  // The calls 0.156 makes that are not inference.
  assert.equal(origin('chatgpt.com', '/backend-api/wham/accounts/check'), 'https://chatgpt.com');
  assert.equal(origin('chatgpt.com:443', '/backend-api/ps/plugins/featured'), 'https://chatgpt.com');
  assert.equal(origin('CHATGPT.COM.', '/backend-api/wham/settings/user'), 'https://chatgpt.com');
  // Codex inference on the same host is the pool's.
  assert.equal(origin('chatgpt.com', '/backend-api/codex/responses'), null);
  assert.equal(origin('chatgpt.com', '/backend-api/codex'), null);
  // An Anthropic request on the Anthropic host, pinned or not, is routed as ever.
  assert.equal(origin('api.anthropic.com', '/v1/messages'), null);
  assert.equal(origin('api.anthropic.com', '/backend-api/wham/accounts/check'), null);
  // A base-URL client addresses the proxy itself.
  assert.equal(origin('127.0.0.1:3456', '/backend-api/wham/accounts/check'), null);
  assert.equal(origin(undefined, '/backend-api/wham/accounts/check'), null);
  assert.equal(origin('', '/x'), null);
  assert.equal(origin('a b', '/x'), null);
  // Hosts the proxy never terminates cannot be passed through: a look-alike, the
  // telemetry subdomain, and chatgpt.com itself in a fleet with no Codex account.
  assert.equal(origin('ab.chatgpt.com', '/x'), null);
  assert.equal(origin('chatgpt.com.evil.test', '/x'), null);
  assert.equal(origin('chatgpt.com', '/backend-api/wham/accounts/check', { accounts: [claude('a')] }), null);
  // Codex accounts behind a gateway: the gateway stands in for the host.
  assert.equal(origin('chatgpt.com', '/backend-api/wham/accounts/check', config, [claude('a'), codex('c', { upstream: 'http://127.0.0.1:4000' })]), 'http://127.0.0.1:4000');
});

// ── through the request listener ─────────────────────────────

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function closeHard(server) { server?.closeAllConnections?.(); try { server?.close(); } catch { /* closing */ } }

// Records what reached it, body included.
async function recordingUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, accountId: req.headers['chatgpt-account-id'] || null, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(server);
  return { server, port, seen };
}

function request(port, { method = 'GET', path, host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.once('error', reject);
    r.end(body);
  });
}

// The pool is never consulted for a passthrough: an account manager that throws
// from selection proves it by the test passing at all.
const refusing = (accounts) => ({ accounts, getActiveAccount() { throw new Error('must not rotate a chatgpt.com passthrough'); } });

test('a Codex client\'s workspace check on chatgpt.com reaches chatgpt.com with its own login, body and path intact', async () => {
  const up = await recordingUpstream();
  const codexAccount = { ...codex('c', { upstream: `http://127.0.0.1:${up.port}` }), index: 0, provider: 'codex' };
  const config = { upstream: 'https://api.anthropic.invalid', accounts: [claude('a'), codex('c')] };
  const proxy = http.createServer(createProxyRequestListener({ accountManager: refusing([codexAccount]), upstream: config.upstream, config }));
  const port = await listen(proxy);
  try {
    const get = await request(port, { path: '/backend-api/wham/accounts/check', host: 'chatgpt.com', headers: { authorization: 'Bearer client-own-token', 'chatgpt-account-id': 'client-acct' } });
    assert.equal(get.status, 200);
    const post = await request(port, { method: 'POST', path: '/backend-api/wham/settings/user', host: 'chatgpt.com:443', headers: { authorization: 'Bearer client-own-token', 'content-type': 'application/json' }, body: '{"theme":"dark"}' });
    assert.equal(post.status, 200);
    assert.deepEqual(up.seen, [
      { method: 'GET', url: '/backend-api/wham/accounts/check', authorization: 'Bearer client-own-token', accountId: 'client-acct', body: '' },
      { method: 'POST', url: '/backend-api/wham/settings/user', authorization: 'Bearer client-own-token', accountId: null, body: '{"theme":"dark"}' },
    ]);
  } finally {
    closeHard(proxy); closeHard(up.server);
  }
});

test('Codex inference on the same host is still served by the pool', async () => {
  const up = await recordingUpstream();
  const am = new AccountManager([claude('a'), codex('c', { upstream: `http://127.0.0.1:${up.port}` })], 0.98);
  const config = { upstream: 'https://api.anthropic.invalid', accounts: [claude('a'), codex('c')] };
  const proxy = http.createServer(createProxyRequestListener({ accountManager: am, upstream: config.upstream, config }));
  const port = await listen(proxy);
  try {
    const res = await request(port, { method: 'POST', path: '/backend-api/codex/responses', host: 'chatgpt.com', headers: { authorization: 'Bearer client-own-token', 'content-type': 'application/json' }, body: '{"model":"gpt-6.1-sol","input":[]}' });
    assert.equal(res.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].authorization, 'Bearer T-c', 'the fleet token, not the client\'s');
    assert.equal(up.seen[0].accountId, 'acct-c');
  } finally {
    closeHard(proxy); closeHard(up.server);
  }
});

test('on the Anthropic host the same path is Anthropic traffic, routed as before', async () => {
  // Nothing on chatgpt.com is involved: the request is addressed to the Anthropic
  // upstream's own host, so it takes the ordinary path and draws a pooled token.
  const up = await recordingUpstream();
  const upstream = `http://127.0.0.1:${up.port}`;
  const am = new AccountManager([claude('a'), codex('c')], 0.98);
  const config = { upstream, accounts: [claude('a'), codex('c')] };
  const proxy = http.createServer(createProxyRequestListener({ accountManager: am, upstream, config }));
  const port = await listen(proxy);
  try {
    const res = await request(port, { path: '/backend-api/wham/accounts/check', host: `127.0.0.1:${up.port}`, headers: { authorization: 'Bearer client-own-token' } });
    assert.equal(res.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].authorization, 'Bearer T-a');
  } finally {
    closeHard(proxy); closeHard(up.server);
  }
});

// ── the Codex WebSocket, through a real terminated tunnel ──────

const T = { timeout: 30000 };

function connectThroughProxy(proxyPort, target, caCertPem) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['http/1.1'] }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

async function upgradeOver(tlsSock, hostHeader, path) {
  tlsSock.write(
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'authorization: Bearer client-own-token\r\n\r\n',
  );
  const [reply] = await once(tlsSock, 'data');
  return reply.toString('utf8');
}

test('the Codex Responses WebSocket is refused, so the client falls back to pooled HTTPS', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  // Anything that reaches an upstream here is a failure: the refusal must happen
  // before the relay, and the Anthropic upstream is the only one in reach.
  const upstream = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sawUpgrade = [];
  upstream.on('upgrade', (req, socket) => { sawUpgrade.push(req.url); socket.destroy(); });
  const upPort = await listen(upstream);
  const am = new AccountManager([claude('a'), codex('c')], 0.98);
  const logs = [];
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}`, mitm: { http1Only: true }, accounts: [claude('a'), codex('c')] },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: (l) => logs.push(l),
  }));
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem);
  try {
    const reply = await upgradeOver(tlsSock, 'chatgpt.com', '/backend-api/codex/responses');
    assert.match(reply, /^HTTP\/1\.1 501 /);
    await once(tlsSock, 'close');
    assert.deepEqual(sawUpgrade, [], 'nothing was relayed');
    assert.ok(logs.some(l => /refusing a codex WebSocket for \/backend-api\/codex\/responses/.test(l)), logs.join('\n'));
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});
