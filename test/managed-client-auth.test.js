import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { issueManagedCredential, resolveManagedCredential, buildManagedEnv } from '../src/managed-client-auth.js';
const fixture = () => ({
  proxy: { managedClientAuth: true, apiKey: 'test-proxy-key-not-a-provider-token' },
  accounts: [
    { id: 'disabled', type: 'oauth', disabled: true },
    { id: 'codex', type: 'oauth', provider: 'codex' },
    { id: 'api', type: 'apikey' },
    { id: 'first/조직', type: 'oauth', accessToken: 'test-access-old', refreshToken: 'test-refresh-old' },
    { id: 'second', type: 'oauth' },
  ],
});
const bearer = token => `Bearer ${token}`;
const referenceToken = (config, id) => {
  const payload = `tc-managed-v1.${Buffer.from(id).toString('base64url')}`;
  return `${payload}.${createHmac('sha256', config.proxy.apiKey).update(payload).digest('base64url')}`;
};

test('issues an account-bound proxy credential without provider secrets', () => {
  assert.equal(typeof issueManagedCredential, 'function');
  const config = fixture();
  const token = issueManagedCredential(config);
  assert.equal(token, referenceToken(config, 'first/조직'));
  assert.deepEqual(resolveManagedCredential(config, bearer(token)), { ok: true, accountId: 'first/조직' });
  assert.equal(token.includes('test-access'), false);
  assert.equal(token.includes('test-refresh'), false);
  assert.equal(token.includes(config.proxy.apiKey), false);
});

test('binding survives provider token refresh and config reorder', () => {
  const config = fixture();
  const token = referenceToken(config, 'first/조직');
  config.accounts[3].accessToken = 'test-access-new';
  config.accounts[3].refreshToken = 'test-refresh-new';
  config.accounts.reverse();
  assert.deepEqual(resolveManagedCredential(config, bearer(token)), { ok: true, accountId: 'first/조직' });
});

test('explicit account id is honored and never silently replaced', () => {
  const config = fixture();
  assert.equal(issueManagedCredential(config, 'second'), referenceToken(config, 'second'));
  for (const id of ['missing', 'disabled', 'codex', 'api']) {
    assert.throws(() => issueManagedCredential(config, id), /account/i);
  }
});

test('disabled mode and missing proxy key cannot issue credentials', () => {
  for (const proxy of [{}, { managedClientAuth: true }, { managedClientAuth: false, apiKey: 'test-key' }]) {
    assert.throws(() => issueManagedCredential({ ...fixture(), proxy }), /managed|key/i);
  }
});

test('ordinary client credentials retain the passthrough contract', () => {
  for (const header of [undefined, '', 'Bearer ordinary-provider-token', 'Basic abc']) {
    assert.equal(resolveManagedCredential(fixture(), header), null);
  }
});

test('tampering, malformed markers and proxy key revocation fail closed', () => {
  const config = fixture();
  const token = referenceToken(config, 'second');
  const changedId = token.replace(Buffer.from('second').toString('base64url'), Buffer.from('first/조직').toString('base64url'));
  for (const candidate of [changedId, 'tc-managed-v1.', 'tc-managed-v1.%%%.bad', `${token}.extra`, `${token}=`, 'tc-managed-v1.bad']) {
    assert.equal(resolveManagedCredential(config, bearer(candidate)).ok, false);
  }
  config.proxy.apiKey = 'rotated-test-key';
  assert.equal(resolveManagedCredential(config, bearer(token)).ok, false);
});

test('disabled, removed, duplicate and unavailable accounts revoke the binding', () => {
  for (const mutate of [
    c => { c.proxy.managedClientAuth = false; },
    c => { c.accounts = []; },
    c => { c.accounts[4].disabled = true; },
    c => { c.accounts[4].status = 'error'; },
    c => { c.accounts[4].upstream = 'https://third-party.invalid'; },
    c => { c.accounts.push({ ...c.accounts[4] }); },
  ]) {
    const config = fixture();
    const token = referenceToken(config, 'second');
    mutate(config);
    assert.equal(resolveManagedCredential(config, bearer(token)).ok, false);
  }
});

test('launch replaces inherited provider auth without mutating parent environment', () => {
  const env = {
    PATH: '/test/bin', CLAUDE_CODE_OAUTH_TOKEN: 'old-personal-token',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'old-personal-refresh',
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '7', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '8',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session-secret',
    ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'old-token',
    ANTHROPIC_BASE_URL: 'https://elsewhere.invalid', ANTHROPIC_FOUNDRY_API_KEY: 'old-foundry-key',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://elsewhere.invalid',
  };
  const original = { ...env };
  const result = buildManagedEnv(env, 'test-managed-token', ['api.anthropic.com']);
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, 'test-managed-token');
  assert.equal(result.PATH, env.PATH);
  for (const key of Object.keys(env).filter(k => k !== 'PATH' && k !== 'CLAUDE_CODE_OAUTH_TOKEN')) assert.equal(result[key], undefined, key);
  assert.deepEqual(env, original);
});

test('protected hosts cannot bypass proxy through NO_PROXY spelling variants', () => {
  const bypasses = ['*', 'api.anthropic.com', 'API.ANTHROPIC.COM:443', '.anthropic.com', '*.anthropic.com', 'anthropic.com', 'api.anthropic.com.', '*anthropic.com', 'api.*.com', 'chatgpt.com:443'];
  const result = buildManagedEnv({ NO_PROXY: bypasses.concat('dev.test', 'localhost').join(','), no_proxy: '127.0.0.1,.internal.test' }, 'test-managed-token', ['api.anthropic.com', 'chatgpt.com']);
  assert.equal(result.NO_PROXY, result.no_proxy);
  const kept = result.NO_PROXY.split(',');
  for (const bypass of bypasses) assert.equal(kept.includes(bypass), false, bypass);
  for (const local of ['localhost', '127.0.0.1', '::1', 'dev.test', '.internal.test']) assert.ok(kept.includes(local), local);
});

test('lookalike hosts remain excluded from proxy as requested by operator', () => {
  const result = buildManagedEnv({ NO_PROXY: 'notanthropic.com,api.anthropic.com.attacker.test,example.com:3500' }, 'test-managed-token', ['api.anthropic.com']);
  assert.match(result.NO_PROXY, /notanthropic\.com/);
  assert.match(result.NO_PROXY, /api\.anthropic\.com\.attacker\.test/);
  assert.match(result.NO_PROXY, /example\.com:3500/);
});
