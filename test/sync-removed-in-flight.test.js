import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { markAccountRemoved } from '../src/account-pairing.js';
import { CredentialSync } from '../src/credential-sync.js';
import { ROUTING_FAILED } from '../src/account-routing.js';

// The TUI's remove changes memory first and saves second. A reload landing
// between the two reads the file the save has not rewritten yet, finds a row
// with no running account, and added it straight back — and the save then wrote
// it back too (#422). The removal is recorded for exactly that window, and the
// reload now reads it.

const entry = (id, name) => ({ id, name, type: 'apikey', apiKey: `k-${id}` });

function removing(markRemoved) {
  const disk = [entry('a', 'a@example.com'), entry('b', 'b@example.com')];
  const memConfig = { accounts: disk.map(a => ({ ...a })) };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  // What _doRemove has done by the time the racing reload arrives.
  am.removeAccount(1);
  memConfig.accounts.splice(1, 1);
  if (markRemoved) markAccountRemoved(memConfig, 'b');
  return { disk, memConfig, am };
}

test('a reload during a removal does not re-add the account from the stale file', async () => {
  const { disk, memConfig, am } = removing(true);
  const { added } = await syncAccountsFromDisk({ accounts: disk }, memConfig, am);
  assert.equal(added, 0);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com']);
  assert.deepEqual(memConfig.accounts.map(a => a.name), ['a@example.com']);
});

// The control: without the record the same row IS a new account, which is how an
// account added on disk reaches a running server.
test('the same row with no removal recorded is still adopted', async () => {
  const { disk, memConfig, am } = removing(false);
  const { added } = await syncAccountsFromDisk({ accounts: disk }, memConfig, am);
  assert.equal(added, 1);
  assert.deepEqual(am.accounts.map(a => a.name), ['a@example.com', 'b@example.com']);
});

// Work that holds an account across an await - a token refresh, a request
// awaiting upstream, a credential-sync pass - must not land on whichever account
// a removal slid into its old index. A token refresh used to persist the new
// pair against the index it was called with, writing one account's tokens into
// another's config row.

const oauthEntry = (name) => ({ name, type: 'oauth', accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() - 1000 });

function deferred() {
  /** @type {(v: any) => void} */ let resolve = () => {};
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('a token refresh that lands after a lower account is removed is persisted against the account it refreshed', async () => {
  const d = deferred();
  const am = new AccountManager([oauthEntry('x'), oauthEntry('a'), oauthEntry('b')], 0.98, { refreshFn: async () => d.promise });
  /** @type {Array<{ name: string|undefined, refreshToken: string }>} */
  const persisted = [];
  am.onTokenRefresh((index, tokens) => { persisted.push({ name: am.accounts[index]?.name, refreshToken: tokens.refreshToken }); });
  const inflight = am.ensureTokenFresh(1); // a, at index 1
  am.removeAccount(0); // x goes: a becomes 0, b becomes 1
  d.resolve({ accessToken: 'at-a2', refreshToken: 'rt-a2', expiresAt: Date.now() + 3600_000 });
  await inflight;
  assert.deepEqual(persisted, [{ name: 'a', refreshToken: 'rt-a2' }]);
  assert.equal(am.accounts[1].refreshToken, 'rt-b', "b keeps its own refresh token");
});

test('a token refresh of an account removed mid-flight persists nothing', async () => {
  const d = deferred();
  const am = new AccountManager([oauthEntry('a'), oauthEntry('b')], 0.98, { refreshFn: async () => d.promise });
  let persisted = 0;
  am.onTokenRefresh(() => { persisted++; });
  const inflight = am.ensureTokenFresh(0);
  am.removeAccount(0); // a goes: b becomes 0
  d.resolve({ accessToken: 'at-a2', refreshToken: 'rt-a2', expiresAt: Date.now() + 3600_000 });
  await inflight;
  assert.equal(persisted, 0);
  assert.equal(am.accounts[0].refreshToken, 'rt-b');
});

test('a removed account no longer names the account that took its index', () => {
  const am = new AccountManager([oauthEntry('a'), oauthEntry('b')], 0.98);
  const removed = am.accounts[0];
  am.removeAccount(0);
  assert.equal(removed.index, -1);
  // What a request that was in flight on the removed account does on a 401.
  am.markCredentialRejected(removed.index, 'token rejected');
  assert.notEqual(am.accounts[0].status, 'error', 'the surviving account is untouched');
});

test('a credential-sync adopt for an account removed during the pass leaves the others alone', () => {
  const am = new AccountManager([oauthEntry('a'), oauthEntry('b'), oauthEntry('c')], 0.98);
  const sync = new CredentialSync({ accountManager: am, addAccount: () => {}, log: () => {}, isSignedIn: async () => true });
  const b = am.accounts[1];
  am.removeAccount(1); // c now sits at index 1
  sync._adopt(b, /** @type {any} */ ({ by: 'other-host', accessToken: 'at-b2', refreshToken: 'rt-b2', expiresAt: Date.now() + 3600_000 }), 'newer');
  assert.equal(am.accounts[1].name, 'c');
  assert.equal(am.accounts[1].refreshToken, 'rt-c', "c keeps its own tokens");
});

test('a refresh whose routing proxy fails after a lower account is removed holds the right account', async () => {
  /** @type {(e: any) => void} */ let fail = () => {};
  const pending = new Promise((_, rej) => { fail = rej; });
  const routed = (name) => ({ ...oauthEntry(name), routing: 'socks5://127.0.0.1:1080' });
  const am = new AccountManager([routed('x'), routed('a'), routed('b')], 0.98, { refreshFn: async () => pending });
  const inflight = am.ensureTokenFresh(1); // a, at index 1
  am.removeAccount(0); // a becomes 0, b becomes 1
  fail(Object.assign(new Error('routing proxy down'), { code: ROUTING_FAILED }));
  await inflight;
  assert.equal(am.isRoutingDown(0), true, 'a, whose refresh failed, is held');
  assert.equal(am.isRoutingDown(1), false, 'b is not');
});
