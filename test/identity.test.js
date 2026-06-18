import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgKey, sameIdentity, emailOf, matchAccounts } from '../src/identity.js';

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
