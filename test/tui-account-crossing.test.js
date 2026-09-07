import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';
import { syncRefreshedTokens } from '../src/account-pairing.js';

// The TUI's account actions are addressed by the row the operator selected, and
// that row is an index into the AccountManager's list. The config list is not
// the same shape: resolveAccounts drops every entry without a usable credential,
// so from the first drop onward the two indices name different accounts. Remove,
// disable and re-import all reach across that gap.
//
// Every state below puts a credential-less entry FIRST, the smallest
// arrangement where the two indices disagree: the manager's account 0 is the
// config's entry 1.

// The real startup pipeline, because what these pin is that an account can still
// name the entry it came from after passing through it: loadConfig gives the
// entries ids, resolveAccounts drops what it cannot use, and makeAccount copies
// each id onto the account it builds.
async function makeTUI(configAccounts) {
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  const config = { proxy: { port: 1 }, accounts: configAccounts, routes: [] };
  const saved = [];
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async c => { saved.push(c.accounts.map(a => a.name)); },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, am, config, saved };
}

// A tokenless oauth entry is admitted into the config and refused by
// resolveAccounts, so it has no manager account and shifts every later index.
const droppedEntryAhead = () => [
  { name: 'tokenless@example.com', type: 'oauth' },
  { name: 'first@example.com', type: 'apikey', apiKey: 'k-first' },
  { name: 'second@example.com', type: 'apikey', apiKey: 'k-second' },
];

test('an account carries the id of the entry it was built from', async () => {
  const { am, config } = await makeTUI(droppedEntryAhead());

  assert.equal(am.accounts.length, 2, 'the tokenless entry is dropped');
  assert.equal(am.accounts[0].id, config.accounts[1].id);
  assert.equal(am.accounts[1].id, config.accounts[2].id);
  assert.notEqual(am.accounts[0].id, am.accounts[1].id);
});

test('removing an account deletes its own config entry, not the row at its index', async () => {
  const { tui, config } = await makeTUI(droppedEntryAhead());

  // Manager row 1 is "second@example.com"; the config entry at index 1 is
  // "first@example.com". A positional splice deletes the wrong account.
  await tui._doRemove(1);

  assert.deepEqual(
    config.accounts.map(a => a.name),
    ['tokenless@example.com', 'first@example.com'],
    'the removed account\'s own entry must be the one that goes',
  );
});

test('removing an account leaves a credential-less entry alone', async () => {
  const { tui, config } = await makeTUI(droppedEntryAhead());

  // Manager row 0 is "first@example.com"; config index 0 is the tokenless entry,
  // which has no manager account at all and must never be addressed by one.
  await tui._doRemove(0);

  assert.deepEqual(
    config.accounts.map(a => a.name),
    ['tokenless@example.com', 'second@example.com'],
    'an entry with no manager account cannot be removed by a manager index',
  );
});

test('disabling an account writes the flag onto its own config entry', async () => {
  const { tui, config, am } = await makeTUI(droppedEntryAhead());

  await tui._doToggleDisabled(1); // "second@example.com"

  assert.equal(am.accounts[1].disabled, true, 'the running account is disabled');
  assert.equal(config.accounts[2].disabled, true, 'its own entry records it');
  assert.equal(config.accounts[1].disabled, undefined, 'the neighbour must not be disabled instead');
  assert.equal(config.accounts[0].disabled, undefined, 'nor the dropped entry');
});

test('a re-import puts the fresh token on the account its entry owns', async () => {
  const { tui, am, config } = await makeTUI([
    { name: 'tokenless@example.com', type: 'oauth' },
    { name: 'user@example.com', type: 'oauth', accountUuid: 'uuid-a', accessToken: 't-a' },
  ]);

  tui._readCredentials = async () => ({ accessToken: 't-a-fresh', refreshToken: 'r-a-fresh', expiresAt: 3_000 });
  tui._readProfile = async () => ({ accountUuid: 'uuid-a', email: 'user@example.com' });

  const idBefore = config.accounts[1].id;
  await tui._doImport();

  assert.equal(am.accounts[0].credential, 't-a-fresh', 'the running account takes the fresh token');
  assert.equal(config.accounts[1].accessToken, 't-a-fresh', 'and so does its own entry');
  assert.equal(config.accounts[1].id, idBefore, 'the entry keeps the id its running account pairs by');
  assert.equal(am.accounts[0].id, idBefore);
});

test('a re-import onto a tokenless entry does not rewrite a live account', async () => {
  // The entry the import updates is the tokenless one: it matches the imported
  // profile by name, and having no accountUuid nothing contradicts that match.
  // It has no running account, so there is nothing on the manager side to write
  // — and the account that happens to sit at its index belongs to someone else.
  const { tui, am, config } = await makeTUI([
    { name: 'user@example.com', type: 'oauth' },
    { name: 'other@example.com', type: 'oauth', accountUuid: 'uuid-b', orgUuid: 'org-b', accessToken: 't-b' },
  ]);

  tui._readCredentials = async () => ({ accessToken: 't-a-fresh', refreshToken: 'r-a-fresh', expiresAt: 3_000 });
  tui._readProfile = async () => ({ accountUuid: 'uuid-a', orgUuid: 'org-a', email: 'user@example.com' });

  await tui._doImport();

  assert.equal(config.accounts[0].accessToken, 't-a-fresh', 'the entry that matched takes the credential');
  assert.equal(am.accounts[0].credential, 't-b', 'the live account keeps its own credential');
  assert.equal(am.accounts[0].accountUuid, 'uuid-b', 'and its own identity');
  assert.equal(am.accounts[0].orgUuid, 'org-b');
});

test('an account imported from the TUI pairs with the entry that created it', async () => {
  const { tui, am, config } = await makeTUI(droppedEntryAhead());

  tui._readCredentials = async () => ({ accessToken: 't-new', refreshToken: 'r-new', expiresAt: 4_000 });
  tui._readProfile = async () => ({ accountUuid: 'uuid-new', email: 'new@example.com' });

  await tui._doImport();

  const added = config.accounts.at(-1);
  assert.equal(added.name, 'new@example.com');
  assert.ok(added.id, 'the new entry has an id');
  assert.equal(am.accounts.at(-1).id, added.id, 'both lists took the same entry');

  // Without that, the new account has no entry to be saved onto and the first
  // token it refreshes is dropped instead of persisted.
  const written = syncRefreshedTokens(config.accounts, am.accounts, am.accounts.at(-1).index, {
    accessToken: 't-new-fresh', refreshToken: 'r-new-fresh', expiresAt: 5_000,
  });
  assert.equal(config.accounts[written], added);
});

test('an account added from the TUI pairs with the entry that created it', async () => {
  const { tui, am, config } = await makeTUI(droppedEntryAhead());

  await tui._doAddKey('k-added');

  const added = config.accounts.at(-1);
  assert.equal(added.apiKey, 'k-added');
  assert.equal(am.accounts.at(-1).id, added.id, 'both lists took the same entry');
  // Its index differs on the two sides, which is exactly why the id is needed.
  assert.equal(config.accounts.length, 4);
  assert.equal(am.accounts.length, 3);
});
