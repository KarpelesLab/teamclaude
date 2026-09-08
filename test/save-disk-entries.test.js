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

// The carryover used to ask a different question than the merge above it. The
// merge found an entry's disk row by identity and consumed it; the carryover
// then asked whether that row's id was among the kept ones, and appended the row
// the merge had just used. Two processes that minted different ids for one
// pre-id config made the two answers disagree for every row at once, and the
// list doubled.

const oauth = (id, name, over = {}) => ({
  id, name, type: 'oauth', accountUuid: `u-${name}`, orgUuid: 'o-1', accessToken: `disk-${id}`, ...over,
});
const mgr = (id, credential) => ({ id, credential, refreshToken: `r-${id}`, expiresAt: 1 });

test('a disk row already merged onto an entry is not appended again under its own id', () => {
  const cfg = [oauth('x1', 'a'), oauth('x2', 'b')];
  const disk = [oauth('y1', 'a'), oauth('y2', 'b')];
  const out = mergeAccountsForSave(cfg, [mgr('x1', 'live-a'), mgr('x2', 'live-b')], disk);

  assert.deepEqual(out.map(a => a.name), ['a', 'b'], 'one row per account, not two');
  assert.deepEqual(out.map(a => a.id), ['x1', 'x2'], 'and each keeps the id its account is paired by');
  assert.deepEqual(out.map(a => a.accessToken), ['live-a', 'live-b'], 'carrying the live credential, not the disk copy');
});

// Identity is not one-to-one: two entries for one person share it, which is the
// whole reason entries carry an id. Consuming disk rows one apiece is what keeps
// that pair from leaving a spare row behind for the carryover to append.
test('two entries sharing one identity consume one disk row each', () => {
  const cfg = [oauth('x1', 'p'), oauth('x2', 'p')];
  const disk = [oauth('y1', 'p'), oauth('y2', 'p')];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.id), ['x1', 'x2'], 'neither disk row survives as a third entry');
});

// Disk order is not entry order — a login rewrites the file from its own list.
// An exact id is evidence and identity is a fallback, so the id decides first.
test('an entry merges the disk row carrying its own id, whatever the disk order', () => {
  const cfg = [oauth('x1', 'p'), oauth('x2', 'p')];
  const disk = [oauth('x2', 'p', { importFrom: '/second' }), oauth('x1', 'p', { importFrom: '/first' })];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/first', '/second'], 'not the row identity happened to reach first');
});

// The other half of the carryover contract. The three tests above pin that a
// claimed row is not appended twice; this one pins that an unclaimed one is
// still appended, which is what an over-claiming pairing would silently break.
test('an account another process added survives a save whose ids disagree with disk', () => {
  const cfg = [oauth('x1', 'a')];
  const disk = [oauth('y1', 'a'), oauth('y2', 'added-by-login')];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.name), ['a', 'added-by-login'], 'the external addition is not swallowed by the identity claim');
});

// removedIds is keyed by id, so a row without one can never be recognised as a
// deletion in progress. Skipping it is what keeps the save that removes an
// account from writing it straight back.
test('an id-less disk row is not adopted over the removal it cannot be matched against', () => {
  const config = { accounts: [entry('i1', 'a'), entry('i2', 'doomed')] };
  markAccountRemoved(config, 'i2');
  config.accounts = config.accounts.filter(a => a.id !== 'i2');

  const disk = [{ name: 'a', type: 'apikey', apiKey: 'k' }, { name: 'doomed', type: 'apikey', apiKey: 'k' }];
  const out = mergeAccountsForSave(config.accounts, [], disk, removedAccountIds(config));

  assert.deepEqual(out.map(a => a.name), ['a'], 'the save that deletes it must not put it back');
});

