import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { markAccountRemoved } from '../src/account-pairing.js';

// The TUI's remove changes memory first and saves second. A reload landing
// between the two reads the file the save has not rewritten yet, finds a row
// with no running account, and added it straight back — and the save then wrote
// it back too (#422). The removal is recorded for exactly that window, and the
// reload now reads it.

const entry = (id, name) => ({ id, name, type: 'apikey', apiKey: `k-${id}` });

function removing(markRemoved) {
  const disk = [entry('a', 'a@example.com'), entry('b', 'b@example.com')];
  const memConfig = { accounts: disk.map(a => ({ ...a })) };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  // What _doRemove has done by the time the racing reload arrives.
  am.removeAccount(1);
  memConfig.accounts.splice(1, 1);
  if (markRemoved) markAccountRemoved(memConfig, 'b');
  return { disk, memConfig, am };
}

test('a reload during a removal does not re-add the account from the stale file', async () => {
  const { disk, memConfig, am } = removing(true);
  const added = await syncAccountsFromDisk({ accounts: disk }, memConfig, am);
  assert.equal(added, 0);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com']);
  assert.deepEqual(memConfig.accounts.map(a => a.name), ['a@example.com']);
});

// The control: without the record the same row IS a new account, which is how an
// account added on disk reaches a running server.
test('the same row with no removal recorded is still adopted', async () => {
  const { disk, memConfig, am } = removing(false);
  const added = await syncAccountsFromDisk({ accounts: disk }, memConfig, am);
  assert.equal(added, 1);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com', 'b@example.com']);
});
