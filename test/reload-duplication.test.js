import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';

// resolveAccounts drops every entry without a usable credential, so such an
// entry has no manager account for the life of the process. syncAccountsFromDisk
// read "no manager account" as "new", pushed another config row on every pass,
// and the save/reload pair compounded it — 1, 2, 4, 8 — from nothing more exotic
// than an importFrom whose file went away, which is what logging out of Claude
// Code produces (#200, #235).

// A credential-less oauth entry beside one live API-key account.
function fixture() {
  const disk = {
    accounts: [
      { name: 'live@example.com', type: 'apikey', apiKey: 'k' },
      { name: 'gone@example.com', type: 'oauth', importFrom: '/nonexistent/creds.json' },
    ],
  };
  ensureAccountIds(disk.accounts);
  // memConfig starts as a copy of disk, as loadConfig would produce it.
  const memConfig = { accounts: disk.accounts.map(a => ({ ...a })) };
  // The manager is built only from entries that resolved a credential.
  const am = new AccountManager([{ name: 'live@example.com', type: 'apikey', apiKey: 'k', id: disk.accounts[0].id }], 0.98);
  return { disk, memConfig, am };
}

// Model the save the TUI performs: memConfig is written to disk verbatim.
const save = (memConfig) => ({ accounts: memConfig.accounts.map(a => ({ ...a })) });

test('a credential-less entry is not duplicated by repeated reloads', async () => {
  const { disk, memConfig, am } = fixture();
  for (let i = 0; i < 5; i++) await syncAccountsFromDisk(disk, memConfig, am);
  assert.equal(memConfig.accounts.length, 2, 'config gained a row per reload');
  assert.equal(am.accounts.length, 2, 'the manager gained an account per reload');
});

// The compounding case from #235: a save carries any duplicate to disk, and the
// next reload sees a row it cannot claim.
test('save-and-reload cycles do not grow the lists', async () => {
  let { disk, memConfig, am } = fixture();
  for (let cycle = 0; cycle < 4; cycle++) {
    await syncAccountsFromDisk(disk, memConfig, am);
    disk = save(memConfig);
  }
  assert.equal(memConfig.accounts.length, 2, `config grew to ${memConfig.accounts.length}`);
  assert.equal(disk.accounts.length, 2, `disk grew to ${disk.accounts.length}`);
  assert.equal(am.accounts.length, 2, `manager grew to ${am.accounts.length}`);
  assert.deepEqual(
    memConfig.accounts.map(a => a.name).sort(),
    ['gone@example.com', 'live@example.com'],
  );
});

// The suppression must not cost the recovery: an entry whose credential comes
// back should start serving on a reload, not need a restart.
test('an entry whose credential reappears is picked up on reload', async () => {
  const { disk, memConfig, am } = fixture();
  await syncAccountsFromDisk(disk, memConfig, am);
  assert.equal(memConfig.accounts.length, 2);

  // The operator logs back in: the entry now carries a token directly.
  const revived = disk.accounts.find(a => a.name === 'gone@example.com');
  delete revived.importFrom;
  revived.accessToken = 'fresh-token';
  revived.refreshToken = 'r';
  revived.expiresAt = Date.now() + 3600_000;

  await syncAccountsFromDisk(disk, memConfig, am);

  assert.equal(memConfig.accounts.length, 2, 'still no duplicate row');
  const mgr = am.accounts.find(a => a.name === 'gone@example.com');
  assert.ok(mgr, 'the revived entry has a running account');
  assert.equal(mgr.credential, 'fresh-token', 'and it picked up the credential');
});

// A genuinely new entry must still be added — the guard keys on "already has a
// config row", not on "has no credential".
test('a genuinely new account is still picked up', async () => {
  const { disk, memConfig, am } = fixture();
  await syncAccountsFromDisk(disk, memConfig, am);
  const before = memConfig.accounts.length;

  disk.accounts.push({ name: 'new@example.com', type: 'apikey', apiKey: 'k2' });
  ensureAccountIds(disk.accounts);
  const added = await syncAccountsFromDisk(disk, memConfig, am);

  assert.equal(added, 1);
  assert.equal(memConfig.accounts.length, before + 1);
  assert.ok(am.accounts.some(a => a.name === 'new@example.com'));
});
