import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { Writable } from 'node:stream';
import { TextEncoder, TextDecoder } from 'node:util';
import { upstreamFetch, resolveHeadersTimeout, DEFAULT_HEADERS_TIMEOUT_MS } from '../src/upstream-fetch.js';
import { readWithIdleTimeout, streamResponse, createProxyServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { withEnv } from '../test-helpers/env.js';

// A client that leaves while the upstream is silent used to hold the pending
// read (and the upstream socket) until the body-idle watchdog fired, because
// the disconnect was only noticed after the next chunk. The relay now cancels
// the reader on the client's 'close'.
test('client disconnect cancels a silent upstream immediately, not at idle timeout', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const client = new Writable({ write(chunk, enc, cb) { cb(); } });
  const running = streamResponse(upstream, client, 0, { recordTokenUsage() {} });
  client.destroy();
  // The cancel settles the pending read, which is what ends the relay: a
  // relay that instead waited for the idle watchdog (2 minutes by default)
  // would hold this await for that long, and the runner's timeout is what
  // fails it — no shorter race of our own, which a stalled event loop loses.
  await running;
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

  // The error names the budget that fired, which is the proof that the 200 ms
  // watchdog — not Node's 300 s default — ended the wait; how long the
  // scheduler took to run it is not the code's to answer for.
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', headersTimeoutMs: 200 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT' && /after 200ms/.test(err.message),
  );

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
    await assert.rejects(
      () => readWithIdleTimeout(reader, 200),
      (err) => err.code === 'TEAMCLAUDE_BODY_TIMEOUT' && /idle for 200ms/.test(err.message),
    );
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

  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/`, { defaultHeadersTimeoutMs: 200 }),
    (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT' && /after 200ms/.test(err.message),
  );

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
    // 200 from the environment, not the caller's 60 s: the message says which.
    await assert.rejects(
      () => upstreamFetch(`http://127.0.0.1:${port}/`, { defaultHeadersTimeoutMs: 60_000 }),
      (err) => err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT' && /after 200ms/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS;
    else process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS = prev;
    server.close();
  }
});

// setTimeout keeps its delay in a signed 32-bit integer and fires a larger one
// after 1 ms, so a headers-timeout setting meant as "practically never" cut
// the wait for every head at about 1 ms: a backend answering in 50 ms was a
// "socket hang up" about 10 ms in. It is read as the longest delay a timer
// holds instead, as the body-idle setting is. Asserted on the value, which is
// what the head timer is armed with.
test('a headers-timeout setting past the timer range is read as the longest timer, not as 1 ms', async () => {
  const HEAD = 'TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS';
  await withEnv({ [HEAD]: 99_999_999_999 }, () => {
    assert.equal(resolveHeadersTimeout(null), 2 ** 31 - 1);
    assert.equal(resolveHeadersTimeout(null, 300_000), 2 ** 31 - 1, "over a caller's default too");
  });
  await withEnv({ [HEAD]: 'Infinity' }, () => {
    assert.equal(resolveHeadersTimeout(null), 2 ** 31 - 1);
  });
  await withEnv({ [HEAD]: 2 ** 31 }, () => {
    assert.equal(resolveHeadersTimeout(null), 2 ** 31 - 1, 'one past it is read as it');
  });
  await withEnv({ [HEAD]: 2 ** 31 - 1 }, () => {
    assert.equal(resolveHeadersTimeout(null), 2 ** 31 - 1, 'the longest timer itself is kept');
  });
});

// ── the same deadline while an answer is held ───────────────────────────────

// An answer that is not an event stream is read whole before it is relayed
// (holdBody), and that read had no deadline: an upstream that sent its head and
// a few bytes and then went quiet held the request, its socket and its
// admission permit for as long as it kept the connection open, while the same
// silence in an event stream was cut at the body-idle deadline. holdBody is
// imported in the test, so a build without it fails this test and not the file.
test('holdBody gives up on a body that goes quiet, and cancels it', async () => {
  const { holdBody } = await import('../src/server.js');
  const alive = setInterval(() => {}, 60_000); // the watchdog is unref'd; see above
  try {
    let cancelled = false;
    const quiet = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"a":')); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(holdBody(quiet, 1024, 100),
      (err) => err.code === 'TEAMCLAUDE_BODY_TIMEOUT' && /idle for 100ms/.test(err.message));
    assert.equal(cancelled, true, 'the upstream body was cancelled, dropping its connection');
  } finally {
    clearInterval(alive);
  }
});

