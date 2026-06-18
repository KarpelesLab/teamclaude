import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import { once } from 'node:events';
import { h2Relay } from '../src/h2/relay.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

test('h2 relay rewrites only authorization, drops x-api-key, observes response', async () => {
  // Upstream (cleartext h2) echoes what it received + a rate-limit header.
  const upstream = http2.createServer();
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
  let observed = null;
  const front = net.createServer((clientSock) => {
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
    client.close();
    front.close();
    upstream.close();
  }
});

test('h2 relay streams a larger body intact (backpressure path)', async () => {
  const upstream = http2.createServer();
  const big = 'x'.repeat(200_000);
  upstream.on('stream', (s) => { s.respond({ ':status': 200 }); s.end(big); });
  const upPort = await listen(upstream);
  const front = net.createServer((c) => {
    const u = net.connect(upPort, '127.0.0.1', () => h2Relay(c, u, {}));
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
    client.close(); front.close(); upstream.close();
  }
});
