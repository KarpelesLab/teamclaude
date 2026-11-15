import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configIndexFor,
  managerAccountFor,
  mergeAccountsForSave,
  syncRefreshedTokens,
} from '../src/account-pairing.js';
import { ensureAccountIds } from '../src/account-id.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { AccountManager } from '../src/account-manager.js';

// The config list and the AccountManager's are not positionally aligned:
// resolveAccounts drops every entry without a usable credential, so from the
// first drop onward a config index and a manager index name different accounts.
// Two places in the server path used one list's index on the other — the
// token-refresh sync and the save that rebuilds the on-disk account list — which
// wrote one account's refreshed tokens onto another account's config record, and
// that record is what reached disk.
//
// These go through the real startup pipeline rather than hand-building the two
// lists, because the pairing is only as good as the id's survival through it.

async function startup(configAccounts) {
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  return { config: configAccounts, am };
}

// The smallest arrangement where the two indices disagree: a tokenless oauth
// entry is admitted into the config and refused by resolveAccounts, so the
// manager's account 0 is the config's entry 1.
const droppedEntryAhead = () => [
  { name: 'tokenless@example.com', type: 'oauth' },
  { name: 'first@example.com', type: 'oauth', accessToken: 't-first', refreshToken: 'r-first', expiresAt: 1_000 },
  { name: 'second@example.com', type: 'oauth', accessToken: 't-second', refreshToken: 'r-second', expiresAt: 1_000 },
];

test('a refreshed token is recorded against the account that owns it', async () => {
  const { config, am } = await startup(droppedEntryAhead());

  // Manager account 0 is "first@example.com". Config index 0 is the tokenless
  // entry, so a positional write lands the token on an account it does not
  // belong to — and the next save persists it.
  const written = syncRefreshedTokens(config, am.accounts, 0, {
    accessToken: 't-first-fresh', refreshToken: 'r-first-fresh', expiresAt: 2_000,
  });

  assert.equal(written, 1);
  assert.equal(config[1].accessToken, 't-first-fresh');
  assert.equal(config[0].accessToken, undefined, 'the dropped entry must stay tokenless');
  assert.equal(config[2].accessToken, 't-second', 'the neighbour keeps its own token');
});

// Composed rather than unit-tested, because the whole fix rests on what
// onTokenRefresh hands its caller: an index into the MANAGER list, which is the
// list the config list does not share indices with. A unit test that passes that
// index in by hand assumes the contract instead of checking it.
test('a real refresh records its token on the entry of the account that refreshed', async () => {
  const configAccounts = [
    { name: 'tokenless@example.com', type: 'oauth' },
    { name: 'a@example.com', type: 'oauth', accessToken: 't-a', refreshToken: 'r-a', expiresAt: Date.now() - 1_000 },
    { name: 'b@example.com', type: 'oauth', accessToken: 't-b', refreshToken: 'r-b', expiresAt: Date.now() + 3_600_000 },
  ];
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98, {
    refreshFn: async () => ({ accessToken: 't-a-fresh', refreshToken: 'r-a-fresh', expiresAt: Date.now() + 3_600_000 }),
  });
  am.onTokenRefresh((idx, newTokens) => syncRefreshedTokens(configAccounts, am.accounts, idx, newTokens));

  // Manager account 0 is "a@example.com"; config entry 0 is the dropped one.
  await am.ensureTokenFresh(0);

  assert.equal(am.accounts[0].name, 'a@example.com');
  assert.equal(configAccounts[1].accessToken, 't-a-fresh');
  assert.equal(configAccounts[1].refreshToken, 'r-a-fresh');
  assert.equal(configAccounts[0].accessToken, undefined, 'the dropped entry stays tokenless');
  assert.equal(configAccounts[2].accessToken, 't-b', 'the other account keeps its own token');
});

test('a refresh for an account with no config entry writes nothing', async () => {
  const { config, am } = await startup(droppedEntryAhead());
  // An account whose entry is gone: nothing on the config side speaks for it.
  am.accounts[0].id = 'no-entry-holds-this';

  const written = syncRefreshedTokens(config, am.accounts, 0, {
    accessToken: 't-orphan', refreshToken: 'r-orphan', expiresAt: 2_000,
  });

  assert.equal(written, -1);
  assert.deepEqual(
    config.map(a => a.accessToken),
    [undefined, 't-first', 't-second'],
    'no entry may absorb an orphaned account\'s credential',
  );
});

test('a save gives each account its own live tokens, not its neighbour\'s', async () => {
  const { config, am } = await startup(droppedEntryAhead());
  am.accounts[0].credential = 't-first-live';
  am.accounts[1].credential = 't-second-live';

  const saved = mergeAccountsForSave(config, am.accounts, []);

  assert.equal(saved[1].accessToken, 't-first-live');
  assert.equal(saved[2].accessToken, 't-second-live');
  assert.equal(saved[0].accessToken, undefined, 'the dropped entry gains no credential from a save');
});

test('a lookup for a manager index that names no account finds nothing', async () => {
  const { config, am } = await startup(droppedEntryAhead());

  // -1 is what a caller passes when it has no account. Answering with a real
  // index here would hand the first entry a credential belonging to nobody.
  assert.equal(configIndexFor(config, am.accounts, -1), -1);
  assert.equal(configIndexFor(config, am.accounts, am.accounts.length), -1);
});

// Unidentified records must be refused, not matched to each other. Both lookups
// take lists from their callers, and two records that agree only on having no id
// are not the same record — a bare search would pair them, and the entry it
// picked would be whichever came first, the dropped one included.
test('an entry with no id is paired with nothing rather than with an account that has none', async () => {
  const { config, am } = await startup(droppedEntryAhead());
  config[1].id = null;
  am.accounts[0].id = null;

  assert.equal(managerAccountFor(am.accounts, config[1]), null);
});

