import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationDigest, pinKeyFor, MAX_CONVERSATION_BYTES } from '../src/conversation.js';
import { MAX_KEY_LENGTH, MAX_SESSION_ID_LENGTH } from '../src/session-tracker.js';

const body = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8');
const digest = (o) => conversationDigest(body(o));

// The shape Claude Code sends: a big system prompt, tools, then the message
// list. The first message is the conversation's opening and does not move.
const turn = (first, rest = []) => ({
  model: 'claude-opus-5',
  system: [{ type: 'text', text: 'you are a helpful assistant' }],
  tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: first }, ...rest],
});

test('the digest holds while the transcript grows around it', () => {
  // The one property the pin depends on. A conversation's later turns carry
  // more messages, a rewritten system prompt and moved cache_control markers;
  // none of that is the conversation's opening.
  const first = digest(turn('build me a proxy'));
  const later = digest({
    ...turn('build me a proxy', [
      { role: 'assistant', content: 'on it' },
      { role: 'user', content: 'now add tests' },
    ]),
    system: [{ type: 'text', text: 'a wholly different system prompt' }],
  });
  assert.equal(later, first);
});

test('siblings of one fan-out are told apart', () => {
  // Measured against Claude Code: parallel subagents carry byte-identical
  // system prompts and tools, so only the first message separates them. This is
  // the case the whole change exists for.
  const a = digest(turn('review the auth module'));
  const b = digest(turn('review the routing module'));
  const c = digest(turn('review the quota module'));
  assert.equal(new Set([a, b, c]).size, 3);
});

test('a cache_control marker on the first message changes the digest once', () => {
  // Stated rather than defended: the digest is over raw bytes, so a marker
  // moving off the first message re-keys that conversation a single time. The
  // assertion pins the behaviour so a reader is not surprised by it.
  const marked = digest({ messages: [{ role: 'user', content: 'hi', cache_control: { type: 'ephemeral' } }] });
  const bare = digest({ messages: [{ role: 'user', content: 'hi' }] });
  assert.notEqual(marked, bare);
});

test('the message list is found wherever it sits in the body', () => {
  const after = digest({ model: 'claude-opus-5', system: 'x', messages: [{ role: 'user', content: 'go' }] });
  const before = digest({ messages: [{ role: 'user', content: 'go' }], system: 'x', model: 'claude-opus-5' });
  assert.equal(before, after);
});

test('a `messages` key nested in a tool schema is not mistaken for the list', () => {
  const decoy = digest({
    tools: [{ name: 't', input_schema: { properties: { messages: [{ role: 'user', content: 'DECOY' }] } } }],
    messages: [{ role: 'user', content: 'go' }],
  });
  assert.equal(decoy, digest({ messages: [{ role: 'user', content: 'go' }] }));
});

test('JSON metacharacters inside strings do not end the element early', () => {
  // `}`, `]` and `,` inside a quoted string, and the escaped quote that hides
  // one. A scanner that ignored string state would cut the element at the first
  // of these and digest a prefix.
  const tricky = digest({ messages: [{ role: 'user', content: 'a, b] c} d\\" e' }, { role: 'assistant', content: 'x' }] });
  const alone = digest({ messages: [{ role: 'user', content: 'a, b] c} d\\" e' }] });
  assert.equal(tricky, alone);
  assert.notEqual(tricky, digest({ messages: [{ role: 'user', content: 'a, b] c} d\\" f' }] }));
});

test('a nested content array is part of the opening', () => {
  const one = digest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'alpha' }] }, { role: 'assistant', content: 'x' }] });
  const two = digest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'beta' }] }, { role: 'assistant', content: 'x' }] });
  assert.notEqual(one, two);
});

test('a repeated `messages` key is read as its first occurrence', () => {
  // The one place the scanner and JSON.parse disagree (parse takes the last),
  // and it is what lets the scan stop early. Pinned here so the disagreement is
  // a decision rather than a surprise. No client sends the key twice, which is
  // what makes the early exit worth its cost in both directions.
  const twice = '{"messages":[{"role":"user","content":"first"}],"messages":[{"role":"user","content":"second"}]}';
  assert.equal(conversationDigest(Buffer.from(twice, 'utf8')),
    digest({ messages: [{ role: 'user', content: 'first' }] }));
});

