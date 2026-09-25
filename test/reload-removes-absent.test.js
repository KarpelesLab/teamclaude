import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { markAccountRemoved, markAccountAdded } from '../src/account-pairing.js';

// A reload used to add accounts from disk and never drop any: an operator's
// `teamclaude remove` from another shell left the account serving until the
// next restart. A running account whose config entry has gone from disk is
// now removed on reload, from the manager and from the in-memory config.

const HOUR = 3600_000;
const acct = (name, id) => ({ id, name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, accountUuid: `u-${name}` });

test('an account removed on disk is dropped from the running fleet on reload', async () => {
  const mem = { accounts: [acct('a@x.com', 'id-a'), acct('b@x.com', 'id-b'), acct('c@x.com', 'id-c')] };
  const am = new AccountManager(mem.accounts.map(a => ({ ...a })), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  am.setCurrentAccount(2);
  const disk = { accounts: [acct('a@x.com', 'id-a'), acct('c@x.com', 'id-c')] };
  const r = await syncAccountsFromDisk(disk, mem, am);
  assert.deepEqual(r, { added: 0, removed: 1 });
  assert.deepEqual(am.accounts.map(a => a.name), ['a@x.com', 'c@x.com']);
  assert.deepEqual(mem.accounts.map(a => a.name), ['a@x.com', 'c@x.com']);
  assert.equal(am.accounts[am.currentIndex].name, 'c@x.com', 'the current account follows the index shift');
  assert.ok(am.accounts.every((a, i) => a.index === i), 'the survivors are renumbered to their positions');
});

// The two lists are not positionally aligned: resolveAccounts drops an entry
// with no usable credential, so from there on a manager index and a config
// index name different accounts. The config row to drop is found by the
// account's id, not by its position in the manager list.
test('the config row dropped is the one the account was built from, not the one at its position', async () => {
  const noCred = { id: 'id-dead', name: 'dead@x.com', type: 'oauth', accountUuid: 'u-dead@x.com' };
  const mem = { accounts: [acct('a@x.com', 'id-a'), noCred, acct('b@x.com', 'id-b'), acct('c@x.com', 'id-c')] };
  // The manager never held the credential-less entry, so b@x.com is manager
  // index 1 and config index 2; a positional splice would take dead@x.com.
  // (That entry stays off disk too: a disk row with no running account is
  // re-admitted, which is not what this test is about.)
  const am = new AccountManager([mem.accounts[0], mem.accounts[2], mem.accounts[3]].map(a => ({ ...a })), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const disk = { accounts: [acct('a@x.com', 'id-a'), acct('c@x.com', 'id-c')] };
  assert.deepEqual(await syncAccountsFromDisk(disk, mem, am), { added: 0, removed: 1 });
  assert.deepEqual(am.accounts.map(a => a.id), ['id-a', 'id-c']);
  assert.deepEqual(mem.accounts.map(a => a.id), ['id-a', 'id-dead', 'id-c']);
  assert.ok(am.accounts.every((a, i) => a.index === i));
});

// The TUI and the MCP endpoint add the other way round: into memory first,
// then a save. A reload that reads the file before the save lands sees a
// running account with no row, which without the record would read as a
// removal — of the account the operator just added.
test("an account added in memory whose save has not landed survives a reload that reads the file first", async () => {
  const mem = { accounts: [acct('a@x.com', 'id-a')] };
  const am = new AccountManager(mem.accounts.map(a => ({ ...a })), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  // The TUI added b@x.com: one object into both lists, and its id recorded.
  const fresh = acct('b@x.com', 'id-b');
  mem.accounts.push(fresh);
  am.addAccount(fresh);
  markAccountAdded(mem, 'id-b');
  const disk = { accounts: [acct('a@x.com', 'id-a')] };
  assert.deepEqual(await syncAccountsFromDisk(disk, mem, am), { added: 0, removed: 0 });
  assert.deepEqual(am.accounts.map(a => a.name), ['a@x.com', 'b@x.com']);
  assert.deepEqual(mem.accounts.map(a => a.name), ['a@x.com', 'b@x.com']);
});

test('nothing is dropped when disk and memory agree, and an addition is still reported', async () => {
  const mem = { accounts: [acct('a@x.com', 'id-a')] };
  const am = new AccountManager(mem.accounts.map(a => ({ ...a })), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const disk = { accounts: [acct('a@x.com', 'id-a'), acct('b@x.com', 'id-b')] };
  assert.deepEqual(await syncAccountsFromDisk(disk, mem, am), { added: 1, removed: 0 });
  assert.deepEqual(am.accounts.map(a => a.name), ['a@x.com', 'b@x.com']);
});

test("the TUI's in-flight removal (memory first, disk not yet saved) is neither re-added nor double-removed", async () => {
  const mem = { accounts: [acct('a@x.com', 'id-a')] };
  const am = new AccountManager(mem.accounts.map(a => ({ ...a })), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  // The TUI removed b@x.com from memory and recorded its id; disk still lists it.
  markAccountRemoved(mem, 'id-b');
  const disk = { accounts: [acct('a@x.com', 'id-a'), acct('b@x.com', 'id-b')] };
  assert.deepEqual(await syncAccountsFromDisk(disk, mem, am), { added: 0, removed: 0 });
  assert.deepEqual(am.accounts.map(a => a.name), ['a@x.com']);
});
