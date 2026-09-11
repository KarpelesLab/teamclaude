import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ClientUsageTracker } from '../src/client-usage.js';

// The upgrade gate resolved a client identity and the handler threw it away,
// so a WebSocket handshake authenticated with a clientKeys entry was relayed
// but never attributed: not under `clients` in /teamclaude/status, not
// prefixed `[name]` in the activity log (#325). A handshake is not a request
// and has no tokens, so it is booked as a `connection`, apart from the usage
// counters, and only once the upstream accepts it.

const PROXY = { apiKey: 'shared-key', clientKeys: [{ name: 'alice', key: 'alice-key' }] };
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const accept = createHash('sha1').update(`${WS_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

// Every log line the relay writes while `fn` runs, with console.log restored after.
async function capturing(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(lines); } finally { console.log = orig; }
  return lines;
}

async function withRelay({ acceptUpgrade }, fn) {
  const open = [];
  const upstream = http.createServer(() => {});
  upstream.on('upgrade', (req, s) => {
    open.push(s);
    if (acceptUpgrade) {
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    } else {
      s.end('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
    }
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, null, tracker);
  const port = await listen(proxy);

  // Opens a handshake, resolves with whatever arrived once the socket closes
  // or, for an accepted channel, after the 101 — and hands back a `close`.
  const handshake = (key) => new Promise((resolve) => {
    const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
      open.push(c);
      c.write('GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
        + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${WS_KEY}\r\n`
        + (key ? `x-api-key: ${key}\r\n` : '') + '\r\n');
    });
    let buf = '';
    const settle = () => resolve({ buf, close: () => new Promise(r => { if (c.destroyed) return r(); c.once('close', r); c.destroy(); }) });
    const done = setTimeout(settle, 1500);
    c.on('data', (d) => { buf += d; if (/\r\n\r\n/.test(buf)) { clearTimeout(done); settle(); } });
    c.on('close', () => { clearTimeout(done); settle(); });
  });

  try {
    await fn({ handshake, tracker });
  } finally {
    for (const s of open) s.destroy();
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

// The relay's log lines land after the socket events they describe, so give
// the loop a turn before reading them.
const tick = () => new Promise(r => setTimeout(r, 50));

test('a handshake authenticated with a client key is booked as that client\'s connection', async () => {
  await withRelay({ acceptUpgrade: true }, async ({ handshake, tracker }) => {
    const lines = await capturing(async () => {
      const { buf, close } = await handshake('alice-key');
      assert.match(buf, /^HTTP\/1\.1 101/, 'the channel opened');
      await tick();
      assert.deepEqual(tracker.export().alice, {
        requests: 0, connections: 1, inputTokens: 0, outputTokens: 0, lastUsed: tracker.export().alice.lastUsed,
      });
      assert.ok(tracker.export().alice.lastUsed, 'a connection is use');
      await close();
      await tick();
    });
    assert.ok(lines.some(l => /\[alice\] WebSocket \/v1\/session_ingress\/ws\/abc connected$/.test(l)), `connected line, got: ${lines}`);
    assert.ok(lines.some(l => /\[alice\] WebSocket \/v1\/session_ingress\/ws\/abc closed \(\d+\.\ds\)$/.test(l)), `closed line, got: ${lines}`);
  });
});

test('a key-less loopback handshake stays unattributed, as its requests do', async () => {
  await withRelay({ acceptUpgrade: true }, async ({ handshake, tracker }) => {
    const lines = await capturing(async () => {
      const { buf, close } = await handshake(null);
      assert.match(buf, /^HTTP\/1\.1 101/);
      await tick();
      assert.deepEqual(tracker.export(), {});
      await close();
    });
    assert.ok(lines.some(l => /^\[TeamClaude\] WebSocket \/v1\/session_ingress\/ws\/abc connected$/.test(l)), `no prefix, got: ${lines}`);
  });
});

test('a handshake the upstream refuses is answered, logged, and booked to nobody', async () => {
  // Before, a plain response from upstream went unhandled: the client socket
  // hung until it timed out and nothing was logged.
  await withRelay({ acceptUpgrade: false }, async ({ handshake, tracker }) => {
    const lines = await capturing(async () => {
      const { buf } = await handshake('alice-key');
      assert.match(buf, /^HTTP\/1\.1 403 Forbidden\r\n/, 'the refusal reaches the client');
      assert.match(buf, /content-type: application\/json/i, 'with its headers');
      assert.doesNotMatch(buf, /content-length/i, 'but no body length, since no body is relayed');
      await tick();
      assert.deepEqual(tracker.export(), {}, 'a refused handshake opened nothing');
    });
    assert.ok(lines.some(l => /\[alice\] WebSocket \/v1\/session_ingress\/ws\/abc refused by upstream \(403\)/.test(l)), `refused line, got: ${lines}`);
  });
});
