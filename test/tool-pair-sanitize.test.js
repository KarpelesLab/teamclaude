import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolPairs } from '../src/tool-pair-sanitize.js';

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, url = MESSAGES, ct = JSON_CT) => sanitizeToolPairs(buf(obj), url, ct);

// True when no tool_use lacks a result and no tool_result lacks a use — the exact
// invariant Anthropic enforces (whole-body pairing).
function isPaired(body) {
  const uses = new Set();
  const results = new Set();
  for (const m of body.messages ?? []) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use') uses.add(b.id);
      else if (b?.type === 'tool_result') results.add(b.tool_use_id);
    }
  }
  for (const id of uses) if (!results.has(id)) return false;
  for (const id of results) if (!uses.has(id)) return false;
  return true;
}

function rolesAlternate(body) {
  const roles = (body.messages ?? []).map((m) => m.role);
  return roles.every((r, i) => i === 0 || r !== roles[i - 1]);
}

test('strips a tail tool_use that has no tool_result and drops the emptied turn', () => {
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_a', name: 'a', input: {} },
        { type: 'tool_use', id: 'toolu_b', name: 'b', input: {} },
      ] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});

test('well-formed body is returned as the same Buffer instance (no reserialize)', () => {
  const original = buf({
    model: 'claude',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ok', name: 'a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'done' }] },
      { role: 'assistant', content: 'all set' },
    ],
  });
  assert.equal(sanitizeToolPairs(original, MESSAGES, JSON_CT), original);
});

test('removes a dangling tool_result whose tool_use is gone, keeps sibling content', () => {
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_missing', content: 'orphan' },
        { type: 'text', text: 'and here is my next ask' },
      ] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.equal(body.messages.length, 1);
  assert.ok(body.messages[0].content.some((b) => b.type === 'text'));
});

test('an orphan alongside real content drops only the orphan, keeps the message', () => {
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'toolu_dead', name: 'a', input: {} },
      ] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.equal(body.messages[1].content.length, 1);
  assert.equal(body.messages[1].content[0].type, 'text');
});

test('dropping a whole message coalesces same-role neighbors so roles still alternate', () => {
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.ok(rolesAlternate(body));
  assert.equal(body.messages.filter((m) => m.role === 'assistant').length, 1);
});

test('leaves non-/v1/messages, non-JSON, and unparseable bodies untouched', () => {
  const orphan = { model: 'x', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_z', name: 'a', input: {} }] }] };
  const b1 = buf(orphan);
  assert.equal(sanitizeToolPairs(b1, '/v1/complete', JSON_CT), b1);
  const b2 = Buffer.from('not json at all', 'utf8');
  assert.equal(sanitizeToolPairs(b2, MESSAGES, JSON_CT), b2);
  const b3 = buf(orphan);
  assert.equal(sanitizeToolPairs(b3, MESSAGES, 'text/plain'), b3);
});

test('also covers /v1/messages/count_tokens', () => {
  const out = run(
    { model: 'x', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ct', name: 'a', input: {} }] }] },
    '/v1/messages/count_tokens',
  );
  assert.ok(isPaired(parse(out)));
});
