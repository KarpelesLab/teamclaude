import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TextEncoder } from 'node:util';
import { ReadableStream } from 'node:stream/web';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createSseLineScanner, streamResponse, SSE_MAX_LINE_CHARS } from '../src/server.js';

// The SSE usage parser used to accumulate the whole relayed body into one
// string and drain it on the `\n\n` event boundary. An upstream that never
// sent a blank line grew that string for the entire response — re-split on
// every chunk — until V8 aborted the process on its heap limit, which no
// handler can catch (#341). The relay never needed the buffer: the bytes go
// to the client before the parser sees them, and the accounting reads single
// lines. So the parser keeps one line, bounded, and nothing else.

// ── the scanner ──────────────────────────────────────────────────────────────

test('complete lines are delivered as they arrive, split across chunks or not', () => {
  const lines = [];
  const s = createSseLineScanner(l => lines.push(l));
  s.push('event: ping\ndata: {}\n\nda');
  s.push('ta: {"a":1}\n');
  s.push('\nevent: x\ndata: {"b":2}');
  assert.deepEqual(lines, ['event: ping', 'data: {}', '', 'data: {"a":1}', '', 'event: x']);
  s.flush();
  assert.deepEqual(lines.at(-1), 'data: {"b":2}', 'the final unterminated line is delivered on flush');
  assert.equal(s.pending(), 0);
});

test('a line with no newline never retains more than the bound', () => {
  const lines = [];
  const max = 1024;
  const s = createSseLineScanner(l => lines.push(l), max);
  const chunk = 'a'.repeat(300);
  let peak = 0;
  for (let i = 0; i < 100; i++) { s.push(chunk); peak = Math.max(peak, s.pending()); }
  assert.ok(peak <= max, `retained ${peak} chars against a bound of ${max}`);
  assert.equal(s.pending(), 0, 'once over the bound the partial line is dropped, not kept');
  assert.deepEqual(lines, [], 'nothing was delivered: there was no line');
  // The rest of that line is discarded up to its newline; the next line is
  // read normally, so one oversized line costs only its own figure.
  s.push('tail-of-the-long-line\ndata: {"after":true}\n');
  assert.deepEqual(lines, ['data: {"after":true}']);
  s.flush();
  assert.deepEqual(lines, ['data: {"after":true}'], 'flush delivers nothing extra');
});

test('a line that arrives whole but over the bound is skipped, not delivered', () => {
  const lines = [];
  const s = createSseLineScanner(l => lines.push(l), 16);
  s.push('x'.repeat(40) + '\nshort\n');
  assert.deepEqual(lines, ['short']);
});

test('the default bound sits far above any real SSE line', () => {
  assert.ok(SSE_MAX_LINE_CHARS >= 1 << 20);
});

// ── streamResponse, end to end ───────────────────────────────────────────────

// The issue's shape: `text/event-stream` with no blank line ever, in 1 MiB
// chunks. Every byte must still reach the client, and the usage that follows
// the garbage must still be read. The retained state is asserted through the
// scanner above; here the proof is that the stream is relayed in full and the
// accounting survives it.
test('a stream with no blank line is relayed in full and does not accumulate', async () => {
  const written = [];
  let total = 0;
  const res = {
    destroyed: false, writableEnded: false, headersSent: true,
    write(c) { total += c.length; written.push(c.length); return true; },
    end() { this.writableEnded = true; },
    once() {}, off() {}, on() {},
  };
  const recorded = [];
  const am = {
    updateUsage() {},
    recordTokenUsage(_i, _s, _m, usage) { recorded.push(usage); },
  };
  const enc = new TextEncoder();
  const junk = enc.encode('a'.repeat(1 << 20)); // 1 MiB, no newline at all
  const N = 48;                                  // 48 MiB of one unterminated line
  const tail = enc.encode('\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i < N) { c.enqueue(junk.slice()); i++; } else if (i === N) { c.enqueue(tail); i++; } else c.close();
    },
  });

  await streamResponse(stream, res, 0, am, null, null, null, null);

  assert.equal(total, N * (1 << 20) + tail.length, 'every byte was relayed');
  assert.equal(written.length, N + 1, 'relayed chunk by chunk, never re-buffered');
  assert.equal(res.writableEnded, true);
  assert.deepEqual(recorded, [{ output_tokens: 7 }], 'usage after the oversized line was still read');
});

