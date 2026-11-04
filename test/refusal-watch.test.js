import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';
import { ReadableStream } from 'node:stream/web';
import { Writable } from 'node:stream';
import { refusalFromSseEvent, refusalFromBody, reportRefusal } from '../src/refusal-watch.js';
import { streamResponse } from '../src/server.js';

// A safety decline is a 200 — `stop_reason: "refusal"` with a stop_details
// category — so it crossed the relay as ordinary bytes and never reached the
// log, and an operator learned about the ban before the refusals behind it.
// These detectors read the events the usage accounting already parses and
// emit one line per decline, category and explanation only, never content.

const REFUSAL_DELTA = 'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"Declined: malware construction help."}},"usage":{"output_tokens":12}}\n\n';

test('message_delta with stop_reason refusal yields a finding with category and explanation', () => {
  assert.deepEqual(
    refusalFromSseEvent({
      type: 'message_delta',
      delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' } },
    }),
    { rescued: false, category: 'cyber', explanation: 'Declined.' },
  );
});

test('other stop reasons and malformed details yield nothing', () => {
  assert.equal(refusalFromSseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), null);
  assert.equal(refusalFromSseEvent({ type: 'message_start', message: {} }), null);
  assert.deepEqual(
    refusalFromSseEvent({ type: 'message_delta', delta: { stop_reason: 'refusal' } }),
    { rescued: false, category: null, explanation: null },
  );
});

test('a fallback content block yields a rescued finding naming both models', () => {
  assert.deepEqual(
    refusalFromSseEvent({
      type: 'content_block_start',
      content_block: { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-5-5' } },
    }),
    { rescued: true, category: 'claude-fable-5-1', explanation: 'claude-fable-5-1 → claude-opus-5-5' },
  );
  assert.deepEqual(
    refusalFromSseEvent({ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }),
    { rescued: true, category: 'a', explanation: 'a → b' },
  );
});

test('a buffered body yields refusal and fallback findings, refusal first', () => {
  assert.deepEqual(
    refusalFromBody({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'bio', explanation: 'Declined.' },
      content: [{ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }],
    }),
    [
      { rescued: false, category: 'bio', explanation: 'Declined.' },
      { rescued: true, category: 'a', explanation: 'a → b' },
    ],
  );
  assert.deepEqual(refusalFromBody({ stop_reason: 'end_turn', content: [] }), []);
});

test('reportRefusal renders one bounded line in the log shape of other account notices', () => {
  const lines = [];
  const log = l => lines.push(l);
  reportRefusal('dev@x', { rescued: false, category: 'cyber', explanation: 'Declined.' }, log);
  assert.deepEqual(lines, ['[TeamClaude] Refusal (cyber) on "dev@x" — Declined.']);
  reportRefusal('dev@x', { rescued: true, category: 'a', explanation: 'a → b' }, log);
  assert.deepEqual(lines.at(-1), '[TeamClaude] Refusal on "dev@x" rescued by fallback (a → b)');
  reportRefusal('d\n"evil@x', { rescued: false, category: 'c\r\n43 on "', explanation: 'x'.repeat(500) }, log);
  assert.equal(lines.at(-1).split('\n').length, 1, 'no embedded newline survives');
  assert.ok(lines.at(-1).length < 400, 'the explanation is bounded');
});

// ── wired into the relay ─────────────────────────────────────────────────────

function sseStream(text) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function nullAccountManager() {
  return {
    updateUsage() {},
    recordTokenUsage() {},
  };
}

test('streamResponse reports a mid-stream refusal to onRefusal while relaying every byte', async () => {
  const body = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}\n\n'
    + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"I ca"}}\n\n'
    + REFUSAL_DELTA;
  const received = [];
  const res = new Writable({ write(chunk, _e, cb) { received.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  const findings = [];
  await streamResponse(sseStream(body), res, 0, nullAccountManager(), null, null, null, null, null, f => findings.push(f));
  assert.deepEqual(findings, [{ rescued: false, category: 'cyber', explanation: 'Declined: malware construction help.' }]);
  assert.equal(Buffer.concat(received).toString(), body, 'the client sees the bytes unchanged');
});

test('streamResponse reports nothing for an ordinary stream', async () => {
  const body = 'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}\n\n'
    + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n';
  const res = new Writable({ write(_c, _e, cb) { cb(); } });
  res.writeHead = () => {};
  const findings = [];
  await streamResponse(sseStream(body), res, 0, nullAccountManager(), null, null, null, null, null, f => findings.push(f));
  assert.deepEqual(findings, []);
});
