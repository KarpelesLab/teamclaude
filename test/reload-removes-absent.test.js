import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { markAccountRemoved } from '../src/account-pairing.js';

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
