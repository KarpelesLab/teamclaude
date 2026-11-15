import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// syncAccountsFromDisk pairs disk entries to running accounts with a greedy 1:1
// claimer, because identity alone is ambiguous: sameIdentity compares orgKey
// only when BOTH sides carry one, and falls back to comparing names when no
// accountUuid is present. The memConfig side must pair the same way — a
// first-match scan there writes a third-party-backend binding onto the wrong
// account, which the next TUI save then persists to disk.
//
// These build the ambiguous state by hand; real configs mostly avoid it.

// The manager receives org identity that memConfig may still lack — the sync
// backfills orgUuid/orgName onto the manager object only, so a memConfig entry
// can sit without an orgKey indefinitely.
function twoOrgsOneUuid() {
  const disk = [
    { name: 'user@example.com (Acme)', type: 'apikey', apiKey: 'k-acme', accountUuid: 'uuid-shared', orgUuid: 'org-acme' },
    { name: 'user@example.com (Globex)', type: 'apikey', apiKey: 'k-globex', accountUuid: 'uuid-shared', orgUuid: 'org-globex' },
  ];
  // memConfig's first entry predates org disambiguation: same accountUuid, no
  // orgUuid, so sameIdentity() says "same account" against BOTH disk entries.
  const mem = [
    { name: 'user@example.com (Acme)', type: 'apikey', apiKey: 'k-acme', accountUuid: 'uuid-shared' },
    { name: 'user@example.com (Globex)', type: 'apikey', apiKey: 'k-globex', accountUuid: 'uuid-shared', orgUuid: 'org-globex' },
  ];
  return { disk, mem };
}

// No accountUuid anywhere: sameIdentity falls back to name equality, so two
// same-named apikey entries are mutually ambiguous.
function twoApiKeysOneName() {
  const disk = [
    { name: 'shared-name', type: 'apikey', apiKey: 'k-first' },
    { name: 'shared-name', type: 'apikey', apiKey: 'k-second' },
  ];
  return { disk, mem: disk.map(a => ({ ...a })) };
}

test('a second disk entry sharing an accountUuid mirrors onto its own memConfig entry', async () => {
  const { disk, mem } = twoOrgsOneUuid();
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);

  // The Globex account (second entry) gains a third-party backend on disk.
  disk[1].upstream = 'https://api.example.test/anthropic';
  disk[1].modelMap = { 'claude-sonnet-4-6': 'other-model' };

  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);

  assert.equal(mem[1].upstream, 'https://api.example.test/anthropic', 'the edited entry must receive the binding');
  assert.equal(mem[0].upstream, undefined, 'the Acme entry must NOT receive another account\'s upstream');
  assert.equal(mem[0].modelMap, undefined, 'the Acme entry must NOT receive another account\'s modelMap');
  // The manager side pairs correctly today; assert it stays that way.
  assert.equal(am.accounts[1].upstream, 'https://api.example.test/anthropic');
  assert.equal(am.accounts[0].upstream, null);
});

test('two apikey accounts sharing a name each mirror onto their own memConfig entry', async () => {
  const { disk, mem } = twoApiKeysOneName();
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);

  disk[1].upstream = 'https://api.example.test/anthropic';

  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);

  assert.equal(mem[1].upstream, 'https://api.example.test/anthropic');
  assert.equal(mem[0].upstream, undefined, 'the first same-named entry must not absorb the second\'s upstream');
  assert.equal(am.accounts[1].upstream, 'https://api.example.test/anthropic');
  assert.equal(am.accounts[0].upstream, null);
});

// Pairing must not depend on positional alignment either: resolveAccounts drops
// credential-less entries at startup, so memConfig can hold entries the manager
// never received, shifting every later index.
test('pairing survives a memConfig entry the manager never received', async () => {
  const mem = [
    { name: 'tokenless@example.com', type: 'oauth' },
    { name: 'live@example.com', type: 'apikey', apiKey: 'k-live' },
  ];
  // The manager was built from the filtered list — the tokenless entry is absent.
  const am = new AccountManager([mem[1]].map(a => ({ ...a })), 0.98);
  const disk = mem.map(a => ({ ...a }));
  disk[1].upstream = 'https://api.example.test/anthropic';

  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);

  assert.equal(mem[1].upstream, 'https://api.example.test/anthropic', 'the live account keeps its own binding');
  assert.equal(mem[0].upstream, undefined, 'the dropped entry must not absorb it');
});
