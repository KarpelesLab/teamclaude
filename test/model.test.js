import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFamilyBlock, isFableModel, modelGlobOverlaps, modelLabel, NestedFieldFinder, parseRequestEffort, parseRequestModel, parseRequestStream, TopLevelFieldFinder } from '../src/model.js';

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

// The reasoning effort sits one level under the root: `output_config.effort` on
// an Anthropic Messages body, `reasoning.effort` on a Codex Responses body. The
// same key turns up in conversation text and tool schemas, and those must
// never be read as the request's own setting.

test('parseRequestEffort reads output_config.effort on an Anthropic body', () => {
  const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [], output_config: { effort: 'xhigh' } });
  assert.equal(parseRequestEffort(body), 'xhigh');
  assert.equal(parseRequestEffort(Buffer.from(body), 'anthropic'), 'xhigh');
});

test('parseRequestEffort reads reasoning.effort on a Codex body, and only there', () => {
  const codex = JSON.stringify({ model: 'gpt-6', input: [], reasoning: { summary: 'auto', effort: 'max' } });
  assert.equal(parseRequestEffort(codex, 'codex'), 'max');
  // Each provider reads its own parent, so the other's spelling is absent.
  assert.equal(parseRequestEffort(codex, 'anthropic'), null);
  assert.equal(parseRequestEffort(JSON.stringify({ output_config: { effort: 'low' } }), 'codex'), null);
  // `reasoning` with no effort (the Responses Lite lane) is a request that set none.
  assert.equal(parseRequestEffort(JSON.stringify({ reasoning: { summary: 'auto' } }), 'codex'), null);
  // An unknown provider has no known place for it.
  assert.equal(parseRequestEffort(JSON.stringify({ output_config: { effort: 'low' } }), 'nope'), null);
});

test('parseRequestEffort is null when the body sets no effort', () => {
  assert.equal(parseRequestEffort(JSON.stringify({ model: 'm', messages: [] })), null);
  assert.equal(parseRequestEffort(JSON.stringify({ model: 'm', output_config: {} })), null);
  assert.equal(parseRequestEffort(JSON.stringify({ model: 'm', output_config: { effort: '' } })), null);
  assert.equal(parseRequestEffort(''), null);
  assert.equal(parseRequestEffort(null), null);
});

test('parseRequestEffort ignores an effort key nested in messages and tools', () => {
  const body = JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: '{"output_config":{"effort":"low"}}' }] },
      { role: 'user', content: [{ type: 'tool_result', content: { output_config: { effort: 'low' } } }] }],
    tools: [{ name: 't', input_schema: { properties: { output_config: { effort: 'medium' } } } }],
    metadata: { output_config: { effort: 'high' } },
    effort: 'top-level',
  });
  assert.equal(parseRequestEffort(body), null);
  // And with the real field after all the decoys, it is the one read.
  const real = JSON.stringify({ ...JSON.parse(body), output_config: { effort: 'xhigh' } });
  assert.equal(parseRequestEffort(real), 'xhigh');
});

test('parseRequestEffort does not depend on key order', () => {
  assert.equal(parseRequestEffort('{"output_config":{"effort":"low","format":{"type":"json"}},"model":"m"}'), 'low');
  assert.equal(parseRequestEffort('{"model":"m","output_config":{"format":{"type":"json","effort":"no"},"effort":"high"}}'), 'high');
  assert.equal(parseRequestEffort('{ "output_config" : { "task_budget" : 9 , "effort" : "medium" } }'), 'medium');
});

test('parseRequestEffort reads a non-string effort as absent', () => {
  assert.equal(parseRequestEffort('{"output_config":{"effort":5}}'), null);
  assert.equal(parseRequestEffort('{"output_config":{"effort":null}}'), null);
  assert.equal(parseRequestEffort('{"output_config":{"effort":{"level":"high"}}}'), null);
  assert.equal(parseRequestEffort('{"output_config":{"effort":["high"]}}'), null);
  // A parent that is not an object holds no child field.
  assert.equal(parseRequestEffort('{"output_config":"effort"}'), null);
  assert.equal(parseRequestEffort('{"output_config":[{"effort":"high"}]}'), null);
});

test('parseRequestEffort keeps a client-supplied value as sent, with no list of known levels', () => {
  assert.equal(parseRequestEffort('{"output_config":{"effort":"ludicrous"}}'), 'ludicrous');
});

test('NestedFieldFinder resolves across chunk boundaries, mid-key and mid-value', () => {
  const body = Buffer.from('{"model":"m","output_config":{"effort":"xhigh"}}');
  for (let cut = 1; cut < body.length; cut++) {
    const finder = new NestedFieldFinder('output_config', 'effort');
    finder.push(body.subarray(0, cut));
    assert.equal(finder.push(body.subarray(cut)), 'xhigh', `split at byte ${cut}`);
  }
  // A byte at a time, through an escaped quote inside a decoy string.
  const finder = new NestedFieldFinder('reasoning', 'effort');
  for (const b of Buffer.from('{"input":"say \\"reasoning\\": {","reasoning":{"effort":"low"}}')) finder.push(Buffer.from([b]));
  assert.equal(finder.value, 'low');
});

test('NestedFieldFinder stops once the parent object closes without the field', () => {
  const finder = new NestedFieldFinder('output_config', 'effort');
  finder.push(Buffer.from('{"output_config":{"format":{}}'));
  assert.equal(finder.done, true);
  assert.equal(finder.value, null);
});

test('modelLabel joins model and effort, and never shows an effort on its own', () => {
  assert.equal(modelLabel('claude-opus-5-5', 'xhigh'), 'claude-opus-5-5·xhigh');
  assert.equal(modelLabel('claude-opus-5-5', null), 'claude-opus-5-5');
  assert.equal(modelLabel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(modelLabel(null, 'xhigh'), '');
});
