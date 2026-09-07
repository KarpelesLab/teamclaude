import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { rewriteRequestBody } from '../src/server.js';

// Wiring pin for the `system.cache_control.scope` 400: Claude Code sends a
// `scope` subfield inside cache_control that Anthropic accepts but strict
// third-party upstreams (here: a Muse backend) reject with
// 400 unknown parameter `system.cache_control.scope`. rewriteRequestBody must
// strip it on the custom-upstream leg while leaving Anthropic-bound bodies
// byte-identical.

const MESSAGES = '/v1/messages';
const JSON_CT = 'application/json';
const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));

// What Claude Code sends with a new model: system array whose first block
// carries the scoped cache breakpoint, plus a user turn.
const scopedBody = () => buf({
  model: 'claude-opus-5',
  system: [
    { type: 'text', text: 'env', cache_control: { type: 'ephemeral', scope: 'session' } },
    { type: 'text', text: 'project' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
});

function fleet() {
  return new AccountManager([
    { name: 'muse', type: 'apikey', apiKey: 'k1', upstream: 'https://muse.example', modelMap: { 'claude-opus-5': 'muse-opus-5' }, priority: 100 },
    { name: 'claude', type: 'apikey', apiKey: 'k2' },
  ], 0.98).accounts;
}

test('third-party (muse) leg: scope stripped, model map still applied', () => {
  const [muse] = fleet();
  const out = parse(rewriteRequestBody(scopedBody(), muse, MESSAGES, JSON_CT));
  assert.equal(out.model, 'muse-opus-5', 'the model map must still apply');
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' },
    'scope must be stripped before the strict upstream sees it');
  assert.deepEqual(out.system[1], { type: 'text', text: 'project' });
});

test('Anthropic leg: body passes through as the identical buffer', () => {
  const [, claude] = fleet();
  const body = scopedBody();
  assert.equal(rewriteRequestBody(body, claude, MESSAGES, JSON_CT), body,
    'first-party bodies must keep their exact bytes (scope included)');
});

test('third-party leg with a clean body: identical buffer, no re-serialization', () => {
  const [muse] = fleet();
  // Model not in the map and nothing to strip → the caller keeps Content-Length.
  const plain = buf({ model: 'other-model', messages: [] });
  assert.equal(rewriteRequestBody(plain, muse, MESSAGES, JSON_CT), plain);
});
