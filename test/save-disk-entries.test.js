import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAccountsForSave, markAccountRemoved, removedAccountIds, clearRemovedAccountIds,
} from '../src/account-pairing.js';

// The save rebuilt the on-disk list as configAccounts.map(...), so it was
// exactly as long as the in-memory one and an account added to config.json by
// another process since the last reload — `teamclaude login` or `import` while
// the server runs — was dropped by the next save (#205).
//
// The trap: removal is ITSELF a save, so adopting disk-only rows without
// knowing which were deliberately deleted would resurrect the account being
// removed, on the very write meant to delete it.

const entry = (id, name, over = {}) => ({ id, name, type: 'apikey', apiKey: 'k', ...over });

test('an account added to disk since the last reload survives the save', () => {
  const cfg = [entry('i1', 'a')];
  const disk = [entry('i1', 'a'), entry('i2', 'added-by-login')];
  const out = mergeAccountsForSave(cfg, [], disk);
  assert.deepEqual(out.map(a => a.name).sort(), ['a', 'added-by-login']);
});

test('an account the operator removed is NOT resurrected', () => {
  const config = { accounts: [entry('i1', 'a'), entry('i2', 'doomed')] };
  // What _doRemove does: record the id, then drop the row.
  markAccountRemoved(config, 'i2');
  config.accounts = config.accounts.filter(a => a.id !== 'i2');

  // Disk still has it — this save is the one that deletes it.
  const disk = [entry('i1', 'a'), entry('i2', 'doomed')];
  const out = mergeAccountsForSave(config.accounts, [], disk, removedAccountIds(config));
  assert.deepEqual(out.map(a => a.name), ['a']);
});

// Both at once: one row deleted, another added externally, in the same save.
test('a removal and an external addition are both honoured', () => {
  const config = { accounts: [entry('i1', 'a'), entry('i2', 'doomed')] };
  markAccountRemoved(config, 'i2');
  config.accounts = config.accounts.filter(a => a.id !== 'i2');

  const disk = [entry('i1', 'a'), entry('i2', 'doomed'), entry('i3', 'new')];
  const out = mergeAccountsForSave(config.accounts, [], disk, removedAccountIds(config));
  assert.deepEqual(out.map(a => a.name).sort(), ['a', 'new']);
});

// Once the write omits them they are gone from disk, so holding the ids would
// only refuse the same account if the operator re-added it later.
test('the removal record is cleared after the save that applies it', () => {
  const config = { accounts: [] };
  markAccountRemoved(config, 'i2');
  assert.equal(removedAccountIds(config).has('i2'), true);
  clearRemovedAccountIds(config);
  assert.equal(removedAccountIds(config).has('i2'), false);

  // Re-adding the same account later must now stick.
  const disk = [entry('i2', 'back-again')];
  const out = mergeAccountsForSave([], [], disk, removedAccountIds(config));
  assert.deepEqual(out.map(a => a.name), ['back-again']);
});

// The bookkeeping must never reach the config file.
test('the removal record is not serialised into config.json', () => {
  const config = { accounts: [entry('i1', 'a')], proxy: { port: 3456 } };
  markAccountRemoved(config, 'i9');
  const round = JSON.parse(JSON.stringify(config));
  assert.deepEqual(Object.keys(round).sort(), ['accounts', 'proxy']);
  assert.ok(!JSON.stringify(config).includes('i9'));
});

test('a disk row with no id is left to the identity merge, not duplicated', () => {
  const cfg = [entry('i1', 'a')];
  const disk = [{ name: 'a', type: 'apikey', apiKey: 'k' }];   // pre-id row
  const out = mergeAccountsForSave(cfg, [], disk);
  assert.equal(out.length, 1, 'a pre-id row must not be appended alongside its own entry');
});