// The forward path gives its held answer more silence than that: a
// `stream:false` completion says nothing while the model generates, and a
// backend may send its head first and its whole body at the end. So the hold
// waits the longer of the body-idle deadline and the head deadline the request
// was given, the operator's or else the account provider's.
test('a forwarded answer is held for the longer of the body-idle and the head deadline', async () => {
  const { resolveHeldAnswerIdleTimeout } = await import('../src/server.js');
  const BODY = 'TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS';
  const HEAD = 'TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS';
  const claude = { name: 'a', type: 'apikey' };
  const codex = { name: 'c', type: 'oauth', provider: 'codex' };
  await withEnv({ [BODY]: null, [HEAD]: null }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(claude), DEFAULT_HEADERS_TIMEOUT_MS, 'both at their defaults, which are equal');
    assert.equal(resolveHeldAnswerIdleTimeout(codex), 300_000, "the provider's longer head deadline");
  });
  await withEnv({ [BODY]: 300, [HEAD]: null }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(claude), DEFAULT_HEADERS_TIMEOUT_MS, 'a short body-idle setting does not shorten the hold');
  });
  await withEnv({ [BODY]: 600_000, [HEAD]: null }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(codex), 600_000, 'a body-idle setting longer than the head deadline is the one used');
  });
  await withEnv({ [BODY]: 300, [HEAD]: 900_000 }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(codex), 900_000, "the operator's head deadline replaces the provider's");
  });
  await withEnv({ [BODY]: 300, [HEAD]: 200 }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(claude), 300);
  });
  await withEnv({ [BODY]: 300, [HEAD]: 99_999_999_999 }, () => {
    assert.equal(resolveHeldAnswerIdleTimeout(claude), 2 ** 31 - 1, 'never past the longest delay a timer holds');
  });
});

// End to end with the deadline at 300 ms: a held answer that goes quiet is cut
// as a quiet event stream is, by closing the client's connection. Its head is
// written by then; on HTTP/1.1, as here, Node sends a written head only with
// the first body bytes, so the client sees the close and no head (behind the
// MITM's HTTP/2 server writeHead sends the head at once, and the client sees it
// and then the stream reset). The two passthroughs, which have written nothing
// yet, answer 502. Each upstream sends its head and a few bytes, then nothing.
//
// Nothing here races the deadline: the upstream stays quiet for good, so the
// 300 ms can only be the thing that ends the request, however late the
// scheduler runs it, and the proxy's log line names the deadline that fired. A
// proxy that waits on leaves the request open for the runner's timeout.

/**
 * A proxy in front of `upstream`, with console.error collected. The servers
 * are closed in an after hook, which a timed-out test still runs: these
 * upstreams never end their answers.
 * @param {import('node:test').TestContext} t
 * @param {import('node:http').Server} upstream
 * @param {(upstreamPort: number) => { accounts: Record<string, any>[], upstream: string, managerOpts?: Record<string, any> }} setup
 * @param {Record<string, any>} [hooks]
 */
async function quietProxy(t, upstream, setup, hooks = {}) {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const { accounts, upstream: fleetUpstream, managerOpts } = setup(upstreamPort);
  const am = new AccountManager(accounts, 0.98, managerOpts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: fleetUpstream }, hooks);
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  /** @type {string[]} */
  const errors = [];
  const error = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  t.after(() => {
    console.error = error;
    proxy.closeAllConnections(); upstream.closeAllConnections();
    proxy.close(); upstream.close();
  });
  return { port: /** @type {import('node:net').AddressInfo} */ (proxy.address()).port, errors };
}

/** An upstream that sends its head and a few bytes, then nothing. `onRequest` runs before the head goes out. */
function quietUpstream(onRequest = () => {}) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { onRequest(); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"type":'); });
  });
}

/** POST through the proxy; what the client saw once its connection closed. */
function postQuiet(port, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'x-api-key': 'k', 'content-type': 'application/json' } }, (res) => {
      let ended = false;
      res.on('data', () => {});
      res.on('end', () => { ended = true; });
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode, ended, complete: res.complete }));
    });
    req.on('error', () => resolve({ status: null, ended: false, complete: false }));
    req.end('{"model":"m","messages":[]}');
  });
}

// The forward path's hold waits the longer of the two deadlines, so both are
// 300 ms here. The head deadline is set only once the upstream has the
// request: it is read for the head wait when the request is sent, and for the
// hold when the head has arrived, so setting it in between shortens the hold
// alone and leaves the head its default, which a loaded machine cannot miss.
test('a held answer that goes quiet is cut at its idle deadline, as a quiet stream is', async (t) => {
  const HEAD = 'TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS';
  await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 300, [HEAD]: null }, async () => {
    const { port, errors } = await quietProxy(t, quietUpstream(() => { process.env[HEAD] = '300'; }), (upstreamPort) => ({
      accounts: [{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }],
      upstream: 'http://127.0.0.1:9',
    }));
    const got = await postQuiet(port, '/v1/messages');
    assert.equal(got.ended, false, 'the connection closed, with no clean end');
    assert.equal(got.complete, false);
    assert.ok(errors.some(l => /Upstream error \(account "backend"\).*idle for 300ms/.test(l)), `the hold's idle deadline is what ended it: ${errors.join(' | ')}`);
  });
});

