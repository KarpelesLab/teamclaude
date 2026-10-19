import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldSystemMessages } from '../src/system-message-fold.js';

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, url = MESSAGES, ct = JSON_CT) => foldSystemMessages(buf(obj), url, ct);

const NOTE = '<total_tokens>14648286 tokens left</total_tokens>';
const user = (text) => ({ role: 'user', content: text });
const asst = (text) => ({ role: 'assistant', content: text });
const sysMsg = (content) => ({ role: 'system', content });

test('string system: leading system message is appended with a blank line', () => {
  const r = run({ model: 'm', system: 'You are X.', messages: [sysMsg(NOTE), user('hi')] });
  assert.equal(r.count, 1);
  const out = parse(r.body);
  assert.equal(out.system, `You are X.\n\n${NOTE}`);
  assert.deepEqual(out.messages, [user('hi')]);
  assert.equal(out.model, 'm');
});

test('array system: text block appended, existing cache_control kept, none added', () => {
  const system = [
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
  ];
  const r = run({ system, messages: [sysMsg(NOTE), user('hi')] });
  assert.equal(r.count, 1);
  const out = parse(r.body);
  assert.deepEqual(out.system, [...system, { type: 'text', text: NOTE }]);
  assert.equal(out.system.filter((b) => b.cache_control).length, 1);
  assert.deepEqual(out.messages, [user('hi')]);
});

test('absent system: becomes a string', () => {
  const r = run({ messages: [sysMsg(NOTE), user('hi')] });
  const out = parse(r.body);
  assert.equal(out.system, NOTE);
  assert.deepEqual(out.messages, [user('hi')]);
});

test('system message content as an array: only text blocks are taken', () => {
  const content = [
    { type: 'text', text: 'one' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'two' },
  ];
  const r = run({ system: 'S', messages: [sysMsg(content), user('hi')] });
  const out = parse(r.body);
  assert.equal(out.system, 'S\n\none\n\ntwo');
  assert.deepEqual(out.messages, [user('hi')]);

  const r2 = run({ system: [{ type: 'text', text: 'S' }], messages: [sysMsg(content), user('hi')] });
  assert.deepEqual(parse(r2.body).system, [
    { type: 'text', text: 'S' }, { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
  ]);
});

test('non-leading system messages are moved too, other messages keep their order', () => {
  const r = run({
    system: 'S',
    messages: [sysMsg('first'), user('u1'), asst('a1'), sysMsg('later'), user('u2')],
  });
  assert.equal(r.count, 2);
  const out = parse(r.body);
  assert.equal(out.system, 'S\n\nfirst\n\nlater');
  assert.deepEqual(out.messages, [user('u1'), asst('a1'), user('u2')]);
});

test('no system-role message: same Buffer returned, byte-for-byte unchanged', () => {
  // Odd spacing and key order on purpose: a re-serialize would change the bytes.
  const raw = Buffer.from('{"system":"S" , "messages":[{"role":"user","content":"role system"}],"z":1}', 'utf8');
  const copy = Buffer.from(raw);
  const r = foldSystemMessages(raw, MESSAGES, JSON_CT);
  assert.equal(r.count, 0);
  assert.equal(r.body, raw);
  assert.ok(r.body.equals(copy));
});

test('marker text inside a string but no real system message: same Buffer', () => {
  const raw = buf({ system: 'S', messages: [user('the text "role":"system" appears here')] });
  const r = foldSystemMessages(raw, MESSAGES, JSON_CT);
  assert.equal(r.count, 0);
  assert.equal(r.body, raw);
});

test('pretty-printed JSON is folded too', () => {
  const raw = Buffer.from(JSON.stringify({ messages: [sysMsg(NOTE), user('hi')] }, null, 1), 'utf8');
  const r = foldSystemMessages(raw, MESSAGES, JSON_CT);
  assert.equal(r.count, 1);
  assert.equal(parse(r.body).system, NOTE);
});

test('count_tokens path is folded; other paths, non-JSON, and bad JSON are untouched', () => {
  const obj = { messages: [sysMsg(NOTE), user('hi')] };
  assert.equal(run(obj, '/v1/messages/count_tokens').count, 1);
  const raw = buf(obj);
  assert.equal(foldSystemMessages(raw, '/v1/complete', JSON_CT).body, raw);
  assert.equal(foldSystemMessages(raw, MESSAGES, 'text/plain').body, raw);
  const bad = Buffer.from('{"role":"system", oops', 'utf8');
  assert.equal(foldSystemMessages(bad, MESSAGES, JSON_CT).body, bad);
});

test('system message with no text is still removed; system left as it was', () => {
  const r = run({ messages: [sysMsg([]), user('hi')] });
  assert.equal(r.count, 1);
  const out = parse(r.body);
  assert.equal('system' in out, false);
  assert.deepEqual(out.messages, [user('hi')]);
});

test('forwardRequest folds before the tool-pair pass, for every upstream', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const fold = src.indexOf('foldSystemMessages(body, req.url');
  const sanitize = src.indexOf('sanitizeToolPairs(folded.body');
  const fwd = src.indexOf('export async function forwardRequest(');
  assert.ok(fwd > 0 && fold > fwd && sanitize > fold, 'fold runs inside forwardRequest, before sanitizeToolPairs');
  // Not gated on customUpstream / native: it must run for both.
  const between = src.slice(fwd, fold);
  assert.ok(between.includes('const customUpstream ='), 'fold comes after upstream is known but is not inside an upstream branch');
});
