import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeContentBlocks, contentBlockTypesToStrip } from '../src/content-block-sanitize.js';

// Claude Code announces tools that appear after the first request with
// `tool_addition` / `tool_removal` content blocks inside a mid-conversation
// message. Anthropic accepts them; a strict Anthropic-compatible upstream
// answers a non-retryable 400, and because the block stays in the history every
// later turn of that conversation fails too. The strip is opt-in per block type
// (`stripRequestFields: ["content.tool_addition"]`) and walks
// `messages[].content[]` only.

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const TOOL_CHANGES = new Set(['tool_addition', 'tool_removal']);
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, drop = TOOL_CHANGES, url = MESSAGES, ct = JSON_CT) => sanitizeContentBlocks(buf(obj), url, ct, drop);

const addition = (name, extra = {}) => ({ type: 'tool_addition', tool: { type: 'tool_reference', name }, ...extra });
const removal = (name) => ({ type: 'tool_removal', tool: { type: 'tool_reference', name } });
const EPHEMERAL = { type: 'ephemeral', ttl: '1h' };

test('stripRequestFields entries of the form content.<type> select the block types', () => {
  assert.deepEqual([...contentBlockTypesToStrip(['context_management', 'cache_control.scope', 'content.tool_addition', 'content.tool_removal'])], ['tool_addition', 'tool_removal']);
  assert.equal(contentBlockTypesToStrip(['content.']).size, 0);
  assert.equal(contentBlockTypesToStrip(undefined).size, 0);
  assert.equal(contentBlockTypesToStrip([42, null]).size, 0);
});

test('the reported case: tool_addition blocks leave, the announcing text stays', () => {
  const out = parse(run({ model: 'm', messages: [
    { role: 'user', content: 'hi' },
    { role: 'system', content: [{ type: 'text', text: 'Tools became available: a, b' }, addition('a'), addition('b')] },
  ] }));
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: 'Tools became available: a, b' }]);
  assert.deepEqual(out.messages[0], { role: 'user', content: 'hi' });
});

test('the cache breakpoint a dropped block carried moves to the last block that stays', () => {
  const out = parse(run({ model: 'm', messages: [
    { role: 'system', content: [{ type: 'text', text: 't' }, removal('old'), addition('new', { cache_control: EPHEMERAL })] },
  ] }));
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 't', cache_control: EPHEMERAL }]);
});

test('a breakpoint already on the surviving block is not overwritten', () => {
  const own = { type: 'ephemeral' };
  const out = parse(run({ model: 'm', messages: [
    { role: 'system', content: [{ type: 'text', text: 't', cache_control: own }, addition('new', { cache_control: EPHEMERAL })] },
  ] }));
  assert.deepEqual(out.messages[0].content[0].cache_control, own);
});

test('a message left with no content is dropped, not sent with an empty array', () => {
  const out = parse(run({ model: 'm', messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [addition('a', { cache_control: EPHEMERAL })] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
  ] }));
  assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'hi' }], 'a breakpoint with nowhere to go in its own message is dropped, not moved to a neighbour');
});

test('only listed types are dropped', () => {
  const out = parse(run({ model: 'm', messages: [
    { role: 'system', content: [{ type: 'text', text: 't' }, removal('old'), addition('new')] },
  ] }, new Set(['tool_addition'])));
  assert.deepEqual(out.messages[0].content.map(b => b.type), ['text', 'tool_removal']);
});

test('the same type name inside a tool_use input or a tool_result payload is data, left alone', () => {
  const body = { model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: { type: 'tool_addition' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"type":"tool_addition"}' }] }] },
  ] };
  const original = buf(body);
  assert.equal(sanitizeContentBlocks(original, MESSAGES, JSON_CT, TOOL_CHANGES), original);
});

test('with no types configured, nothing is touched even when the block is present', () => {
  const original = buf({ model: 'm', messages: [{ role: 'system', content: [addition('a')] }] });
  assert.equal(sanitizeContentBlocks(original, MESSAGES, JSON_CT, new Set()), original);
});

test('a body without the listed blocks is returned as the identical buffer', () => {
  const original = buf({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.equal(sanitizeContentBlocks(original, MESSAGES, JSON_CT, TOOL_CHANGES), original);
});

test('string content and the count_tokens endpoint', () => {
  const stringOnly = buf({ model: 'm', messages: [{ role: 'user', content: 'say "tool_addition"' }] });
  assert.equal(sanitizeContentBlocks(stringOnly, MESSAGES, JSON_CT, TOOL_CHANGES), stringOnly);
  const out = parse(run({ model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 't' }, addition('a')] }] }, TOOL_CHANGES, '/v1/messages/count_tokens?beta=true'));
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 't' }]);
});

test('non-messages endpoints and non-JSON bodies pass through unchanged', () => {
  const body = buf({ messages: [{ role: 'system', content: [addition('a')] }] });
  assert.equal(sanitizeContentBlocks(body, '/v1/oauth/token', JSON_CT, TOOL_CHANGES), body);
  const notJson = Buffer.from('"tool_addition" not json', 'utf8');
  assert.equal(sanitizeContentBlocks(notJson, MESSAGES, JSON_CT, TOOL_CHANGES), notJson);
});
