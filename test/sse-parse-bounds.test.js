import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';
import { ReadableStream } from 'node:stream/web';
import { createSseLineScanner, streamResponse, SSE_MAX_LINE_CHARS } from '../src/server.js';

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