// The same hold under a head deadline longer than the body-idle one, 600 ms
// against 300, set as above once the upstream has the request. The upstream
// never speaks again, so only the hold's deadline can end the request, and the
// line names the one that did: the head deadline, which a hold timed by the
// body-idle deadline alone (as the two passthroughs' are) never waits for.
test('a forwarded answer held whole waits out a head deadline longer than the body-idle one', async (t) => {
  const HEAD = 'TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS';
  await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 300, [HEAD]: null }, async () => {
    const { port, errors } = await quietProxy(t, quietUpstream(() => { process.env[HEAD] = '600'; }), (upstreamPort) => ({
      accounts: [{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }],
      upstream: 'http://127.0.0.1:9',
    }));
    const got = await postQuiet(port, '/v1/messages');
    assert.equal(got.ended, false, 'the connection closed, with no clean end');
    assert.ok(errors.some(l => /Upstream error \(account "backend"\).*idle for 600ms/.test(l)), `the head deadline is what ended it: ${errors.join(' | ')}`);
  });
});

test('the token-refresh passthrough answers 502 when its upstream goes quiet', async (t) => {
  await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 300 }, async () => {
    const { port, errors } = await quietProxy(t, quietUpstream(), (upstreamPort) => ({
      accounts: [{ name: 'a', type: 'apikey', apiKey: 'k1' }],
      upstream: `http://127.0.0.1:${upstreamPort}`,
    }));
    const got = await postQuiet(port, '/v1/oauth/token');
    assert.equal(got.status, 502);
    assert.ok(errors.some(l => /Raw relay error:.*idle for 300ms/.test(l)), `the body-idle deadline is what ended it: ${errors.join(' | ')}`);
  });
});

// The client-credential retry (a GET the pooled token was not scoped for, sent
// once on the client's own login) holds its answer too, and answers 502 when
// that upstream goes quiet, with the activity row saying so.
test('the client-credential retry answers 502 when its upstream goes quiet', async (t) => {
  const upstream = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (token !== 'client-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'scope', details: { error_code: 'oauth_scope_insufficient' } } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"settings":');
  });
  /** @type {(info: Record<string, any>) => void} */
  let ended = () => {};
  const requestEnded = new Promise((resolve) => { ended = resolve; });
  await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 300 }, async () => {
    const { port, errors } = await quietProxy(t, upstream, (upstreamPort) => ({
      accounts: [{ name: 'a', type: 'oauth', accessToken: 'a-token' }],
      upstream: `http://127.0.0.1:${upstreamPort}`,
      managerOpts: { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
    }), { onRequestEnd: (/** @type {any} */ _id, /** @type {Record<string, any>} */ info) => ended(info) });
    const res = await fetch(`http://127.0.0.1:${port}/api/profile-required`, { headers: { 'x-api-key': 'k', authorization: 'Bearer client-token' } });
    await res.text();
    assert.equal(res.status, 502);
    assert.ok(errors.some(l => /Client-credential relay error:.*idle for 300ms/.test(l)), `the body-idle deadline is what ended it: ${errors.join(' | ')}`);
    assert.equal((await requestEnded).status, 502, 'the activity row reports the 502');
  });
});

// setTimeout keeps its delay in a signed 32-bit integer and fires a larger one
// after 1 ms, so a body-idle setting meant as "practically never" cut every
// body at once. It is read as the longest delay a timer holds instead: here a
// stream with 20 ms between chunks is relayed whole under such a setting.
test('a body-idle setting past the timer range is read as the longest timer, not as 1 ms', async () => {
  const alive = setInterval(() => {}, 60_000);
  try {
    await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 99_999_999_999 }, async () => {
      let n = 0;
      const slow = new ReadableStream({
        pull(controller) {
          if (n === 3) { controller.close(); return undefined; }
          return new Promise((resolve) => setTimeout(() => { controller.enqueue(new TextEncoder().encode(`event: ping\ndata: {"n":${n++}}\n\n`)); resolve(undefined); }, 20));
        },
      });
      let written = 0;
      const client = new Writable({ write(chunk, _enc, cb) { written += chunk.length; cb(); } });
      await streamResponse(slow, client, 0, { recordTokenUsage() {} });
      assert.equal(n, 3);
      assert.ok(written > 0 && written === 3 * 'event: ping\ndata: {"n":0}\n\n'.length, `relayed ${written} bytes`);
    });
  } finally {
    clearInterval(alive);
  }
});
