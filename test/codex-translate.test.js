import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudeRequestToCodex, shortenName, shortenCallId, buildShortNameMap, normalizeToolParameters, budgetToEffort } from '../src/codex/request-translate.js';
import { createCodexStreamTranslator, mapStopReason, extractUsage, sanitizeToolId } from '../src/codex/response-translate.js';
import { isValidGptReasoningSignature, compatibleGptSignature, splitProviderPrefix } from '../src/codex/signature.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));

// ── differential fixtures ───────────────────────────────────
//
// These assert byte-equality against output captured from CLIProxyAPI, the
// reference implementation these translators were ported from. A failure means
// the port drifted from the behaviour a real Codex backend expects — not that a
// style preference changed. Regenerate the fixtures only against a known-good
// CLIProxyAPI revision, never to make a failing test pass.

const requestFixtures = load('codex-requests.json');
const streamFixtures = load('codex-streams.json');

for (const c of requestFixtures.cases) {
  test(`request translation matches ground truth: ${c.name}`, () => {
    const got = JSON.parse(claudeRequestToCodex(c.request, requestFixtures._model).toString('utf-8'));
    assert.deepEqual(got, c.want);
  });
}

// Frames rather than raw chunks: the client sees a flat SSE sequence, and how it
// was batched across chunk boundaries is not part of the contract.
function frames(text) {
  return text.split(/\n\n(?=event: |$)/).map(s => s.trim()).filter(Boolean);
}

for (const c of streamFixtures.cases) {
  test(`stream translation matches ground truth: ${c.name}`, () => {
    const t = createCodexStreamTranslator(c.original);
    const got = frames(c.chunks.flatMap(chunk => t.push(chunk)).join(''));
    assert.deepEqual(got, c.want);
  });
}

// ── unit coverage for helpers ───────────────────────────────

test('shortenName leaves short names alone', () => {
  assert.equal(shortenName('get_weather'), 'get_weather');
});

test('shortenName keeps the distinguishing tail of an MCP name', () => {
  const name = 'mcp__' + 'server'.repeat(12) + '__the_actual_tool';
  const short = shortenName(name);
  assert.ok(short.length <= 64);
  assert.ok(short.startsWith('mcp__'));
  assert.ok(short.includes('the_actual_tool'));
});

test('buildShortNameMap disambiguates names that truncate to the same value', () => {
  // Without disambiguation the model could not address these separately.
  const a = 'mcp__' + 'x'.repeat(70) + '__same';
  const b = 'mcp__' + 'y'.repeat(70) + '__same';
  const map = buildShortNameMap([a, b]);
  assert.notEqual(map.get(a), map.get(b));
  assert.ok(map.get(a).length <= 64);
  assert.ok(map.get(b).length <= 64);
});

test('shortenCallId keeps long ids distinct via a hash suffix', () => {
  const prefix = 'toolu_' + 'a'.repeat(70);
  const one = shortenCallId(prefix + 'one');
  const two = shortenCallId(prefix + 'two');
  assert.ok(one.length <= 64);
  assert.notEqual(one, two);
});

test('shortenCallId leaves short ids untouched', () => {
  assert.equal(shortenCallId('toolu_123'), 'toolu_123');
});

test('normalizeToolParameters fills in a missing properties map', () => {
  assert.deepEqual(normalizeToolParameters({ type: 'object' }), { type: 'object', properties: {} });
  assert.deepEqual(normalizeToolParameters(undefined), { type: 'object', properties: {} });
  assert.deepEqual(normalizeToolParameters(null), { type: 'object', properties: {} });
});

test('normalizeToolParameters preserves a populated schema', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  assert.deepEqual(normalizeToolParameters(schema), schema);
});

test('budgetToEffort maps each band', () => {
  assert.equal(budgetToEffort(-1), 'auto');
  assert.equal(budgetToEffort(0), 'none');
  assert.equal(budgetToEffort(512), 'minimal');
  assert.equal(budgetToEffort(1024), 'low');
  assert.equal(budgetToEffort(8192), 'medium');
  assert.equal(budgetToEffort(24576), 'high');
  assert.equal(budgetToEffort(24577), 'xhigh');
  assert.equal(budgetToEffort(-2), null);
});

test('mapStopReason returns tool_use whenever a tool block was emitted', () => {
  assert.equal(mapStopReason('stop', true), 'tool_use');
  assert.equal(mapStopReason('max_tokens', true), 'tool_use');
});

test('mapStopReason maps codex reasons without a tool block', () => {
  assert.equal(mapStopReason('', false), 'end_turn');
  assert.equal(mapStopReason('completed', false), 'end_turn');
  assert.equal(mapStopReason('max_output_tokens', false), 'max_tokens');
  assert.equal(mapStopReason('content_filter', false), 'refusal');
  assert.equal(mapStopReason('pause_turn', false), 'pause_turn');
  // Codex named a tool finish but nothing was emitted, so it is a normal turn.
  assert.equal(mapStopReason('tool_calls', false), 'end_turn');
  assert.equal(mapStopReason('something_new', false), 'end_turn');
});