test('a body that names no conversation digests to null', () => {
  // The Responses shape a translating sidecar sends, an empty list, a truncated
  // body, and a body that is not an object. None is a failure: routing falls
  // back to the session id, which is what it keyed on before.
  assert.equal(digest({ model: 'gpt-6', input: 'hello', instructions: 'be nice' }), null);
  assert.equal(digest({ messages: [] }), null);
  assert.equal(digest('{"messages": [   ]}'), null);
  assert.equal(digest('{"messages":[{"role":"user"'), null);
  assert.equal(digest('[1,2,3]'), null);
  assert.equal(conversationDigest(Buffer.alloc(0)), null);
  assert.equal(conversationDigest(null), null);
  assert.equal(conversationDigest('a string, not a buffer'), null);
});

test('a single-message list closes on the array bracket', () => {
  // The only element, with no comma to end it. Must digest the same as the
  // identical opening in a longer list, or a conversation would re-key on its
  // second turn — the one thing the key may never do.
  const only = digest({ messages: [{ role: 'user', content: 'go' }] });
  assert.notEqual(only, null);
  assert.equal(only, digest({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'x' }] }));
});

test('a pretty-printed body is stable from its first turn to its second', () => {
  // The regression. Element 0 ends at the array's `]` while it is the only
  // element and at a `,` once it is not, and a pretty-printer puts a newline
  // and an indent before the `]` but nothing before the `,`. Digesting that gap
  // re-keyed every such conversation on its second turn — a split off its own
  // cache. Checked for each indent style a client might serialise with.
  const withTurns = (n) => ({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'the opening' },
      ...Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: `turn ${i}` }))],
  });
  for (const indent of [0, 2, 4, '\t']) {
    const digests = [0, 1, 2, 5].map(n => conversationDigest(Buffer.from(JSON.stringify(withTurns(n), null, indent), 'utf8')));
    assert.equal(new Set(digests).size, 1, `indent ${JSON.stringify(indent)} split: ${digests.join(' ')}`);
  }
});

test('a huge opening is bounded in what it costs to read', () => {
  // The walk stops at the bound, so routing a request never costs more than
  // this however much was pasted into its first message. Two openings that
  // agree over the bound then collide, which is the harmless direction.
  const huge = (tail) => digest({ messages: [{ role: 'user', content: 'x'.repeat(MAX_CONVERSATION_BYTES) + tail }] });
  assert.equal(huge('a'), huge('aa'));
  // Openings that differ INSIDE the bound are still told apart.
  assert.notEqual(huge('a'), digest({ messages: [{ role: 'user', content: 'y'.repeat(MAX_CONVERSATION_BYTES) }] }));
  // And the cost is flat past it: 16x the bytes, nothing like 16x the time.
  const time = (n) => {
    const b = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(n) }] }), 'utf8');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) conversationDigest(b);
    return Number(process.hrtime.bigint() - t0);
  };
  const small = time(MAX_CONVERSATION_BYTES * 2);
  const large = time(MAX_CONVERSATION_BYTES * 32);
  assert.ok(large < small * 4, `cost grew with the paste: ${small} -> ${large}`);
});

test('pinKeyFor narrows a session, and degrades to it', () => {
  const sid = '090efd2c-7026-4c6a-9e51-8a075c51327d';
  const a = pinKeyFor(sid, digest(turn('task one')));
  const b = pinKeyFor(sid, digest(turn('task two')));
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`${sid}/`));
  // No conversation in the body: the key is the session, exactly as before, so
  // a Responses-shaped request routes as it always did.
  assert.equal(pinKeyFor(sid, digest({ input: 'hi' })), sid);
  assert.equal(pinKeyFor(null, digest(turn('task one'))), null);
});

test('a pin key fits the bound the tracker guards with', () => {
  // The tracker truncates past MAX_KEY_LENGTH, and truncating a key would merge
  // conversations. Every key the request path can build has to fit under it.
  const longest = pinKeyFor('x'.repeat(MAX_SESSION_ID_LENGTH), digest(turn('task one')));
  assert.ok(longest.length <= MAX_KEY_LENGTH, `${longest.length} > ${MAX_KEY_LENGTH}`);
});
