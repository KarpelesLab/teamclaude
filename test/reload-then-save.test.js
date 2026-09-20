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
