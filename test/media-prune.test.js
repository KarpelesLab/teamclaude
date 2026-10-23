import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneHistoricalMedia, DEFAULT_MEDIA_BUDGET_BYTES } from '../src/media-prune.js';

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, opts = {}, url = MESSAGES, ct = JSON_CT) =>
  pruneHistoricalMedia(buf(obj), url, ct, opts);

function png(bytes) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) },
  };
}
function pdf(bytes) {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'B'.repeat(bytes) },
  };
}

test('no media marker is a same-Buffer no-op (never parsed)', () => {
  const original = buf({
    model: 'm',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ],
  });
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { budgetBytes: 1 });
  assert.equal(out.body, original);
  assert.equal(out.count, 0);
});

test('body under the budget is a same-Buffer no-op even with images', () => {
  const original = buf({
    model: 'm',
    messages: [{ role: 'user', content: [png(100), { type: 'text', text: 'see' }] }],
  });
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { budgetBytes: original.length + 10 });
  assert.equal(out.body, original);
  assert.equal(out.count, 0);
});

test('non-messages URL is left alone', () => {
  const original = buf({ messages: [{ role: 'user', content: [png(100)] }] });
  const out = pruneHistoricalMedia(original, '/v1/models', JSON_CT, { budgetBytes: 1 });
  assert.equal(out.body, original);
});

test('enabled:false is a no-op', () => {
  const original = buf({ messages: [{ role: 'user', content: [png(8000)] }] });
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { enabled: false, budgetBytes: 1 });
  assert.equal(out.body, original);
});

test('budget 0 (env disable) is a no-op', () => {
  const original = buf({ messages: [{ role: 'user', content: [png(8000)] }] });
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { budgetBytes: 0 });
  assert.equal(out.body, original);
});

test('drops oldest images first and keeps the newest that fit', () => {
  const out = run({
    model: 'm',
    messages: [
      { role: 'user', content: [png(1000), { type: 'text', text: 'old' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [png(1000), { type: 'text', text: 'new' }] },
    ],
  }, { budgetBytes: 1500 });
  assert.equal(out.count, 1);
  assert.equal(out.bytes, 1000);
  const body = parse(out.body);
  assert.match(body.messages[0].content[0].text, /omitted image/);
  assert.equal(body.messages[2].content[0].type, 'image');
  assert.equal(body.messages[2].content[0].source.data.length, 1000);
});

test('a single oversized PDF is dropped (keepLast cannot override budget)', () => {
  const out = run({
    model: 'm',
    messages: [{ role: 'user', content: [pdf(5000), { type: 'text', text: 'resume' }] }],
  }, { budgetBytes: 1000 });
  assert.equal(out.count, 1);
  const body = parse(out.body);
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.match(body.messages[0].content[0].text, /omitted document/);
  assert.equal(body.messages[0].content[1].text, 'resume');
});

test('nested tool_result images are pruned the same way', () => {
  const out = run({
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [png(2000)] }] },
      { role: 'assistant', content: 'saw it' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [png(200)] }] },
    ],
  }, { budgetBytes: 500 });
  assert.equal(out.count, 1);
  const body = parse(out.body);
  assert.match(body.messages[0].content[0].content[0].text, /omitted image/);
  assert.equal(body.messages[2].content[0].content[0].type, 'image');
});

test('url / file_id sources are not treated as inline media', () => {
  const original = buf({
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example/x.png' } }],
    }],
  });
  // Force a parse by making the body larger than budget; still no inline data.
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { budgetBytes: 1 });
  assert.equal(out.count, 0);
  assert.equal(out.body, original);
});

test('count_tokens path is pruned too (so the count matches what /v1/messages will send)', () => {
  const out = pruneHistoricalMedia(
    buf({ messages: [{ role: 'user', content: [png(4000)] }] }),
    '/v1/messages/count_tokens',
    JSON_CT,
    { budgetBytes: 100 },
  );
  assert.equal(out.count, 1);
});

test('invalid JSON is forwarded untouched', () => {
  const original = Buffer.from('{not-json', 'utf8');
  const out = pruneHistoricalMedia(original, MESSAGES, JSON_CT, { budgetBytes: 1 });
  assert.equal(out.body, original);
});

test('default budget is 8MB', () => {
  assert.equal(DEFAULT_MEDIA_BUDGET_BYTES, 8 * 1024 * 1024);
});
