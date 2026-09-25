import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { rewriteRequestBody } from '../src/server.js';

// Wiring pin for the `tool_addition` 400: once a tool appears mid-conversation,
// Claude Code puts a `tool_addition` block into the history, a strict
// third-party upstream rejects the whole body, and every later turn of that
// conversation fails with it. rewriteRequestBody must drop the listed block
// types on a custom-upstream leg that OPTS IN via
// `stripRequestFields: ["content.tool_addition"]` and leave every other
// account's body byte-identical.

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));

const toolChangeBody = () => buf({
  model: 'k3',
  context_management: { edits: [] },
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'system', content: [
      { type: 'text', text: 'Tools became available: lookup' },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'lookup' }, cache_control: { type: 'ephemeral', scope: 'session' } },
    ] },
  ],
});

function fleet() {
  return new AccountManager([
    { name: 'strict', type: 'apikey', apiKey: 'k1', upstream: 'https://strict.example', stripRequestFields: ['context_management', 'cache_control.scope', 'content.tool_addition'], priority: 100 },
    { name: 'claude', type: 'apikey', apiKey: 'k2' },
    { name: 'relay', type: 'apikey', apiKey: 'k3', upstream: 'https://mirror.example' },
  ], 0.98).accounts;
}

test('opted-in leg: the block is dropped and the other strips still apply to what is left', () => {
  const [strict] = fleet();
  const out = parse(rewriteRequestBody(toolChangeBody(), strict, MESSAGES, JSON_CT));
  assert.deepEqual(out.messages[1].content, [
    { type: 'text', text: 'Tools became available: lookup', cache_control: { type: 'ephemeral' } },
  ], 'the breakpoint moves to the text block and loses the scope the same account strips');
  assert.equal('context_management' in out, false, 'the top-level entry still applies');
});

test('a custom upstream that did not opt in keeps the block', () => {
  const [, , relay] = fleet();
  const body = toolChangeBody();
  assert.equal(rewriteRequestBody(body, relay, MESSAGES, JSON_CT), body);
});

test('Anthropic leg: body passes through as the identical buffer', () => {
  const [, claude] = fleet();
  const body = toolChangeBody();
  assert.equal(rewriteRequestBody(body, claude, MESSAGES, JSON_CT), body);
});
