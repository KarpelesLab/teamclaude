import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerOf, providerForPath, applyAuthHeaders, upstreamFor, rewritesBody,
  isKnownProvider, DEFAULT_PROVIDER,
} from '../src/provider.js';

// An account written before providers existed carries no `provider` field. It
// must keep behaving as Anthropic, or every existing config breaks on upgrade.
test('an account with no provider is Anthropic', () => {
  assert.equal(providerOf({ name: 'legacy', type: 'oauth' }), 'anthropic');
  assert.equal(providerOf({}), 'anthropic');
  assert.equal(providerOf(undefined), 'anthropic');
  assert.equal(DEFAULT_PROVIDER, 'anthropic');
});

test('an unknown provider falls back rather than routing nowhere', () => {
  assert.equal(providerOf({ provider: 'not-a-provider' }), 'anthropic');
  assert.equal(isKnownProvider('codex'), true);
  assert.equal(isKnownProvider('nope'), false);
});

// One port serves both CLIs; the request path is what says which pool of
// accounts is eligible.
test('the request path selects the provider', () => {
  assert.equal(providerForPath('/v1/messages'), 'anthropic');
  assert.equal(providerForPath('/v1/messages/count_tokens'), 'anthropic');
  assert.equal(providerForPath('/backend-api/codex/responses'), 'codex');
  assert.equal(providerForPath('/backend-api/codex/models'), 'codex');
  // Codex appends a client_version query on its catalog fetch.
  assert.equal(providerForPath('/backend-api/codex/models?client_version=0.150.1'), 'codex');
  // The OpenAI *API platform* paths are not Codex's: a ChatGPT token is
  // rejected there, so they must not be routed to a Codex account.
  assert.equal(providerForPath('/v1/responses'), 'anthropic');
  // Anything unrecognised stays Anthropic's, so a config with no Codex
  // accounts routes exactly as it did before.
  assert.equal(providerForPath('/v1/complete'), 'anthropic');
  assert.equal(providerForPath(''), 'anthropic');
  assert.equal(providerForPath(undefined), 'anthropic');
});

test('Anthropic OAuth sends a bearer token, an API key sends x-api-key', () => {
  const oauth = {};
  applyAuthHeaders(oauth, { type: 'oauth', credential: 'tok' });
  assert.deepEqual(oauth, { authorization: 'Bearer tok' });

  const apikey = {};
  applyAuthHeaders(apikey, { type: 'apikey', credential: 'sk-ant' });
  assert.deepEqual(apikey, { 'x-api-key': 'sk-ant' });
});

// ChatGPT-Account-Id is OpenAI's counterpart to the account_uuid the Anthropic
// path patches into the request body — a header, so no body rewrite is needed.
test('Codex sends a bearer token plus the ChatGPT account header', () => {
  const headers = {};
  applyAuthHeaders(headers, { provider: 'codex', type: 'oauth', credential: 'tok', accountId: 'acct-1' });
  assert.deepEqual(headers, { authorization: 'Bearer tok', 'chatgpt-account-id': 'acct-1' });
});

test('Codex without an account id still authenticates', () => {
  const headers = {};
  applyAuthHeaders(headers, { provider: 'codex', type: 'oauth', credential: 'tok' });
  assert.deepEqual(headers, { authorization: 'Bearer tok' });
  assert.ok(!('chatgpt-account-id' in headers));
});

test('an account upstream overrides the provider default', () => {
  assert.equal(upstreamFor({ upstream: 'https://glm.example' }, 'https://api.anthropic.com'), 'https://glm.example');
});

// The configured `upstream` predates providers and means "where Anthropic
// lives", so it must not capture Codex traffic.
test('the configured upstream applies to Anthropic only', () => {
  const configured = 'https://anthropic.internal';
  assert.equal(upstreamFor({ name: 'a' }, configured), configured);
  assert.equal(upstreamFor({ provider: 'codex' }, configured), 'https://chatgpt.com');
});

test('body rewrites are Anthropic-only', () => {
  assert.equal(rewritesBody({ type: 'oauth' }), true);
  assert.equal(rewritesBody({ provider: 'codex' }), false);
});
