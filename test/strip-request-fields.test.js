import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripBodyFields } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';

// Third-party upstreams implement the Anthropic message API but reject fields
// Claude Code legitimately sends — observed: `context_management` drawing a 400
// "Extra inputs are not permitted", which breaks EVERY request once such an
// account is selected. stripRequestFields drops them for those accounts only.

const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));

test('a configured field is dropped and the rest of the body survives', () => {
  const body = buf({ model: 'claude-x', context_management: { enabled: true }, messages: [{ role: 'user' }] });
  const out = stripBodyFields(body, ['context_management']);
  const obj = parse(out);
  assert.equal('context_management' in obj, false);
  assert.equal(obj.model, 'claude-x');
  assert.deepEqual(obj.messages, [{ role: 'user' }]);
});

test('several fields can be dropped at once', () => {
  const out = stripBodyFields(buf({ a: 1, b: 2, c: 3 }), ['a', 'c']);
  assert.deepEqual(parse(out), { b: 2 });
});

// The caller refreshes Content-Length only when the buffer actually changes, so
// "nothing matched" has to return the very same buffer, not an equal one.
test('a body with none of the fields is returned untouched', () => {
  const body = buf({ model: 'claude-x' });
  assert.equal(stripBodyFields(body, ['context_management']), body);
});

test('only top-level fields are removed', () => {
  const out = stripBodyFields(buf({ tools: [{ context_management: 1 }] }), ['context_management']);
  assert.deepEqual(parse(out), { tools: [{ context_management: 1 }] });
});

// Non-JSON bodies reach this path too (any non-messages endpoint), and must not
// be corrupted or throw.
test('a non-JSON body passes through unchanged', () => {
  const body = Buffer.from('not json at all', 'utf8');
  assert.equal(stripBodyFields(body, ['x']), body);
});

test('a field explicitly set to null still counts as present', () => {
  const out = stripBodyFields(buf({ context_management: null, model: 'm' }), ['context_management']);
  assert.deepEqual(parse(out), { model: 'm' });
});

test('the account carries stripRequestFields through from config', () => {
  const am = new AccountManager([
    { name: 'zen', type: 'apikey', apiKey: 'k', upstream: 'https://zen.example', stripRequestFields: ['context_management'] },
    { name: 'anthropic', type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  assert.deepEqual(am.accounts[0].stripRequestFields, ['context_management']);
  // Anthropic accounts must stay untouched — the strip is opt-in per account.
  assert.equal(am.accounts[1].stripRequestFields, null);
});
