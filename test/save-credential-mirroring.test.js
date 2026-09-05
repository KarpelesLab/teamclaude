import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccountsForSave } from '../src/account-pairing.js';

// The save wrote `accessToken: am.credential` onto every entry. That is right
// for an ordinary oauth account and wrong for the other two kinds (#202, #204).

const mgr = (over) => ({ id: 'i1', name: 'a', credential: 'live-secret', refreshToken: 'r', expiresAt: 123, ...over });

test('an API-key entry does not get its key mirrored into accessToken', () => {
  const cfg = [{ id: 'i1', name: 'a', type: 'apikey', apiKey: 'k-old' }];
  const out = mergeAccountsForSave(cfg, [mgr({ credential: 'k-old' })], []);
  assert.equal(out[0].accessToken, undefined,
    'makeAccount reads accessToken||apiKey, so a mirror shadows a rotated key on the next cold start');
  assert.equal(out[0].apiKey, 'k-old');
});

// The consequence, spelled out: rotate the key on disk and a cold start must use
// the new one.
test('a rotated API key is what a fresh AccountManager would read', async () => {
  const cfg = [{ id: 'i1', name: 'a', type: 'apikey', apiKey: 'k-old' }];
  const saved = mergeAccountsForSave(cfg, [mgr({ credential: 'k-old' })], [])[0];
  const rotated = { ...saved, apiKey: 'k-new' };          // operator edits config.json
  const { AccountManager } = await import('../src/account-manager.js');
  const am = new AccountManager([rotated], 0.98);
  assert.equal(am.accounts[0].credential, 'k-new');
});

test('an importFrom entry does not get its delegated token materialised', () => {
  const cfg = [{ id: 'i1', name: 'a', type: 'oauth', importFrom: '~/.claude/.credentials.json' }];
  const out = mergeAccountsForSave(cfg, [mgr()], []);
  assert.equal(out[0].accessToken, undefined, 'the file is meant to stay authoritative');
  assert.equal(out[0].importFrom, '~/.claude/.credentials.json');
});

// The case the write exists for must keep working.
test('an ordinary oauth entry still persists its refreshed token', () => {
  const cfg = [{ id: 'i1', name: 'a', type: 'oauth', accessToken: 'stale', refreshToken: 'old', expiresAt: 1 }];
  const out = mergeAccountsForSave(cfg, [mgr()], []);
  assert.equal(out[0].accessToken, 'live-secret');
  assert.equal(out[0].refreshToken, 'r');
  assert.equal(out[0].expiresAt, 123);
});

test('an entry with no running account is left exactly as it was', () => {
  const cfg = [{ id: 'zz', name: 'gone', type: 'oauth', accessToken: 'kept' }];
  const out = mergeAccountsForSave(cfg, [], []);
  assert.equal(out[0].accessToken, 'kept');
});
