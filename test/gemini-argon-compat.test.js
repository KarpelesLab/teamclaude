import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGeminiArgonRequest } from '../src/gemini-argon-compat.js';

const identity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const encode = x => Buffer.from(JSON.stringify(x));

test('Argon removes only the generated identity and keeps all actual instructions and history', () => {
  const original = {
    model: 'gemini-4-argon', max_tokens: 16000,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: test' },
      { type: 'text', text: identity },
      { type: 'text', text: 'Follow the project instructions.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: identity }],
    thinking: { type: 'adaptive' }, metadata: { user_id: 'test' }, stream: true,
  };
  const out = normalizeGeminiArgonRequest(encode(original), { model: 'gemini-4-argon' });
  const expected = structuredClone(original);
  expected.system.splice(1, 1);
  assert.deepEqual(JSON.parse(out), expected);
  assert.equal(out.length, Buffer.byteLength(out.toString(), 'utf8'));
});

test('all configured Argon aliases normalize and repeated normalization is a byte no-op', () => {
  for (const model of ['gemini-4-argon', 'gemini-4-argon-high', 'gemini-4-argon[1m]']) {
    const out = normalizeGeminiArgonRequest(encode({ system: identity }), { model });
    assert.deepEqual(JSON.parse(out), {});
    assert.equal(normalizeGeminiArgonRequest(out, { model }), out);
  }
});

test('native Anthropic, other families, and similarly named models remain byte-identical', () => {
  const body = encode({ system: [{ type: 'text', text: identity }] });
  for (const opts of [
    { model: 'gemini-4-argon', native: true },
    { model: 'gemini-3.8-flash' }, { model: 'gpt-6.1-sol' },
    { model: 'deepseek-v4-pro' }, { model: 'gemini-4-argonaut' }, {},
  ]) assert.equal(normalizeGeminiArgonRequest(body, opts), body);
});

test('user-authored text, malformed JSON, and unrelated system blocks are untouched', () => {
  for (const body of [
    Buffer.from('invalid json'),
    encode({ system: identity + ' Follow my additional instruction.' }),
    encode({ system: [{ type: 'text', text: 'Keep this instruction.' }], messages: [{ role: 'user', content: identity }] }),
  ]) assert.equal(normalizeGeminiArgonRequest(body, { model: 'gemini-4-argon' }), body);
});
