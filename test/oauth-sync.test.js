import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncClientOAuthRefresh } from '../src/oauth-sync.js';
import { AccountManager } from '../src/account-manager.js';
import { hostMode } from '../src/mitm.js';
import { interceptHostsFor, isOAuthMirrorHost } from '../src/provider.js';

const oauth = (name, over = {}) => ({
  name, type: 'oauth', accessToken: 'a', refreshToken: 'r-old', expiresAt: Date.now() + 3600_000, ...over,
});

test('syncClientOAuthRefresh updates the account that held the sent refresh token', () => {
  const am = new AccountManager([oauth('a'), oauth('b', { refreshToken: 'r-other' })], 0.98);
  const req = JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'r-old', client_id: 'x' });
  const res = JSON.stringify({
    access_token: 'a-new',
    refresh_token: 'r-new',
    expires_in: 3600,
  });
  assert.equal(syncClientOAuthRefresh(am, req, res, 200), 1);
  assert.equal(am.accounts[0].refreshToken, 'r-new');
  assert.equal(am.accounts[0].credential, 'a-new');
  assert.equal(am.accounts[1].refreshToken, 'r-other');
});

test('syncClientOAuthRefresh ignores authorization_code grants', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const req = JSON.stringify({ grant_type: 'authorization_code', code: 'c', client_id: 'x' });
  const res = JSON.stringify({ access_token: 'a-new', refresh_token: 'r-new', expires_in: 3600 });
  assert.equal(syncClientOAuthRefresh(am, req, res, 200), 0);
  assert.equal(am.accounts[0].refreshToken, 'r-old');
});

test('syncClientOAuthRefresh ignores non-2xx responses', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const req = JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'r-old' });
  const res = JSON.stringify({ error: 'invalid_grant' });
  assert.equal(syncClientOAuthRefresh(am, req, res, 400), 0);
});

test('syncClientOAuthRefresh clears error status on the matched account', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].status = 'error';
  am.accounts[0]._deadRefreshToken = 'r-old';
  const req = JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'r-old' });
  const res = JSON.stringify({ access_token: 'a-new', refresh_token: 'r-new', expires_in: 3600 });
  assert.equal(syncClientOAuthRefresh(am, req, res, 200), 1);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0]._deadRefreshToken, null);
});

test('platform.claude.com is an oauth-mirror host, not a rewrite host', () => {
  assert.equal(isOAuthMirrorHost('platform.claude.com'), true);
  assert.equal(hostMode('platform.claude.com', { accounts: [] }), 'oauth-mirror');
  assert.equal(hostMode('api.anthropic.com', { accounts: [] }), 'rewrite');
  assert.ok(interceptHostsFor([]).includes('platform.claude.com'));
});

test('invalid_grant recovers from a fresher Claude Code store', async () => {
  const am = new AccountManager(
    [oauth('a', { importFrom: '~/.claude/.credentials.json' })],
    0.98,
    {
      refreshFn: async () => {
        const err = new Error('Token refresh failed (400): invalid_grant');
        err.status = 400;
        throw err;
      },
    },
  );
  am._importCredentialsFn = async () => ({
    accessToken: 'from-keychain',
    refreshToken: 'r-fresh',
    expiresAt: Date.now() + 3600_000,
  });
  am.accounts[0].expiresAt = Date.now() - 1000;
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].refreshToken, 'r-fresh');
  assert.equal(am.accounts[0].credential, 'from-keychain');
});

test('invalid_grant still errors when Claude Code store has the same dead token', async () => {
  const am = new AccountManager(
    [oauth('a')],
    0.98,
    {
      refreshFn: async () => {
        const err = new Error('Token refresh failed (400): invalid_grant');
        err.status = 400;
        throw err;
      },
    },
  );
  am._importCredentialsFn = async () => ({
    accessToken: 'same',
    refreshToken: 'r-old',
    expiresAt: Date.now() + 3600_000,
  });
  am.accounts[0].expiresAt = Date.now() - 1000;
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'error');
});
