import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, upgradeTarget } from '../src/server.js';

// relayUpgrade built its target as `new URL(upstream + req.url)`. With an
// upstream that carries a port and a request target that is not a plain path
// — the absolute form `GET http://x/ HTTP/1.1`, ordinary proxy traffic — the
// concatenation ran on from the port digits and `new URL()` threw. The
// upgrade listener was the one entry point with no try/catch, so the throw was
// an uncaughtException and the daemon exited: one handshake, every session
// gone (#340). The target is now an answer or null, never a throw, and both
// upgrade listeners are guarded like the request and connect handlers are.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('upgradeTarget relays only an origin-form path, pinned to the upstream origin', () => {
  const ported = 'http://127.0.0.1:4999';
  assert.equal(upgradeTarget(ported, '/v1/session_ingress/ws/abc').href, 'http://127.0.0.1:4999/v1/session_ingress/ws/abc');
  assert.equal(upgradeTarget(ported, '/ws?x=1').search, '?x=1');
  // The crash: absolute form after a port.
  assert.equal(upgradeTarget(ported, 'http://x/'), null);
  assert.equal(upgradeTarget('https://api.anthropic.com:443', 'http://x/'), null);
  // The SSRF a naive `new URL(url, base)` would have traded it for.
  assert.equal(upgradeTarget(ported, '//evil.example/p'), null);
  assert.equal(upgradeTarget(ported, '/\\evil.example/p'), null);
  assert.equal(upgradeTarget(ported, '\\\\evil.example/p'), null);
  assert.equal(upgradeTarget(ported, 'evil.example/p'), null);
  assert.equal(upgradeTarget(ported, '*'), null);
  assert.equal(upgradeTarget(ported, ''), null);
  assert.equal(upgradeTarget(ported, undefined), null);
  // An upstream with a path prefix keeps it, which resolution would discard.
  assert.equal(upgradeTarget('https://gateway.example/anthropic', '/v1/ws').href, 'https://gateway.example/anthropic/v1/ws');
  // A bad upstream is an answer too.
  assert.equal(upgradeTarget('not a url', '/v1/ws'), null);
});

// Drive the real listener against a ported upstream: the handshake that used to
// exit the process is answered 400, and the proxy goes on to relay a good one.
test('a crafted upgrade against a ported upstream is refused, and the proxy survives it', async () => {
  const open = [];
  let relayed = 0;
  const upstream = http.createServer(() => {});
  upstream.on('upgrade', (req, socket) => {
    relayed++;
    open.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-a' }], 0.98);
  // No key configured, so the gate is open and the target is what decides.
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  const handshake = (requestLine) => new Promise((resolve, reject) => {
    const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
      open.push(c);
      c.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    c.once('data', (d) => resolve(d.toString()));
    c.once('error', reject);
    c.once('close', () => resolve(''));
  });

  try {
    assert.match(await handshake('GET http://x/ HTTP/1.1'), /^HTTP\/1\.1 400 /);
    assert.match(await handshake('GET //evil.example/p HTTP/1.1'), /^HTTP\/1\.1 400 /);
    assert.equal(relayed, 0, 'nothing reached the upstream');
    // The process is still here, and a plain path is still relayed.
    assert.match(await handshake('GET /v1/session_ingress/ws/abc HTTP/1.1'), /^HTTP\/1\.1 101 /);
    assert.equal(relayed, 1);
  } finally {
    for (const s of open) s.destroy();
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections(); upstream.close();
  }
});

// The guard itself: a listener that throws for any other reason answers the
// socket instead of taking the process down. Forced by a proxy config the
// gate cannot read: the listener reads `config.proxy` on every handshake.
test('a throw inside the upgrade listener tears down the socket, not the process', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'sk-a' }], 0.98);
  const config = { proxy: {}, upstream: 'http://127.0.0.1:4999' };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  Object.defineProperty(config, 'proxy', { get() { throw new Error('boom'); } });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const answer = await new Promise((resolve, reject) => {
      const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
        c.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      let got = '';
      c.on('data', (d) => { got += d; });
      c.once('close', () => resolve(got));
      c.once('error', reject);
    });
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.ok(errors.some(e => /upgrade handler failed/.test(e)), errors.join('\n'));
  } finally {
    console.error = orig;
    proxy.closeAllConnections?.(); proxy.close();
  }
});
