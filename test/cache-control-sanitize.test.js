import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCacheControl } from '../src/cache-control-sanitize.js';

// Claude Code recently started sending a `scope` subfield inside `cache_control`
// (on system blocks, and potentially message/tool blocks) that Anthropic's own
// API accepts but strict third-party validators reject — observed as
// 400 unknown parameter `system.cache_control.scope`, which breaks EVERY
// request once such an account is selected. sanitizeCacheControl keeps only the
// documented subfields (`type`, `ttl`) so the forwarded body validates.

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));
const run = (obj, url = MESSAGES, ct = JSON_CT) => sanitizeCacheControl(buf(obj), url, ct);

// A Claude Code-style system array: cached prefix block carrying the new scope.
const scopedSystem = () => ([
  { type: 'text', text: 'env', cache_control: { type: 'ephemeral', scope: 'session' } },
  { type: 'text', text: 'project' },
]);

test('the reported case: scope is stripped from system blocks, type survives', () => {
  const out = parse(run({ model: 'm', system: scopedSystem(), messages: [] }));
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(out.system[1], { type: 'text', text: 'project' });
});

test('scope is stripped from message content blocks too', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', scope: 'x' } }] }],
  };
  const out = parse(run(body));
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('a documented ttl survives alongside type', () => {
  const out = parse(run({ model: 'm', system: [{ type: 'text', text: 'e', cache_control: { type: 'ephemeral', ttl: '1h', scope: 's' } }], messages: [] }));
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('a cache_control left with nothing documented is dropped, not emptied', () => {
  const out = parse(run({ model: 'm', system: [{ type: 'text', text: 'e', cache_control: { scope: 's' } }], messages: [] }));
  assert.equal('cache_control' in out.system[0], false);
});

test('tool definitions are covered as well', () => {
  const body = { model: 'm', messages: [], tools: [{ name: 't', cache_control: { type: 'ephemeral', scope: 's' } }] };
  assert.deepEqual(parse(run(body)).tools[0].cache_control, { type: 'ephemeral' });
});

// The caller refreshes Content-Length only when the buffer actually changes, so
// "nothing to strip" has to return the very same buffer, not an equal one.
test('a body without cache_control is returned untouched', () => {
  const body = buf({ model: 'm', messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT), body);
});

test('a body whose cache_control is already clean is returned untouched', () => {
  const body = buf({ model: 'm', system: [{ type: 'text', text: 'e', cache_control: { type: 'ephemeral', ttl: '5m' } }], messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT), body);
});

test('non-messages endpoints pass through unchanged', () => {
  const body = buf({ cache_control: { type: 'ephemeral', scope: 's' } });
  assert.equal(sanitizeCacheControl(body, '/v1/oauth/token', JSON_CT), body);
});

test('the count_tokens endpoint is covered — strict backends validate it too', () => {
  const out = parse(run({ model: 'm', system: scopedSystem(), messages: [] }, '/v1/messages/count_tokens'));
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
});

test('a non-JSON body passes through unchanged', () => {
  const body = Buffer.from('not json at all', 'utf8');
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT), body);
});

test('a string system block passes through unchanged', () => {
  const body = buf({ model: 'm', system: 'plain', messages: [] });
  assert.equal(sanitizeCacheControl(body, MESSAGES, JSON_CT), body);
});
