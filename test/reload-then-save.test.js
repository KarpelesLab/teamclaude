import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// A change made on disk reaches a running server in two hops: the reload
// applies it to the manager, and the next save writes the in-memory config
// entry back over the disk row. If the reload skips the entry, the save puts
// the OLD value back on disk, and the reload after that undoes the change on
// the running account too — with nothing in the log to say why an account the
// operator just enabled is disabled again.

const entry = extra => ({ id: 'x', name: 'x@example.com', type: 'apikey', apiKey: 'k', ...extra });
// An entry with an account uuid, because that is what pairs a renamed row with
// its account: an API-key entry is paired by name, so its rename reloads as a
// new account.
const oauth = (name, extra) => ({ id: 'x', name, type: 'oauth', accountUuid: 'ux', orgUuid: 'ox', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, ...extra });

/** Reload `disk` into a server started from `startup`, then save, then reload
 *  what the save wrote: the round trip an operator's edit has to survive. */
async function roundTrip(startup, disk) {
  const memConfig = { accounts: [startup] };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);
  await syncAccountsFromDisk({ accounts: written }, memConfig, am);
  return { written: written[0], running: am.accounts[0] };
}

/** roundTrip for an entry with no running account when `disk` is reloaded:
 *  resolveAccounts leaves out an entry without a usable credential, so that
 *  reload builds its account from the row (the re-admit path). */
async function readmitRoundTrip(startup, disk) {
  const memConfig = { accounts: [startup] };
  const am = new AccountManager([], 0.98);
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);
  await syncAccountsFromDisk({ accounts: written }, memConfig, am);
  return { written: written[0], running: am.accounts[0] };
}

test('an account enabled on disk stays enabled through the next save', async () => {
  const { written, running } = await roundTrip(entry({ disabled: true }), entry({}));
  assert.notEqual(written.disabled, true, 'the save must not write the old flag back');
  assert.equal(running.disabled, false);
});

test('an account disabled on disk stays disabled through the next save', async () => {
  const { written, running } = await roundTrip(entry({ disabled: false }), entry({ disabled: true }));
  assert.equal(written.disabled, true);
  assert.equal(running.disabled, true);
});

test('a priority changed on disk stays changed through the next save', async () => {
  const { written, running } = await roundTrip(entry({ priority: 5 }), entry({ priority: 1 }));
  assert.equal(written.priority, 1);
  assert.equal(running.priority, 1);
});

test('a priority removed on disk does not come back', async () => {
  const { written } = await roundTrip(entry({ priority: 5 }), entry({}));
  assert.equal('priority' in written, false);
});

// `displayOrder` is the one field here the TUI itself writes onto the entry
// (Settings → Reorder accounts), so after a single arrangement every entry
// holds a value for the save stencil to prefer over the operator's hand edit.

test('a displayOrder changed on disk stays changed through the next save', async () => {
  const { written, running } = await roundTrip(entry({ displayOrder: 3 }), entry({ displayOrder: 0 }));
  assert.equal(written.displayOrder, 0, 'the save wrote the arranged position back over the hand edit');
  assert.equal(running.displayOrder, 0);
});

test('a displayOrder removed on disk does not come back', async () => {
  const { written, running } = await roundTrip(entry({ displayOrder: 3 }), entry({}));
  assert.equal('displayOrder' in written, false);
  assert.equal(running.displayOrder, null, 'the account did not go back among the unplaced');
});

// The name is what `teamclaude rename` changes, along with every route that
// lists the account. The reload renamed the running account but not the entry,
// so the next save (the TUI's, or any MCP account change) wrote the old name
// back, the reload after it renamed the running account back too, and the
// routes were left naming an account that no longer existed.
test('a name changed on disk stays changed through the next save', async () => {
  const { written, running } = await roundTrip(oauth('x@example.com'), oauth('X1'));
  assert.equal(written.name, 'X1', 'the save wrote the old name back over the rename');
  assert.equal(running.name, 'X1');
});