test('well-formed events still yield their usage line by line', async () => {
  const res = {
    destroyed: false, writableEnded: false, headersSent: true,
    write() { return true; }, end() { this.writableEnded = true; },
    once() {}, off() {}, on() {},
  };
  const calls = [];
  const recorded = [];
  const am = {
    updateUsage(_i, input, output) { calls.push([input, output]); },
    recordTokenUsage(_i, _s, _m, usage) { recorded.push(usage); },
  };
  const enc = new TextEncoder();
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  // Split at awkward places so lines straddle chunks.
  const parts = [body.slice(0, 37), body.slice(37, 90), body.slice(90)];
  let i = 0;
  const stream = new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(enc.encode(parts[i++])); else c.close(); } });

  await streamResponse(stream, res, 0, am, null, null, null, null);

  assert.deepEqual(calls, [[12, 0], [0, 500]]);
  assert.deepEqual(recorded, [{ input_tokens: 12, output_tokens: 500 }]);
});

// ── an answer that is not an event stream ────────────────────────────────────

// The forward path holds such an answer whole, for its usage figures and the
// log, and so do the token-refresh passthrough and the client-credential retry,
// to relay it in one write (request-body-cap.test.js and
// scope-403-client-credential.test.js cover those two). Their upstream is a
// configurable one, an account's own `upstream` included, so the size is the
// upstream's to choose; holdBody keeps no more than a bound of it. Imported in
// each test, so a build without it fails these tests and not the file.

const bytes = (s) => new TextEncoder().encode(s);

/** @param {ReadableStream<Uint8Array>} stream */
async function readAll(stream) {
  const out = [];
  for await (const c of stream) out.push(Buffer.from(c));
  return Buffer.concat(out).toString();
}

test('holdBody returns a body within its limit whole, and an absent one as empty', async () => {
  const { holdBody } = await import('../src/server.js');
  const parts = [bytes('ab'), bytes('cd')];
  let i = 0;
  const held = await holdBody(new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]); else c.close(); } }), 4);
  assert.equal(held.buf?.toString(), 'abcd', 'exactly the limit is still within it');
  assert.equal(held.body, null);
  const none = await holdBody(null, 4);
  assert.equal(none.buf?.length, 0);
  assert.equal(none.body, null);
});

// A body far past the limit (finite, so a holdBody that never stops fails here
// rather than reading forever): it reads no further than the chunk that crossed
// the limit, and its replay starts with what was held and goes on with the same
// stream, byte for byte.
test('holdBody stops at its limit, reading no further, and replays what it held ahead of the rest', async () => {
  const { holdBody } = await import('../src/server.js');
  let n = 0;
  let cancelled = null;
  const long = new ReadableStream({
    pull(c) { if (n < 1000) c.enqueue(bytes(String(n++ % 10))); else c.close(); },
    cancel(reason) { cancelled = reason ?? 'cancelled'; },
  });
  const held = await holdBody(long, 5);
  assert.equal(held.buf, null, 'past the limit nothing is returned whole');
  assert.ok(n <= 7, `read ${n} one-byte chunks for a limit of 5`);
  assert.ok(held.body);
  const reader = held.body.getReader();
  let seen = '';
  while (seen.length < 12) seen += Buffer.from((await reader.read()).value).toString();
  assert.equal(seen, '012345678901', 'the held bytes first, then the rest, in order');
  // A caller that does not relay it cancels the replay, which reaches the source.
  await reader.cancel('done');
  assert.equal(cancelled, 'done');
});

