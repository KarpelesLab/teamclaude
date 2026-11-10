import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// `teamclaude login --long-lived` saves an entry marked `longLived` with no
// refresh token. The running server must take that marker from a reload, never
// refresh such an account, and leave an unmarked entry's refresh token alone.

const YEAR_MS = 365 * 24 * 3600 * 1000;
const entry = (fields) => ({
  id: 'a', name: 'a@example.com', type: 'oauth', accountUuid: 'ua', orgUuid: 'oa', ...fields,
});

function running(mem, opts) {
  const memConfig = { accounts: [{ ...mem }] };
  const am = new AccountManager([{ ...mem }], 0.98, opts);
  const persisted = [];
  am.onTokenRefresh((idx, tokens) => persisted.push(tokens));
  return { memConfig, am, persisted };
}

test('a reload of a long-lived entry drops the refresh token held in memory', async () => {
  const { memConfig, am, persisted } = running(entry({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000 }));

  const disk = entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);

  assert.equal(am.accounts[0].credential, 'at-long');
  assert.equal(am.accounts[0].longLived, true);
  assert.equal(am.accounts[0].refreshToken, null);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].refreshToken, null);
});

// The control: without the marker a missing refresh token on disk is not a
// decision to drop it, and the one in memory keeps the account refreshing.
test('a reload of an unmarked entry without a refresh token keeps the one in memory', async () => {
  const { memConfig, am } = running(entry({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000 }));

  const disk = entry({ accessToken: 'at-new', expiresAt: Date.now() + 7_200_000 });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);

  assert.equal(am.accounts[0].credential, 'at-new');
  assert.equal(am.accounts[0].refreshToken, 'rt-old');
});

test('a reload of an unchanged long-lived entry rewrites nothing', async () => {
  const disk = entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true });
  const { memConfig, am, persisted } = running(disk);

  await syncAccountsFromDisk({ accounts: [{ ...disk }] }, memConfig, am);

  assert.equal(persisted.length, 0);
});

test('a reload of a long-lived entry with a stray refresh token rewrites nothing', async () => {
  const disk = entry({ accessToken: 'at-long', refreshToken: 'rt-stray', expiresAt: Date.now() + YEAR_MS, longLived: true });
  const { memConfig, am, persisted } = running(disk);

  await syncAccountsFromDisk({ accounts: [{ ...disk }] }, memConfig, am);

  assert.equal(persisted.length, 0);
  assert.equal(am.accounts[0].refreshToken, null);
});

// The staleness guard compares expiries, and a year-long token in memory
// outlasts any ordinary login; the marker changing says this one is newer.
test('a reload takes an ordinary login over a long-lived token held in memory', async () => {
  const { memConfig, am } = running(entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true }));

  const disk = entry({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 8 * 3_600_000 });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);

  assert.equal(am.accounts[0].credential, 'at-new');
  assert.equal(am.accounts[0].refreshToken, 'rt-new');
  assert.equal(am.accounts[0].longLived, false);
});

// A long-lived login drops `importFrom` on disk. The running server's config
// entry must lose it too, or the next save writes it back and the credentials
// file is read over the year-long token from then on.
test('a save after the reload does not write a dropped importFrom back', async () => {
  const { memConfig, am } = running(entry({ importFrom: '~/.claude/.credentials.json', accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000 }));

  const disk = entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const [saved] = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);

  assert.equal('importFrom' in saved, false);
  assert.equal(saved.longLived, true);
  assert.equal(saved.accessToken, 'at-long');
});

// The same, for an account the server dropped at startup because its importFrom
// file was missing: the reload re-admits it from the long-lived row, and the
// config row it pairs with still names the file.
test('a save after re-admitting a dropped account does not write importFrom back', async () => {
  const memConfig = { accounts: [entry({ importFrom: '~/.claude/.credentials.json' })] };
  const am = new AccountManager([], 0.98);

  const disk = entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const [saved] = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);

  assert.equal(am.accounts[0].longLived, true);
  assert.equal('importFrom' in saved, false);
  assert.equal(saved.longLived, true);
});

// The other direction: an ordinary login clears the marker on disk, and a save
// that put it back would stop the account refreshing for good.
test('a save after the reload does not write a cleared marker back', async () => {
  const { memConfig, am } = running(entry({ accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true }));

  const disk = entry({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 8 * 3_600_000 });
  await syncAccountsFromDisk({ accounts: [disk] }, memConfig, am);
  const [saved] = mergeAccountsForSave(memConfig.accounts, am.accounts, [disk]);

  assert.equal('longLived' in saved, false);
  assert.equal(saved.refreshToken, 'rt-new');
});

test('a long-lived account is never refreshed, even when forced', async () => {
  let calls = 0;
  const { am } = running(
    entry({ accessToken: 'at-long', refreshToken: 'rt-stray', expiresAt: Date.now() - 1000, longLived: true }),
    { refreshFn: async () => { calls++; return { accessToken: 'at-short', refreshToken: 'rt-short', expiresAt: Date.now() + 3_600_000 }; } },
  );

  await am.ensureTokenFresh(0);
  await am.ensureTokenFresh(0, true);

  assert.equal(calls, 0);
  assert.equal(am.accounts[0].credential, 'at-long');
});
