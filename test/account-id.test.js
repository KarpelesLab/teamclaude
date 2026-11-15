import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAccountIds, mintAccountId } from '../src/account-id.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { AccountManager } from '../src/account-manager.js';

// Every lookup that pairs a config entry to a running account assumes an entry's
// id is unique within its list. Nothing downstream can repair a violation: two
// entries answering to one id are one entry as far as a lookup is concerned, and
// the second would be handed the first one's credential. So the invariant is
// established here, wherever entries enter an in-memory list.

test('an entry that arrives without an id is given one', () => {
  const accounts = [{ name: 'a', type: 'apikey', apiKey: 'k' }];
  ensureAccountIds(accounts);
  assert.equal(typeof accounts[0].id, 'string');
  assert.ok(accounts[0].id.length > 0);
});

test('an entry that already has an id keeps it', () => {
  const accounts = [{ id: 'kept', name: 'a', type: 'apikey', apiKey: 'k' }];
  ensureAccountIds(accounts);
  assert.equal(accounts[0].id, 'kept');
});

test('a duplicated id is re-minted on the later entry, not the first', () => {
  // What a copied config section looks like: the id came along with it.
  const accounts = [
    { id: 'shared', name: 'a', type: 'apikey', apiKey: 'k-a' },
    { id: 'shared', name: 'a', type: 'apikey', apiKey: 'k-b' },
  ];
  ensureAccountIds(accounts);
  assert.equal(accounts[0].id, 'shared', 'the first claimant keeps the id');
  assert.notEqual(accounts[1].id, 'shared');
});

test('an id that is not a usable string is replaced', () => {
  const accounts = [
    { id: '', name: 'a', type: 'apikey', apiKey: 'k' },
    { id: 42, name: 'b', type: 'apikey', apiKey: 'k' },
    { id: null, name: 'c', type: 'apikey', apiKey: 'k' },
  ];
  ensureAccountIds(accounts);
  for (const a of accounts) assert.equal(typeof a.id, 'string');
  assert.equal(new Set(accounts.map(a => a.id)).size, 3);
});

test('a list of entries with no ids at all comes out with distinct ones', () => {
  const accounts = Array.from({ length: 8 }, () => ({ name: 'same', type: 'apikey', apiKey: 'k' }));
  ensureAccountIds(accounts);
  assert.equal(new Set(accounts.map(a => a.id)).size, 8);
});

test('a missing or empty account list is not an error', () => {
  assert.doesNotThrow(() => ensureAccountIds(undefined));
  assert.doesNotThrow(() => ensureAccountIds([]));
  assert.doesNotThrow(() => ensureAccountIds([null]));
});

test('minted ids do not repeat', () => {
  const ids = new Set(Array.from({ length: 500 }, mintAccountId));
  assert.equal(ids.size, 500);
});

// ── carriage into the account built from the entry ───────────

test('an account is built carrying its entry id', async () => {
  const accounts = [{ name: 'a', type: 'apikey', apiKey: 'k-a' }];
  ensureAccountIds(accounts);
  const am = new AccountManager(await resolveAccounts({ accounts }), 0.98);
  assert.equal(am.accounts[0].id, accounts[0].id);
});

test('an account built from an entry without an id has none, rather than a wrong one', () => {
  // Nothing in the running system should produce this, but a null id makes the
  // pairing refuse rather than answer with whichever entry also lacks one.
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  assert.equal(am.accounts[0].id, null);
});

test('a delegated entry keeps its id through the credential import', async () => {
  // resolveAccounts rebuilds an importFrom entry as `{ ...acct, ...creds }`, so
  // the id has to survive that spread — the import supplies credentials only.
  const dir = await mkdtemp(join(tmpdir(), 'tc-acct-id-'));
  const credsPath = join(dir, 'creds.json');
  await writeFile(credsPath, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 9_000 }));

  const accounts = [{ name: 'delegated', type: 'oauth', importFrom: credsPath }];
  ensureAccountIds(accounts);
  const resolved = await resolveAccounts({ accounts });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, accounts[0].id);
  assert.equal(resolved[0].accessToken, 'at');
});

// ── the boundary where a config read from disk enters memory ──

test('a config written before the field existed is given ids on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-acct-id-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    accounts: [
      { name: 'a', type: 'apikey', apiKey: 'k-a' },
      { name: 'a', type: 'apikey', apiKey: 'k-b' },
    ],
  }));

  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = configPath;
  try {
    const { loadConfig, saveConfig } = await import('../src/config.js');
    const config = await loadConfig();
    assert.equal(new Set(config.accounts.map(a => a.id)).size, 2, 'two same-named entries are still two entries');

    // Persisted on the next write, so the ids a running process handed out are
    // the ones the next start reads back.
    await saveConfig(config);
    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.deepEqual(written.accounts.map(a => a.id), config.accounts.map(a => a.id));
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
});