test('holdBody relays the end of a body it outgrew', { timeout: 10_000 }, async () => {
  const { holdBody } = await import('../src/server.js');
  const parts = ['ab', 'cd', 'ef', 'gh'].map(bytes);
  let i = 0;
  const held = await holdBody(new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]); else c.close(); } }), 3);
  assert.equal(held.buf, null);
  assert.equal(await readAll(/** @type {any} */ (held.body)), 'abcdefgh');
});

test('holdBody rejects on a failed read, as buffer() did', async () => {
  const { holdBody } = await import('../src/server.js');
  let i = 0;
  const failing = new ReadableStream({
    pull(c) { if (i++ === 0) c.enqueue(bytes('ab')); else c.error(new Error('socket reset')); },
  });
  await assert.rejects(holdBody(failing, 1024), /socket reset/);
});

// End to end, through an account's own upstream: an answer past the limit (64
// MiB, BUFFERED_RESPONSE_LIMIT) reaches the client before the upstream has
// finished sending it. The upstream holds its last MiB back until the client
// has seen a byte; a proxy holding the answer whole shows it nothing until the
// end, so a deadline ends it anyway and the order gives that proxy away.
test('an answer past the hold limit is relayed as it arrives, not held whole', { timeout: 60_000 }, async () => {
  const MiB = 1 << 20;
  const chunk = Buffer.alloc(MiB, 0x61);
  const total = 64 * MiB + 2 * MiB;
  /** @type {() => void} */
  let clientHasBytes = () => {};
  const firstByte = new Promise((resolve) => { clientHasBytes = () => resolve(undefined); });
  let upstreamEnded = false;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let sent = 0; sent < total - MiB; sent += MiB) {
        if (!res.write(chunk)) await once(res, 'drain');
      }
      // Unref'd: once the client has a byte, this deadline must not hold the
      // test process open for the rest of its three seconds.
      await Promise.race([firstByte, delay(3000, undefined, { ref: false })]);
      upstreamEnded = true;
      res.end(chunk);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const am = new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const got = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'k', 'content-type': 'application/json' } }, (res) => {
        let received = 0;
        /** @type {boolean|null} */
        let endedFirst = null;
        res.on('data', (c) => {
          if (endedFirst === null) { endedFirst = upstreamEnded; clientHasBytes(); }
          received += c.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, received, endedFirst }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', messages: [] }));
    });
    assert.equal(got.status, 200);
    assert.equal(got.received, total, 'every byte reached the client');
    assert.equal(got.endedFirst, false, 'the client saw bytes before the upstream finished sending');
    assert.ok(lines.some(l => /"backend" is larger than 64 MiB; relaying it as it arrives/.test(l)), 'the operator is told which account sent it');
  } finally {
    console.log = log;
    proxy.close();
    upstream.close();
  }
});

// Past the limit the answer is relayed, and two things have to survive the
// switch from holding to relaying: an upstream failure after it still reaches
// the client as a broken answer, never a clean end of a truncated one, and a
// client that stops reading still stops the upstream, so the proxy holds no more
// than the limit plus what is in flight. Both use an account's own upstream
// answering in 1 MiB chunks, with backpressure.
async function withBigAnswer({ total, reset = false }, fn) {
  const MiB = 1 << 20;
  const chunk = Buffer.alloc(MiB, 0x61);
  const state = { sent: 0, closed: false };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.on('close', () => { state.closed = true; });
      const pump = () => {
        while (state.sent < total) {
          if (state.closed) return;
          state.sent += MiB;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        if (reset) setTimeout(() => res.socket?.destroy(), 200);
        else res.end();
      };
      pump();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const am = new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }], 0.98);
  /** @type {Record<string, any>[]} */
  const ended = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' },
    { onRequestEnd: (/** @type {any} */ _id, /** @type {Record<string, any>} */ info) => ended.push(info) });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
  const log = console.log;
  console.log = () => {};
  try {
    await fn({ port, state, MiB, ended });
  } finally {
    console.log = log;
    proxy.close();
    upstream.close();
  }
}

const postOpts = (port) => ({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'k', 'content-type': 'application/json' } });

