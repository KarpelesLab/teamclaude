import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { upstreamFetch } from '../src/upstream-fetch.js';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// The #106 fix: the default direct path pools HTTP/1.1 connections, so N
// concurrent requests use N connections and run in PARALLEL — they do not
// serialize behind one shared connection the way Node global fetch's single
// HTTP/2 connection does under concurrent uploads.
test('concurrent requests each open their own connection and run in parallel', async () => {
  let conns = 0;
  const HEADER_DELAY = 300;
  const { server, port } = await listen((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, HEADER_DELAY);
  });
  server.on('connection', () => { conns += 1; });

  const N = 8;
  const started = Date.now();
  const bodies = await Promise.all(
    Array.from({ length: N }, () =>
      upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 5000 }).then((r) => r.text())),
  );
  const elapsed = Date.now() - started;

  assert.deepEqual(bodies, Array(N).fill('ok'));
  assert.equal(conns, N, `expected ${N} parallel connections, saw ${conns}`);
  // Parallel: total ≈ one request's delay, NOT N × delay (serialization).
  assert.ok(elapsed < HEADER_DELAY * 3, `expected parallel (~${HEADER_DELAY}ms), took ${elapsed}ms`);

  server.close();
});

// A large POST body (the workload that serializes on one h2 connection) streams
// through, and the fetch-Response surface server.js relies on is intact.
test('streams a large POST body and exposes the fetch-Response surface', async () => {
  const bodyLen = 1_000_000;
  const { server, port } = await listen((req, res) => {
    let received = 0;
    req.on('data', (c) => { received += c.length; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-received': String(received) });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const res = await upstreamFetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(bodyLen, 0x61),
    headersTimeoutMs: 5000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-received'), String(bodyLen));
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(await res.text()), { ok: true });

  server.close();
});

// Streaming (SSE) response is delivered incrementally through the web-stream body.
test('streams an SSE response body incrementally', async () => {
  const { server, port } = await listen(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: a\n\n');
    await new Promise((r) => setTimeout(r, 50));
    res.write('event: b\n\n');
    res.end();
  });

  const res = await upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 5000 });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  assert.match(text, /event: a/);
  assert.match(text, /event: b/);

  server.close();
});
