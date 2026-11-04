import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The client-route gate (IPM fork AI-1552) on both entry paths a pool request
// can take: direct HTTP (the key in x-api-key, req.tcClient) and a MITM CONNECT
// (the key in Proxy-Authorization, carried into the tunnel as forcedClient).
// Every gate outcome is driven through both, against one stub upstream whose
// log is the witness for which account served. A WebSocket upgrade, on either
// path, relays with the client's own credential and never draws a pool account.

const T = { timeout: 30000 };
const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const closeHard = (s) => { s?.closeAllConnections?.(); try { s?.close(); } catch { /* closing */ } };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');
const oauth = (name) => ({ name, type: 'oauth', accessToken: `TOKEN-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

const ADMIN = 'admin-key';
const PROXY = {
  apiKey: ADMIN,
  clientKeys: [{ name: 'ana', key: 'ana-key' }, { name: 'uma', key: 'uma-key' }],
  requireClientRoute: true,
};
const ROUTES = [{ name: 'seat-a', clients: ['ana'], accounts: ['sa'] }];

function connectThroughProxy(proxyPort, target, caCertPem, alpn, proxyAuth = null) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` + (proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : '') + '\r\n',
    ));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: alpn }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

async function setup({ multi = false } = {}) {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  /** @type {string[]} */
  const seen = [];
  /** @type {string[]} */
  const upgrades = [];
  const policyHeaders = [];
  const state = { spent: false };
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || '').replace(/^Bearer TOKEN-/, '');
    seen.push(who);
    policyHeaders.push(req.headers['x-teamclaude-seat-policy']);
    if (multi && state.spent && who === 'sa') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  upstream.on('upgrade', (req, socket) => {
    upgrades.push(String(req.headers.authorization || ''));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const upPort = await listen(upstream);
  const quietLog = console.log;
  console.log = () => {};
  const am = new AccountManager([oauth('sa'), oauth('sc')], 0.98, {
    clientRoutes: multi ? [{ name: 's1+s2', clients: ['ana'], accounts: ['sa', 'sc'] }] : ROUTES,
  });
  const config = { proxy: PROXY, upstream: `http://127.0.0.1:${upPort}`, mitm: { http1Only: false } };
  const direct = createProxyServer(am, config);
  const directPort = await listen(direct);
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);
  const close = () => { console.log = quietLog; closeHard(direct); closeHard(mitm); closeHard(upstream); };
  return { am, caCertPem, upPort, seen, upgrades, policyHeaders, state, directPort, mitmPort, close };
}

