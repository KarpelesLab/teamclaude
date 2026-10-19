import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteModel } from '../src/server.js';

const advisor = { type: 'advisor_20260301', name: 'advisor', model: 'claude-fable-5' };
const bash = { name: 'Bash', description: 'run', input_schema: { type: 'object' } };
const pair = (id, result) => ([
  { type: 'server_tool_use', id, name: 'advisor', input: { question: 'q' } },
  { type: 'advisor_tool_result', tool_use_id: id, content: result },
]);
const rewrite = (body, opts = {}) => rewriteModel(Buffer.from(JSON.stringify(body)), {}, opts);
const read = (body, opts = {}) => JSON.parse(rewrite(body, opts).toString());

test('native bodies are an exact no-op without the capability', () => {
  const body = { model: 'claude-fable-5', tools: [bash, advisor], messages: [
    { role: 'assistant', content: [...pair('srvtoolu_1', { type: 'advisor_result', text: 'plain' }), { type: 'text', text: 'kept' }] },
  ] };
  assert.equal(rewrite(body).toString(), JSON.stringify(body));
});

test('explicit advisor opt-in preserves tools and history exactly', () => {
  const body = { model: 'm', tools: [bash, advisor], messages: [{ role: 'assistant', content: pair('srvtoolu_1', { type: 'advisor_redacted_result', encrypted_content: 'cipher' }) }] };
  const copied = structuredClone(body);
  assert.equal(rewrite(body, { dropAdvisorTools: false }).toString(), JSON.stringify(copied));
});

test('mixed assistant content drops only the advisor pair and keeps text and ordinary tool pairs', () => {
  const out = read({ tools: [advisor, bash], messages: [
    { role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} },
      { type: 'text', text: 'before' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'advisor_result', text: 'readable history' } },
      { type: 'text', text: 'after' },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  ] }, { normalizeAdvisorHistory: true });
  // This tree retains its G9 strip semantics for tools[]; only history is
  // normalized here. (The deployed tree additionally drops the tool type.)
  assert.equal(out.tools.length, 2);
  assert.deepEqual(out.messages[0].content.map(b => b.type), ['text', 'tool_use', 'text', 'text']);
  assert.equal(out.messages[0].content[0].text, 'before');
  assert.ok(out.messages[0].content[2].text.includes('readable history'));
  assert.deepEqual(out.messages[1].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]);
});

test('empty and advisor-only messages get an explicit placeholder', () => {
  const out = read({ messages: [{ role: 'assistant', content: pair('srvtoolu_1', { type: 'advisor_redacted_result', encrypted_content: 'never-forward' }) }, { role: 'user', content: [] }] }, { normalizeAdvisorHistory: true });
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '[Historical advisor result unavailable on this backend.]' }]);
  assert.deepEqual(out.messages[1].content, []);
});

test('multiple interleaved pairs are removed without dangling calls', () => {
  const out = read({ messages: [{ role: 'assistant', content: [
    ...pair('a', { type: 'advisor_result', text: 'a-advice' }),
    { type: 'text', text: 'mid' },
    ...pair('b', { type: 'advisor_redacted_result', encrypted_content: 'sealed' }),
    ...pair('c', { type: 'advisor_result', stop_reason: 'end_turn' }),
  ] }] }, { normalizeAdvisorHistory: true });
  const types = out.messages[0].content.map(b => b.type);
  assert.ok(!types.some(t => t === 'server_tool_use' || t === 'advisor_tool_result'));
  assert.equal(types.filter(t => t === 'text').length, 4, 'mid text + one result/placeholder per pair (c has no plaintext)');
});

test('result-only history is removed and plaintext is preserved, never ciphertext', () => {
  const out = read({ messages: [{ role: 'user', content: [{ type: 'advisor_tool_result', tool_use_id: 'missing', content: { type: 'advisor_redacted_result', encrypted_content: 'SECRET-CIPHERTEXT' } }] }] }, { normalizeAdvisorHistory: true });
  assert.ok(!JSON.stringify(out).includes('SECRET-CIPHERTEXT'));
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '[Historical advisor result unavailable on this backend.]' }]);
});

test('non-advisor server tools pass through byte-for-byte', () => {
  const body = { tools: [bash], messages: [{ role: 'assistant', content: [
    { type: 'server_tool_use', id: 'srvtoolu_x', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_x', content: [{ type: 'web_search_result', url: 'u' }] },
  ] }] };
  const copied = structuredClone(body);
  assert.equal(rewrite(body, { normalizeAdvisorHistory: true }).toString(), JSON.stringify(copied));
});

test('every rewritten body reports its true byte length', () => {
  const body = { tools: [advisor], messages: [{ role: 'assistant', content: pair('srvtoolu_1', { type: 'advisor_result', text: 'x'.repeat(400) }) }] };
  const out = rewrite(body, { normalizeAdvisorHistory: true });
  assert.equal(out.length, Buffer.byteLength(out.toString(), 'utf8'));
  assert.ok(out.length < Buffer.byteLength(JSON.stringify(body), 'utf8'), 'ciphertext/declaration removal shrinks the body');
});