test('an account with no id is paired with nothing rather than with an entry that has none', async () => {
  const { config, am } = await startup(droppedEntryAhead());
  am.accounts[0].id = null;
  config[0].id = null;

  assert.equal(configIndexFor(config, am.accounts, 0), -1);
  assert.equal(syncRefreshedTokens(config, am.accounts, 0, {
    accessToken: 't-nowhere', refreshToken: 'r-nowhere', expiresAt: 2_000,
  }), -1);
  assert.equal(config[0].accessToken, undefined, 'the dropped entry gains nothing');
});

test('two entries alike in every field keep their own accounts through a refresh', async () => {
  // Same person, same organization, recorded twice with the same token: nothing
  // on the records separates them, and a refresh rewrites the one field that
  // might have. Each entry still has an account of its own to be saved onto.
  const { config, am } = await startup([
    { name: 'user@example.com', type: 'oauth', accountUuid: 'uuid-a', orgUuid: 'org-a', accessToken: 't', refreshToken: 'r', expiresAt: 1_000 },
    { name: 'user@example.com', type: 'oauth', accountUuid: 'uuid-a', orgUuid: 'org-a', accessToken: 't', refreshToken: 'r', expiresAt: 1_000 },
  ]);

  assert.equal(syncRefreshedTokens(config, am.accounts, 1, {
    accessToken: 't-fresh', refreshToken: 'r-fresh', expiresAt: 2_000,
  }), 1);
  assert.equal(config[1].accessToken, 't-fresh');
  assert.equal(config[0].accessToken, 't', 'the first entry is not the one that refreshed');

  // And again for the other one, which must not now collapse onto entry 1.
  assert.equal(syncRefreshedTokens(config, am.accounts, 0, {
    accessToken: 't-other', refreshToken: 'r-other', expiresAt: 3_000,
  }), 0);
  assert.equal(config[0].accessToken, 't-other');
  assert.equal(config[1].accessToken, 't-fresh');
});

test('an account admitted from disk is saved onto the entry admitted with it', async () => {
  // Both lists take the same object, so the account is built carrying its
  // entry's id. Nothing else would pair them: the entry arrived after startup,
  // at an index the manager list does not share.
  const { config, am } = await startup(droppedEntryAhead());
  const disk = [
    ...config.map(a => ({ ...a })),
    { name: 'late@example.com', type: 'oauth', accessToken: 't-late', refreshToken: 'r-late', expiresAt: 5_000 },
  ];

  await syncAccountsFromDisk({ accounts: disk }, { accounts: config }, am);

  const late = am.accounts.find(a => a.credential === 't-late');
  assert.ok(late, 'the new account is running');
  const written = syncRefreshedTokens(config, am.accounts, late.index, {
    accessToken: 't-late-fresh', refreshToken: 'r-late-fresh', expiresAt: 6_000,
  });
  assert.ok(written >= 0);
  assert.equal(config[written].id, late.id, 'the entry written is the one the account came from');
  assert.equal(config[written].name, 'late@example.com');
  assert.equal(
    config.filter(a => a.accessToken === 't-late-fresh').length, 1,
    'exactly one entry holds the credential',
  );
});

test('an entry admitted from disk holding a used id is re-minted before its account is built', async () => {
  // A config section copied by hand carries the id it was copied from. Admitting
  // it as-is would build an account whose id two entries answer to, and the
  // lookup would take the first — handing the copy's credential to the original.
  const { config, am } = await startup(droppedEntryAhead());
  const disk = [
    ...config.map(a => ({ ...a })),
    { ...config[1], id: config[1].id, name: 'copy@example.com', accessToken: 't-copy' },
  ];

  await syncAccountsFromDisk({ accounts: disk }, { accounts: config }, am);

  const copy = am.accounts.find(a => a.credential === 't-copy');
  assert.ok(copy, 'the copied entry is running');
  assert.notEqual(copy.id, config[1].id, 'its id no longer collides with the entry it was copied from');
  assert.equal(new Set(config.map(a => a.id)).size, config.length, 'every entry still has an id of its own');

  const written = syncRefreshedTokens(config, am.accounts, copy.index, {
    accessToken: 't-copy-fresh', refreshToken: 'r-copy-fresh', expiresAt: 6_000,
  });
  assert.equal(config[written].name, 'copy@example.com');
  assert.equal(config[1].accessToken, 't-first', 'the original entry keeps its own credential');
});

test('a save keeps disk-only fields and the entry id', async () => {
  const { config, am } = await startup([
    { name: 'delegated', type: 'oauth', accessToken: 't-a', refreshToken: 'r-a', expiresAt: 1_000 },
  ]);
  const disk = [{ ...config[0], importFrom: '~/.claude/.credentials.json' }];

  const saved = mergeAccountsForSave(config, am.accounts, disk);

  assert.equal(saved[0].importFrom, '~/.claude/.credentials.json', 'a disk-only field survives');
  assert.equal(saved[0].id, config[0].id, 'so the next start reads back the same id');
});

test('an entry whose account is gone keeps its own credential on a save', async () => {
  const { config, am } = await startup([
    { name: 'a@example.com', type: 'oauth', accessToken: 't-a', refreshToken: 'r-a', expiresAt: 1_000 },
    { name: 'b@example.com', type: 'oauth', accessToken: 't-b', refreshToken: 'r-b', expiresAt: 1_000 },
  ]);
  am.removeAccount(0);

  const saved = mergeAccountsForSave(config, am.accounts, []);

  assert.equal(saved[0].accessToken, 't-a', 'no live credential to write, so the entry keeps its own');
  assert.equal(saved[1].accessToken, 't-b', 'and the surviving account still writes to its own entry');
});