// On acaa750, which held the answer whole, the client saw no head and no bytes,
// so this fails there on its first assertion. What it pins is the relay's error
// path: a replay that ended quietly on a failed read would turn the upstream's
// failure into a clean end of a truncated answer.
test('an upstream that fails after the hold limit leaves the client with a broken answer, not a clean end', { timeout: 60_000 }, async () => {
  await withBigAnswer({ total: 66 * (1 << 20), reset: true }, async ({ port, MiB }) => {
    const got = await new Promise((resolve) => {
      const req = http.request(postOpts(port), (res) => {
        let received = 0;
        let ended = false;
        res.on('data', (c) => { received += c.length; });
        res.on('end', () => { ended = true; });
        res.on('error', () => {});
        res.on('close', () => resolve({ status: res.statusCode, received, ended, complete: res.complete }));
      });
      req.on('error', () => resolve({ status: null, received: 0, ended: false, complete: false }));
      req.end(JSON.stringify({ model: 'm', messages: [] }));
    });
    assert.equal(got.status, 200);
    assert.ok(got.received > 64 * MiB, `the relay had started (${got.received} bytes)`);
    assert.equal(got.ended, false, 'no clean end');
    assert.equal(got.complete, false);
  });
});

// The relay is waiting for the client's socket to drain when the client leaves,
// and a socket that closes never drains, so the request must end on the close:
// within a second, recorded as a client that left (499).
test('a client that stops reading an answer past the hold limit stops the upstream too', { timeout: 60_000 }, async () => {
  await withBigAnswer({ total: 200 * (1 << 20) }, async ({ port, state, MiB, ended }) => {
    const sentWhilePaused = await new Promise((resolve) => {
      const req = http.request(postOpts(port), (res) => {
        res.on('error', () => {});
        res.once('data', () => {
          res.pause();
          setTimeout(() => { const sent = state.sent; req.destroy(); resolve(sent); }, 2000);
        });
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ model: 'm', messages: [] }));
    });
    assert.ok(sentWhilePaused < 100 * MiB, `the upstream sent ${sentWhilePaused / MiB} of 200 MiB to a client that read one chunk`);
    for (let i = 0; i < 100 && !state.closed; i++) await delay(20);
    assert.equal(state.closed, true, 'and its connection was dropped once the client left');
    for (let i = 0; i < 50 && ended.length === 0; i++) await delay(20);
    assert.equal(ended.at(-1)?.status, 499, 'and the request ended, as one whose client left');
  });
});

// An answer past the limit is relayed the way a stream is, but not read as one:
// a file whose lines look like an event stream's usage reports (a saved
// transcript) is a download, and booking its lines would credit an account
// with tokens nothing spent. Passes on acaa750 too, which held such a file and
// failed to parse it as JSON: it guards the relay.
test('an answer past the hold limit is relayed without reading its lines for usage', { timeout: 60_000 }, async () => {
  const line = 'data: {"type":"message_delta","usage":{"output_tokens":1000}}\n';
  const body = Buffer.from(line.repeat(Math.ceil((65 << 20) / line.length)));
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const am = new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
  const log = console.log;
  console.log = () => {};
  try {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/files/file_1/content', headers: { 'x-api-key': 'k' } }, (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        res.on('end', () => resolve(n));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(received, body.length, 'the file reached the client whole');
    assert.equal(am.accounts[0].usage.totalOutputTokens, 0, 'and nothing was booked from its lines');
  } finally {
    console.log = log;
    proxy.close();
    upstream.close();
  }
});

// The line saying an answer was too large to hold names only such an answer:
// an event stream is never held, and is not one.
test('an event stream relayed through the forward path is not reported as too large to hold', { timeout: 30_000 }, async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const am = new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (proxy.address()).port;
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(postOpts(port), (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
    });
    assert.equal(status, 200);
    assert.ok(!lines.some(l => /is larger than .* MiB; relaying it as it arrives/.test(l)), `no such line: ${lines.join(' | ')}`);
  } finally {
    console.log = log;
    proxy.close();
    upstream.close();
  }
});
