import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { unavailableLine } from '../src/status-renderer.js';

// A bare `error` told a status reader nothing it could act on: the reason went
// to the server log only. Each way into 'error' now leaves its reason on the
// account, and status carries it while, and only while, the account is in it.

const paint = new Proxy({}, { get: () => (v => String(v)) });

function expiring(over = {}) {
  return { name: 'a', type: 'oauth', accessToken: 'at-secret-value', refreshToken: 'rt-secret-value', expiresAt: Date.now() - 1000, ...over };
}

function rejected(status) {
  const e = /** @type {Error & { status?: number }} */ (new Error(`Token refresh failed (${status}): {"error":"invalid_grant"}`));
  e.status = status;
  return e;
}

test('a rejected refresh token reports its code, status, time and remedy', async () => {
  const before = Date.now();
  const am = new AccountManager([expiring()], 0.98, { refreshFn: async () => { throw rejected(400); } });
  await am.ensureTokenFresh(0);
  const row = am.getStatus().accounts[0];
  assert.equal(row.status, 'error');
  assert.equal(row.errorReason.code, 'refresh_rejected');
  assert.match(row.errorReason.detail, /\(400\)/);
  assert.ok(row.errorReason.since >= before);
  assert.equal(row.errorReason.remedy, 'teamclaude login');
  assert.doesNotMatch(JSON.stringify(row.errorReason), /invalid_grant|secret-value/, 'no upstream body and no token in status');
});

test('a 401 on a token with nothing to refresh reports credential_rejected', () => {
  const am = new AccountManager([expiring({ refreshToken: undefined, expiresAt: Date.now() + 3600_000 })], 0.98);
  am.markCredentialRejected(0, 'upstream rejected its token (401) and it has no refresh token');
  const row = am.getStatus().accounts[0];
  assert.equal(row.errorReason.code, 'credential_rejected');
  assert.equal(row.errorReason.detail, 'upstream rejected its token (401) and it has no refresh token');
});

test('a Codex account is told to sign in with --codex', () => {
  const am = new AccountManager([expiring({ provider: 'codex', accountId: 'acct', refreshToken: undefined, expiresAt: Date.now() + 3600_000 })], 0.98);
  am.markCredentialRejected(0, 'upstream rejected its token (401) and it has no refresh token');
  assert.equal(am.getStatus().accounts[0].errorReason.remedy, 'teamclaude login --codex');
});

test('the reason leaves status once the account is back', async () => {
  const am = new AccountManager([expiring()], 0.98, { refreshFn: async () => { throw rejected(401); } });
  await am.ensureTokenFresh(0);
  am.updateAccountTokens(0, { accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 3600_000 });
  const row = am.getStatus().accounts[0];
  assert.equal(row.status, 'active');
  assert.equal(row.errorReason, null);
});

test('a transient refresh failure leaves no reason behind', async () => {
  const am = new AccountManager([expiring()], 0.98, { refreshFn: async () => { throw rejected(503); } });
  await am.ensureTokenFresh(0);
  assert.equal(am.getStatus().accounts[0].errorReason, null);
});

test('status prints the reason and the command instead of "see logs"', async () => {
  const am = new AccountManager([expiring()], 0.98, { refreshFn: async () => { throw rejected(400); } });
  await am.ensureTokenFresh(0);
  const line = unavailableLine(am.getStatus().accounts[0], paint);
  assert.match(line ?? '', /needs a re-login: upstream rejected its refresh token \(400\) — run: teamclaude login/);
  assert.doesNotMatch(line ?? '', /see logs/);
});
