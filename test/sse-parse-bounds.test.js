import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { TextEncoder } from 'node:util';
import { ReadableStream } from 'node:stream/web';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createSseLineScanner, streamResponse, SSE_MAX_LINE_CHARS } from '../src/server.js';
import { withEnv } from '../test-helpers/env.js';

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

// The hold limit is a whole number of bytes, parsed as upstream-fetch.js
// parses TEAMCLAUDE_UPSTREAM_MAX_SOCKETS and ..._QUEUE_TIMEOUT_MS. Read as any
// positive number, a fraction was taken as given (0.5 made every answer with a
// byte in it too large to hold: each relayed token refresh was a 502 "larger
// than 0.5 bytes"), and so were Infinity, 1e400 and integers past
// Number.MAX_SAFE_INTEGER. Anything but a safe positive integer is the default
// now; what Number() reads as one (hexadecimal, an exponent, surrounding
// spaces) is used, as documented.
test('the hold limit is a whole number of bytes, and any other setting is the default', async () => {
  const { resolveBufferedResponseLimit } = await import('../src/server.js');
  const DEFAULT = 64 * 1024 * 1024;
  for (const value of [null, '', '0', '-1', 'abc', '64MiB', '0.5', '1.5', '4096.7', 'Infinity', '-Infinity', '1e400', '1e20', '9007199254740993']) {
    await withEnv({ TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES: value }, () => {
      assert.equal(resolveBufferedResponseLimit(), DEFAULT, `${JSON.stringify(value)} is read as the default`);
    });
  }
  for (const [value, limit] of [['1', 1], ['4096', 4096], ['0x1000', 4096], ['1e3', 1000], [' 4096 ', 4096], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    await withEnv({ TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES: value }, () => {
      assert.equal(resolveBufferedResponseLimit(), limit, `${value} is used as given`);
    });
  }
});

// ── end to end, through an account's own upstream ───────────────────────────

// The limit is 64 MiB unless TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES says otherwise;
// these tests set 4 KiB, so that an answer crosses it in two writes instead of
// 66 MiB of loopback traffic. None of them is decided by a clock: each upstream
// waits on what it is told about the client, and a proxy that never gets there
// leaves the request open for the runner's timeout to report.
const LIMIT = 4096;
const HELD = { TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES: LIMIT };

/**
 * A proxy in front of one backend account whose upstream answers every request
 * with `answer(res)`. The servers are closed in an after hook, which a
 * timed-out test still runs: several of these upstreams leave their answer
 * open on purpose.
 * @param {import('node:test').TestContext} t
 * @param {(res: import('node:http').ServerResponse) => void} answer
 * @param {Record<string, any>} [hooks]
 */
async function throughBackend(t, answer, hooks = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => answer(res));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const am = new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${upstreamPort}` }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' }, hooks);
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    proxy.close(); upstream.close();
  });
  return { port: /** @type {import('node:net').AddressInfo} */ (proxy.address()).port, am };
}

/** Run `fn` with console.log collected instead of printed. */
async function quietly(fn) {
  /** @type {string[]} */
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    return await fn(lines);
  } finally {
    console.log = log;
  }
}

/** A promise and the function that settles it, for an upstream to wait on. */
function signal() {
  /** @type {(value?: any) => void} */
  let fire = () => {};
  const fired = new Promise((resolve) => { fire = resolve; });
  return { fire, fired };
}

const postOpts = (port) => ({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'k', 'content-type': 'application/json' } });

// An answer past the limit reaches the client before the upstream has finished
// sending it: the upstream keeps its last part back until the client has seen
// a byte. A proxy holding the answer whole shows the client nothing until the
// end, which does not come: the hold is cut at its idle deadline instead (120 s
// at the defaults, as long as npm test's runner timeout), and the test fails
// on whichever of the two comes first.
test('an answer past the hold limit is relayed as it arrives, not held whole', async (t) => {
  const first = Buffer.alloc(2 * LIMIT, 0x61);
  const last = Buffer.alloc(LIMIT, 0x62);
  const clientHasBytes = signal();
  const { port } = await throughBackend(t, async (res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(first);
    await clientHasBytes.fired;
    res.end(last);
  });
  await quietly((lines) => withEnv(HELD, async () => {
    const got = await new Promise((resolve, reject) => {
      const req = http.request(postOpts(port), (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); clientHasBytes.fire(); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', messages: [] }));
    });
    assert.equal(got.status, 200);
    assert.ok(got.body.equals(Buffer.concat([first, last])), `the client got the answer byte for byte (${got.body.length} bytes)`);
    assert.ok(lines.some(l => /"backend" is larger than 4096 bytes; relaying it as it arrives/.test(l)),
      `the operator is told which account sent it, and the limit: ${lines.join(' | ')}`);
  }));
});

// Past the limit the answer is relayed, and two things have to survive the
// switch from holding to relaying: an upstream failure after it still reaches
// the client as a broken answer, never a clean end of a truncated one, and a
// client that stops reading or leaves still stops the upstream.

// The upstream resets its connection once the client has everything it sent,
// so the relay has started by then and the failure can only arrive through it.
// What this pins is the relay's error path: a replay that ended quietly on a
// failed read would turn the upstream's failure into a clean end of a truncated
// answer.
test('an upstream that fails after the hold limit leaves the client with a broken answer, not a clean end', async (t) => {
  const sent = 2 * LIMIT;
  const clientHasAll = signal();
  const { port } = await throughBackend(t, async (res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(sent, 0x61));
    await clientHasAll.fired;
    res.destroy();
  });
  await quietly(() => withEnv(HELD, async () => {
    const got = await new Promise((resolve) => {
      const req = http.request(postOpts(port), (res) => {
        let received = 0;
        let ended = false;
        res.on('data', (c) => { received += c.length; if (received >= sent) clientHasAll.fire(); });
        res.on('end', () => { ended = true; });
        res.on('error', () => {});
        res.on('close', () => resolve({ status: res.statusCode, received, ended, complete: res.complete }));
      });
      req.on('error', () => resolve({ status: null, received: 0, ended: false, complete: false }));
      req.end(JSON.stringify({ model: 'm', messages: [] }));
    });
    assert.equal(got.status, 200);
    assert.equal(got.received, sent, 'the relay had started: everything sent before the reset arrived');
    assert.equal(got.ended, false, 'no clean end');
    assert.equal(got.complete, false);
  }));
});

// A client that leaves part-way through such an answer: the upstream here never
// ends its answer, so its connection closes only if the proxy drops it, and the
// request ends only if the proxy ends it, recorded as a client that left (499).
test('a client that leaves an answer past the hold limit has the upstream dropped, and the request ended as a 499', async (t) => {
  const upstreamDropped = signal();
  const requestEnded = signal();
  const { port } = await throughBackend(t, (res) => {
    res.on('close', () => upstreamDropped.fire());
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(Buffer.alloc(2 * LIMIT, 0x61));
  }, { onRequestEnd: (/** @type {any} */ _id, /** @type {Record<string, any>} */ info) => requestEnded.fire(info) });
  await quietly(() => withEnv(HELD, async () => {
    const req = http.request(postOpts(port), (res) => {
      res.on('error', () => {});
      res.once('data', () => req.destroy());
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'm', messages: [] }));
    // The await is the check, as the comment above says: only the proxy
    // dropping the upstream's connection settles it.
    await upstreamDropped.fired;
    assert.equal((await requestEnded.fired).status, 499, 'and the request ended, as one whose client left');
  }));
});

// The same for a client that is still there but has stopped reading: the relay
// waits for its socket to drain and reads nothing further meanwhile, so the
// proxy holds no more than the limit plus one chunk; and since a socket that
// closes never drains, the wait ends on the close. Driven on the relay itself,
// where a write that does not drain is a return value: over loopback it takes
// megabytes to fill the socket buffers, and "the upstream has stopped sending"
// is only ever observed by waiting. The source is always ready, so a relay
// that did not wait for the drain reads all of it without yielding once; one
// turn of the event loop is enough to tell the two apart. What it measures is
// the relay's reads of the replay; that a body nobody reads pauses the
// upstream socket is the transport's half (nodeToWeb, upstream-pool.test.js).
test('a relay past the hold limit reads no further while its client has not drained, and cancels the replay when it leaves', async () => {
  const { holdBody } = await import('../src/server.js');
  let pulls = 0;
  let cancelled = false;
  const source = new ReadableStream({
    pull(c) { if (pulls < 1000) { pulls++; c.enqueue(bytes('x')); } else c.close(); },
    cancel() { cancelled = true; },
  });
  const held = await holdBody(source, 5);
  assert.equal(held.buf, null);
  const heldPulls = pulls;
  const parked = signal();
  const res = new class extends EventEmitter {
    destroyed = false; writableEnded = false; headersSent = true; writes = 0;
    write() { this.writes++; parked.fire(); return false; }
    end() { this.writableEnded = true; }
  }();
  const relay = streamResponse(/** @type {any} */ (held.body), res, 0, { recordTokenUsage() {} }, null, null, null, null, null, null, false);
  await parked.fired;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.writes, 1, 'nothing more was written to a client that had not drained');
  assert.ok(pulls <= heldPulls + 2, `the upstream was read no further (${pulls} chunks, ${heldPulls} of them for the hold)`);
  // The client leaves without ever draining.
  res.destroyed = true;
  res.emit('close');
  await relay;
  assert.equal(cancelled, true, 'the upstream body was cancelled once the client left');
  assert.equal(res.writes, 1);
});

// An answer past the limit is relayed the way a stream is, but not read as one:
// a file whose lines look like an event stream's usage reports (a saved
// transcript) is a download, and booking its lines would credit an account
// with tokens nothing spent. Passes on acaa750 too, which held such a file and
// failed to parse it as JSON: it guards the relay.
test('an answer past the hold limit is relayed without reading its lines for usage', async (t) => {
  const line = 'data: {"type":"message_delta","usage":{"output_tokens":1000}}\n';
  const body = Buffer.from(line.repeat(Math.ceil((2 * LIMIT) / line.length)));
  const { port, am } = await throughBackend(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await quietly((lines) => withEnv(HELD, async () => {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/files/file_1/content', headers: { 'x-api-key': 'k' } }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok(received.equals(body), 'the file reached the client whole');
    assert.ok(lines.some(l => /is larger than 4096 bytes; relaying it as it arrives/.test(l)), 'it was relayed past the limit, not held');
    assert.equal(am.accounts[0].usage.totalOutputTokens, 0, 'and nothing was booked from its lines');
  }));
});

// The line saying an answer was too large to hold names only such an answer:
// an event stream is never held, and is not one, however long (here it is
// longer than a limit of 16 bytes).
test('an event stream relayed through the forward path is not reported as too large to hold', async (t) => {
  const { port } = await throughBackend(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await quietly((lines) => withEnv({ TEAMCLAUDE_UPSTREAM_MAX_HELD_BYTES: 16 }, async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(postOpts(port), (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
    });
    assert.equal(status, 200);
    assert.ok(!lines.some(l => /is larger than .*; relaying it as it arrives/.test(l)), `no such line: ${lines.join(' | ')}`);
  }));
});
