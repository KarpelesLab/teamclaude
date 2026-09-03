import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, ...extra,
});
const codex = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });

// A provider partition is absolute: an Anthropic account cannot serve an
// OpenAI Responses request at all, so selection must never cross it.
test('a Codex request never selects an Anthropic account', () => {
  const am = new AccountManager([oauth('claude-1'), oauth('claude-2'), codex('codex-1')], 0.98);
  const picked = am.getActiveAccount(null, null, null, null, 'codex');
  assert.equal(picked.name, 'codex-1');
});

test('an Anthropic request never selects a Codex account', () => {
  const am = new AccountManager([codex('codex-1'), oauth('claude-1')], 0.98);
  const picked = am.getActiveAccount(null, null, null, null, 'anthropic');
  assert.equal(picked.name, 'claude-1');
});

// Callers that predate providers pass four arguments; they must keep getting
// Anthropic selection.
test('selection defaults to Anthropic when no provider is given', () => {
  const am = new AccountManager([codex('codex-1'), oauth('claude-1')], 0.98);
  assert.equal(am.getActiveAccount().name, 'claude-1');
  assert.equal(am.getActiveAccount(null, null, null, null).name, 'claude-1');
});

test('a request for a provider with no accounts selects nothing rather than crossing over', () => {
  const am = new AccountManager([oauth('claude-1')], 0.98);
  assert.equal(am.getActiveAccount(null, null, null, null, 'codex'), null);
});

// The caller's own exclude set (accounts already tried this request) must still
// be honoured alongside the provider filter.
test('the per-request exclude set is preserved', () => {
  const am = new AccountManager([codex('codex-1'), codex('codex-2'), oauth('claude-1')], 0.98);
  const first = am.getActiveAccount(null, null, null, null, 'codex');
  const second = am.getActiveAccount(new Set([first.index]), null, null, null, 'codex');
  assert.ok(second, 'a second Codex account should be reachable');
  assert.notEqual(second.name, first.name);
  assert.equal(second.provider, 'codex');
});

// A single-provider config is the overwhelmingly common case and must not pay
// for the partition.
test('a config with one provider behaves exactly as before', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getActiveAccount(null, null, null, null, 'anthropic').name, 'a');
});
