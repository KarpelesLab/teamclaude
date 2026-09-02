import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orgKey,
  sameIdentity,
  emailOf,
  matchAccounts,
  findUpsertTarget,
  distinctAccounts,
  canUpsertOAuthAccount,
  oauthIdentityFields,
} from '../src/identity.js';

test('orgKey prefers orgUuid, falls back to orgName, else null', () => {
  assert.equal(orgKey({ orgUuid: 'u1', orgName: 'Acme' }), 'u1');
  assert.equal(orgKey({ orgName: 'Acme' }), 'Acme');
  assert.equal(orgKey({}), null);
  assert.equal(orgKey(null), null);
});

test('same person, same org → same identity', () => {
  const a = { accountUuid: 'p1', orgUuid: 'o1' };
  const b = { accountUuid: 'p1', orgUuid: 'o1' };
  assert.equal(sameIdentity(a, b), true);
});

test('same person, different org → distinct identities', () => {
  const a = { accountUuid: 'p1', orgUuid: 'o1' };
  const b = { accountUuid: 'p1', orgUuid: 'o2' };
  assert.equal(sameIdentity(a, b), false);
});

test('different person → distinct identities regardless of org', () => {
  const a = { accountUuid: 'p1', orgUuid: 'o1' };
  const b = { accountUuid: 'p2', orgUuid: 'o1' };
  assert.equal(sameIdentity(a, b), false);
});

test('legacy entry (no org) matches a freshly-profiled login of the same person (backfill path)', () => {
  const legacy = { accountUuid: 'p1', name: 'a@x.com' };          // no org stored yet
  const fresh = { accountUuid: 'p1', orgUuid: 'o1', name: 'a@x.com' };
  assert.equal(sameIdentity(legacy, fresh), true);
});

test('orgName falls back as discriminator when orgUuid absent', () => {
  const a = { accountUuid: 'p1', orgName: 'Acme' };
  const b = { accountUuid: 'p1', orgName: 'Personal' };
  assert.equal(sameIdentity(a, b), false);
  const c = { accountUuid: 'p1', orgName: 'Acme' };
  assert.equal(sameIdentity(a, c), true);
});

// The migration scenario end-to-end: a legacy entry exists, then two different
// orgs for the same person are added in sequence. After the first add backfills
// the legacy entry's org, the second org must be recognized as distinct.
test('legacy + two different orgs added in sequence resolves to two distinct accounts', () => {
  const accounts = [{ accountUuid: 'p1', name: 'a@x.com' }]; // legacy, org unknown

  // First login carries org o1: matches the legacy entry (one org unknown) → backfill in place.
  const first = { accountUuid: 'p1', orgUuid: 'o1', name: 'a@x.com' };
  let idx = accounts.findIndex(a => sameIdentity(a, first));
  assert.equal(idx, 0);
  accounts[idx] = { ...accounts[idx], ...first };

  // Second login carries org o2: both org keys now known and differ → new account.
  const second = { accountUuid: 'p1', orgUuid: 'o2', name: 'a@x.com' };
  idx = accounts.findIndex(a => sameIdentity(a, second));
  assert.equal(idx, -1);
  accounts.push(second);

  assert.equal(accounts.length, 2);
});

test('apikey / no-uuid accounts fall back to name matching', () => {
  assert.equal(sameIdentity({ name: 'k1' }, { name: 'k1' }), true);
  assert.equal(sameIdentity({ name: 'k1' }, { name: 'k2' }), false);
});

test('emailOf strips a " (org)" suffix', () => {
  assert.equal(emailOf({ name: 'a@x.com (Acme)' }), 'a@x.com');
  assert.equal(emailOf({ name: 'a@x.com' }), 'a@x.com');
  assert.equal(emailOf({}), '');
});

// resolveAccount in index.js is built on matchAccounts; cover the routing here.
const ACCTS = [
  { name: 'a@x.com (Acme)', accountUuid: 'p1', orgUuid: 'o-acme', orgName: 'Acme' },
  { name: 'a@x.com (Personal)', accountUuid: 'p1', orgUuid: 'o-pers', orgName: 'Personal' },
  { name: 'b@y.com', accountUuid: 'p2', orgUuid: 'o-b', orgName: 'BizCo' },
];

test('matchAccounts: exact display-name match wins', () => {
  const m = matchAccounts(ACCTS, 'a@x.com (Acme)');
  assert.equal(m.length, 1);
  assert.equal(m[0].orgName, 'Acme');
});

test('matchAccounts: bare email is ambiguous across orgs', () => {
  const m = matchAccounts(ACCTS, 'a@x.com');
  assert.equal(m.length, 2);
});

