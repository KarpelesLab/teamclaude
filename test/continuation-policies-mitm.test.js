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
import { keyHashOf } from '../src/client-routes.js';

// Owner-root continuation over a MITM CONNECT tunnel (AI-1903, C9/E10): the
// CONNECT-time keyHash rides the per-(pin, client, keyHash) listener into the
// tunnelled requests as forcedKeyHash, so a root matches exactly as on the
// direct HTTP path — here: a force root hops with no legacy header at all.

const T = { timeout: 30000 };
const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const closeHard = (s) => { s?.closeAllConnections?.(); try { s?.close(); } catch { /* closing */ } };
const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');
const oauth = (name) => ({ name, type: 'oauth', accessToken: `TOKEN-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

function connectThroughProxy(proxyPort, target, caCertPem, proxyAuth) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${proxyAuth}\r\n\r\n`,
    ));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['h2'] }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

test('a tunnelled request matches the force root with no legacy header', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  /** @type {string[]} */
  const seen = [];
  /** @type {(string|undefined)[]} */
  const contractHeaders = [];
  const state = { spent: false };
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || '').replace(/^Bearer TOKEN-/, '');
    seen.push(who);
    contractHeaders.push(req.headers['x-teamclaude-cg-contract']);
    if (state.spent && who === 'sa') {
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
  const upPort = await listen(upstream);
  const quietLog = console.log;
  console.log = () => {};
  const am = new AccountManager([oauth('sa'), oauth('sc')], 0.98, {
    clientRoutes: [{ name: 's1+s2', clients: ['ana'], accounts: ['sa', 'sc'] }],
    continuationPolicies: [{ client: 'ana', keyHash: keyHashOf('ana-key'), mode: 'force', revision: 'r_mitm' }],
  });
  const config = {
    proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }], requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: false },
  };
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);
  const viaTunnel = async (session) => {
    const sock = await connectThroughProxy(mitmPort, `127.0.0.1:${upPort}`, caCertPem, basic(':ana-key'));
    const client = http2.connect('https://localhost', { createConnection: () => sock });
    try {
      const req = client.request({
        ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json',
        'x-claude-code-session-id': session,
        'x-teamclaude-cg-contract': 'root-v1',
      });
      let status = 0;
      let body = '';
      req.on('response', (h) => { status = Number(h[':status']); });
      req.on('data', (c) => { body += c; });
      req.end('{"model":"claude-opus-4-1","messages":[{"role":"user","content":"hello"}]}');
      await once(req, 'close');
      return { status, body };
    } finally {
      client.close();
      sock.destroy();
    }
  };
  try {
    assert.equal((await viaTunnel('tun-1')).status, 200);
    state.spent = true;
    const forced = await viaTunnel('tun-1');
    assert.equal(forced.status, 200, 'the root force-hopped inside the tunnel without any legacy header');
    assert.deepEqual(seen, ['sa', 'sa', 'sc']);
    assert.ok(contractHeaders.every((v) => v === undefined), 'the contract header must not reach upstream');
  } finally {
    console.log = quietLog;
    closeHard(mitm);
    closeHard(upstream);
  }
});

test('two keys sharing a client name get separate tunnel listeners and separate roots', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  /** @type {string[]} */
  const seen = [];
  const state = { spent: false };
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = String(req.headers.authorization || '').replace(/^Bearer TOKEN-/, '');
    seen.push(who);
    if (state.spent && who === 'sa') {
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
  const upPort = await listen(upstream);
  const quietLog = console.log;
  console.log = () => {};
  // ana has two keys; only ana-key has a root. ana-alt stays legacy.
  const am = new AccountManager([oauth('sa'), oauth('sc')], 0.98, {
    clientRoutes: [{ name: 's1+s2', clients: ['ana'], accounts: ['sa', 'sc'] }],
    continuationPolicies: [{ client: 'ana', keyHash: keyHashOf('ana-key'), mode: 'force', revision: 'r_mitm' }],
  });
  const config = {
    proxy: {
      apiKey: 'admin-key',
      clientKeys: [{ name: 'ana', key: 'ana-key' }, { name: 'ana', key: 'ana-alt-key' }],
      requireClientRoute: true,
    },
    upstream: `http://127.0.0.1:${upPort}`,
    mitm: { http1Only: false },
  };
  const mitm = http.createServer();
  allowLoopbackForward(mitm);
  mitm.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }), log: () => {} }));
  const mitmPort = await listen(mitm);
  const viaTunnel = async (session, key, policy = null) => {
    const sock = await connectThroughProxy(mitmPort, `127.0.0.1:${upPort}`, caCertPem, basic(`:${key}`));
    const client = http2.connect('https://localhost', { createConnection: () => sock });
    try {
      const req = client.request({
        ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json',
        'x-claude-code-session-id': session,
        ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
      });
      let status = 0;
      req.on('response', (h) => { status = Number(h[':status']); });
      req.resume();
      req.end('{"model":"claude-opus-4-1","messages":[{"role":"user","content":"hello"}]}');
      await once(req, 'close');
      return status;
    } finally {
      client.close();
      sock.destroy();
    }
  };
  try {
    // Both keys pin their conversations on sa before it spends out.
    assert.equal(await viaTunnel('root-1', 'ana-key'), 200);
    assert.equal(await viaTunnel('alt-1', 'ana-alt-key'), 200);
    assert.deepEqual(seen, ['sa', 'sa']);
    state.spent = true;
    // The alt key is legacy: a recommend header does not hop.
    assert.equal(await viaTunnel('alt-1', 'ana-alt-key', '*=recommend'), 429, 'the rootless key keeps legacy behavior');
    assert.deepEqual(seen, ['sa', 'sa', 'sa']);
    // The rooted key force-hops on the same seat, with no header at all. sa's
    // rejection is already recorded (the alt key's 429), so the hop is armed
    // pre-send and sa is not touched again.
    assert.equal(await viaTunnel('root-1', 'ana-key'), 200, 'the root must force the hop');
    assert.deepEqual(seen, ['sa', 'sa', 'sa', 'sc']);
  } finally {
    console.log = quietLog;
    closeHard(mitm);
    closeHard(upstream);
  }
});
