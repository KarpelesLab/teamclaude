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
