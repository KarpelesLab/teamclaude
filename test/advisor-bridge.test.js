import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { normalizeAdvisorHistory } from '../src/advisor-bridge.js';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => { s.close(r); s.closeAllConnections(); });
const text = s => ({ type: 'text', text: s });
const call = () => ({ type: 'tool_use', id: 'toolu_advisor', name: 'advisor', input: {} });
function reply(res, model, content, stop_reason = 'end_turn', streaming = true) {
  const message = { id: 'msg_test', type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } };
  if (!streaming) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  content.forEach((b, index) => {
    emit({ type: 'content_block_start', index, content_block: b.type === 'text' ? text('') : b });
    if (b.type === 'text') emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    emit({ type: 'content_block_stop', index });
  });
  emit({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } });
  emit({ type: 'message_stop' }); res.end();
}
async function setup(t, handler, extra = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let bytes = ''; for await (const c of req) bytes += c;
    const b = JSON.parse(bytes); seen.push(b); await handler(b, res, seen);
  });
  const upPort = await listen(upstream);
  const account = (name, model, mapped) => ({ name, type: 'apikey', apiKey: 'test', upstream: `http://127.0.0.1:${upPort}`, modelMap: { [model]: mapped }, strictModelMap: true, acceptsModels: [mapped] });
  const am = new AccountManager([account('executor', 'gpt-6-luna', 'executor-model'), account('advisor', 'gpt-6-astra', 'advisor-model')]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, ...extra });
  const port = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  return { seen, post: (overrides = {}, path = '/v1/messages') => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'test-session' },
    body: JSON.stringify({ model: 'gpt-6-luna', max_tokens: 1000, tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'gpt-6-astra' }], messages: [{ role: 'user', content: 'Consult your advisor then answer.' }], ...overrides }),
  }) };
}
const consult = (b, res) => {
  assert.ok(!b.tools?.some(t => t.type === 'advisor_20260301'));
  if (b.model === 'advisor-model') {
    assert.equal(b.tools, undefined); assert.match(b.messages[0].content, /Consult your advisor/);
    reply(res, b.model, [text('Use a bounded worker pool.')]);
  } else if (b.messages.length === 1) reply(res, b.model, [text('Checking.'), call()], 'tool_use');
  else {
    assert.equal(b.messages.at(-1).content[0].content, 'Use a bounded worker pool.');
    reply(res, b.model, [text('Final: use a bounded worker pool.')]);
  }
};
test('independently routes pinned executor and custom advisor, then resumes with real advice', async t => {
  const { post, seen } = await setup(t, consult);
  const res = await post({}, '/tc-acct/executor/v1/messages?beta=true');
  assert.equal(res.status, 200); const b = await res.json();
  assert.deepEqual(seen.map(b => b.model), ['executor-model', 'advisor-model', 'executor-model']);
  assert.equal(b.content[1].type, 'server_tool_use');
  assert.equal(b.content[2].content.type, 'advisor_result');
  assert.equal(b.content[3].text, 'Final: use a bounded worker pool.');
  assert.equal(b.stop_reason, 'end_turn'); assert.equal(b.usage.input_tokens, 10);
  assert.equal(b.usage.iterations[1].model, 'gpt-6-astra');
});
test('streams one message with monotonic block indexes and no client-side advisor tool call', async t => {
  const { post } = await setup(t, consult);
  const res = await post({ stream: true });
  const events = (await res.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert.equal(events.filter(e => e.type === 'message_start').length, 1);
  assert.equal(events.filter(e => e.type === 'message_stop').length, 1);
  const starts = events.filter(e => e.type === 'content_block_start');
  assert.deepEqual(starts.map(e => e.index), [0, 1, 2, 3]);
  assert.deepEqual(starts.map(e => e.content_block.type), ['text', 'server_tool_use', 'advisor_tool_result', 'text']);
  assert.equal(events.at(-2).delta.stop_reason, 'end_turn');
});
test('blocked advisor yields a visible failure and executor continues', async t => {
  const { post } = await setup(t, (b, res) => {
    if (b.messages.length === 1) reply(res, b.model, [call()], 'tool_use');
    else { assert.equal(b.messages.at(-1).content[0].is_error, true); reply(res, b.model, [text('Continued')]); }
  }, { blockedModels: ['gpt-6-astra'] });
  const b = await (await post()).json();
  assert.equal(b.content[1].content.type, 'advisor_tool_result_error');
  assert.equal(b.content.at(-1).text, 'Continued');
});
test('blocked executor never reaches upstream', async t => {
  const { post, seen } = await setup(t, () => assert.fail('must not forward'), { blockedModels: ['gpt-6-luna'] });
  const res = await post(); assert.equal(res.status, 400); assert.equal(seen.length, 0);
});
test('max_uses zero does not invoke advisor and normal tools remain client-side', async t => {
  const { post, seen } = await setup(t, (b, res) => reply(res, b.model,
    [call(), { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'true' } }], 'tool_use'));
  const b = await (await post({ tools: [
    { type: 'advisor_20260301', name: 'advisor', model: 'gpt-6-astra', max_uses: 0 },
    { name: 'Bash', input_schema: { type: 'object' } },
  ] })).json();
  assert.equal(seen.length, 1); assert.equal(b.stop_reason, 'tool_use');
  assert.equal(b.content[1].name, 'Bash'); assert.equal(b.content[2].content.error_code, 'max_uses_exceeded');
});
test('normalizes readable advisor history and preserves unrelated tool pairs', () => {
  const result = normalizeAdvisorHistory([{ role: 'assistant', content: [
    { type: 'server_tool_use', name: 'advisor', id: 'srvtoolu_old' },
    { type: 'advisor_tool_result', content: { type: 'advisor_result', text: 'old advice' } },
    { type: 'tool_use', name: 'Bash', id: 'toolu_bash', input: {} },
    { type: 'advisor_tool_result', content: { type: 'advisor_redacted_result', encrypted_content: 'opaque' } },
  ] }]);
  assert.match(result[0].content[0].text, /old advice/); assert.equal(result[0].content[1].name, 'Bash');
  assert.ok(!JSON.stringify(result).includes('opaque'));
});
test('accepts JSON upstream responses even when streaming requested', async t => {
  const { post } = await setup(t, (b, res) => reply(res, b.model, [text('No consultation needed')], 'end_turn', false));
  const b = await (await post()).json(); assert.equal(b.content[0].text, 'No consultation needed');
});
test('native empty input_json_delta is a valid no-argument advisor call', async t => {
  let first = true;
  const { post } = await setup(t, (b, res) => {
    if (b.model === 'advisor-model') { reply(res, b.model, [text('Advice')]); return; }
    if (!first) { reply(res, b.model, [text('Done')]); return; }
    first = false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { id: 'msg_empty', type: 'message', role: 'assistant', model: b.model, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: call() },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const b = await (await post()).json();
  assert.equal(b.content[1].content.type, 'advisor_result');
  assert.equal(b.content[1].content.stop_reason, 'end_turn');
  assert.equal(b.content.at(-1).text, 'Done');
});
test('JSON fallback emits text deltas that the Claude stream parser consumes', async t => {
  const { post } = await setup(t, (b, res) => reply(res, b.model, [text('Visible text')], 'end_turn', false));
  const output = await (await post({ stream: true })).text();
  assert.match(output, /"type":"text_delta","text":"Visible text"/);
  assert.match(output, /"content_block":\{"type":"text","text":""\}/);
});
