import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { Writable } from 'node:stream';
import { TextEncoder, TextDecoder } from 'node:util';
import { upstreamFetch, DEFAULT_HEADERS_TIMEOUT_MS } from '../src/upstream-fetch.js';
import { readWithIdleTimeout, streamResponse } from '../src/server.js';

// A client that leaves while the upstream is silent used to hold the pending
// read (and the upstream socket) until the body-idle watchdog fired, because
// the disconnect was only noticed after the next chunk. The relay now cancels
// the reader on the client's 'close'.
test('client disconnect cancels a silent upstream immediately, not at idle timeout', { timeout: 2000 }, async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const client = new Writable({ write(chunk, enc, cb) { cb(); } });
  const running = streamResponse(upstream, client, 0, { recordTokenUsage() {} });
  client.destroy();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('disconnect did not cancel upstream')), 200))]);
  assert.equal(cancelled, true);
});

// Bring up an HTTP server on an ephemeral port and hand back {server, port}.
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// A half-dead upstream: it accepts the connection but never sends a response —
// exactly what a keep-alive socket becomes after the host's network drops and
// reconnects. Without the headers timeout this hangs until Node's 300s default.
test('fails fast (does not hang) when upstream never sends headers', async () => {
  const { server, port } = await listen(() => { /* never respond */ });

  const start = Date.now();
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', headersTimeoutMs: 200 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected fast-fail, took ${elapsed}ms`);

  server.close();
});

// The mechanism the whole fix rests on: after a hung request the dead socket is
// dropped from the pool, so the next request to the SAME origin opens a fresh
// connection and succeeds. Same origin is the point: two ports would be two
// pools and prove nothing about eviction. We count TCP connections and assert
// the second request opened a new one rather than reusing the dead keep-alive.
test('evicts the dead socket and reconnects on the same origin', async () => {
  let conns = 0;
  let mode = 'hang';
  const { server, port } = await listen((req, res) => {
    if (mode === 'respond') { res.writeHead(200); res.end('ok'); }
    // else: never respond, simulating a half-dead socket after a network drop
  });
  server.on('connection', () => { conns += 1; });
  const origin = `http://127.0.0.1:${port}/`;

  await assert.rejects(
    () => upstreamFetch(origin, { headersTimeoutMs: 150 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );

  mode = 'respond';
  const res = await upstreamFetch(origin, { headersTimeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  // >1 connection proves the dead socket was evicted and a fresh one opened; a
  // reuse of the aborted socket would leave the count at 1 (and hang). undici may
  // open more than one on the abort path, so assert the invariant, not an exact n.
  assert.ok(conns >= 2, `expected a fresh socket after eviction, saw ${conns} connection(s)`);

  server.close();
});

// The headers deadline is headers-only: once headers arrive it is disarmed, so a
// body that streams well past the timeout window is NOT cut off (SSE completions
// run for minutes). Headers here return instantly; the body finishes at ~400ms
// with a 150ms headers timeout.
test('does not cut a slow body once headers have arrived', async () => {
  const { server, port } = await listen(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\n\n');
    await new Promise((r) => setTimeout(r, 400));
    res.write('event: done\n\n');
    res.end();
  });

  const res = await upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 150 });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /done/); // full body read, not aborted at 150ms

  server.close();
});

// Mid-stream recovery (extends the PR): once headers have arrived the headers
// timeout is disarmed, so a drop DURING the body would hang forever. The
// body-idle watchdog in streamResponse guards each read. Here the stream yields
// one chunk then goes silent; the second read must fail fast with a transient
// TEAMCLAUDE_BODY_TIMEOUT (which server.js treats as retryable) rather than hang.
test('body watchdog fails fast when the stream goes silent mid-body', async () => {
  // readWithIdleTimeout's watchdog is unref'd (in production the listening socket
  // keeps the loop alive; here this test has no socket of its own), so hold a
  // ref'd handle for the test's duration or the loop can drain before it fires.
  const alive = setInterval(() => {}, 60_000);
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
        // never enqueue again and never close — a mid-stream network drop
      },
    });
    const reader = stream.getReader();

    // First chunk is already buffered: resolves immediately, no timeout.
    const first = await readWithIdleTimeout(reader, 200);
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), 'event: ping\n\n');

    // Second read: the stream is silent, so the watchdog fires fast.
    const start = Date.now();
    await assert.rejects(
      () => readWithIdleTimeout(reader, 200),
      (err) => err.code === 'TEAMCLAUDE_BODY_TIMEOUT',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected fast body-timeout, took ${elapsed}ms`);
  } finally {
    clearInterval(alive);
  }
});

// The watchdog must not fire on a healthy-but-slow stream: a chunk that arrives
// within the window resets nothing artificially — it simply resolves.
test('body watchdog does not fire when chunks keep arriving', async () => {
  const alive = setInterval(() => {}, 60_000); // see note above: keep the loop alive
  try {
    let pushed = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (pushed) { controller.close(); return; }
        pushed = true;
        return new Promise((resolve) => setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('event: ok\n\n'));
          resolve();
        }, 100));
      },
    });
    const reader = stream.getReader();

    const r = await readWithIdleTimeout(reader, 500); // 100ms chunk < 500ms window
    assert.equal(r.done, false);
    assert.match(new TextDecoder().decode(r.value), /ok/);
  } finally {
    clearInterval(alive);
  }
});

// The head deadline has four sources, and this is the order they settle in:
// the per-call `headersTimeoutMs`, the operator's
// TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS, the caller's
// `defaultHeadersTimeoutMs` (the forward path passes the account provider's
// own default there — Codex's head is held open while the model reasons), and
// finally the fleet default below. The tests that follow pin that order, in
// milliseconds rather than the real figures, so a wrong answer shows up as a
// failure instead of a two-minute wait.
test('the fleet default is two minutes, for any backend with no opinion', () => {
  assert.equal(DEFAULT_HEADERS_TIMEOUT_MS, 120_000);
});

test('a caller default bounds the head wait when nothing overrides it', async () => {
  const { server, port } = await listen(() => { /* never respond */ });

  const start = Date.now();
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/`, { defaultHeadersTimeoutMs: 200 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected the caller default to apply, took ${elapsed}ms`);

  server.close();
});

// A per-call timeout is the most specific thing anyone can say about one
// request, so a caller default must never narrow it.
test('a per-call headers timeout wins over the caller default', async () => {
  const { server, port } = await listen(async (req, res) => {
    await new Promise((r) => setTimeout(r, 200)); // head arrives past the 20ms default
    res.writeHead(200);
    res.end('ok');
  });

  const res = await upstreamFetch(`http://127.0.0.1:${port}/`, { headersTimeoutMs: 5000, defaultHeadersTimeoutMs: 20 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');

  server.close();
});

// The env var is the operator's fleet-wide say, so it outranks a default the
// caller supplied — otherwise a provider default could not be brought back
// down on a deployment that wants it shorter.
test('the env override beats the caller default', async () => {
  const prev = process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS;
  process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS = '200';
  const { server, port } = await listen(() => { /* never respond */ });
  try {
    const start = Date.now();
    await assert.rejects(
      () => upstreamFetch(`http://127.0.0.1:${port}/`, { defaultHeadersTimeoutMs: 60_000 }),
      (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected the env override to apply, took ${elapsed}ms`);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS;
    else process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS = prev;
    server.close();
  }
});
