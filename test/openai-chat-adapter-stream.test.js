import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { streamOpenAIChatResponse } from '../src/server.js';

const USAGE = { input_tokens: 11, cache_read_tokens: 7, output_tokens: 5, total_tokens: 16 };

function responseDouble() {
  return {
    destroyed: false,
    writableEnded: false,
    write() { return true; },
    end() { this.writableEnded = true; },
    once() {}, off() {}, on() {},
  };
}

test('an abort after cumulative usage settles the latest report exactly once', async () => {
  let pull = 0;
  const upstream = new ReadableStream({
    pull(controller) {
      if (pull++ === 0) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: 'chatcmpl-abort', choices: [], usage: USAGE })}\n\n`));
      } else {
        controller.error(new Error('aborted'));
      }
    },
  });
  const accountCalls = [];
  const clientCalls = [];
  const sessionCalls = [];
  const am = {
    updateUsage(_index, input, output) { accountCalls.push([input, output]); },
    recordTokenUsage(_index, _pin, _model, usage) { sessionCalls.push(usage); },
  };
  await assert.rejects(streamOpenAIChatResponse(
    upstream, responseDouble(), 0, am, null,
    (input, output, cacheRead, cacheCreation) => clientCalls.push([input, output, cacheRead, cacheCreation]),
    'session', 'gemini-3-pro',
  ), /aborted/);
  assert.deepEqual(accountCalls, [[11, 5]]);
  assert.deepEqual(clientCalls, [[11, 5, 7, 0]]);
  assert.deepEqual(sessionCalls, [{
    input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 5,
  }]);
});

test('client disconnect cancels a silent adapted upstream immediately', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const client = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const running = streamOpenAIChatResponse(upstream, client, 0, {}, null);
  client.destroy();
  await running;
  assert.equal(cancelled, true);
});