test('matchAccounts: --org narrows by org name or uuid prefix', () => {
  assert.equal(matchAccounts(ACCTS, 'a@x.com', 'Personal').length, 1);
  assert.equal(matchAccounts(ACCTS, 'a@x.com', 'o-acme').length, 1);
  assert.equal(matchAccounts(ACCTS, 'a@x.com', 'o-ac')[0].orgName, 'Acme'); // uuid prefix
});

test('matchAccounts: unique email needs no org', () => {
  assert.equal(matchAccounts(ACCTS, 'b@y.com').length, 1);
});

test('matchAccounts: no match returns empty', () => {
  assert.equal(matchAccounts(ACCTS, 'nobody@z.com').length, 0);
});

// The failure this guards against: one person, two organizations. Both entries
// are auto-named from the same email, so a name match is not evidence that the
// incoming login is the same account — and taking it as such overwrites the
// other org's entry. The account disappears from the config while the running
// server still holds it in memory, so the loss only becomes visible at the next
// restart, far from the login that caused it.
test('findUpsertTarget: a second org of the same person is a NEW entry, not an overwrite', () => {
  const accounts = [
    { name: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-personal', orgName: 'Personal' },
  ];
  const incoming = { name: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-acme', orgName: 'Acme' };
  assert.equal(findUpsertTarget(accounts, incoming), -1);
});

test('findUpsertTarget: the same account+org updates in place', () => {
  const accounts = [
    { name: 'a@x.com (Personal)', accountUuid: 'u1', orgUuid: 'o-personal' },
    { name: 'a@x.com (Acme)', accountUuid: 'u1', orgUuid: 'o-acme' },
  ];
  assert.equal(findUpsertTarget(accounts, { name: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-acme' }), 1);
});

// A legacy entry predating stored org UUIDs must still be backfilled rather than
// duplicated — "org unknown" means cannot tell, not different.
test('findUpsertTarget: an entry with no org backfills instead of duplicating', () => {
  const accounts = [{ name: 'a@x.com', accountUuid: 'u1' }];
  assert.equal(findUpsertTarget(accounts, { name: 'a@x.com', accountUuid: 'u1', orgUuid: 'o-acme' }), 0);
});

test('findUpsertTarget: matches by name when neither side carries a UUID', () => {
  const accounts = [{ name: 'a@x.com' }];
  assert.equal(findUpsertTarget(accounts, { name: 'a@x.com', accountUuid: null }), 0);
});

// Two different people whose entries somehow share a display name must not
// collapse into one either.
test('findUpsertTarget: a different person with the same name is a new entry', () => {
  const accounts = [{ name: 'shared', accountUuid: 'u1', orgUuid: 'o1' }];
  assert.equal(findUpsertTarget(accounts, { name: 'shared', accountUuid: 'u2', orgUuid: 'o2' }), -1);
});

test('distinctAccounts: unknown identity on either side is never "different"', () => {
  assert.equal(distinctAccounts({ name: 'a' }, { name: 'a', accountUuid: 'u1' }), false);
  assert.equal(distinctAccounts({ accountUuid: 'u1' }, { accountUuid: 'u1', orgUuid: 'o1' }), false);
  assert.equal(distinctAccounts({ accountUuid: 'u1', orgUuid: 'o1' }, { accountUuid: 'u1', orgUuid: 'o2' }), true);
});

test('anonymous OAuth upsert requires an identifiable profile', () => {
  assert.equal(canUpsertOAuthAccount(null, false), false);
  assert.equal(canUpsertOAuthAccount({ error: 'expired token' }, false), false);
  assert.equal(canUpsertOAuthAccount({}, false), false);
  assert.equal(canUpsertOAuthAccount({ email: 'account@example.com' }, false), true);
  assert.equal(canUpsertOAuthAccount({ accountUuid: 'account-uuid' }, false), true);
});

test('explicitly named OAuth upsert remains available without a profile', () => {
  assert.equal(canUpsertOAuthAccount(null, true), true);
  assert.equal(canUpsertOAuthAccount({ error: 'offline' }, true), true);
});

test('unavailable profile fields do not erase stored OAuth identity', () => {
  const stored = { accountUuid: 'account-uuid', orgUuid: 'org-uuid', orgName: 'Example' };

  assert.deepEqual({ ...stored, ...oauthIdentityFields({ error: 'offline' }) }, stored);
  assert.deepEqual({ ...stored, ...oauthIdentityFields({ email: 'account@example.com' }) }, stored);
  assert.deepEqual(oauthIdentityFields({
    accountUuid: 'new-account',
    orgUuid: 'new-org',
    orgName: 'New Example',
  }), {
    accountUuid: 'new-account',
    orgUuid: 'new-org',
    orgName: 'New Example',
  });
});
