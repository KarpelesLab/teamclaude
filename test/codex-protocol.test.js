import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCodexAccount,
  isStreamingRequest,
  codexUrlForPath,
  codexHeaders,
  codexPromptCacheKey,
  CODEX_BASE_URL,
} from '../src/codex/protocol.js';
import { AccountManager } from '../src/account-manager.js';

test('isCodexAccount keys off the protocol field', () => {
  assert.equal(isCodexAccount({ protocol: 'codex' }), true);
  assert.equal(isCodexAccount({ protocol: 'anthropic' }), false);
  assert.equal(isCodexAccount({}), false);
  assert.equal(isCodexAccount(null), false);
});

test('codexUrlForPath maps the messages endpoint onto /responses', () => {
  assert.equal(codexUrlForPath('/v1/messages'), `${CODEX_BASE_URL}/responses`);
  assert.equal(codexUrlForPath('/v1/messages/'), `${CODEX_BASE_URL}/responses`);
  assert.equal(codexUrlForPath('/v1/messages?beta=true'), `${CODEX_BASE_URL}/responses`);
});

test('codexUrlForPath refuses endpoints with no Responses-API equivalent', () => {
  // Forwarding these would send an Anthropic-only request somewhere that
  // answers it wrongly; the caller turns null into a 404.
  assert.equal(codexUrlForPath('/v1/messages/count_tokens'), null);
  assert.equal(codexUrlForPath('/v1/models'), null);
  assert.equal(codexUrlForPath('/'), null);
});

test('codexUrlForPath honours a per-account upstream override', () => {
  assert.equal(codexUrlForPath('/v1/messages', 'http://localhost:9999/codex'), 'http://localhost:9999/codex/responses');
  assert.equal(codexUrlForPath('/v1/messages', 'http://localhost:9999/codex/'), 'http://localhost:9999/codex/responses');
});

test('codexHeaders carries the credential, account id and CLI identity', () => {
  const h = codexHeaders({ credential: 'tok', accountId: 'acct-1' }, { cacheKey: 'ck-1' });
  assert.equal(h['authorization'], 'Bearer tok');
  assert.equal(h['chatgpt-account-id'], 'acct-1');
  // Session_id doubles as the prompt cache scope, so it carries the derived key.
  assert.equal(h['session_id'], 'ck-1');
  assert.equal(h['originator'], 'codex-tui');
  assert.match(h['user-agent'], /^codex-tui\//);
  assert.equal(h['content-type'], 'application/json');
});

test('codexHeaders sets the accept header from the stream flag', () => {
  const acct = { credential: 't', accountId: 'a' };
  assert.equal(codexHeaders(acct, { stream: true })['accept'], 'text/event-stream');
  assert.equal(codexHeaders(acct, { stream: false })['accept'], 'application/json');
});

test('codexHeaders mints a session id only when no cache key was derived', () => {
  const h = codexHeaders({ credential: 't', accountId: 'a' }, {});
  assert.match(h['session_id'], /^[0-9a-f-]{36}$/);
});

test('isStreamingRequest reads the top-level stream flag', () => {
  assert.equal(isStreamingRequest(Buffer.from('{"model":"m","stream":true}')), true);
  assert.equal(isStreamingRequest(Buffer.from('{"model":"m","stream":false}')), false);
  assert.equal(isStreamingRequest(Buffer.from('{"model":"m"}')), false);
});

test('isStreamingRequest is safe on empty and malformed bodies', () => {
  assert.equal(isStreamingRequest(Buffer.alloc(0)), false);
  assert.equal(isStreamingRequest(Buffer.from('{not json')), false);
  assert.equal(isStreamingRequest(null), false);
});

test('isStreamingRequest ignores a nested stream key', () => {
  // A `stream` inside message content must not be mistaken for the request flag.
  assert.equal(isStreamingRequest(Buffer.from('{"messages":[{"stream":true}]}')), false);
});

// ── account manager integration ─────────────────────────────

function codexAcct(name, extra = {}) {
  return {
    name, type: 'oauth', protocol: 'codex', accountId: 'acct-1',
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra,
  };
}

test('a codex account keeps its protocol and account id through makeAccount', () => {
  const am = new AccountManager([codexAcct('cx')], 0.98);
  assert.equal(am.accounts[0].protocol, 'codex');
  assert.equal(am.accounts[0].accountId, 'acct-1');
});

test('an account with no protocol defaults to anthropic', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't' }], 0.98);
  assert.equal(am.accounts[0].protocol, 'anthropic');
  assert.equal(am.accounts[0].accountId, null);
});

