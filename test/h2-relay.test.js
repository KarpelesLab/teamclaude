import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import { once } from 'node:events';
import { h2Relay } from '../src/h2/relay.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

// Per-test timeout: turn any future deadlock into a fast, located failure
// instead of a 30-minute CI stall (option form works on Node 18).
const T = { timeout: 30000 };

// Tear everything down hard. node:test runs each file in its own child process
// and, on Node 18 (unlike Node 20+), does not force-exit that child — so any
// socket/session left open after the assertions keeps the event loop alive and
// the whole run hangs. Graceful client.close() is exactly such a leak on the CI
// runner; destroy() + destroying tracked connections/sessions drains the loop.
function teardown({ client, conns = [], sessions = [], servers = [] }) {
  try { client?.destroy(); } catch { /* already gone */ }
  for (const s of sessions) { try { s.destroy(); } catch { /* */ } }
  for (const c of conns) { try { c.destroy(); } catch { /* */ } }
  for (const srv of servers) { try { srv.closeAllConnections?.(); srv.close(); } catch { /* */ } }
}

test('h2 relay rewrites only authorization, drops x-api-key, observes response', T, async () => {
  // Upstream (cleartext h2) echoes what it received + a rate-limit header.
  const upstream = http2.createServer();
  const sessions = [];
  upstream.on('session', (s) => sessions.push(s));
  upstream.on('stream', (s, h) => {
    s.respond({
      ':status': 200,
      'x-saw-auth': h.authorization || 'none',
      'x-saw-xkey': h['x-api-key'] || 'none',
      'x-saw-path': h[':path'],
      'x-saw-ct': h['content-type'] || 'none',
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
    });
    s.end('upstream-body');
  });
  const upPort = await listen(upstream);

  // Relay front door: each TCP conn → dial upstream, bridge with h2Relay.
  const conns = [];
  let observed = null;
  const front = net.createServer((clientSock) => {
    conns.push(clientSock);
    const upSock = net.connect(upPort, '127.0.0.1', () => {
      h2Relay(clientSock, upSock, {
        rewriteRequest: (fields) => fields
          .filter(f => f.name.toString().toLowerCase() !== 'x-api-key')
          .map(f => f.name.toString().toLowerCase() === 'authorization'
            ? { name: Buffer.from('authorization'), value: Buffer.from('Bearer REAL'), sensitive: true }
            : f),
        onResponseHeaders: (fields) => {
          const m = {};
          for (const f of fields) m[f.name.toString()] = f.value.toString();
          if (m[':status']) observed = m;
        },
      });
    });
    conns.push(upSock);
  });
  const frontPort = await listen(front);

  const client = http2.connect(`http://127.0.0.1:${frontPort}`);
  try {
    const req = client.request({
      ':method': 'POST', ':path': '/v1/messages',
      authorization: 'Bearer FAKE', 'x-api-key': 'sk-fake', 'content-type': 'application/json',
    });
    let respHeaders;
    let body = '';
    req.on('response', (h) => { respHeaders = h; });
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.end('{}');
    await once(req, 'close');

    assert.equal(respHeaders['x-saw-auth'], 'Bearer REAL');  // rewritten
    assert.equal(respHeaders['x-saw-xkey'], 'none');         // x-api-key dropped
    assert.equal(respHeaders['x-saw-path'], '/v1/messages'); // path preserved
    assert.equal(respHeaders['x-saw-ct'], 'application/json'); // other headers preserved
    assert.equal(body, 'upstream-body');                     // response body relayed
    // response observed for quota
    assert.equal(observed[':status'], '200');
    assert.equal(observed['anthropic-ratelimit-unified-5h-utilization'], '0.5');
  } finally {
    teardown({ client, conns, sessions, servers: [front, upstream] });
  }
});

test('h2 relay streams a larger body intact (backpressure path)', T, async () => {
  const upstream = http2.createServer();
  const sessions = [];
  upstream.on('session', (s) => sessions.push(s));
  const big = 'x'.repeat(200_000);
  upstream.on('stream', (s) => { s.respond({ ':status': 200 }); s.end(big); });
  const upPort = await listen(upstream);
  const conns = [];
  const front = net.createServer((c) => {
    conns.push(c);
    const u = net.connect(upPort, '127.0.0.1', () => h2Relay(c, u, {}));
    conns.push(u);
  });
  const frontPort = await listen(front);
  const client = http2.connect(`http://127.0.0.1:${frontPort}`);
  try {
    const req = client.request({ ':path': '/' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.end();
    await once(req, 'close');
    assert.equal(body.length, big.length);
  } finally {
    teardown({ client, conns, sessions, servers: [front, upstream] });
  }
});
