import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { upstreamFetch, DEFAULT_UPSTREAM_MAX_SOCKETS } from '../src/upstream-fetch.js';

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
  const N = 8;
  // A barrier, not a delay: no request is answered until all N have arrived.
  // Requests that serialize behind one connection can never all arrive, so
  // the barrier never opens and the watchdog fails the test; requests that
  // run in parallel all arrive, however slowly the machine gets them there.
  /** @type {import('node:http').ServerResponse[]} */
  const pending = [];
  let serialized = false;
  const answerAll = () => { for (const res of pending.splice(0)) { res.writeHead(200); res.end('ok'); } };
  const watchdog = setTimeout(() => { serialized = true; answerAll(); }, 30_000);
  const { server, port } = await listen((req, res) => {
    pending.push(res);
    if (pending.length === N) { clearTimeout(watchdog); answerAll(); }
  });
  server.on('connection', () => { conns += 1; });

  const bodies = await Promise.all(
    Array.from({ length: N }, () =>
      upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 60_000 }).then((r) => r.text())),
  );

  assert.deepEqual(bodies, Array(N).fill('ok'));
  assert.equal(conns, N, `expected ${N} parallel connections, saw ${conns}`);
  assert.equal(serialized, false, `the ${N} requests did not all arrive while the first was still pending`);

  server.close();
});

// Long-lived streams hold their pooled socket (and admission permit) until the
// body ends; with the default pool width a dozen of them must not wait on one
// another for headers.
test('twelve long-lived streams receive headers without waiting for another stream to end', async t => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\n\n');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  // The streams never end, so a fetch that waited on another's end would
  // wait forever: the headers deadline only has to be shorter than that, and
  // generous enough that a busy machine is not what trips it.
  const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
    upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 60_000 })));
  for (const r of results) if (r.status === 'fulfilled') await r.value.body.cancel();
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 12);
});

// The admission gate in front of the pool: a request past MAX_SOCKETS waits in
// a bounded queue with its own deadline, leaves that queue the moment its
// signal aborts, is refused outright when the queue is full, and is admitted
// (with the headers deadline armed only then) when a stream ahead of it ends.
// None of the refused requests ever reach the server.
test('upstream queue is bounded, cancellable, separately timed, and recovers on stream release', async t => {
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
  // Queueing for longer than the headers deadline must not consume it: the
  // deadline is armed at admission. Armed at enqueue instead, it would fire
  // while the request is still queued, whatever the machine is doing; armed
  // correctly, a loopback response has the whole 2 s to arrive.
  const next = limited(`${base}/next`, { queueTimeoutMs: 60_000, headersTimeoutMs: 2_000 });
  await delay(2_500);
  await hold.body.cancel();
  assert.equal(await (await next).text(), 'ok');
  assert.deepEqual(reached, ['/hold', '/next']);
});

// A lowered pool width bounds the fan-out (a reconnect storm opens no more
// than MAX_SOCKETS connections per origin) and the queued remainder drains
// once the first batch completes.
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

// The body passes backpressure on to the socket: nodeToWeb pauses the
// IncomingMessage whenever the web stream's queue is full and resumes it when
// the reader asks for more, so a reader that stops (a relay waiting for its
// client to drain) stops the upstream too, rather than the proxy taking in all
// it sends. Over loopback that takes megabytes to see, through the socket
// buffers; on a stand-in for the IncomingMessage it is the order of the calls,
// over two fills. nodeToWeb is imported in the test, so a build without the
// export fails this test and not the file.
test('the response body pauses its socket while its queue is full, and resumes it when read', async () => {
  const { nodeToWeb } = await import('../src/upstream-fetch.js');
  const res = new class extends EventEmitter {
    /** @type {string[]} */
    calls = [];
    pause() { this.calls.push('pause'); return this; }
    resume() { this.calls.push('resume'); return this; }
    destroy() { this.calls.push('destroy'); return this; }
  }();
  const reader = nodeToWeb(/** @type {any} */ (res)).getReader();
  res.emit('data', Buffer.from('a'));
  assert.equal(res.calls.at(-1), 'pause', `a chunk not yet read fills the queue, and the socket is paused: ${res.calls}`);
  const { value } = await reader.read();
  assert.equal(Buffer.from(value).toString(), 'a');
  assert.equal(res.calls.at(-1), 'resume', `reading it asks for more, which resumes the socket: ${res.calls}`);
  res.emit('data', Buffer.from('b'));
  assert.equal(res.calls.at(-1), 'pause', `the next unread chunk pauses it again, not only the first: ${res.calls}`);
  await reader.cancel();
  assert.equal(res.calls.at(-1), 'destroy', 'a reader that cancels drops the connection');
});
