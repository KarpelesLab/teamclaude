import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { rewriteModel } from '../src/server.js';

// Covers the third-party-backend feature (#74): per-account `upstream`/`modelMap`/
// `models`, model-ownership routing in AccountManager, and the request-body model
// rewrite in server.js.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// A DeepSeek-style third-party account: alternate upstream, a modelMap, and a
// `models` list it exclusively owns. Higher priority value = fallback only.
function deepseek(extra = {}) {
  return oauth('deepseek', {
    upstream: 'https://api.deepseek.com/anthropic',
    priority: 100,
    modelMap: { 'claude-haiku-4-5-20251001': 'deepseek-v4-flash', 'claude-sonnet-4-6': 'deepseek-v4-pro[1m]' },
    models: ['deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-v4-flash'],
    ...extra,
  });
}

// ── config → account object ──────────────────────────────────────────────────

test('constructor carries upstream/modelMap/models onto the account (and defaults to null)', () => {
  const am = new AccountManager([deepseek(), oauth('claude')], 0.98);
  const [ds, cl] = am.accounts;
  assert.equal(ds.upstream, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(ds.models, ['deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.equal(ds.modelMap['claude-sonnet-4-6'], 'deepseek-v4-pro[1m]');
  // A plain Claude account gets nulls, so the ownership/rewrite paths stay inert.
  assert.equal(cl.upstream, null);
  assert.equal(cl.modelMap, null);
  assert.equal(cl.models, null);
});

// ── model-ownership routing ──────────────────────────────────────────────────

test('ownership is inert when no account declares a models list', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  // No models declared anywhere → every account serves every model.
  assert.equal(am._isAvailable(am.accounts[0], 'claude-sonnet-4-6'), true);
  assert.equal(am._selectNext(null, 'anything-goes').name, 'a');
});

test('a request for an owned model routes only to accounts that own it', () => {
  const am = new AccountManager([oauth('claude'), deepseek()], 0.98);
  const [cl, ds] = am.accounts;
  // deepseek owns 'deepseek-v4-pro[1m]'; the Claude account (no models) is excluded.
  assert.equal(am._isAvailable(cl, 'deepseek-v4-pro[1m]'), false);
  assert.equal(am._isAvailable(ds, 'deepseek-v4-pro[1m]'), true);
  assert.equal(am._selectNext(null, 'deepseek-v4-pro[1m]').name, 'deepseek');
});

test('the [Nm] suffix is stripped when matching, so a bare model name still routes to its owner', () => {
  const am = new AccountManager([oauth('claude'), deepseek()], 0.98);
  // Declared as 'deepseek-v4-pro[1m]', requested bare — still owned by deepseek.
  assert.equal(am._isAvailable(am.accounts[0], 'deepseek-v4-pro'), false);
  assert.equal(am._selectNext(null, 'deepseek-v4-pro').name, 'deepseek');
});

test('a Claude model is not owned by the third-party account → Claude accounts stay eligible', () => {
  const am = new AccountManager([oauth('claude'), deepseek()], 0.98);
  // deepseek's models are all deepseek-*, so a Claude model claims no owner and
  // any account may serve it — priority then makes deepseek a fallback only.
  assert.equal(am._isAvailable(am.accounts[0], 'claude-sonnet-4-6'), true);
  assert.equal(am._selectNext(null, 'claude-sonnet-4-6').name, 'claude');
});

test('third-party account is used as a fallback once Claude accounts are exhausted', () => {
  const am = new AccountManager([oauth('claude', { priority: 0 }), deepseek()], 0.98);
  // While Claude (priority 0) is healthy it wins a Claude-model request.
  assert.equal(am._selectNext(null, 'claude-sonnet-4-6').name, 'claude');
  // Exhaust it → the higher-priority-value third-party account takes over.
  am.accounts[0].status = 'exhausted';
  assert.equal(am._selectNext(null, 'claude-sonnet-4-6').name, 'deepseek');
});

test('a request for an owned model with its only owner unavailable selects nothing', () => {
  const am = new AccountManager([oauth('claude'), deepseek({ disabled: true })], 0.98);
  // Claude is ownership-excluded and the sole owner is disabled → no eligible account.
  assert.equal(am._selectNext(null, 'deepseek-v4-pro[1m]'), null);
});

test('two accounts can co-own the same model — both stay eligible', () => {
  const am = new AccountManager([
    oauth('ds-a', { models: ['deepseek-v4-pro'], priority: 1 }),
    oauth('ds-b', { models: ['deepseek-v4-pro'], priority: 2 }),
    oauth('claude'),
  ], 0.98);
  assert.equal(am._isAvailable(am.accounts[0], 'deepseek-v4-pro'), true);
  assert.equal(am._isAvailable(am.accounts[1], 'deepseek-v4-pro'), true);
  assert.equal(am._isAvailable(am.accounts[2], 'deepseek-v4-pro'), false); // no models → excluded
  assert.equal(am._selectNext(null, 'deepseek-v4-pro').name, 'ds-a'); // lower priority value wins
});

// ── request-body model rewrite (server.rewriteModel) ─────────────────────────

const modelMap = { 'claude-sonnet-4-6': 'deepseek-v4-pro[1m]' };

test('rewriteModel maps a known model and returns re-serialized JSON', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 10 }));
  const out = rewriteModel(body, modelMap);
  const parsed = JSON.parse(out.toString('utf8'));
  assert.equal(parsed.model, 'deepseek-v4-pro[1m]');
  assert.equal(parsed.max_tokens, 10); // other fields preserved
});

test('rewriteModel updates the byte length so Content-Length can be corrected', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6' }));
  const out = rewriteModel(body, modelMap);
  // The mapped name is a different length, so the buffer size changes — this is
  // exactly why forwardRequest resets content-length from out.length.
  assert.notEqual(out.length, body.length);
  assert.equal(out.length, Buffer.byteLength(out.toString('utf8'), 'utf8'));
});

test('rewriteModel leaves the body untouched when the model is not in the map', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8' }));
  const out = rewriteModel(body, modelMap);
  assert.equal(out, body); // same reference — passed through unchanged
});

test('rewriteModel passes non-JSON bodies through unchanged', () => {
  const body = Buffer.from('not json at all');
  const out = rewriteModel(body, modelMap);
  assert.equal(out, body);
});

test('rewriteModel passes through a JSON body that has no model field', () => {
  const body = Buffer.from(JSON.stringify({ messages: [] }));
  const out = rewriteModel(body, modelMap);
  assert.equal(out, body);
});
