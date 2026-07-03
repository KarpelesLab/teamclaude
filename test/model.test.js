import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFableModel, parseRequestModel, TopLevelFieldFinder } from '../src/model.js';

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