test('ensureTokenFresh routes a codex account to the codex refresher', async () => {
  const calls = [];
  const am = new AccountManager([codexAcct('cx', { expiresAt: Date.now() - 1000 })], 0.98, {
    refreshFn: async () => { calls.push('anthropic'); return { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 }; },
    codexRefreshFn: async () => { calls.push('codex'); return { accessToken: 'cx-new', refreshToken: 'cx-r', expiresAt: Date.now() + 3600_000, accountId: 'acct-2' }; },
  });

  await am.ensureTokenFresh(0);
  assert.deepEqual(calls, ['codex']);
  assert.equal(am.accounts[0].credential, 'cx-new');
  // A refresh re-derives the account id, so a migrated account is picked up.
  assert.equal(am.accounts[0].accountId, 'acct-2');
});

test('ensureTokenFresh routes an anthropic account to the anthropic refresher', async () => {
  const calls = [];
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() - 1000 }], 0.98, {
    refreshFn: async () => { calls.push('anthropic'); return { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 }; },
    codexRefreshFn: async () => { calls.push('codex'); return {}; },
  });

  await am.ensureTokenFresh(0);
  assert.deepEqual(calls, ['anthropic']);
});

test('a codex refresh that omits accountId leaves the existing one intact', async () => {
  const am = new AccountManager([codexAcct('cx', { expiresAt: Date.now() - 1000 })], 0.98, {
    codexRefreshFn: async () => ({ accessToken: 'n', refreshToken: 'r2', expiresAt: Date.now() + 3600_000, accountId: null }),
  });

  await am.ensureTokenFresh(0);
  assert.equal(am.accounts[0].accountId, 'acct-1');
});

test('codex and anthropic accounts rotate as peers in one fleet', () => {
  // The point of the fork: management and selection stay protocol-agnostic.
  const am = new AccountManager([
    { name: 'claude-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    codexAcct('codex-1'),
  ], 0.98);

  assert.equal(am.accounts.length, 2);
  am.setDisabled(0, true);
  assert.equal(am.getActiveAccount().name, 'codex-1');
  assert.equal(am.getActiveAccount().protocol, 'codex');
});

// ── prompt cache key ────────────────────────────────────────
//
// Codex caches on a prompt prefix but scopes it by this key, so the key must be
// stable across a conversation's turns. Measured against the live backend on a
// 3k-token prompt: a stable key caches 2816 of 3016 input tokens from the
// second turn on; a fresh key each request caches nothing at all.

test('the same session yields the same cache key across turns', () => {
  const acct = { accountId: 'acct-1', name: 'cx' };
  const a = codexPromptCacheKey(acct, { sessionId: 's1', model: 'gpt-5.6-sol' });
  const b = codexPromptCacheKey(acct, { sessionId: 's1', model: 'gpt-5.6-sol' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('different sessions get different cache keys', () => {
  const acct = { accountId: 'acct-1' };
  assert.notEqual(
    codexPromptCacheKey(acct, { sessionId: 's1', model: 'm' }),
    codexPromptCacheKey(acct, { sessionId: 's2', model: 'm' }));
});

test('a sub-agent gets its own cache key within one session', () => {
  // Sub-agents run a different prompt prefix, so sharing the parent's key would
  // mean two prefixes competing for one cache scope.
  const acct = { accountId: 'acct-1' };
  assert.notEqual(
    codexPromptCacheKey(acct, { sessionId: 's1', model: 'm' }),
    codexPromptCacheKey(acct, { sessionId: 's1', agentId: 'sub-1', model: 'm' }));
});

test('a client sending no session id still gets a stable key', () => {
  // The regression this fixes: such a caller previously got a fresh UUID per
  // request and therefore never cached anything.
  const acct = { accountId: 'acct-1' };
  const a = codexPromptCacheKey(acct, { model: 'gpt-5.6-sol' });
  const b = codexPromptCacheKey(acct, { model: 'gpt-5.6-sol' });
  assert.equal(a, b);
});

test('two accounts do not share a cache key when neither sends a session', () => {
  assert.notEqual(
    codexPromptCacheKey({ accountId: 'acct-1' }, { model: 'm' }),
    codexPromptCacheKey({ accountId: 'acct-2' }, { model: 'm' }));
});

test('the raw session id never reaches the backend', () => {
  // The key is hashed, so a session identifier is not sent in the clear.
  const key = codexPromptCacheKey({ accountId: 'a' }, { sessionId: 'secret-session', model: 'm' });
  assert.ok(!key.includes('secret'));
});
