import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from '../src/providers/anthropic.js';
import { providerById, providerForHost, providerForUpstream, DEFAULT_PROVIDER_ID } from '../src/providers/index.js';

test('anthropic provider exposes the expected constants', () => {
  assert.equal(anthropic.id, 'anthropic');
  assert.equal(anthropic.upstreamBase, 'https://api.anthropic.com');
  assert.ok(anthropic.hosts.includes('api.anthropic.com'));
  assert.equal(anthropic.oauth.tokenUrl, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(anthropic.oauth.clientId, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.match(anthropic.oauth.authorizeUrl, /claude\.ai\/oauth\/authorize$/);
  assert.match(anthropic.oauth.profileUrl, /\/api\/oauth\/profile$/);
  assert.match(anthropic.oauth.usageUrl, /\/api\/oauth\/usage$/);
});

test('matchHost only matches this provider\'s hosts', () => {
  assert.equal(anthropic.matchHost('api.anthropic.com'), true);
  assert.equal(anthropic.matchHost('chatgpt.com'), false);
  assert.equal(anthropic.matchHost(''), false);
});

test('providerById falls back to the default for unknown ids', () => {
  assert.equal(providerById('anthropic'), anthropic);
  assert.equal(providerById('nope').id, DEFAULT_PROVIDER_ID);
  assert.equal(providerById(undefined).id, DEFAULT_PROVIDER_ID);
});

test('providerForHost / providerForUpstream resolve by host', () => {
  assert.equal(providerForHost('api.anthropic.com'), anthropic);
  assert.equal(providerForHost('unknown.example'), null);
  assert.equal(providerForHost(null), null);
  assert.equal(providerForUpstream('https://api.anthropic.com'), anthropic);
  assert.equal(providerForUpstream('not a url'), null);
});

test('injectAuth uses Bearer for oauth and x-api-key for api-key accounts', () => {
  const h1 = {};
  anthropic.injectAuth(h1, { type: 'oauth', credential: 'tok' });
  assert.equal(h1['authorization'], 'Bearer tok');
  assert.equal(h1['x-api-key'], undefined);

  const h2 = {};
  anthropic.injectAuth(h2, { type: 'apikey', credential: 'sk-123' });
  assert.equal(h2['x-api-key'], 'sk-123');
  assert.equal(h2['authorization'], undefined);
});

test('rewriteBody returns the same buffer instance when nothing applies', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x', hi: 1 }));
  assert.equal(anthropic.rewriteBody(body, { type: 'oauth' }), body);
});

test('rewriteBody remaps the model when the account has a modelMap', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x' }));
  const out = anthropic.rewriteBody(body, { modelMap: { 'claude-x': 'glm-4' } });
  assert.notEqual(out, body);
  assert.equal(JSON.parse(out).model, 'glm-4');
});

test('rateLimitHeaders keeps only anthropic-ratelimit-* headers', () => {
  const headers = new Map([
    ['anthropic-ratelimit-unified-5h-status', 'allowed'],
    ['content-type', 'application/json'],
    ['anthropic-ratelimit-unified-7d-status', 'rejected'],
  ]);
  const out = anthropic.rateLimitHeaders(headers);
  assert.deepEqual(out, {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
  });
});

test('classify429 distinguishes general vs model-scoped exhaustion', () => {
  assert.deepEqual(
    anthropic.classify429({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }),
    { quotaExhausted: true, modelScoped: false });
  assert.deepEqual(
    anthropic.classify429({ 'anthropic-ratelimit-unified-7d_oi-status': 'rejected' }),
    { quotaExhausted: true, modelScoped: true });
  assert.deepEqual(
    anthropic.classify429({ 'anthropic-ratelimit-unified-5h-status': 'allowed' }),
    { quotaExhausted: false, modelScoped: false });
});

test('parseUsageEvent / parseUsageBody extract token deltas', () => {
  assert.deepEqual(anthropic.parseUsageEvent({ type: 'message_start', message: { usage: { input_tokens: 10 } } }), { input: 10, output: 0 });
  assert.deepEqual(anthropic.parseUsageEvent({ type: 'message_delta', usage: { output_tokens: 5 } }), { input: 0, output: 5 });
  assert.equal(anthropic.parseUsageEvent({ type: 'ping' }), null);
  assert.deepEqual(anthropic.parseUsageBody({ usage: { input_tokens: 3, output_tokens: 7 } }), { input: 3, output: 7 });
  assert.equal(anthropic.parseUsageBody({ ok: true }), null);
});
