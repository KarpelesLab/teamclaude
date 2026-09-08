import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler, upgradeUpstreamFor } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';
import { allowLoopbackForward } from '../src/forward-target.js';

// The terminating MITM server is shared by every intercepted host, and a
// WebSocket Upgrade used to be relayed to the configured upstream no matter
// which host the client had tunnelled to — a Codex client's WebSocket against
// chatgpt.com, Authorization header and all, landed on api.anthropic.com. The
// Upgrade is now routed by the Host header the client wrote, and a host this
// proxy does not intercept is refused rather than guessed.

const codex = { name: 'cx', type: 'oauth', provider: 'codex', accessToken: 'T', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };

test('an Upgrade is routed by its Host header: own upstream, provider host, or refused', () => {
  const upstream = 'http://127.0.0.1:4242';
  const anthropic = { upstream, accounts: [] };
  assert.equal(upgradeUpstreamFor('127.0.0.1', anthropic, upstream), upstream);
  assert.equal(upgradeUpstreamFor('127.0.0.1:443', anthropic, upstream), upstream);
  // A provider host is relayed to that provider only when an account uses it.
  assert.equal(upgradeUpstreamFor('chatgpt.com', { upstream, accounts: [codex] }, upstream), 'https://chatgpt.com');
  assert.equal(upgradeUpstreamFor('CHATGPT.COM.:443', { upstream, accounts: [codex] }, upstream), 'https://chatgpt.com');
  assert.equal(upgradeUpstreamFor('chatgpt.com', anthropic, upstream), null);
  // Never a host the proxy does not terminate, and never a guess for a bad header.
  assert.equal(upgradeUpstreamFor('ab.chatgpt.com', { upstream, accounts: [codex] }, upstream), null);
  assert.equal(upgradeUpstreamFor('evil.example', anthropic, upstream), null);
  assert.equal(upgradeUpstreamFor('evil.example:443', anthropic, upstream), null);
  assert.equal(upgradeUpstreamFor(undefined, anthropic, upstream), null);
  assert.equal(upgradeUpstreamFor('', anthropic, upstream), null);
  assert.equal(upgradeUpstreamFor('a b', anthropic, upstream), null);
  // The default upstream host, with no upstream configured.
  assert.equal(upgradeUpstreamFor('api.anthropic.com', { accounts: [] }, 'https://api.anthropic.com'), 'https://api.anthropic.com');
});

// ── end to end, through a real terminated tunnel ────────────────────────────

const T = { timeout: 30000 };
function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function closeHard(server) { server?.closeAllConnections?.(); try { server?.close(); } catch { /* closing */ } }

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

async function upgradeOver(tlsSock, hostHeader) {
  tlsSock.write(
    'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
    `Host: ${hostHeader}\r\n` +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'authorization: Bearer client-own-token\r\n\r\n',
  );
  const [reply] = await once(tlsSock, 'data');
  return reply.toString('utf8');
}

async function setup() {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sawUpgrade = [];
  upstream.on('upgrade', (req, socket) => {
    sawUpgrade.push(req.headers.host);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (c) => socket.write(c));
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 'T', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const proxy = http.createServer();
  const logs = [];
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}`, mitm: { http1Only: true } },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: (l) => logs.push(l),
  }));
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  return { caCertPem, upstream, upPort, proxy, proxyPort, sawUpgrade, logs };
}

test('an Upgrade whose Host is the tunnelled upstream host is relayed there', T, async () => {
  const { caCertPem, upstream, upPort, proxy, proxyPort, sawUpgrade } = await setup();
  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem);
  try {
    const reply = await upgradeOver(tlsSock, `127.0.0.1:${upPort}`);
    assert.match(reply, /101 Switching Protocols/);
    assert.deepEqual(sawUpgrade, [`127.0.0.1:${upPort}`]);
    tlsSock.write('ping');
    const [echoed] = await once(tlsSock, 'data');
    assert.equal(echoed.toString(), 'ping');
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('an Upgrade naming a host this proxy does not intercept is refused, not relayed', T, async () => {
  const { caCertPem, upstream, upPort, proxy, proxyPort, sawUpgrade, logs } = await setup();
  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem);
  try {
    const reply = await upgradeOver(tlsSock, 'evil.example');
    assert.match(reply, /^HTTP\/1\.1 421 /);
    await once(tlsSock, 'close');
    assert.deepEqual(sawUpgrade, [], 'nothing reached the upstream');
    assert.ok(logs.some(l => /refusing a WebSocket Upgrade for host "evil\.example"/.test(l)), logs.join('\n'));
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});
