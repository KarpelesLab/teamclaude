import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
import { extractUsageFromBody, streamResponse, bookUsageTotals } from '../src/server.js';

// extractUsageFromBody and streamResponse each already parse the account's own
// usage figures for accountManager.recordTokenUsage; the SQLite usage row rides
// the same parse via the trailing `onTotals` hook, which bookUsageTotals turns into
// the row's totals, right next to that existing call instead of re-parsing the body or the SSE stream a second
// time. These tests exercise that hook directly, in isolation from
// recordRequest itself — which lives one level up, in createProxyRequestListener's
// single finally block (see test/usage-server.test.js and test/mitm-integration.test.js
// for the row actually landing in the store end to end).

const fakeAccountManager = () => ({ updateUsage() {}, recordTokenUsage() {} });

test('extractUsageFromBody fills usageTotals from the same usage object it books', () => {
  const usageTotals = {};
  extractUsageFromBody(
    Buffer.from(JSON.stringify({
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    })),
    0, fakeAccountManager(), null, null, null, null, (u) => bookUsageTotals(usageTotals, u),
  );
  assert.deepEqual(usageTotals, { input: 3, cacheRead: 2, cacheWrite: 1, output: 5 });
});

test('extractUsageFromBody leaves usageTotals untouched when the body carries no usage', () => {
  const usageTotals = {};
  extractUsageFromBody(Buffer.from(JSON.stringify({ model: 'm' })), 0, fakeAccountManager(), null, null, null, null, (u) => bookUsageTotals(usageTotals, u));
  assert.deepEqual(usageTotals, {});
});

test('extractUsageFromBody tolerates a missing onTotals (no throw, existing callers unaffected)', () => {
  assert.doesNotThrow(() => extractUsageFromBody(
    Buffer.from(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })),
    0, fakeAccountManager(),
  ));
});

function fakeRes() {
  const res = {
    destroyed: false, writableEnded: false,
    write() { return true; },
    end() { res.writableEnded = true; },
    once() {}, off() {}, on() {},
  };
  return res;
}

function sseStream(...events) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < events.length) { c.enqueue(enc.encode(events[i++])); return; }
      c.close();
    },
  });
}

const event = (obj) => `event: x\ndata: ${JSON.stringify(obj)}\n\n`;

test('streamResponse fills usageTotals from message_start + message_delta, merged across both', async () => {
  const usageTotals = {};
  const stream = sseStream(
    event({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } }),
    event({ type: 'message_delta', usage: { output_tokens: 11 } }),
  );
  await streamResponse(stream, fakeRes(), 0, fakeAccountManager(), null, null, null, null, null, (u) => bookUsageTotals(usageTotals, u));
  assert.deepEqual(usageTotals, { input: 7, cacheRead: 900, cacheWrite: 50, output: 11 });
});

test('streamResponse leaves usageTotals untouched when the stream carried no usage at all', async () => {
  const usageTotals = {};
  const stream = sseStream(event({ type: 'ping' }));
  await streamResponse(stream, fakeRes(), 0, fakeAccountManager(), null, null, null, null, null, (u) => bookUsageTotals(usageTotals, u));
  assert.deepEqual(usageTotals, {}, 'an empty merge is written nowhere, same as the accountManager side');
});

test('streamResponse tolerates a missing onTotals (no throw, existing callers unaffected)', async () => {
  const stream = sseStream(event({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
  await assert.doesNotReject(() => streamResponse(stream, fakeRes(), 0, fakeAccountManager(), null, null, null, null));
});
