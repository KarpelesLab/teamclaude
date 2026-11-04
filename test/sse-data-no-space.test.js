import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import { createProxyServer, peekStreamFailure } from '../src/server.js';

// The space after `data:` is optional in SSE, and some Anthropic-shaped
// backends (Kimi among them) send `data:{...}`. The usage parser and the
// stream-failure peek both required `data: `, so not one token of such a
// stream was booked per client or per account, and an in-stream failure in
// that form was relayed instead of hopped. Both now accept either form.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const PROXY = { apiKey: 'shared-key', clientKeys: [{ name: 'alice', key: 'alice-key' }] };

test('usage on `data:` lines with no space is booked per client and per account', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata:{"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n');
    res.write('event: message_delta\ndata:{"type":"message_delta","usage":{"output_tokens":40}}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, null, tracker);
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'alice-key' },
      body: JSON.stringify({ model: 'x', messages: [], stream: true }),
    });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /^event: message_start\ndata:\{/, 'the bytes reach the client as sent');
    await new Promise(r => setTimeout(r, 50));
    const out = tracker.export();
    assert.equal(out.alice.inputTokens, 100);
    assert.equal(out.alice.outputTokens, 40);
    assert.equal(am.accounts[0].usage.totalInputTokens, 100);
    assert.equal(am.accounts[0].usage.totalOutputTokens, 40);
  } finally {
    proxy.close();
    upstream.close();
  }
});

/** @param {string} text */
const streamOf = (text) => new ReadableStream({
  start(c) { c.enqueue(new Uint8Array(Buffer.from(text))); c.close(); },
});

test('the stream-failure peek reads a failure on a `data:` line with no space', async () => {
  const peeked = await peekStreamFailure(streamOf('event: error\ndata:{"type":"error","error":{"type":"overloaded_error"}}\n\n'), { holdMs: 200 });
  assert.equal(peeked.failureCode, 'overloaded_error');
  await peeked.cancel();
});

test('the stream-failure peek still reads the spaced form', async () => {
  const peeked = await peekStreamFailure(streamOf('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'), { holdMs: 200 });
  assert.equal(peeked.failureCode, 'overloaded_error');
  await peeked.cancel();
});