// One request on the direct path: `key` in x-api-key, an optional /tc-acct/ pin.
async function viaDirect(env, { key, pin = null, session = null, policy = null }) {
  const res = await fetch(`http://127.0.0.1:${env.directPort}${pin ? `/tc-acct/${pin}` : ''}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
      ...(session ? { 'x-claude-code-session-id': session } : {}),
      ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
    },
    body: '{"model":"claude-opus-4-1","messages":[]}',
  });
  await res.text();
  return res.status;
}

// The same request through a CONNECT tunnel: the key in Proxy-Authorization,
// a TC_ACCT pin in its username slot.
async function viaMitm(env, { key, pin = null, session = null, policy = null }) {
  const auth = key ? basic(`${pin ?? ''}:${key}`) : (pin ? basic(`${pin}:`) : null);
  const sock = await connectThroughProxy(env.mitmPort, `127.0.0.1:${env.upPort}`, env.caCertPem, ['h2'], auth);
  const client = http2.connect('https://localhost', { createConnection: () => sock });
  try {
    const req = client.request({
      ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json',
      ...(session ? { 'x-claude-code-session-id': session } : {}),
      ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
    });
    let status = 0;
    req.on('response', (h) => { status = Number(h[':status']); });
    req.resume();
    req.end('{"model":"claude-opus-4-1","messages":[]}');
    await once(req, 'close');
    return status;
  } finally {
    client.close();
    sock.destroy();
  }
}

const OUTCOMES = [
  { what: 'bound key → its seat', req: { key: 'ana-key' }, status: 200, served: 'sa' },
  { what: 'key with no seat → 403', req: { key: 'uma-key' }, status: 403, served: null },
  { what: 'bound key pinning another account → 403', req: { key: 'ana-key', pin: 'sc' }, status: 403, served: null },
  { what: 'admin override of the key\'s session → the override account', req: { key: 'ana-key', session: 'sess-override' }, status: 200, served: 'sc', override: true },
  { what: 'shared key, unpinned → 403', req: { key: ADMIN }, status: 403, served: null },
  { what: 'key-less loopback, unpinned → 403', req: { key: null }, status: 403, served: null },
  { what: 'shared key, pinned → that account', req: { key: ADMIN, pin: 'sc' }, status: 200, served: 'sc' },
];

for (const [path, send] of [['direct HTTP', viaDirect], ['MITM CONNECT', viaMitm]]) {
  for (const o of OUTCOMES) {
    test(`${path}: ${o.what}`, T, async () => {
      const env = await setup();
      try {
        if (o.override) {
          env.am.sessionPins.set('sess-override', 'sc');
          env.am.sessionPins.bind('sess-override', 'ana');
        }
        const status = await send(env, o.req);
        assert.equal(status, o.status);
        assert.deepEqual(env.seen, o.served ? [o.served] : [], `upstream saw ${JSON.stringify(env.seen)}`);
      } finally {
        env.close();
      }
    });
  }
}

for (const [path, send] of [['direct HTTP', viaDirect], ['MITM CONNECT', viaMitm]]) {
  test(`${path}: force hops on the first quota failure and strips the policy header`, T, async () => {
    const env = await setup({ multi: true });
    try {
      assert.equal(await send(env, { key: 'ana-key', session: 'force-session' }), 200);
      env.state.spent = true;
      assert.equal(await send(env, { key: 'ana-key', session: 'force-session', policy: '*=recommend,s1=force' }), 200);
      assert.deepEqual(env.seen, ['sa', 'sa', 'sc']);
      assert.ok(env.policyHeaders.every(v => v === undefined), 'the internal policy header reached upstream');
    } finally {
      env.close();
    }
  });
}

// ── WebSocket upgrades ───────────────────────────────────────────────────────

test('direct HTTP: a WebSocket upgrade from a key with no seat carries its own credential, never a pool token', T, async () => {
  const env = await setup();
  try {
    const sock = net.connect(env.directPort, '127.0.0.1');
    await once(sock, 'connect');
    sock.write('GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-api-key: uma-key\r\n'
      + 'authorization: Bearer client-own-token\r\n\r\n');
    const [reply] = await once(sock, 'data');
    sock.destroy();
    assert.match(reply.toString(), /101 Switching Protocols/);
    assert.deepEqual(env.upgrades, ['Bearer client-own-token']);
    assert.deepEqual(env.seen, []);
  } finally {
    env.close();
  }
});

test('MITM CONNECT: a WebSocket upgrade from a bound key carries its own credential, never its seat\'s token', T, async () => {
  const env = await setup();
  try {
    const sock = await connectThroughProxy(env.mitmPort, `127.0.0.1:${env.upPort}`, env.caCertPem, ['http/1.1'], basic(':ana-key'));
    sock.write('GET /v1/session_ingress/ws/abc HTTP/1.1\r\n'
      + `Host: 127.0.0.1:${env.upPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + 'authorization: Bearer client-own-token\r\n\r\n');
    const [reply] = await once(sock, 'data');
    sock.destroy();
    assert.match(reply.toString(), /101 Switching Protocols/);
    assert.deepEqual(env.upgrades, ['Bearer client-own-token']);
    assert.ok(!env.upgrades.some(a => /TOKEN-/.test(a)));
  } finally {
    env.close();
  }
});
