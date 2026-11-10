import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// A running account marked `longLived` holds no refresh token, whatever its
// entry carries: every gate that decides "can this account be refreshed" reads
// the refresh token, and a stray one sends a dead year-long token through a
// forced refresh that does nothing instead of out of rotation.

const YEAR_MS = 365 * 24 * 3600 * 1000;
const longLived = (fields = {}) => ({
  id: 'a', name: 'a@example.com', type: 'oauth', accountUuid: 'ua',
  accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true, ...fields,
});

test('a long-lived entry that still carries a refresh token is built without it', () => {
  const am = new AccountManager([longLived({ refreshToken: 'rt-stray' })], 0.98);
  assert.equal(am.accounts[0].longLived, true);
  assert.equal(am.accounts[0].refreshToken, null);
});

// An importFrom file is a refreshing Claude Code login, so the marker cannot
// apply to the token read from it.
test('the marker is ignored on an entry that delegates to an importFrom file', () => {
  const am = new AccountManager([longLived({ importFrom: '~/.claude/.credentials.json', refreshToken: 'rt-file' })], 0.98);
  assert.equal(am.accounts[0].longLived, false);
  assert.equal(am.accounts[0].refreshToken, 'rt-file');
});

test('new tokens for a long-lived account do not bring a refresh token with them', () => {
  const am = new AccountManager([longLived()], 0.98);
  am.updateAccountTokens(0, { accessToken: 'at-long-2', refreshToken: 'rt-stray', expiresAt: Date.now() + YEAR_MS });
  assert.equal(am.accounts[0].credential, 'at-long-2');
  assert.equal(am.accounts[0].refreshToken, null);
});

// A plain `teamclaude login` would turn the account back into a refreshing one.
test('a rejected long-lived account names the long-lived login as the remedy', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const am = new AccountManager([longLived(), { ...longLived({ id: 'b', name: 'b@example.com', accountUuid: 'ub' }), longLived: undefined, refreshToken: 'rt-b' }], 0.98);
  am.markCredentialRejected(0, 'upstream rejected its token (401)');
  am.markCredentialRejected(1, 'upstream rejected its token (401)');
  assert.match(lines[0], /run: teamclaude login --long-lived$/);
  assert.match(lines[1], /run: teamclaude login$/);
});

// The TUI's import writes the running account directly and does not reload its
// own save, so it has to clear the marker there too or the imported 8h token is
// never refreshed.
test('a TUI import over a running long-lived account makes it refreshable again', async () => {
  const configAccounts = [longLived()];
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: configAccounts, routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  tui._readCredentials = async () => ({ accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() + 8 * 3_600_000 });
  tui._readProfile = async () => ({ accountUuid: 'ua', email: 'a@example.com' });

  await tui._doImport();

  assert.equal(am.accounts[0].credential, 'at-imported');
  assert.equal(am.accounts[0].longLived, false);
  assert.equal(am.accounts[0].refreshToken, 'rt-imported');
  assert.equal('longLived' in configAccounts[0], false);

  // The save merges each row over the one on disk, which still carries the mark.
  const [saved] = mergeAccountsForSave(configAccounts, am.accounts, [longLived()]);
  assert.equal('longLived' in saved, false);
  assert.equal(saved.refreshToken, 'rt-imported');
});
