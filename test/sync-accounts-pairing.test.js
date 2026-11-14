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

for (const [kind, before, after, replace] of [
  ['provider', {}, { provider: 'codex', accountId: 'workspace' }, true],
  ['organization', { accountUuid: 'person', orgUuid: 'old' }, { orgUuid: 'new' }, true],
  ['account UUID', { accountUuid: 'old' }, { accountUuid: 'new' }, true],
  ['Codex account', { provider: 'codex', accountId: 'old', userId: 'user' }, { accountId: 'new' }, true],
  ['Codex user', { provider: 'codex', accountId: 'workspace', userId: 'old' }, { userId: 'new' }, true],
  ['rename', {}, { name: 'renamed' }, false],
  ['profile backfill', { accountUuid: 'person' }, { orgUuid: 'known' }, false],
]) {
  test(`exact-ID reload handles ${kind} without identity churn or stale affinity`, async t => {
    const original = { id: 'b', name: 'original', type: 'oauth', accessToken: 'synthetic-old', expiresAt: Date.now() + 3_600_000, ...before };
    const stable = { id: 'a', name: 'stable', type: 'apikey', apiKey: 'synthetic-stable' };
    const mem = { persistSessionAffinity: true, accounts: [original, stable] };
    const am = new AccountManager(mem.accounts, 0.98, { distributeSessions: 'adaptive' });
    const old = am.accounts[0];
    am.beginSession('owned', { sessionId: 'client', conversation: 'opening' });
    am.recordSession('owned', 0, 'claude-opus-5');
    am.recordThreadMessage('owned', 'msg_owned');
    am.endSession('owned');
    am.recordSession('unrelated', 1, 'claude-opus-5');
    const disk = { accounts: [{ ...stable }, { ...original, ...after, accessToken: 'synthetic-new', expiresAt: Date.now() + 7_200_000 }] };
    const unchangedDisk = JSON.stringify(disk);
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    assert.deepEqual(await syncAccountsFromDisk(disk, mem, am), { added: replace ? 1 : 0, removed: replace ? 1 : 0 });
    assert.equal(logs.some(line => line === '[TeamClaude] Replaced account "original": its disk entry now names a different provider/account scope'), replace);
    assert.equal(logs.some(line => line.includes('Picked up new account')), false, 'existing entries are not fresh admissions');
    const current = am.accounts.find(a => a.id === 'b');
    assert.equal(current === old, !replace);
    for (const [field, value] of Object.entries(after)) assert.equal(current[field], value);
    assert.equal(current.credential, 'synthetic-new');
    assert.equal(am.sessionTracker.pinnedAccount('owned', 'unified7d'), replace ? null : current.index);
    assert.equal(am.accounts[am.sessionTracker.pinnedAccount('unrelated', 'unified7d')].id, 'a');
    assert.deepEqual(am.threadOwner('client', 'msg_owned'), { key: 'owned', conversation: 'opening' });
    assert.equal(JSON.stringify(disk), unchangedDisk, 'replacement must not remint its disk ID in memory');
    assert.deepEqual(mem.accounts.map(a => a.id).sort(), ['a', 'b']);
    assert.deepEqual(await syncAccountsFromDisk(JSON.parse(unchangedDisk), mem, am), { added: 0, removed: 0 });
    assert.equal(am.accounts.find(a => a.id === 'b'), current, 'a second reload must keep the rebuilt account');
    assert.deepEqual(am.accounts.map(a => a.id).sort(), ['a', 'b']);
    am.recordSession('fresh', current.index, 'claude-opus-5');
    const restarted = new AccountManager(JSON.parse(unchangedDisk).accounts.reverse(), 0.98, { distributeSessions: 'adaptive' });
    restarted.restoreAffinityState(JSON.parse(JSON.stringify(am.exportAffinityState())));
    assert.equal(restarted.accounts[restarted.sessionTracker.pinnedAccount('fresh', 'unified7d')].id, 'b');
    assert.equal(restarted.accounts[restarted.sessionTracker.pinnedAccount('unrelated', 'unified7d')].id, 'a');
    assert.deepEqual(restarted.threadOwner('client', 'msg_owned'), { key: 'owned', conversation: 'opening' });
    logs.length = 0;
    await syncAccountsFromDisk({ accounts: [...disk.accounts, { ...stable, id: 'c', name: 'new' }] }, mem, am);
    assert.deepEqual(logs, ['[TeamClaude] Picked up new account "new" from config'], 'a fresh admission stays distinct from replacement');
  });
}
