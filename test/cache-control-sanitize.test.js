import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCacheControl, cacheControlSubfieldsToStrip } from '../src/cache-control-sanitize.js';

// Claude Code sends `scope` (and on some models `ttl: "1h"`) inside
// `cache_control` breakpoints that Anthropic accepts but some strict
// third-party validators reject with a non-retryable 400 — observed as
// `unknown parameter system.cache_control.scope` — which breaks EVERY request
// once such an account is selected. The strip is opt-in per subfield
// (`stripRequestFields: ["cache_control.scope"]`), walks only the documented
// breakpoint positions, and keeps `type`/`ttl` unless they are listed.

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const SCOPE = new Set(['scope']);
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, drop = SCOPE, url = MESSAGES, ct = JSON_CT) => sanitizeCacheControl(buf(obj), url, ct, drop);

// A Claude Code-style system array: cached prefix block carrying the new scope.
const scopedSystem = () => ([
  { type: 'text', text: 'env', cache_control: { type: 'ephemeral', scope: 'session' } },
  { type: 'text', text: 'project' },
]);

test('stripRequestFields entries of the form cache_control.<sub> select the subfields', () => {
  assert.deepEqual([...cacheControlSubfieldsToStrip(['context_management', 'cache_control.scope', 'cache_control.ttl'])], ['scope', 'ttl']);
  assert.equal(cacheControlSubfieldsToStrip(['cache_control.']).size, 0);
  assert.equal(cacheControlSubfieldsToStrip(undefined).size, 0);
  assert.equal(cacheControlSubfieldsToStrip([42, null]).size, 0);
});

test('the reported case: scope is stripped from system blocks, type survives', () => {
  const out = parse(run({ model: 'm', system: scopedSystem(), messages: [] }));
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.system[1], { type: 'text', text: 'project' });
});

test('scope is stripped from message content blocks and tool_result content blocks', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', scope: 'x' } },
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'r', cache_control: { type: 'ephemeral', scope: 'x' } }] },
    ] }],
  };
  const out = parse(run(body));
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.messages[0].content[1].content[0].cache_control, { type: 'ephemeral' });
});

test('ttl is documented and kept unless it is listed', () => {
  const body = { model: 'm', system: [{ type: 'text', text: 'e', cache_control: { type: 'ephemeral', ttl: '1h', scope: 's' } }], messages: [] };
  assert.deepEqual(parse(run(body)).system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(parse(run(body, new Set(['scope', 'ttl']))).system[0].cache_control, { type: 'ephemeral' });
});

test('a cache_control left empty is dropped, not sent as {}', () => {
  const out = parse(run({ model: 'm', system: [{ type: 'text', text: 'e', cache_control: { scope: 's' } }], messages: [] }));
  assert.equal('cache_control' in out.system[0], false);
});

test('tool definitions and the root are covered as well', () => {
  const body = { model: 'm', messages: [], cache_control: { type: 'ephemeral', scope: 'r' }, tools: [{ name: 't', cache_control: { type: 'ephemeral', scope: 's' } }] };
  const out = parse(run(body));
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.cache_control, { type: 'ephemeral' });
});

// A `cache_control` key that is DATA — inside a tool call the model already
// emitted, a tool_result payload, or metadata — is not a breakpoint and must
// not be touched: rewriting it would change the tool call.
test('a cache_control inside tool_use.input, a tool_result payload, or metadata is left byte-identical', () => {
  const body = buf({
    model: 'm',
    metadata: { user_id: 'u', cache_control: { scope: 'data' } },
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write', input: { path: 'x', cache_control: { scope: 'data', type: 'x' } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ cache_control: { scope: 'data' } }) }] },
    ],
  });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, SCOPE), body);
});

test('with no subfields configured, nothing is touched even when scope is present', () => {
  const body = buf({ model: 'm', system: scopedSystem(), messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, new Set()), body);
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, undefined), body);
});

// The caller refreshes Content-Length only when the buffer actually changes, so
// "nothing to strip" has to return the very same buffer, not an equal one.
test('a body without cache_control is returned untouched', () => {
  const body = buf({ model: 'm', messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, SCOPE), body);
});

test('a body whose cache_control is already clean is returned untouched', () => {
  const body = buf({ model: 'm', system: [{ type: 'text', text: 'e', cache_control: { type: 'ephemeral' } }], messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, SCOPE), body);
});

test('non-messages endpoints pass through unchanged', () => {
  const body = buf({ cache_control: { type: 'ephemeral', scope: 's' } });
  assert.equal(sanitizeCacheControl(body, '/v1/oauth/token', JSON_CT, SCOPE), body);
});

test('the count_tokens endpoint is covered — strict backends validate it too', () => {
  const out = parse(run({ model: 'm', system: scopedSystem(), messages: [] }, SCOPE, '/v1/messages/count_tokens'));
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
});

test('a non-JSON body passes through unchanged', () => {
  const body = Buffer.from('not json at all', 'utf8');
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, SCOPE), body);
});

test('a string system block passes through unchanged', () => {
  const body = buf({ model: 'm', system: 'plain', messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT, SCOPE), body);
});
