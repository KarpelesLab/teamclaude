import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyRequestListener } from '../src/server.js';

// Artifacts (/api/frame/*) belong to the client's user: a rotated account's
// token sees them as not found. getActiveAccount throws, so a passing test
// proves the relay never consulted the fleet for these paths.

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function recordingUpstream() {
  const seen = [];
  return listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || null,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).then(r => ({ ...r, seen }));
}

const refusingManager = {
  accounts: [],
  getActiveAccount() { throw new Error('must not rotate an /api/frame/* request'); },
};

async function through(path, init) {
  const { server: upstream, port, seen } = await recordingUpstream();
  const listener = createProxyRequestListener({ accountManager: refusingManager, upstream: `http://127.0.0.1:${port}` });
  const { server: proxy, port: proxyPort } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, init);
    return { status: res.status, text: await res.text(), seen };
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.close();
  }
}

for (const path of ['/api/frame/frames', '/api/frame/abc123']) {
  test(`a GET to ${path} keeps the client's own credential`, async () => {
    const { status, seen } = await through(path, { headers: { authorization: 'Bearer client-own-token' } });
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer client-own-token');
    assert.equal(seen[0].url, path);
  });
}

for (const path of ['/api/frame/deploy/prepare', '/api/frame/deploy/direct']) {
  test(`a POST to ${path} keeps the client's own credential and its body`, async () => {
    const body = JSON.stringify({ slug: 'abc123', shas: ['0'.repeat(64)] });
    const { status, seen } = await through(path, {
      method: 'POST',
      headers: { authorization: 'Bearer client-own-token', 'content-type': 'application/json' },
      body,
    });
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].authorization, 'Bearer client-own-token');
    assert.equal(seen[0].body, body, 'the deploy body must reach upstream unchanged');
  });
}