// A row whose name was deleted by hand leaves the running account its name, as
// it always has, and the entry keeps it too: a save must not write the row out
// with no name at all.
test('a name deleted on disk is not mirrored as no name', async () => {
  const { written, running } = await roundTrip(oauth('x@example.com'), oauth(undefined));
  assert.equal(written.name, 'x@example.com');
  assert.equal(running.name, 'x@example.com');
});

// The TUI's import gives an entry that shares its account uuid with the one
// being imported an " (org)" name in memory, then saves. A reload whose read
// came before that save finds the old name on disk and the running account
// already under it. That is no rename, and the entry keeps the name the save
// is about to write.
test('a name the TUI gave an entry in memory outlasts a reload that read the file before its save', async () => {
  const memConfig = { accounts: [oauth('x@example.com')] };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  memConfig.accounts[0].name = 'x@example.com (Org1)';
  await syncAccountsFromDisk({ accounts: [oauth('x@example.com')] }, memConfig, am);
  assert.equal(memConfig.accounts[0].name, 'x@example.com (Org1)', 'the reload put the old name back on the entry');
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, [oauth('x@example.com')]);
  assert.equal(written[0].name, 'x@example.com (Org1)');
});

// An entry left out at startup has its first reload build its account from the
// row. That entry kept every value it held, so the save wrote them back over
// what the CLI had just changed, and the reload after it undid the change on
// the running account too.
test('a name changed on disk stays changed through the next save when the reload re-admits the account', async () => {
  const { written, running } = await readmitRoundTrip(oauth('x@example.com'), oauth('X1'));
  assert.equal(written.name, 'X1', 'the save wrote the old name back over the rename');
  assert.equal(running.name, 'X1');
});

test('a priority and an enable made on disk stay through the next save when the reload re-admits the account', async () => {
  const { written, running } = await readmitRoundTrip(oauth('x@example.com', { priority: 2, disabled: true }), oauth('x@example.com', { priority: 5 }));
  assert.equal(written.priority, 5);
  assert.equal('disabled' in written, false, 'the save wrote the old flag back');
  assert.equal(running.priority, 5);
  assert.equal(running.disabled, false);
});

test('a name deleted on disk is not mirrored as no name when the reload re-admits the account', async () => {
  const { written } = await readmitRoundTrip(oauth('x@example.com'), oauth(undefined));
  assert.equal(written.name, 'x@example.com');
});

// The reload pairs rows with entries by identity, and one person in two
// organizations is ambiguous when a row does not name its organization: with
// the rows on disk in another order, each row is claimed by the other's entry.
// Here e2 has no running account (no credential at startup), so its entry is
// re-admitted with e1's row. Mirroring that row onto it wrote the other row's
// name, priority and routing proxy onto e2's row on the next save. Only a row
// with the entry's own id is mirrored.
test('a row paired with another account\'s entry by identity does not give that entry its name or settings', async () => {
  const e1 = { id: 'e1', name: 'x@example.com (O1)', type: 'oauth', accountUuid: 'u', orgUuid: 'o1', orgName: 'O1', accessToken: 'at1', refreshToken: 'rt1', expiresAt: Date.now() + 3_600_000, priority: 1, routing: 'http://127.0.0.1:1111' };
  const e2 = { id: 'e2', name: 'x@example.com', type: 'oauth', accountUuid: 'u', priority: 9 };
  const clone = o => JSON.parse(JSON.stringify(o));
  const memConfig = { accounts: [clone(e1), clone(e2)] };
  const am = new AccountManager([clone(e1)], 0.98);
  const disk = [clone(e2), clone(e1)];
  await syncAccountsFromDisk({ accounts: clone(disk) }, memConfig, am);
  const written = mergeAccountsForSave(memConfig.accounts, am.accounts, clone(disk));
  const row = id => written.find(a => a.id === id);
  assert.equal(row('e1').name, 'x@example.com (O1)');
  assert.equal(row('e2').name, 'x@example.com');
  assert.equal(row('e2').priority, 9);
  assert.equal('routing' in row('e2'), false, 'the other account\'s proxy was written onto this row');
});
