import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// A reload hands an existing OAuth account the disk's tokens only when they
// differ from the running ones, and updateAccountTokens clears an 'error'
// status. The manager stores a missing refresh token as null while the disk
// entry leaves it undefined, so an access-token-only account compared as
// changed on every reload and came back from 'error' without a new credential.

const HOUR = 3600_000;
const entry = () => ({ name: 'token-only@example.com', type: 'oauth', accessToken: 't-1', expiresAt: Date.now() + HOUR });

test('a reload with unchanged tokens leaves an access-token-only account in error', async () => {
  const mem = [entry()];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  am._needsLogin(am.accounts[0], 'credential_rejected', 'rejected');

  await syncAccountsFromDisk({ accounts: [entry()] }, { accounts: mem }, am);

  assert.equal(am.accounts[0].status, 'error');
});

test('a reload with a new access token still brings the account back', async () => {
  const mem = [entry()];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  am._needsLogin(am.accounts[0], 'credential_rejected', 'rejected');

  await syncAccountsFromDisk({ accounts: [{ ...entry(), accessToken: 't-2' }] }, { accounts: mem }, am);

  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].credential, 't-2');
});
