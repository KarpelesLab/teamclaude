import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIChatRequestError,
  OpenAIChatResponseError,
  createOpenAIChatStream,
  normalizeOpenAIChatUsage,
  rewriteOpenAIChatRequest,
  translateOpenAIChatRequest,
  translateOpenAIChatResponse,
} from '../src/openai-chat-adapter.js';

const USAGE = { input_tokens: 11, cache_read_tokens: 7, output_tokens: 5, total_tokens: 16 };
const ANTHROPIC_USAGE = {
  input_tokens: 11,
  cache_read_input_tokens: 7,
  cache_creation_input_tokens: 0,
  output_tokens: 5,
};
const request = (extra = {}) => ({
  model: 'gemini-3-pro-preview', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50, ...extra,
});

function translated(extra = {}) {
  return translateOpenAIChatRequest(request(extra));
}

function eventsFrom(text) {
  return text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

test('translates text messages, system, sampling, stops and native Gemini model IDs', () => {
  const out = translated({
    system: [{ type: 'text', text: 'Be ' }, { type: 'text', text: 'brief.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
      { role: 'assistant', content: 'hi' },
    ],
    temperature: 0.2,
    top_p: 0.8,
    stop_sequences: ['STOP'],
    metadata: { user_id: 'ignored-by-the-final-answer-adapter' },
  });
  assert.deepEqual(out, {
    model: 'gemini-3-pro-preview',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    max_tokens: 50,
    temperature: 0.2,
    top_p: 0.8,
    stop: ['STOP'],
  });
});

test('accepts text cache hints in order and omits them from OpenAI messages', () => {
  const out = translated({
    system: [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two ', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'three', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
  });
  assert.equal(out.messages[0].content, 'one two three');
  assert.equal(out.messages[1].content, 'hello');
  assert.equal(JSON.stringify(out).includes('cache_control'), false);
});

test('preserves in-array system messages and their position', () => {
  const out = translated({
    system: 'top level',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'system', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: 'third' },
    ],
  });
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'top level' },
    { role: 'user', content: 'first' },
    { role: 'system', content: 'second' },
    { role: 'assistant', content: 'third' },
  ]);
  assert.equal(JSON.stringify(out).includes('cache_control'), false);
  for (const role of ['developer', 'tool', 'function', 'unknown', null, 1]) {
    assert.throws(() => translated({ messages: [{ role, content: 'x' }] }), OpenAIChatRequestError);
  }
});

test('applies modelMap before modelPrefix exactly once', () => {
  const out = translateOpenAIChatRequest(request(), {
    modelMap: { 'gemini-3-pro-preview': 'gemini-3-pro' },
    modelPrefix: 'models/',
  });
  assert.equal(out.model, 'models/gemini-3-pro');
  assert.equal(translateOpenAIChatRequest(request(), { modelPrefix: 'gemini-' }).model, 'gemini-3-pro-preview');
  assert.equal(translateOpenAIChatRequest(request(), {
    modelMap: { constructor: 'not-a-model' }, modelPrefix: '',
  }).model, 'gemini-3-pro-preview');
});

test('maps only low/medium/high reasoning effort', () => {
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(translated({ output_config: { effort } }).reasoning_effort, effort);
  }
  for (const effort of ['default', 'auto', undefined]) {
    assert.equal('reasoning_effort' in translated({ output_config: { effort } }), false);
  }
  assert.throws(() => translated({ output_config: { effort: 'max' } }), OpenAIChatRequestError);
});

test('accepts and omits Claude Code no-op tools, thinking and context envelopes', () => {
  for (const thinking of [{ type: 'adaptive', display: 'omitted' }, { type: 'adaptive' }]) {
    const out = translated({
      tools: [],
      thinking,
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      output_config: { effort: 'high' },
      stream: true,
    });
    assert.equal(out.tools, undefined);
    assert.equal(out.thinking, undefined);
    assert.equal(out.context_management, undefined);
    assert.equal(out.reasoning_effort, 'high');
    assert.equal(out.stream, true);
    assert.deepEqual(out.stream_options, { include_usage: true });
  }
});

test('requests final usage on streams and serializes the rewrite', () => {
  const body = rewriteOpenAIChatRequest(Buffer.from(JSON.stringify(request({ stream: true }))));
  const out = JSON.parse(body.toString());
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test('rejects tools, rich content and unsupported semantics before translation', () => {
  const invalid = [
    { tools: [{ name: 'lookup' }] },
    { tool_choice: 'auto' },
    { thinking: { type: 'enabled', budget_tokens: 100 } },
    { thinking: { type: 'adaptive', display: 'visible' } },
    { thinking: { type: 'adaptive', display: 'omitted', budget_tokens: 100 } },
    { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'none' }] } },
    { context_management: { edits: [{ type: 'compact_messages_20260101', keep: 'all' }] } },
    { context_management: { edits: [] } },
    { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }], extra: true } },
    { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }] },
    { system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    { system: [{ type: 'text', text: 'x', cache_control: { type: 'persistent' } }] },
    { system: [{ type: 'text', text: 'x', cache_control: null }] },
    { model: 'claude-sonnet-4-6' },
  ];
  for (const extra of invalid) assert.throws(() => translated(extra), OpenAIChatRequestError);
});

