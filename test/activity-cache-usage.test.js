import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { cacheUsageLabel, cacheUsageState } from '../src/usage-label.js';

// #642: each request line ends with the response's cache figures, so whether
// the prompt cache held is visible per request, not only in aggregate.

test('the label rounds to k and reads a missing figure as 0', () => {
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 180_400, cache_creation_input_tokens: 2_600, input_tokens: 1_200 }), 'cache r180k w3k in1k');
  assert.equal(cacheUsageLabel({ input_tokens: 7, output_tokens: 3 }), 'cache r0 w0 in7');
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 'x', input_tokens: -4 }), 'cache r0 w0 in0');
});

test('no usage, no label', () => {
  assert.equal(cacheUsageLabel(null), '');
  assert.equal(cacheUsageLabel(undefined), '');
  assert.equal(cacheUsageLabel({}), '');
});

test('the state follows the share read from the cache, and a miss says MISS', () => {
  assert.equal(cacheUsageState({ cache_read_input_tokens: 90, cache_creation_input_tokens: 5, input_tokens: 5 }), 'hit');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 89, cache_creation_input_tokens: 6, input_tokens: 5 }), 'partial');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 50, cache_creation_input_tokens: 50, input_tokens: 0 }), 'partial');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 49, cache_creation_input_tokens: 51, input_tokens: 0 }), 'miss');
  assert.equal(cacheUsageState({ input_tokens: 100 }), 'none', 'no cache use is not a miss');
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 0, cache_creation_input_tokens: 180_000, input_tokens: 1_000 }), 'cache r0 w180k in1k MISS');
  assert.doesNotMatch(cacheUsageLabel({ input_tokens: 100 }), /MISS/);
});

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function requestEnd(respond, body = { model: 'claude-x', messages: [] }) {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => respond(res)); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k-a' }], 0.98);
  const ends = [];
  const hooks = { onRequestEnd: (/** @type {any} */ _id, /** @type {any} */ info) => ends.push(info) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body),
    });
    await res.text();
    return ends.at(-1);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a JSON response hands its usage to the request-end hook', async () => {
  const info = await requestEnd((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', id: 'msg_1', usage: { input_tokens: 7, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 2 } }));
  });
  assert.equal(cacheUsageLabel(info?.cacheUsage), 'cache r3k w0 in7');
});

test('a streamed response hands its merged usage to the request-end hook', async () => {
  const info = await requestEnd((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 1000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 3000 } } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`);
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  }, { model: 'claude-x', stream: true, messages: [] });
  assert.equal(cacheUsageLabel(info?.cacheUsage), 'cache r180k w3k in1k');
});

test('a response with no usage leaves the line as it was', async () => {
  const info = await requestEnd((res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
  });
  assert.equal(cacheUsageLabel(info?.cacheUsage), '');
});
