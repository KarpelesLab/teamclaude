import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamFormatter } from '../src/json-format-stream.js';

// Format a value by feeding it as one chunk.
function fmt(value) {
  const f = new JsonStreamFormatter();
  return f.push(Buffer.from(JSON.stringify(value)));
}

test('streaming format matches JSON.stringify(value, null, 2)', () => {
  const cases = [
    { a: 1, b: 'two', c: [1, 2, 3], d: { e: true, f: null } },
    [],
    {},
    { empty: {}, arr: [], nested: { x: [{ y: 1 }] } },
    { 'with spaces': 'and : colons, commas {}[] inside', n: -3.14e10 },
    'a bare string',
    42,
    [{ a: 1 }, { b: 2 }],
  ];
  for (const v of cases) {
    assert.equal(fmt(v), JSON.stringify(v, null, 2), `mismatch for ${JSON.stringify(v)}`);
  }
});

test('result is identical regardless of how the input is chunked', () => {
  const value = { metadata: { user_id: 'x', items: [1, 2, { deep: 'value, with comma' }] }, list: [true, false, null] };
  const full = JSON.stringify(value);
  const expected = JSON.stringify(value, null, 2);

  // Feed byte-by-byte — the hardest chunking (splits strings, escapes, tokens).
  const f = new JsonStreamFormatter();
  let out = '';
  for (const byte of Buffer.from(full)) out += f.push(Buffer.from([byte]));
  assert.equal(out, expected);
});

test('strings with braces/quotes/escapes are copied verbatim', () => {
  const value = { s: 'he said "{ , : }" and \\ backslash', t: 'tab\tnewline\n' };
  assert.equal(fmt(value), JSON.stringify(value, null, 2));
});

test('pre-existing whitespace in the input is normalized away', () => {
  const messy = '{  "a" :\n\t1 ,   "b":[ 2,3 ]  }';
  const f = new JsonStreamFormatter();
  assert.equal(f.push(Buffer.from(messy)), JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
});
