import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { upstreamFetch, DEFAULT_UPSTREAM_MAX_SOCKETS } from '../src/upstream-fetch.js';

test('twelve long-lived streams receive headers without waiting for another stream to end', { timeout: 4000 }, async t => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\n\n');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
    upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 500 })));
  for (const r of results) if (r.status === 'fulfilled') await r.value.body.cancel();
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 12);
});

test('upstream queue is bounded, cancellable, separately timed, and recovers on stream release', { timeout: 5000 }, async t => {
  const keys = ['TEAMCLAUDE_UPSTREAM_MAX_SOCKETS', 'TEAMCLAUDE_UPSTREAM_MAX_QUEUE'];
  const saved = keys.map(k => process.env[k]);
  process.env[keys[0]] = '1'; process.env[keys[1]] = '1';
  t.after(() => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }));
  const { upstreamFetch: limited } = await import('../src/upstream-fetch.js?queue-test');
  const reached = [];
  const { server, port } = await listen((req, res) => {
    reached.push(req.url);
    if (req.url === '/hold') { res.writeHead(200); res.write('held'); }
    else res.end('ok');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${port}`;
  const hold = await limited(`${base}/hold`);
  const ac = new AbortController();
  const cancel = limited(`${base}/cancel`, { signal: ac.signal });
  const cancelled = assert.rejects(cancel, { name: 'AbortError' });
  await assert.rejects(limited(`${base}/overflow`), { code: 'TEAMCLAUDE_UPSTREAM_OVERLOADED' });
  ac.abort(); await cancelled;
  await assert.rejects(limited(`${base}/expired`, { queueTimeoutMs: 25 }), { code: 'TEAMCLAUDE_UPSTREAM_OVERLOADED' });
  // Waiting 75ms must not consume the 50ms upstream headers deadline.
  const next = limited(`${base}/next`, { queueTimeoutMs: 1000, headersTimeoutMs: 50 });
  await delay(75);
  await hold.body.cancel();
  assert.equal(await (await next).text(), 'ok');
  assert.deepEqual(reached, ['/hold', '/next']);
});

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

test('configured pool bounds reconnect fan-out and drains queued work', async (t) => {
  const old = process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS;
  process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS = '8';
  const { upstreamFetch: boundedFetch } = await import('../src/upstream-fetch.js?bounded-test');
  if (old === undefined) delete process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS;
  else process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS = old;
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { server, port } = await listen(async (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    res.writeHead(200);
    res.end('ok');
  });

  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  assert.equal(DEFAULT_UPSTREAM_MAX_SOCKETS, 256);
  const total = 12;
  const requests = Promise.all(Array.from({ length: total }, () =>
    boundedFetch(`http://127.0.0.1:${port}/bounded`, { headersTimeoutMs: 5_000 })
      .then(response => response.text())));

  // Give every request time to reach the agent. The first pool-width batch is
  // deliberately held, so any extra connection here proves the cap failed.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(peak, 8);
  release();
  assert.deepEqual(await requests, Array(total).fill('ok'));
  assert.equal(peak, 8);

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