test('translates a final response with exact agy usage and no invented cache creation', () => {
  const out = translateOpenAIChatResponse({
    id: 'chatcmpl-1',
    model: 'upstream-must-not-replace-the-native-id',
    choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'length' }],
    usage: { ...USAGE, thinking_tokens: 100 },
  }, 'gemini-3-pro-preview');
  assert.equal(out.id, 'chatcmpl-1');
  assert.equal(out.model, 'gemini-3-pro-preview');
  assert.deepEqual(out.content, [{ type: 'text', text: 'answer' }]);
  assert.equal(out.stop_reason, 'max_tokens');
  assert.deepEqual(out.usage, ANTHROPIC_USAGE);
  assert.equal(out.usage.output_tokens, 5, 'thinking was added to output a second time');
});

test('validates final cumulative usage', () => {
  for (const usage of [
    { ...USAGE, total_tokens: 17 },
    { ...USAGE, input_tokens: -1 },
    { ...USAGE, output_tokens: 1.5 },
    { ...USAGE, cache_read_tokens: '7' },
  ]) {
    assert.throws(() => translateOpenAIChatResponse({ choices: [{ message: { content: 'x' } }], usage }, 'gemini-3-pro'), OpenAIChatResponseError);
  }
});

test('standard OpenAI prompt usage splits cached input without adding reasoning tokens', () => {
  assert.deepEqual(normalizeOpenAIChatUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 60 },
    completion_tokens: 7,
    completion_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 107,
  }), {
    input_tokens: 40,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 0,
    output_tokens: 7,
  });
  assert.throws(() => normalizeOpenAIChatUsage({
    prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens: 7, total_tokens: 57,
  }), OpenAIChatResponseError);
});

test('unexpected upstream tool calls never become Anthropic tool_use', () => {
  const out = translateOpenAIChatResponse({
    id: 'chatcmpl-tools',
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call', function: { name: 'x', arguments: '{}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: USAGE,
  }, 'gemini-3-pro');
  assert.deepEqual(out.content, []);
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(JSON.stringify(out).includes('tool_use'), false);
});

test('translates SSE fragmented at every byte and books only the final cumulative usage', async () => {
  const chunks = [
    { id: 'chatcmpl-stream', choices: [{ delta: { role: 'assistant', content: 'Hé🙂' } }] },
    { id: 'chatcmpl-stream', choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    { id: 'chatcmpl-stream', choices: [], usage: { ...USAGE, thinking_tokens: 100 } },
  ];
  const wire = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  const fragmented = new ReadableStream({
    start(controller) {
      for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const text = await collect(createOpenAIChatStream(fragmented, 'gemini-3-pro-preview'));
  const events = eventsFrom(text);
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[0].message.id, 'chatcmpl-stream');
  assert.equal(events[0].message.model, 'gemini-3-pro-preview');
  assert.deepEqual(events[0].message.usage, {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
  });
  const deltas = events.filter(event => event.type === 'content_block_delta');
  assert.equal(deltas.map(event => event.delta.text).join(''), 'Hé🙂lo');
  const final = events.find(event => event.type === 'message_delta');
  assert.deepEqual(final.usage, ANTHROPIC_USAGE);
  assert.equal(events.at(-1).type, 'message_stop');
});

test('streamed tool calls are ignored rather than converted to tool_use', async () => {
  const chunks = [
    { id: 'chatcmpl-tools', choices: [{ delta: { content: 'final', tool_calls: [{ id: 'call' }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: USAGE },
  ];
  const wire = chunks.map(chunk => `data:${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(wire)); controller.close(); } });
  const text = await collect(createOpenAIChatStream(stream, 'gemini-3-pro'));
  assert.equal(text.includes('tool_use'), false);
  assert.equal(eventsFrom(text).filter(event => event.type === 'content_block_delta')[0].delta.text, 'final');
});

test('cancelling a translated stream directly interrupts a stalled upstream read', async () => {
  let cancelledWith = null;
  const upstream = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel(reason) { cancelledWith = reason; },
  });
  const reader = createOpenAIChatStream(upstream, 'gemini-3-pro').getReader();
  const pending = reader.read();
  await reader.cancel('client disconnected');
  assert.equal(cancelledWith, 'client disconnected');
  assert.equal((await pending).done, true);
});