// sameIdentity answers two different questions: it compares account uuids when
// both records carry one, and falls back to the display name when either does
// not. A claim consumes the row it matches, so an entry holding a uuid that
// settles for a namesake's row takes it away from the entry it belonged to —
// and `importFrom` on that row names the credentials file the entry reads at the
// next start. identity.js already orders these for the login axis (#236); the
// disk axis needs the same order.
test('an entry with a uuid claims the row that proves it, not a namesake without one', () => {
  const cfg = [
    { id: 'x2', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'o1' },
    { id: 'x1', name: 'p@example.com', type: 'oauth' },
  ];
  const disk = [
    { id: 'y0', name: 'p@example.com', type: 'oauth', importFrom: '/hand-added' },
    { id: 'y1', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'o1', importFrom: '/logged-in' },
  ];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/logged-in', '/hand-added'], 'the uuid is evidence; a shared display name is not');
  assert.equal(out[1].accountUuid, undefined, 'and the namesake does not acquire a uuid from a row that is not its own');
});

// The third rung of the same ladder. With uuids equal on both sides,
// sameIdentity compares organizations only when both are known and returns true
// when either is missing — so a legacy entry, whose org was never stored, matches
// any organization of that person. Claiming consumes, so it takes the row from
// the entry whose org actually names it.
test('an entry whose org is stored keeps its own row against a legacy namesake', () => {
  const cfg = [
    { id: 'x1', name: 'p@example.com', type: 'oauth', accountUuid: 'U' },
    { id: 'x2', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O2' },
  ];
  const disk = [
    { id: 'y2', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O2', importFrom: '/second-org' },
    { id: 'y1', name: 'p@example.com', type: 'oauth', accountUuid: 'U', importFrom: '/legacy' },
  ];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/legacy', '/second-org'], 'a known org outranks an unknown one');
});

// The other side of the same rung. Matching the person is not matching the
// account: one uuid spans every organization that person belongs to, so a claim
// made on a known organization has to match that organization and not merely
// its owner. This pass runs earliest of the three and consumes, so accepting the
// person alone here crosses two organizations' rows before any later pass can
// object.
test('two organizations of one person keep their own rows, whatever the disk order', () => {
  const cfg = [
    { id: 'x1', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O1' },
    { id: 'x2', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O2' },
  ];
  const disk = [
    { id: 'y2', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O2', importFrom: '/org-two' },
    { id: 'y1', name: 'p@example.com', type: 'oauth', accountUuid: 'U', orgUuid: 'O1', importFrom: '/org-one' },
  ];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/org-one', '/org-two'], 'a claim on a known org must match that org, not merely the person');
});

// One organization is not one account. Colleagues share an org key, so matching
// the organization alone pairs two different people — and this pass consumes,
// so it would hand each of them the other's credentials file.
test('colleagues in one organization keep their own rows', () => {
  const cfg = [
    { id: 'x1', name: 'a@example.com', type: 'oauth', accountUuid: 'U1', orgUuid: 'O' },
    { id: 'x2', name: 'b@example.com', type: 'oauth', accountUuid: 'U2', orgUuid: 'O' },
  ];
  const disk = [
    { id: 'y2', name: 'b@example.com', type: 'oauth', accountUuid: 'U2', orgUuid: 'O', importFrom: '/person-b' },
    { id: 'y1', name: 'a@example.com', type: 'oauth', accountUuid: 'U1', orgUuid: 'O', importFrom: '/person-a' },
  ];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/person-a', '/person-b'], 'a shared organization must not pair different people');
});

// An entry that already claimed its row by id must not claim a second one. A
// later pass that re-claims overwrites the record of the first, and the row it
// abandons is then suppressed by the keptIds guard rather than carried, because
// the entry still holds that row's id. So the row is not duplicated, it is lost —
// and the entry is left holding a credentials path that belongs to another row.
test('an entry that claimed its row by id does not claim a second one', () => {
  const cfg = [{ id: 'y1', name: 'a@example.com', type: 'oauth', accountUuid: 'U1', orgUuid: 'O' }];
  const disk = [
    { id: 'y1', name: 'a@example.com', type: 'oauth', accountUuid: 'U1', orgUuid: 'O', importFrom: '/its-own' },
    { id: 'y9', name: 'a@example.com', type: 'oauth', accountUuid: 'U1', orgUuid: 'O', importFrom: '/twin' },
  ];
  const out = mergeAccountsForSave(cfg, [], disk);

  assert.deepEqual(out.map(a => a.importFrom), ['/its-own', '/twin'], 'its own row merged, the twin carried over once');
});