test('extractUsage subtracts cached tokens from the input total', () => {
  // Codex counts cached tokens inside input_tokens; Anthropic reports them
  // alongside, so forwarding both unchanged would double-count.
  assert.deepEqual(extractUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } }),
    { input: 40, output: 20, cached: 60 });
});

test('extractUsage clamps when cached exceeds input', () => {
  assert.deepEqual(extractUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 50 } }),
    { input: 0, output: 1, cached: 50 });
});

test('extractUsage handles a missing usage object', () => {
  assert.deepEqual(extractUsage(null), { input: 0, output: 0, cached: 0 });
});

test('sanitizeToolId replaces characters Anthropic tool ids disallow', () => {
  assert.equal(sanitizeToolId('call/with:bad chars', 1), 'call_with_bad_chars');
  assert.equal(sanitizeToolId('fine_id-1', 1), 'fine_id-1');
});

test('sanitizeToolId maps every invalid character rather than dropping it', () => {
  // Substitution, not deletion — so two distinct ids cannot collapse into one.
  assert.equal(sanitizeToolId('///', 7), '___');
});

test('sanitizeToolId synthesizes an id only when the input is empty', () => {
  assert.equal(sanitizeToolId('', 7), 'toolu_codex_7');
  assert.equal(sanitizeToolId(null, 8), 'toolu_codex_8');
});

// ── signature validation ────────────────────────────────────

function gptSig(blocks = 1) {
  const p = Buffer.alloc(1 + 8 + 16 + 16 * blocks + 32);
  p[0] = 0x80;
  for (let i = 9; i < p.length; i++) p[i] = i & 0xff;
  return p.toString('base64url');
}

test('a well-formed GPT reasoning signature validates', () => {
  assert.equal(isValidGptReasoningSignature(gptSig()), true);
  assert.equal(isValidGptReasoningSignature(gptSig(4)), true);
});

test('signatures failing the Fernet structure are rejected', () => {
  assert.equal(isValidGptReasoningSignature(''), false);
  assert.equal(isValidGptReasoningSignature('gAAAAABtooshort'), false);
  assert.equal(isValidGptReasoningSignature('notgpt' + gptSig()), false);
  // Right prefix, wrong version byte.
  const bad = Buffer.alloc(80); bad[0] = 0x79;
  assert.equal(isValidGptReasoningSignature(bad.toString('base64url')), false);
});

test('a ciphertext that is not a whole number of AES blocks is rejected', () => {
  const p = Buffer.alloc(1 + 8 + 16 + 17 + 32);
  p[0] = 0x80;
  assert.equal(isValidGptReasoningSignature(p.toString('base64url')), false);
});

test('compatibleGptSignature drops another provider tagged signature', () => {
  // Replaying Anthropic-issued reasoning to a GPT backend makes it reject the
  // whole request, so the block is dropped instead.
  assert.equal(compatibleGptSignature(`claude#${gptSig()}`), null);
  assert.equal(compatibleGptSignature('ErUBCkYIBxgCKkDxV3nOAnthropicSigned=='), null);
});

test('compatibleGptSignature accepts a gpt-tagged signature', () => {
  const sig = gptSig();
  assert.equal(compatibleGptSignature(`gpt#${sig}`), sig);
  assert.equal(compatibleGptSignature(sig), sig);
});

test('splitProviderPrefix only splits on recognized providers', () => {
  assert.deepEqual(splitProviderPrefix('claude#abc'), { provider: 'claude', signature: 'abc' });
  assert.deepEqual(splitProviderPrefix('unknown#abc'), { provider: null, signature: 'unknown#abc' });
  assert.deepEqual(splitProviderPrefix('abc'), { provider: null, signature: 'abc' });
});

// ── stream translator lifecycle ─────────────────────────────

test('the translator ignores non-data lines and sentinels', () => {
  const t = createCodexStreamTranslator();
  assert.deepEqual(t.push('event: response.created'), []);
  assert.deepEqual(t.push(''), []);
  assert.deepEqual(t.push('data: '), []);
  assert.deepEqual(t.push('data: [DONE]'), []);
  assert.deepEqual(t.push('data: {not json'), []);
});

test('end() closes a text block left open by a truncated stream', () => {
  // Without this the client waits forever on an unclosed content block.
  const t = createCodexStreamTranslator();
  t.push('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'r' } }));
  t.push('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
  const tail = t.end().join('');
  assert.match(tail, /content_block_stop/);
});

test('end() closes an unfinished tool_use block', () => {
  const t = createCodexStreamTranslator();
  t.push('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'r' } }));
  t.push('data: ' + JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'x' },
  }));
  const tail = t.end().join('');
  assert.match(tail, /content_block_stop/);
});

test('end() on a clean stream emits nothing', () => {
  const t = createCodexStreamTranslator();
  t.push('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'r' } }));
  t.push('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'r', usage: {} } }));
  assert.deepEqual(t.end(), []);
});
