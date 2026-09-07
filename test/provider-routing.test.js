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

// ── Codex quota drives rotation the same way Anthropic's does ────────────────

const codexHeaders = (usedPercent, resetAt = 1900000000) => ({
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': String(usedPercent),
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': String(resetAt),
});

test('Codex headers land in the same quota fields the threshold reads', () => {
  const am = new AccountManager([codex('codex-1')], 0.98);
  am.updateQuota(0, codexHeaders(42));
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.42);
  assert.equal(q.unified7dReset, 1900000000 * 1000);
  assert.equal(q.planType, 'pro');
});

// The point of reading quota at all: rotate BEFORE upstream refuses, not after.
test('a Codex account over the switch threshold hands over to a fresh one', () => {
  const am = new AccountManager([codex('codex-1'), codex('codex-2')], 0.98);
  const first = am.getActiveAccount(null, null, null, null, 'codex');
  assert.equal(first.name, 'codex-1');

  am.updateQuota(first.index, codexHeaders(99));   // past the 98% threshold
  am.updateQuota(1, codexHeaders(10));             // plenty left

  const next = am.getActiveAccount(null, null, null, null, 'codex');
  assert.equal(next.name, 'codex-2', 'a nearly-spent Codex account must hand over');
});

test('learning a weekly quota ends probing, as it does for Anthropic', () => {
  const am = new AccountManager([codex('codex-1')], 0.98);
  assert.equal(am.accounts[0].probing, true);
  am.updateQuota(0, codexHeaders(5));
  assert.equal(am.accounts[0].probing, false);
  assert.equal(am.accounts[0].requalify, true);
});

// A catalog fetch carries no quota headers; that must not read as 0% used.
test('a response with no quota headers leaves a known reading intact', () => {
  const am = new AccountManager([codex('codex-1')], 0.98);
  am.updateQuota(0, codexHeaders(77));
  am.updateQuota(0, { 'content-type': 'application/json' });
  assert.equal(am.accounts[0].quota.unified7d, 0.77);
});
