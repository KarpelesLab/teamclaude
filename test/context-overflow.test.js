import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  isContextOverflowError,
  anthropicPromptTooLongBody,
  isAnthropicPromptTooLong,
} from '../src/context-overflow.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('overflow classifier matches wrapped 502 and 413, not a dead adapter', () => {
  assert.equal(isContextOverflowError(502, '{"error":"context_length_exceeded"}'), true);
  assert.equal(isContextOverflowError(500, 'prompt is too long: 300000 tokens > 258400 maximum'), true);
  assert.equal(isContextOverflowError(413, 'payload too large'), true);
  assert.equal(isContextOverflowError(503, '{"error":"adapter unavailable"}'), false);
  assert.equal(isContextOverflowError(502, 'Internal proxy error'), false);
});

test('relay body matches Claude Code compact regex', () => {
  const body = anthropicPromptTooLongBody('request too long: 295400 tokens > 258400');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(isAnthropicPromptTooLong(body.error.message), true);
  assert.match(body.error.message, /^prompt is too long: 295400 tokens > 258400 maximum$/);
});

test('custom adapter overflow 502 is prompt-too-long 400, not a circuit hop', async () => {
  let overflowHits = 0;
  let otherHits = 0;
  const overflow = http.createServer((_req, res) => {
    overflowHits++;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context_length_exceeded: 300000 tokens > 258400' } }));
  });
  const other = http.createServer((_req, res) => {
    otherHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'should-not-hop' }));
  });
  const overflowPort = await listen(overflow);
  const otherPort = await listen(other);
  const am = new AccountManager([
    { name: 'gpt56', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${overflowPort}`, priority: 0 },
    { name: 'other', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${otherPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    assert.equal(res.status, 400, text.slice(0, 300));
    const body = JSON.parse(text);
    assert.equal(body.error?.type, 'invalid_request_error');
    assert.equal(isAnthropicPromptTooLong(body.error.message), true);
    assert.equal(overflowHits, 1);
    assert.equal(otherHits, 0, 'must not hop to another account');
    assert.equal(am.accounts[0].consecutiveFailures, 0);
    assert.ok(!am.accounts[0].circuitOpenUntil);
  } finally {
    await close(proxy); await close(overflow); await close(other);
  }
});
