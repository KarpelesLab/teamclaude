import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFamilyBlock, isFableModel, modelGlobOverlaps, parseRequestModel, parseRequestStream, TopLevelFieldFinder } from '../src/model.js';

test('isFableModel matches the Fable family only', () => {
  assert.equal(isFableModel('claude-fable-5'), true);
  assert.equal(isFableModel('claude-opus-4-8'), false);
  assert.equal(isFableModel('claude-sonnet-5'), false);
  assert.equal(isFableModel(null), false);
  assert.equal(isFableModel(undefined), false);
});

test('parseRequestModel reads the top-level model', () => {
  assert.equal(parseRequestModel('{"model":"claude-fable-5","max_tokens":1}'), 'claude-fable-5');
  assert.equal(parseRequestModel(Buffer.from('{ "model" : "claude-opus-4-8" }')), 'claude-opus-4-8');
  assert.equal(parseRequestModel('{"max_tokens":1}'), null);
  assert.equal(parseRequestModel(''), null);
  assert.equal(parseRequestModel(null), null);
});

test('parseRequestModel ignores a "model" key nested in conversation content', () => {
  // A user message literally contains `"model":"DECOY"`; the real field comes
  // after it at the top level. A regex would grab DECOY — the structural finder
  // must return the top-level value.
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'here is json: {"model":"DECOY-should-be-ignored"}' }],
    system: [{ type: 'text', text: '"model": "ALSO-DECOY"' }],
    model: 'claude-fable-5',
  });
  assert.equal(parseRequestModel(body), 'claude-fable-5');
});

test('parseRequestModel ignores a nested model even when it appears first', () => {
  const body = '{"metadata":{"model":"nested-decoy"},"model":"claude-opus-4-8"}';
  assert.equal(parseRequestModel(body), 'claude-opus-4-8');
});

test('TopLevelFieldFinder resolves across chunk boundaries', () => {
  // Split the body mid-key and mid-value to exercise the streaming state.
  const full = '{"max_tokens":1,"model":"claude-fable-5","stream":true}';
  const finder = new TopLevelFieldFinder('model');
  let out = null;
  for (let i = 0; i < full.length; i += 3) {
    out = finder.push(Buffer.from(full.slice(i, i + 3), 'utf8'));
    if (finder.done) break;
  }
  assert.equal(out, 'claude-fable-5');
  assert.equal(finder.done, true);
});

test('TopLevelFieldFinder marks done (absent) once the root object closes', () => {
  const finder = new TopLevelFieldFinder('model');
  assert.equal(finder.push(Buffer.from('{"max_tokens":1}')), null);
  assert.equal(finder.done, true); // root closed without the field → stop early
});

test('findFamilyBlock matches a family by glob, by concrete id, and by catch-all', () => {
  assert.equal(findFamilyBlock(['*fable*'], 'Fable'), '*fable*');
  assert.equal(findFamilyBlock(['claude-fable-5'], 'Fable'), 'claude-fable-5');
  assert.equal(findFamilyBlock(['*'], 'Fable'), '*');
  assert.equal(findFamilyBlock(['*opus*'], 'Fable'), null);
  assert.equal(findFamilyBlock([], 'Fable'), null);
  assert.equal(findFamilyBlock(['*fable*'], ''), null);
  assert.equal(findFamilyBlock(null, 'Fable'), null);
  assert.equal(findFamilyBlock([null, 42, '*fable*'], 'Fable'), '*fable*');
});

test('modelGlobOverlaps compares literal cores in both directions', () => {
  assert.equal(modelGlobOverlaps('*fable*', '*fable*'), true);
  assert.equal(modelGlobOverlaps('claude-fable-5', '*fable*'), true);
  assert.equal(modelGlobOverlaps('*fable*', 'claude-fable-5'), true);
  assert.equal(modelGlobOverlaps('*', '*fable*'), true);
  assert.equal(modelGlobOverlaps('*opus*', '*fable*'), false);
  assert.equal(modelGlobOverlaps(undefined, '*fable*'), false);
});

test('parseRequestStream reads only the top-level stream field', () => {
  assert.equal(parseRequestStream('{"model":"m","stream":true}'), true);
  assert.equal(parseRequestStream('{"model":"m","stream": true ,"input":[]}'), true);
  assert.equal(parseRequestStream('{"model":"m","stream":false}'), false);
  assert.equal(parseRequestStream('{"model":"m"}'), false);
  assert.equal(parseRequestStream('{"input":[{"stream":true}],"model":"m"}'), false, 'nested stream is not the field');
  assert.equal(parseRequestStream('{"messages":[{"content":"\\"stream\\": true"}]}'), false, 'text is not the field');
  assert.equal(parseRequestStream('{"stream":"true"}'), false, 'a string is not the literal');
  assert.equal(parseRequestStream(''), false);
  assert.equal(parseRequestStream(null), false);
  // The finder still reads string fields as before, scalar support notwithstanding.
  assert.equal(new TopLevelFieldFinder('n').push(Buffer.from('{"n": 42, "model":"m"}')), '42');
  assert.equal(new TopLevelFieldFinder('model').push(Buffer.from('{"n": 42, "model":"m"}')), 'm');
});
