import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler, resolveConnectPin, connectPinToken } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';

// MITM-mode account pinning (TC_ACCT). Inside a CONNECT tunnel the request path
// is the real upstream one, so there is nowhere to hang a `/tc-acct/` prefix —
// the pin rides in the proxy URL's userinfo and arrives as the Basic *username*
// of `Proxy-Authorization` on the CONNECT. Verified against Claude Code 2.1.220,
// which sends that header preemptively on every CONNECT.

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
const T = { timeout: 30000 };

function closeHard(server) {
  if (!server) return;
  server.closeAllConnections?.();
  try { server.close(); } catch { /* already closing */ }
}

const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64');

// CONNECT (optionally with Proxy-Authorization), then TLS over the tunnel.
// Resolves the TLS socket, or rejects with the proxy's status line if refused.
function connectThroughProxy(proxyPort, target, caCertPem, alpn, proxyAuth = null) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : '') + '\r\n',
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

function makeUpstream(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = handler(req, Buffer.concat(chunks).toString('utf8')) || {};
      res.writeHead(out.status || 200, out.headers || {});
      res.end(out.body ?? '');
    });
  });
}

function makeProxy(am, upPort, { leafCertPem, leafKeyPem }, config = {}) {
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}`, ...config },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  return proxy;
}

const oauthAccount = (name, token) =>
  ({ name, type: 'oauth', accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

// Send one POST over the tunnel and resolve the response headers.
async function postOverTunnel(tlsSock) {
  const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
  const req = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
  let resp;
  req.on('response', (h) => { resp = h; });
  req.resume(); req.end('{"model":"x"}');
  await once(req, 'close');
  client.close();
  return resp;
}

// ── the resolver ──────────────────────────────────────────────────────────────

test('the Basic username selects the account', () => {
  const am = { accounts: [{ name: 'work' }, { name: 'personal' }] };
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': basic('work:k') } }, am, 'k'), { pin: 'work', error: null });
  // No key configured — username alone still pins.
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': basic('personal:') } }, am, null), { pin: 'personal', error: null });
  // A rotation index is not a pin form — array position moves under deletion.
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': basic('1:') } }, am, null), { pin: null, error: 'Unknown account pin "1"' });
});

// The documented remote form is `--proxy http://<key>@host:port`, which puts the
// API KEY in the username slot. That must stay auth, never be read as a pin.
test('a username equal to the proxy key is auth, not a pin', () => {
  const am = { accounts: [{ name: 'work' }] };
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': basic('secret:') } }, am, 'secret'), { pin: null, error: null });
  // Even when an account is (unwisely) named after the key, auth wins.
  const clash = { accounts: [{ name: 'secret' }] };
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': basic('secret:') } }, clash, 'secret'), { pin: null, error: null });
});

// A typo'd pin that silently served from the wrong account is the failure this
// feature exists to remove, so an unknown username is an error, not a shrug.
test('an unknown username is an error rather than an ignored pin', () => {
  const am = { accounts: [{ name: 'work' }] };
  const { pin, error } = resolveConnectPin({ headers: { 'proxy-authorization': basic('typo:') } }, am, 'secret');
  assert.equal(pin, null);
  assert.match(error, /Unknown account pin "typo"/);
});

test('no header, or a Bearer key, yields no pin', () => {
  const am = { accounts: [{ name: 'work' }] };
  assert.deepEqual(resolveConnectPin({ headers: {} }, am, 'secret'), { pin: null, error: null });
  assert.deepEqual(resolveConnectPin({ headers: { 'proxy-authorization': 'Bearer secret' } }, am, 'secret'), { pin: null, error: null });
  assert.equal(connectPinToken({ headers: {} }), null);
});

// ── end to end through a real tunnel ──────────────────────────────────────────

test('a pinned CONNECT serves every request in the tunnel from that account', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req) => ({
    status: 200,
    headers: { 'x-saw-auth': req.headers['authorization'] || 'none' },
  }));
  const upPort = await listen(upstream);

  // 'first' is what rotation would pick; the pin must override that.
  const am = new AccountManager([oauthAccount('first', 'TOKEN-A'), oauthAccount('second', 'TOKEN-B')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], basic('second:'));
  try {
    const resp = await postOverTunnel(tlsSock);
    assert.equal(resp['x-saw-auth'], 'Bearer TOKEN-B');   // the pinned account, not the rotation pick
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('an unpinned CONNECT still rotates normally', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req) => ({
    status: 200,
    headers: { 'x-saw-auth': req.headers['authorization'] || 'none' },
  }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('first', 'TOKEN-A'), oauthAccount('second', 'TOKEN-B')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2']);
  try {
    const resp = await postOverTunnel(tlsSock);
    assert.equal(resp['x-saw-auth'], 'Bearer TOKEN-A');   // ordinary selection
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

// Two pins on one proxy must not bleed into each other — each tunnel gets the
// listener bound to its own account.
test('concurrent tunnels with different pins stay separate', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req) => ({
    status: 200,
    headers: { 'x-saw-auth': req.headers['authorization'] || 'none' },
  }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('first', 'TOKEN-A'), oauthAccount('second', 'TOKEN-B')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const a = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], basic('first:'));
  const b = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], basic('second:'));
  try {
    const [ra, rb] = await Promise.all([postOverTunnel(a), postOverTunnel(b)]);
    assert.equal(ra['x-saw-auth'], 'Bearer TOKEN-A');
    assert.equal(rb['x-saw-auth'], 'Bearer TOKEN-B');
  } finally {
    a.destroy(); b.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('an unknown pin is refused at CONNECT', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({ status: 200 }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('first', 'TOKEN-A')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  try {
    await assert.rejects(
      connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], basic('nosuch:')),
      /407/,
    );
  } finally {
    closeHard(proxy); closeHard(upstream);
  }
});

// Clients send Proxy-Authorization on EVERY CONNECT, including blind-tunneled
// third-party hosts where a pin is meaningless. A pin meant for Anthropic must
// not take down unrelated traffic.
test('a pin on a blind-tunneled host is ignored, not refused', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const target = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  const targetPort = await listen(target);
  const upstream = makeUpstream(() => ({ status: 200 }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('first', 'TOKEN-A')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  // A garbage pin that WOULD 407 in rewrite mode. hostMode compares the HOST
  // only, so the tunnel target must differ by name, not just port: the upstream
  // is 127.0.0.1, so `localhost` is a different host and takes the tunnel path.
  const raw = net.connect(proxyPort, '127.0.0.1');
  try {
    await once(raw, 'connect');
    raw.write(`CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\nProxy-Authorization: ${basic('typo:')}\r\n\r\n`);
    const [chunk] = await once(raw, 'data');
    assert.match(chunk.toString('utf8').split('\r\n')[0], / 200 /);
  } finally {
    raw.destroy(); closeHard(proxy); closeHard(target); closeHard(upstream);
  }
});
