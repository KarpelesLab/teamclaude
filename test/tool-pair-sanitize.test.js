import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolPairs } from '../src/tool-pair-sanitize.js';

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, url = MESSAGES, ct = JSON_CT) => sanitizeToolPairs(buf(obj), url, ct);

// True when the body satisfies Anthropic's ACTUAL rule: every tool_use is answered
// by a matching tool_result in the IMMEDIATELY FOLLOWING message, and every
// tool_result is grounded by a tool_use in the message right before it. (Whole-body
// "does the id exist anywhere" is too lenient — it was the bug.)
function idsOf(msg, type, key) {
  const ids = new Set();
  for (const b of Array.isArray(msg?.content) ? msg.content : []) {
    if (b?.type === type && typeof b[key] === 'string') ids.add(b[key]);
  }
  return ids;
}
function isPaired(body) {
  const msgs = body.messages ?? [];
  for (let i = 0; i < msgs.length; i++) {
    const next = idsOf(msgs[i + 1], 'tool_result', 'tool_use_id');
    const prev = idsOf(msgs[i - 1], 'tool_use', 'id');
    for (const b of Array.isArray(msgs[i]?.content) ? msgs[i].content : []) {
      if (b?.type === 'tool_use' && !next.has(b.id)) return false;
      if (b?.type === 'tool_result' && !prev.has(b.tool_use_id)) return false;
    }
  }
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

test('a tool-free body is a same-Buffer no-op via the fast path (never parsed)', () => {
  const original = buf({
    model: 'claude',
    messages: [
      { role: 'user', content: 'just a plain question' },
      { role: 'assistant', content: [{ type: 'text', text: 'a plain answer' }] },
    ],
  });
  assert.equal(sanitizeToolPairs(original, MESSAGES, JSON_CT), original);
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

test('strips a SEPARATED pair — result present but not immediately after (the messages.2 case)', () => {
  // A compaction that keeps a tool_use at messages[2] but moves its tool_result to
  // messages[4] instead of [3]. The id still exists in the body, so whole-body
  // pairing would keep it and Anthropic still 400s. Positional pairing must strip it.
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_gap', name: 'noop', input: {} }] },
      { role: 'user', content: 'unrelated next turn' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gap', content: 'late' }] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.ok(rolesAlternate(body));
  assert.ok(!JSON.stringify(body).includes('toolu_gap'));
});

test('cascade: dropping one turn exposes the next orphan, valid pair is preserved', () => {
  const out = run({
    model: 'claude',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'a', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ra' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'b', input: {} }] },
      { role: 'user', content: 'chatter' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'rb late' }] },
    ],
  });
  const body = parse(out);
  assert.ok(isPaired(body));
  assert.ok(rolesAlternate(body));
  assert.ok(JSON.stringify(body).includes('toolu_A'));
  assert.ok(!JSON.stringify(body).includes('toolu_B'));
});
