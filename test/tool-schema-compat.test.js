import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUnparseablePatterns } from '../src/server.js';

// DeepSeek's schema validator parses `pattern` values as regexes and rejects the
// escapes its engine lacks. Claude Code's NUL guard `^[^\0]*$` (JSON: "^[^\\0]*$")
// is one of them — it 400s the WHOLE request for every tool-bearing turn:
//   Invalid schema for function 'Artifact': "^[^\\0]*$" is not a "regex"
// Diagnosed live 2026-09-18 (bene-6 successor turn).
const NUL_GUARD = '^[^\\0]*$';
const run = (body) => stripUnparseablePatterns(Buffer.from(JSON.stringify(body)));
const read = (body) => JSON.parse(run(body).toString());

const artifactTool = () => ({
  name: 'Artifact',
  description: 'publish',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: 1024, pattern: NUL_GUARD },
      favicon: { type: 'string', minLength: 1, maxLength: 32 },
    },
    required: ['file_path'],
  },
});

test('drops only the unparseable pattern, preserving every other keyword', () => {
  const out = read({ model: 'claude-fable-5-1', tools: [artifactTool()] });
  const title = out.tools[0].input_schema.properties.title;
  assert.equal('pattern' in title, false, 'NUL-guard pattern must be dropped');
  assert.equal(title.type, 'string');
  assert.equal(title.minLength, 1);
  assert.equal(title.maxLength, 1024);
  // untouched siblings
  assert.equal(out.tools[0].input_schema.properties.favicon.maxLength, 32);
  assert.deepEqual(out.tools[0].input_schema.required, ['file_path']);
  assert.equal(out.tools[0].name, 'Artifact');
  assert.equal(out.model, 'claude-fable-5-1');
});

test('keeps patterns the upstream CAN parse', () => {
  const body = {
    tools: [
      { name: 'T', input_schema: { type: 'object', properties: { a: { type: 'string', pattern: '^[a-z]+$' } } } },
    ],
  };
  const out = read(body);
  assert.equal(out.tools[0].input_schema.properties.a.pattern, '^[a-z]+$');
});

test('walks nested schemas (properties / items / anyOf / $defs)', () => {
  const body = {
    tools: [
      {
        name: 'T',
        input_schema: {
          type: 'object',
          properties: { deep: { type: 'array', items: { type: 'object', properties: { x: { type: 'string', pattern: NUL_GUARD } } } } },
          anyOf: [{ properties: { y: { type: 'string', pattern: NUL_GUARD } } }],
          $defs: { Z: { type: 'string', pattern: NUL_GUARD } },
        },
      },
    ],
  };
  const s = read(body).tools[0].input_schema;
  assert.equal('pattern' in s.properties.deep.items.properties.x, false);
  assert.equal('pattern' in s.anyOf[0].properties.y, false);
  assert.equal('pattern' in s.$defs.Z, false);
});

test('no tools / no unparseable pattern -> the ORIGINAL buffer is returned', () => {
  const plain = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
  assert.equal(stripUnparseablePatterns(plain), plain, 'identity when nothing changes');

  const ok = Buffer.from(JSON.stringify({ tools: [{ name: 'T', input_schema: { type: 'object' } }] }));
  assert.equal(stripUnparseablePatterns(ok), ok);
});

test('non-JSON bodies pass through untouched', () => {
  const raw = Buffer.from('not json at all');
  assert.equal(stripUnparseablePatterns(raw), raw);
  const empty = Buffer.from('');
  assert.equal(stripUnparseablePatterns(empty), empty);
});

test('the real Artifact failure shape now egresses clean', () => {
  // Exactly what Claude Code sends: the NUL guard is the ONLY thing DeepSeek chokes on.
  const out = read({ model: 'claude-fable-5-1', tools: [artifactTool()] });
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('\\0'), false, 'no \\0 escape survives to egress');
});
