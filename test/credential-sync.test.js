import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { getCallbackAuthPath, saveCallbackToken } from '../src/callback-auth.js';
import { CredentialSync, refreshOutsideProxy, syncKeyFor, isSyncable, encodeBlob, decodeBlob, entryFromBlob, needsSignIn, tombstoneOf, tombstone, KEY_PREFIX, TOMBSTONE_TTL_MS, REMOVAL_PENDING_MAX_MS } from '../src/credential-sync.js';

// Credential sync through callback.net: every signed-in install keeps its OAuth
// account tokens in the user's credential store and follows it. The store here
// is in memory, speaking the live API's shapes (rows with Data, Updated.unixms,
// `error_credential_locked`, `error_key_exists`), and the account manager is the
// real one with the provider refresh stubbed.

const H = 3600_000;
const T0 = 1_700_000_000_000;

const claude = (name, extra = {}) => ({
  name, type: 'oauth', accountUuid: `uuid-${name}`, orgUuid: `org-${name}`, orgName: `Org ${name}`,
  accessToken: `at-${name}-1`, refreshToken: `rt-${name}-1`, expiresAt: T0 + 8 * H, ...extra,
});
const codex = (name, extra = {}) => ({
  name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, userId: `user-${name}`,
  accessToken: `at-${name}-1`, refreshToken: `rt-${name}-1`, expiresAt: T0 + 8 * H, ...extra,
});

/** The store. `calls` records every API call; `locked` is the lock's state. */
function makeStore() {
  const rows = new Map(); // id → { User_Credential__, Key, Data, Updated, Locked }
  const calls = [];
  let seq = 0;
  let clock = T0;
  const err = (code, token, error) => Object.assign(new Error(error), { code, token });
  const stamp = () => ({ unixms: String(clock), unix: Math.floor(clock / 1000) });
  const view = (r) => ({ ...r, Updated: { ...r.Updated }, Locked: r.Locked ? { ...r.Locked } : null });
  const api = async (method, path, params = null, opts = {}) => {
    calls.push({ method, path, params });
    const m = path.match(/^User\/Credential(?:\/([^:]+))?(?::(\w+))?$/);
    if (!m) throw err(404, 'error_not_found', 'Not Found');
    const [, id, fn] = m;
    if (!id) {
      if (method === 'GET') {
        const all = [...rows.values()].map(view);
        const per = params?.results_per_page || 20;
        const page = params?.page_no || 1;
        const data = all.slice((page - 1) * per, page * per);
        const envelope = { result: 'success', data, paging: { page_no: page, count: all.length, page_max: Math.max(1, Math.ceil(all.length / per)), results_per_page: per } };
        return opts.envelope ? envelope : data;
      }
      if (method === 'POST') {
        if ([...rows.values()].some((r) => r.Key === params.Key)) throw err(400, 'error_key_exists', 'A credential with this key already exists on field Key');
        const row = { User_Credential__: `uscrd-${++seq}`, Key: params.Key, Data: params.Data, Updated: stamp(), Locked: null };
        rows.set(row.User_Credential__, row);
        return view(row);
      }
    }
    const row = rows.get(id);
    if (!row) throw err(404, 'error_not_found', `Not Found: User\\Credential(${id})`);
    if (fn === 'lock') {
      // As measured on the live API: the TAKER's timeout (30s when it names
      // none) decides whether a held lock has lapsed, whoever took it.
      if (row.Locked && clock - Number(row.Locked.unixms) < (params?.timeout ?? 30) * 1000) throw err(0, 'error_credential_locked', 'Credential is locked');
      row.Locked = stamp();
      return view(row);
    }
    if (fn === 'unlock') { row.Locked = null; return view(row); } // anyone's, held or not, as live
    if (method === 'GET') return view(row);
    if (method === 'PATCH') { row.Data = params.Data; row.Updated = stamp(); return view(row); }
    if (method === 'DELETE') { rows.delete(id); return true; }
    throw err(405, 'error_method', 'nope');
  };
  return {
    api, calls, rows,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    byKey: (key) => [...rows.values()].find((r) => r.Key === key) || null,
    blob: (key) => { const r = [...rows.values()].find((x) => x.Key === key); return r ? JSON.parse(r.Data) : null; },
    put: (key, blob) => { const row = { User_Credential__: `uscrd-${++seq}`, Key: key, Data: JSON.stringify(blob), Updated: stamp(), Locked: null }; rows.set(row.User_Credential__, row); return row; },
  };
}

/** A fleet and a sync over a store. */
// `minted`: the fleet's tokens were renewed on this install, so the sync may
// store them (see isMinted); false for a fleet fresh from its config.
// `fromFile`: whether it is signed in, and under which session, is read from
// the callback.net token file, as index.js has it; else `signOut`, `signIn`
// and `signInAs` say.
function setup(entries, { store = makeStore(), signedIn = true, refresh, minted = true, fromFile = false } = {}) {
  const refreshed = [];
  // Each provider call, with the lock state of its row as the call went out.
  const sent = [];
  const am = new AccountManager(entries, 0.98, {
    refreshFn: async (rt, _endpoint, _routing, opts) => {
      refreshed.push(rt);
      sent.push({ rt, budgetMs: opts?.budgetMs, locked: [...store.rows.values()].some((r) => r.Locked) });
      return refresh ? refresh(rt) : { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H };
    },
    codexRefreshFn: async (rt) => { refreshed.push(rt); return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H }; },
  });
  const persisted = [];
  am.onTokenRefresh((idx, tokens) => { persisted.push([am.accounts[idx].name, tokens]); sync.onLocalTokens(idx, tokens); });
  const admitted = [];
  const evicted = [];
  const logs = [];
  let signed = signedIn;
  let session = 'session-1';
  const sleeps = [];
  const removals = [];
  const sync = new CredentialSync({
    accountManager: am, api: store.api, by: 'this-box', now: store.now, log: (l) => logs.push(l),
    isSignedIn: fromFile ? undefined : async () => signed,
    session: fromFile ? undefined : async () => (signed ? session : null),
    sleep: async (ms) => { sleeps.push(ms); store.tick(ms); },
    addAccount: (entry) => { admitted.push(entry); return am.addAccount(entry); },
    evictAccount: (account) => { evicted.push(account.name); am.removeAccount(account.index); },
  });
  am.setRefreshCoordinator((account, refresh, info) => sync.coordinateRefresh(account, refresh, info)); // as index.js wires it
  am.onAccountRemoved((account) => { removals.push(sync.onAccountRemoved(account)); });
  const recoveries = [];
  am.onAccountError((account) => { recoveries.push(sync.onAccountError(account)); });
  if (minted) for (const a of am.accounts) a._minted = true;
  // Every tombstone write a removal started, settled.
  const settled = () => Promise.all(removals);
  return { am, sync, store, refreshed, sent, persisted, admitted, evicted, logs, sleeps, settled, recoveries, signOut: () => { signed = false; }, signIn: () => { signed = true; }, signInAs: (s) => { signed = true; session = s; } };
}

const tokensOf = (a) => ({ accessToken: a.credential, refreshToken: a.refreshToken, expiresAt: a.expiresAt });

// ── the pieces ───────────────────────────────────────────────

test('only OAuth logins to a provider we refresh are synced, keyed by identity and never by the config id', () => {
  assert.equal(syncKeyFor(claude('a')), `${KEY_PREFIX}anthropic.uuid-a.org-a`);
  assert.equal(syncKeyFor(claude('a', { orgUuid: undefined })), `${KEY_PREFIX}anthropic.uuid-a.Org_a`);
  assert.equal(syncKeyFor(codex('c')), `${KEY_PREFIX}codex.acct-c`);
  // The same person on two installs: the same key, whatever ids the configs minted.
  assert.equal(syncKeyFor({ ...claude('a'), id: 'id-1' }), syncKeyFor({ ...claude('a'), id: 'id-2' }));
  for (const not of [
    { name: 'k', type: 'apikey', apiKey: 'k' },
    claude('b', { upstream: 'https://gateway.example' }),
    claude('n', { accountUuid: undefined }),
    { ...codex('c'), accountId: undefined },
    null, undefined,
  ]) {
    assert.equal(isSyncable(not), false, JSON.stringify(not));
    assert.equal(syncKeyFor(not), null);
  }
  // A key never carries a slash or a space, whatever the organization is called.
  assert.doesNotMatch(syncKeyFor(claude('a', { orgUuid: undefined, orgName: 'Acme / R&D team' })), /[/ &]/);
});

test('a row carries identity and tokens, and only a blob of this version reads back', () => {
  const a = { ...claude('a'), priority: 5, disabled: true, routing: 'socks5://x', displayOrder: 2, index: 0, credential: 'at-a-1' };
  const blob = encodeBlob(a, tokensOf(a), { now: T0, by: 'home' });
  assert.deepEqual(blob, {
    v: 1, provider: 'anthropic', name: 'a', accountUuid: 'uuid-a', orgUuid: 'org-a', orgName: 'Org a',
    accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H, updatedAt: T0, by: 'home',
  });
  assert.deepEqual(decodeBlob(JSON.stringify(blob)), blob);
  assert.deepEqual(entryFromBlob(blob), { name: 'a', type: 'oauth', accountUuid: 'uuid-a', orgUuid: 'org-a', orgName: 'Org a', accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H });
  assert.equal(entryFromBlob(encodeBlob(codex('c'), tokensOf({ credential: 'x', refreshToken: 'y', expiresAt: 1 }))).provider, 'codex');
  for (const bad of ['', 'nope', '{}', JSON.stringify({ ...blob, v: 2 }), JSON.stringify({ ...blob, accessToken: '' }), JSON.stringify({ ...blob, expiresAt: 'soon' }), 7, null]) {
    assert.equal(decodeBlob(bad), null, String(bad));
  }
  // A tombstone is the other thing a row can hold: a time, and nothing else.
  assert.deepEqual(tombstone(T0), { _deleted: new Date(T0).toISOString() });
  assert.equal(tombstoneOf(JSON.stringify(tombstone(T0))), T0);
  assert.equal(tombstoneOf(JSON.stringify({ _deleted: T0 })), T0);
  assert.equal(decodeBlob(JSON.stringify(tombstone(T0))), null);
  for (const not of [JSON.stringify(blob), '{}', JSON.stringify({ _deleted: 'whenever' }), 'nope', null]) assert.equal(tombstoneOf(not), null, String(not));
});

// ── the pass ─────────────────────────────────────────────────

test('signed out, nothing happens', async () => {
  const { sync, store, am } = setup([claude('a')], { signedIn: false });
  assert.deepEqual(await sync.sync(), { signedIn: false, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 0 });
  assert.equal(store.calls.length, 0);
  // A refresh is a plain refresh.
  await am.ensureTokenFresh(0, true);
  assert.equal(store.calls.length, 0);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
});

test('the first pass stores every syncable account, and only those', async () => {
  const { sync, store } = setup([claude('a'), codex('c'), { name: 'k', type: 'apikey', apiKey: 'k' }, claude('g', { upstream: 'https://gw.example' })]);
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 2, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 0 });
  assert.deepEqual([...store.rows.values()].map((x) => x.Key).sort(), [`${KEY_PREFIX}anthropic.uuid-a.org-a`, `${KEY_PREFIX}codex.acct-c`]);
  const blob = store.blob(`${KEY_PREFIX}anthropic.uuid-a.org-a`);
  assert.equal(blob.accessToken, 'at-a-1');
  assert.equal(blob.by, 'this-box');
  // A second pass changes nothing.
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 2 });
});

test('a row with no local account becomes one, with its tokens and identity but none of another install\'s settings', async () => {
  const store = makeStore();
  const other = { ...claude('b'), credential: 'at-b-7', refreshToken: 'rt-b-7', expiresAt: T0 + 6 * H, priority: 9, disabled: true };
  store.put(syncKeyFor(other), encodeBlob(other, tokensOf(other), { now: T0, by: 'office' }));
  store.put('someone-elses-key', { whatever: true });
  const { sync, am, admitted, logs } = setup([claude('a')], { store });
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 1, added: 1, evicted: 0, expired: 0, emptied: 0, rows: 1 });
  assert.deepEqual(admitted, [{ name: 'b', type: 'oauth', accountUuid: 'uuid-b', orgUuid: 'org-b', orgName: 'Org b', accessToken: 'at-b-7', refreshToken: 'rt-b-7', expiresAt: T0 + 6 * H }]);
  assert.equal(am.accounts[1].name, 'b');
  assert.equal(am.accounts[1].priority, 0);
  assert.equal(am.accounts[1].disabled, false);
  assert.ok(logs.some((l) => /"b" added from callback.net \(signed in on office\)/.test(l)), logs.join('\n'));
});

test('a long-lived account near its end takes no refreshing login from the store, healthy or rejected', async () => {
  const store = makeStore();
  const a = claude('a', { refreshToken: undefined, longLived: true, expiresAt: T0 + H });
  const ordinary = { ...a, credential: 'at-a-9', refreshToken: 'rt-a-9', expiresAt: T0 + 20 * H };
  store.put(syncKeyFor(claude('a')), encodeBlob(ordinary, tokensOf(ordinary), { now: T0 + 12 * H, by: 'office' }));
  const { sync, am, admitted } = setup([a], { store });

  const r = await sync.sync('start');
  assert.equal(r.adopted, 0);
  assert.equal(r.added, 0);
  assert.deepEqual(admitted, []);
  assert.equal(am.accounts.length, 1);
  assert.equal(am.accounts[0].credential, 'at-a-1');
  assert.equal(am.accounts[0].refreshToken, null);
  assert.equal(am.accounts[0].longLived, true);

  // A 401 on it does not pull the store's refreshing login in either.
  am.accounts[0].status = 'error';
  assert.equal(await sync.onAccountError(am.accounts[0]), false);
  assert.equal(am.accounts[0].credential, 'at-a-1');
  assert.equal(am.accounts[0].status, 'error');
});

test('the newer token wins each way: the store\'s is adopted, this install\'s is stored', async () => {
  const store = makeStore();
  const a = claude('a');
  const fresher = { ...a, credential: 'at-a-9', refreshToken: 'rt-a-9', expiresAt: T0 + 20 * H };
  store.put(syncKeyFor(a), encodeBlob(fresher, tokensOf(fresher), { now: T0 + 12 * H, by: 'office' }));
  const b = claude('b');
  const staler = { ...b, credential: 'at-b-0', refreshToken: 'rt-b-0', expiresAt: T0 + 1 * H };
  store.put(syncKeyFor(b), encodeBlob(staler, tokensOf(staler), { now: T0 - H, by: 'office' }));
  const { sync, am, persisted, store: s } = setup([a, b], { store });

  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 1, pushed: 1, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 2 });
  assert.equal(am.accounts[0].credential, 'at-a-9');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-9');
  assert.equal(am.accounts[0].expiresAt, T0 + 20 * H);
  // Adopting persists like any token change, and does not come back round as a write.
  assert.deepEqual(persisted, [['a', { accessToken: 'at-a-9', refreshToken: 'rt-a-9', expiresAt: T0 + 20 * H }]]);
  assert.equal(s.calls.filter((c) => c.method === 'PATCH').length, 1, 'one PATCH: b');
  assert.equal(s.blob(syncKeyFor(b)).accessToken, 'at-b-1');
  assert.equal(s.blob(syncKeyFor(b)).by, 'this-box');
});

test('a local token change is stored only once renewed here; one the store already holds is not echoed', async () => {
  const { sync, am, store } = setup([claude('a')]);
  await sync.sync();
  const writes = () => store.calls.filter((c) => c.method === 'PATCH' || (c.method === 'POST' && c.path === 'User/Credential')).length;
  const before = writes();
  // New tokens from disk (a reload): not minted here, so not stored, nor by a pass.
  am.updateAccountTokens(0, { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 9 * H });
  await new Promise((r) => setImmediate(r));
  await sync.sync();
  assert.equal(writes(), before);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-1');
  // Their renewal stores what it minted.
  await am.ensureTokenFresh(0, true);
  assert.equal(writes(), before + 1);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-2-renewed-at');
  // The same tokens again: nothing to store.
  am.updateAccountTokens(0, { accessToken: 'rt-a-2-renewed-at', refreshToken: 'rt-a-2-renewed-rt', expiresAt: am.accounts[0].expiresAt });
  await new Promise((r) => setImmediate(r));
  await sync.sync();
  assert.equal(writes(), before + 1);
});

test('a row of ours that does not read is rewritten; a store that fails leaves the fleet as it was', async () => {
  const store = makeStore();
  store.put(syncKeyFor(claude('a')), { v: 99, garbage: true });
  const { sync, am } = setup([claude('a')], { store });
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 1, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 1 });
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-1');

  const broken = setup([claude('b')], { store: { ...makeStore(), api: async () => { throw new Error('fetch failed'); } } });
  await assert.rejects(broken.sync.sync('start'), /fetch failed/);
  assert.match(broken.sync.summary().lastError, /fetch failed/);
  assert.equal(broken.am.accounts[0].credential, 'at-b-1');
});

test('an account removed here leaves a tombstone, and the other installs remove it at their next pass', async () => {
  const store = makeStore();
  const home = setup([claude('a'), claude('b')], { store });
  const office = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  await office.sync.sync();

  home.am.removeAccount(1); // b leaves the home install
  await home.settled();
  const row = store.byKey(syncKeyFor(claude('b')));
  assert.deepEqual(JSON.parse(row.Data), { _deleted: new Date(store.now()).toISOString() });
  // Home's own next pass: nothing comes back.
  assert.deepEqual(await home.sync.sync(), { signedIn: true, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 2 });
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a']);

  // The office install follows.
  const r = await office.sync.sync('daily');
  assert.equal(r.evicted, 1);
  assert.deepEqual(office.evicted, ['b']);
  assert.deepEqual(office.am.accounts.map((a) => a.name), ['a']);
  assert.ok(office.logs.some((l) => /"b" was removed on another install .*; removing it here/.test(l)), office.logs.join('\n'));
  // Its eviction does not write a second tombstone over the first.
  await office.settled();
  assert.equal(JSON.parse(store.byKey(syncKeyFor(claude('b'))).Data)._deleted, new Date(store.now()).toISOString());
  assert.equal(store.calls.filter((c) => c.method === 'PATCH' && c.params.Data.includes('_deleted')).length, 1);
  assert.deepEqual(office.sync.summary(), { lastSyncAt: store.now(), lastError: null, rows: 1, tombstones: 1, signInNeeded: 0 });
});

test('a refresh never brings a removed account back; a sign-in does', async () => {
  const store = makeStore();
  const home = setup([claude('a')], { store });
  const office = setup([claude('a')], { store });
  await home.sync.sync();
  await office.sync.sync();
  home.am.removeAccount(0);
  await home.settled();

  // The office install, not yet synced, has the token expire: the lock finds
  // the tombstone, the request is served with a plain renewal, and the pass
  // that follows takes the account out.
  await office.am.ensureTokenFresh(0, true);
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  await new Promise((r) => setImmediate(r));
  await office.sync.sync(); // the pass the coordinator started, or this one — either removes it
  assert.deepEqual(office.am.accounts, []);
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('a'))).Data), null, 'the renewal did not write over the tombstone');

  // A token change that is not a sign-in (a relayed client refresh) does not either.
  const third = setup([claude('a')], { store });
  third.am.updateAccountTokens(0, { accessToken: 'at-a-5', refreshToken: 'rt-a-5', expiresAt: T0 + 30 * H });
  await new Promise((r) => setImmediate(r));
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('a'))).Data), null);

  // Signing in again anywhere replaces the tombstone, and the account is back
  // on every install's next pass.
  store.tick(H);
  const entry = claude('a', { accessToken: 'at-a-new', refreshToken: 'rt-a-new', expiresAt: store.now() + 8 * H });
  assert.equal(await home.sync.storeSignIn(entry), true);
  assert.equal(store.blob(syncKeyFor(claude('a'))).accessToken, 'at-a-new');
  const r = await office.sync.sync();
  assert.equal(r.added, 1);
  assert.equal(office.am.accounts[0].credential, 'at-a-new');
  // Not for an account the sync does not carry, and not when signed out.
  assert.equal(await home.sync.storeSignIn({ name: 'k', type: 'apikey', apiKey: 'k' }), false);
  home.signOut();
  assert.equal(await home.sync.storeSignIn(entry), false);
});

test('a removal made while another install renews waits for its lock, so the renewal does not write over the tombstone', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('a'));
  const home = setup([claude('a')], { store });
  let homeWaiting = false;
  let renewed;
  const renewedDone = new Promise((r) => { renewed = r; });
  const office = setup([claude('a')], {
    store,
    refresh: async (rt) => {
      // The account is removed at home while office's grant is out, under the lock.
      home.am.removeAccount(0);
      // Let home go as far as it can: write its tombstone, or wait for the lock.
      for (let i = 0; i < 100 && !homeWaiting && tombstoneOf(store.byKey(key).Data) == null; i++) await new Promise((r) => setImmediate(r));
      return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H };
    },
  });
  await home.sync.sync();
  await office.sync.sync();
  // Home's waits end only once office's renewal is stored and its lock released.
  const homeSleeps = [];
  home.sync.sleep = async (ms) => { homeWaiting = true; homeSleeps.push(ms); await renewedDone; store.tick(ms); };
  await office.am.ensureTokenFresh(0, true);
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  assert.equal(store.blob(key).accessToken, 'rt-a-1-renewed-at', 'the renewal was stored first');
  renewed();
  const [written] = await home.settled();
  assert.equal(homeWaiting, true, 'home waited for the lock');
  assert.deepEqual(homeSleeps, [5000], 'a re-check of the lock 5s on, not a later retry');
  assert.equal(written, true);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null, 'the tombstone stands');
  assert.equal(store.byKey(key).Locked, null, 'and the lock is released');
  assert.equal((await office.sync.sync()).evicted, 1);
  assert.deepEqual(office.am.accounts, []);
});

test('a renewal that outlasts its lease reads the row again, and does not write over a tombstone stored meanwhile', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('a'));
  const home = setup([claude('a')], { store });
  const office = setup([claude('a')], {
    store,
    refresh: async (rt) => {
      // The lease runs out while the grant is out, and the removal at home takes the lock.
      store.tick(31_000);
      home.am.removeAccount(0);
      await home.settled();
      return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H };
    },
  });
  await home.sync.sync();
  await office.sync.sync();
  await office.am.ensureTokenFresh(0, true);
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  assert.deepEqual(office.persisted.map(([, t]) => t.accessToken), ['rt-a-1-renewed-at'], 'the request still gets its renewed token');
  const [written] = await home.settled();
  assert.equal(written, true);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null, 'the late renewal did not write over the tombstone');
  assert.ok(office.logs.some((l) => /outlasted the callback\.net lock/.test(l)), office.logs.join('\n'));
  await office.sync.sync();
  assert.deepEqual(office.am.accounts, []);
});

test('a removal finds a row another install stored after the last pass, and records it', async () => {
  const store = makeStore();
  const office = setup([claude('a')], { store });
  await office.sync.sync(); // the store holds a, not b
  // Home stores nothing of its own, so all it has seen is a's row.
  const home = setup([claude('a'), claude('b')], { store, minted: false });
  await home.sync.sync();
  const later = setup([claude('b')], { store });
  await later.sync.sync(); // b's row, made after home's pass
  home.am.removeAccount(1);
  const [written] = await home.settled();
  assert.equal(written, true);
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('b'))).Data), null);
  assert.equal((await home.sync.sync()).added, 0, 'home does not add it back');
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a']);
  assert.equal((await later.sync.sync()).evicted, 1);
});

test('a removal the store could not take is not added back by the next pass, which records it', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  const [written] = await home.settled();
  assert.equal(written, false);
  assert.ok(home.logs.some((l) => /could not record the removal of "b" yet; it is tried again later/.test(l)), home.logs.join('\n'));
  assert.deepEqual(home.sleeps, [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000], 'paused a minute, five, fifteen and thirty minutes between the tries');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  down = false;
  const r = await home.sync.sync();
  assert.equal(r.added, 0, 'not added back from its row');
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a']);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null, 'the pass wrote the tombstone');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.ok(home.logs.some((l) => /"b": its removal here is now recorded on callback\.net/.test(l)), home.logs.join('\n'));
  assert.equal((await office.sync.sync()).evicted, 1);
});

test('a sign-in here replaces a removal still pending, and the next pass leaves the row as signed in', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  down = false;
  store.tick(H);
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.equal(await home.sync.storeSignIn(entry), true);
  assert.equal(home.sync.pendingRemovals.size, 0);
  await home.sync.sync();
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(store.blob(key).accessToken, 'at-b-new');
});

test('an account that goes into error finds a row another install stored after the last pass', async () => {
  const store = makeStore();
  const office = setup([claude('a')], { store });
  await office.sync.sync(); // the store holds a, not b
  const home = setup([claude('a'), claude('b')], { store, minted: false });
  await home.sync.sync();
  // b is signed in on another install after home's pass.
  const elsewhere = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 9 * H });
  assert.equal(await office.sync.storeSignIn(elsewhere), true);
  home.am.markCredentialRejected(1, '401');
  assert.equal(await home.recoveries[0], true);
  assert.equal(home.am.accounts[1].status, 'active');
  assert.equal(home.am.accounts[1].credential, 'at-b-new');
});

/**
 * Home removes b while another install holds b's lock: home's removal waits,
 * its sleeps held until `release()` frees the lock and lets it go on.
 */
async function removalWaitingOnLock() {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  store.byKey(key).Locked = { unixms: String(store.now()), unix: Math.floor(store.now() / 1000) };
  let waiting = false;
  let open;
  const gate = new Promise((r) => { open = r; });
  home.sync.sleep = async (ms) => { waiting = true; await gate; store.tick(ms); };
  home.am.removeAccount(1);
  for (let i = 0; i < 100 && !waiting; i++) await new Promise((r) => setImmediate(r));
  assert.equal(waiting, true, 'the removal is waiting for the lock');
  const release = () => { store.byKey(key).Locked = null; open(); };
  return { store, key, home, release };
}

test('a pass that runs while a removal waits for the lock does not add the account back', async () => {
  const { store, key, home, release } = await removalWaitingOnLock();
  // The pass tries the tombstone once and does not wait on the held lock.
  // A wait would go through the sync's sleep: for this pass, one that counts
  // the call and fails it (the removal already waiting is parked in the gated
  // sleep it called before the swap).
  const gated = home.sync.sleep;
  let slept = 0;
  home.sync.sleep = async () => { slept++; throw new Error('the pass waited on the held lock'); };
  const r = await home.sync.sync();
  home.sync.sleep = gated;
  assert.equal(slept, 0, 'the pass did not wait on the held lock');
  assert.equal(r.added, 0);
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a']);
  assert.equal(home.sync.pendingRemovals.size, 1, 'still pending');
  release();
  assert.deepEqual(await home.settled(), [true]);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal waiting for the lock writes nothing once a sign-in here replaced it', async () => {
  const { store, key, home, release } = await removalWaitingOnLock();
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.equal(await home.sync.storeSignIn(entry), true);
  const after = store.calls.length;
  release();
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(store.blob(key).accessToken, 'at-b-new', 'the sign-in stands');
  assert.deepEqual(store.calls.slice(after).filter((c) => c.path.endsWith(':lock')), [], 'the wait stopped: no lock taken after the sign-in');
  assert.ok(!home.logs.some((l) => /could not record the removal/.test(l)), home.logs.join('\n'));
});

test('a removal waiting for the lock writes nothing once the account is back on this install', async () => {
  const { store, key, home, release } = await removalWaitingOnLock();
  home.am.addAccount(claude('b')); // a reload brought it back from the config, say
  release();
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
});

test('a pending removal is matched to its row by identity, where the row names the organization differently', async () => {
  const store = makeStore();
  // Written by an install whose entry has no orgUuid: keyed by the organization's name.
  const bare = claude('b', { orgUuid: undefined });
  store.put(syncKeyFor(bare), encodeBlob({ ...bare, credential: bare.accessToken }, tokensOf({ credential: bare.accessToken, refreshToken: bare.refreshToken, expiresAt: bare.expiresAt }), { now: T0, by: 'office' }));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  assert.notEqual(syncKeyFor(claude('b')), syncKeyFor(bare));
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  down = false;
  assert.equal((await home.sync.sync()).added, 0, 'not added back from the row under the other key');
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(bare)).Data), null);
});

test('a sign-in under another key replaces a pending removal of the same identity', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  down = false;
  // Signed in again from an entry with no orgUuid, so its key names the organization by name.
  const entry = claude('b', { orgUuid: undefined, accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.notEqual(syncKeyFor(entry), key);
  assert.equal(await home.sync.storeSignIn(entry), true);
  assert.equal(home.sync.pendingRemovals.size, 0);
  await home.sync.sync();
  assert.equal(tombstoneOf(store.byKey(key).Data), null, 'the sign-in is not written over');
  assert.equal(store.blob(key).accessToken, 'at-b-new');
});

test('a removal with no row settles at once, so a sign-in elsewhere later is added, not removed', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store, minted: false }); // stores nothing
  await home.sync.sync();
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.deepEqual(home.sleeps, [], 'settled: no retry pauses');
  const office = setup([], { store });
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.equal(await office.sync.storeSignIn(entry), true);
  assert.equal((await home.sync.sync()).added, 1);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal whose row is gone since it was read settles, and writes nothing', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  store.rows.delete(store.byKey(key).User_Credential__); // deleted on the store's side; still in home's cache
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(store.byKey(key), null, 'not made again');
});

test('a second removal of the same account, made while the first takes the lock, writes the tombstone', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const id = store.byKey(key).User_Credential__;
  let first = true;
  home.sync.api = async (method, path, ...rest) => {
    const r = await store.api(method, path, ...rest);
    if (first && path === `User/Credential/${id}:lock`) {
      // While the first removal's lock call is out: back, then removed again.
      first = false;
      home.am.addAccount(claude('b'));
      home.am.removeAccount(1);
    }
    return r;
  };
  home.am.removeAccount(1);
  await home.settled(); // the second removal is registered during the first
  assert.deepEqual(await home.settled(), [false, true], 'the first lets go, the second writes');
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
});

test('a removal waits out a lock held for a whole lease, then writes', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  store.byKey(key).Locked = { unixms: String(store.now()), unix: Math.floor(store.now() / 1000) }; // never released
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [true]);
  assert.deepEqual(home.sleeps, [5000, 5000, 5000, 5000, 5000, 5000], 'every 5s, until the lease lapsed at 30s');
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal gives up on a lock held throughout, says so, and stays pending', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const id = store.byKey(key).User_Credential__;
  let attempts = 0;
  home.sync.api = async (method, path, ...rest) => {
    if (path === `User/Credential/${id}:lock`) { attempts++; throw Object.assign(new Error('Credential is locked'), { token: 'error_credential_locked' }); }
    return store.api(method, path, ...rest);
  };
  const removedAt = store.now();
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(attempts, 5 * 8, 'eight attempts over 35s, then again after each of the four pauses');
  assert.ok(store.now() - removedAt < H, `every timed retry, its waits for the lock included, is made within the hour (${(store.now() - removedAt) / 1000}s)`);
  assert.ok(home.logs.some((l) => /could not record the removal of "b" yet: its lock is held; it is tried again later/.test(l)), home.logs.join('\n'));
  assert.equal(home.sync.pendingRemovals.size, 1);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal from a CLI command makes one attempt, with no wait for the lock', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  store.byKey(key).Locked = { unixms: String(store.now()), unix: Math.floor(store.now() / 1000) };
  // As index.js builds it for `teamclaude remove`: no fleet of its own.
  const sleeps = [];
  const cli = new CredentialSync({ accountManager: /** @type {any} */ ({ accounts: [] }), addAccount: () => null, api: store.api, isSignedIn: async () => true, session: async () => 'session-1', now: store.now, log: () => {}, sleep: async (ms) => { sleeps.push(ms); store.tick(ms); } });
  const entry = claude('b');
  assert.equal(await cli.onAccountRemoved({ ...entry, credential: entry.accessToken }, { wait: false }), false);
  assert.deepEqual(sleeps, [], 'no wait');
  store.byKey(key).Locked = null;
  assert.equal(await cli.onAccountRemoved({ ...entry, credential: entry.accessToken }, { wait: false }), true);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
});

test('an eviction is not a pending removal, even when its row cannot be reached just then', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  const home = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  await home.sync.sync();
  office.am.removeAccount(1);
  await office.settled();
  // Home's pass evicts b; every call on a single row (read, lock, write) fails from then on.
  let failRow = false;
  home.sync.api = async (method, path, ...rest) => {
    if (failRow && path.startsWith('User/Credential/')) throw new Error('fetch failed');
    return store.api(method, path, ...rest);
  };
  failRow = true;
  assert.equal((await home.sync.sync()).evicted, 1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 0);
  failRow = false;
  // Signed in again on office: home adds it back, and writes no tombstone over it.
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.equal(await office.sync.storeSignIn(entry), true);
  assert.equal((await home.sync.sync()).added, 1);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal the store could not take is tried again a minute later, and lands', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.sync.sleep = async (ms) => { if (ms === 60_000) down = false; store.tick(ms); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [true]);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
});

test('a removal whose store is back half an hour later is recorded by the last timed retry, without a pass', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  const removedAt = store.now();
  const pauses = [];
  home.sync.sleep = async (ms) => {
    pauses.push(ms);
    store.tick(ms);
    if (store.now() - removedAt >= 30 * 60_000) down = false;
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [true], 'no pass ran: a timed retry wrote it');
  assert.deepEqual(pauses, [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal((await office.sync.sync()).evicted, 1);
});

test('a removal waiting for the lock writes nothing once the account is back here under another key', async () => {
  const { store, key, home, release } = await removalWaitingOnLock();
  // Back from an entry with no orgUuid, so its key names the organization by name.
  home.am.addAccount(claude('b', { orgUuid: undefined }));
  assert.notEqual(syncKeyFor(home.am.accounts[1]), key);
  release();
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
});

test('a removal settled during a retry pause takes no lock when it wakes', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  let after = -1;
  let checks = 0;
  home.sync.isSignedIn = async () => { checks++; return true; };
  home.sync.sleep = async (ms) => {
    // During the first pause the store comes back and a pass writes the tombstone.
    if (ms === 60_000) { down = false; await home.sync.sync(); after = store.calls.length; checks = 0; }
    store.tick(ms);
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
  assert.ok(after > 0);
  assert.deepEqual(store.calls.slice(after).map((c) => `${c.method} ${c.path}`), [], 'nothing after it settled');
  assert.equal(checks, 0, 'not even a sign-in check');
});

const NOT_RECORDED = (name, why) => new RegExp(`the removal of "${name}" was not recorded for your other installs \\(${why}\\); the account comes back here from its row, if the store holds one, at the next pass: remove it again then`);

test('a sign-out while a removal is pending ends it: nothing is written, and the pass after signing back in adds the account back', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  const pauses = [];
  home.sync.sleep = async (ms) => { pauses.push(ms); home.signOut(); down = false; store.tick(ms); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(pauses, [60_000], 'found signed out at the first retry, and not tried again');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', 'this install is signed out of callback\\.net').test(l)).length, 1, home.logs.join('\n'));
  home.signIn();
  assert.equal((await home.sync.sync()).added, 1, 'its row is a row like any other again');
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a', 'b']);
  assert.equal(tombstoneOf(store.byKey(key).Data), null, 'no tombstone was written');
});

test('a pass that finds this install signed out ends a pending removal', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 1, 'out of timed retries, left to the passes');
  down = false;
  home.signOut();
  assert.equal((await home.sync.sync()).signedIn, false);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', 'this install is signed out of callback\\.net').test(l)).length, 1, home.logs.join('\n'));
  home.signIn();
  assert.equal((await home.sync.sync()).added, 1);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
});

test('a signed-out pass and a timed retry that both find the sign-out give the removal up once', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  let pass = null;
  home.sync.sleep = async (ms) => {
    store.tick(ms);
    if (ms !== 60_000) return;
    // Signed out during the first pause. A pass starts, the retry comes round,
    // and each has read the sign-out before either acts on it: the pass first.
    const answers = [];
    home.sync.isSignedIn = () => new Promise((resolve) => {
      answers.push(resolve);
      if (answers.length === 2) for (const answer of answers) answer(false);
    });
    pass = home.sync.sync();
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal((await pass).signedIn, false);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', 'this install is signed out of callback\\.net').test(l)).length, 1, home.logs.join('\n'));
});

const SIGNED_IN_AGAIN = 'this install was signed in to callback\\.net again since';
const LAPSED = 'callback\\.net did not take it within an hour';

test('a callback.net sign-in as another user ends a pending removal: nothing is written into their store', async () => {
  const store = makeStore();
  const theirs = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  // Their store holds the same Claude account, signed in there by an install of theirs.
  const elsewhere = setup([claude('b', { accessToken: 'at-b-2', refreshToken: 'rt-b-2', expiresAt: theirs.now() + 9 * H })], { store: theirs });
  await elsewhere.sync.sync();
  let api = async () => { throw new Error('fetch failed'); };
  home.sync.api = (...args) => api(...args);
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 1);
  // `callback login --force` as them (or a login over a session that had
  // lapsed, or a logout and a login with no check between): the token file
  // names their session, and the reload the login sends runs a pass.
  home.signInAs('session-2');
  api = theirs.api;
  const r = await home.sync.sync('reload');
  assert.equal(tombstoneOf(theirs.byKey(key).Data), null, 'nothing written into their store');
  assert.equal(theirs.blob(key).accessToken, 'at-b-2', 'their login stands');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
  assert.equal(r.added, 1, 'given up before the rows are read: the same pass adds the account from their row');
  assert.equal((await elsewhere.sync.sync()).evicted, 0, 'their install keeps it');
});

test('a timed retry under a callback.net session made since the removal writes nothing, and makes no call', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  let after = -1;
  const pauses = [];
  // Signed in again during the first pause, whoever as (the store the new
  // session names may be another user's), and the store in reach when it ends.
  home.sync.sleep = async (ms) => {
    pauses.push(ms);
    store.tick(ms);
    if (ms === 60_000) { home.signInAs('session-2'); down = false; after = store.calls.length; }
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(pauses, [60_000], 'given up at the first retry, and not tried again');
  assert.deepEqual(store.calls.slice(after).map((c) => `${c.method} ${c.path}`), [], 'no lock, no write');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
  // The retry read the new session, so a removal made now belongs to it.
  home.am.removeAccount(0);
  assert.deepEqual(await home.settled(), [false, true]);
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('a'))).Data), null);
});

/**
 * Two callback.net users: `store` is this install's, `theirs` the other
 * user's, which holds the same Claude account b, signed in there by an install
 * of theirs (`elsewhere`). `others` are more accounts of theirs, listed first.
 */
async function theirStore(home, others = []) {
  const theirs = makeStore();
  const elsewhere = setup([...others, claude('b', { accessToken: 'at-b-2', refreshToken: 'rt-b-2', expiresAt: theirs.now() + 9 * H })], { store: theirs });
  await elsewhere.sync.sync();
  assert.equal(home.sync.pendingRemovals.size, 0);
  return { theirs, elsewhere };
}

/** Nothing reached their store's row for b, and the line was logged once. */
async function untouched({ home, theirs, elsewhere, key }) {
  assert.equal(tombstoneOf(theirs.byKey(key).Data), null, 'nothing written into their store');
  assert.equal(theirs.blob(key).accessToken, 'at-b-2', 'their login stands');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
  assert.equal((await elsewhere.sync.sync()).evicted, 0, 'their install keeps it');
}

test('a sign-in to callback.net that lands before a removal is first checked still ends it', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home);
  let api = async () => { throw new Error('fetch failed'); };
  home.sync.api = (...args) => api(...args);
  // `callback login --force` as them saves its token while the removal's
  // first sign-in check is out, before any session is read for it.
  const signedIn = home.sync.isSignedIn;
  let first = true;
  home.sync.isSignedIn = async () => {
    if (first) { first = false; home.signInAs('session-2'); }
    return signedIn();
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  // The reload the login sends runs a pass in their store.
  api = theirs.api;
  const r = await home.sync.sync('reload');
  await untouched({ home, theirs, elsewhere, key });
  assert.equal(r.added, 1, 'their row adds the account, like any other');
});

test('a removal the proxy first learns of after a sign-in to callback.net is given up on, with the line', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home);
  // Signed in as them; then the reload `callback login` sends finds b gone
  // from the config (`teamclaude remove` made just before it, or a hand edit):
  // the reload drops the account, then runs its pass.
  home.signInAs('session-2');
  home.sync.api = theirs.api;
  home.am.removeAccount(1);
  const r = await home.sync.sync('reload');
  assert.deepEqual(await home.settled(), [false]);
  await untouched({ home, theirs, elsewhere, key });
  assert.equal(r.added, 1);
});

test('a removal first learned of after a sign-in, with no row cached (a signed-out pass emptied them), writes nothing into the new store', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home);
  home.signOut();
  assert.equal((await home.sync.sync()).signedIn, false);
  assert.equal(home.sync.rows.size, 0);
  home.signInAs('session-2');
  home.sync.api = theirs.api;
  const before = theirs.calls.length;
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(theirs.calls.slice(before).map((c) => `${c.method} ${c.path}`), [], 'not even a listing of their store');
  await untouched({ home, theirs, elsewhere, key });
});

test('a sign-in to callback.net that lands while the removal waits for the lock is found with the lock held, and nothing is written', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  // The in-memory stores number their rows alike: their row for b has the id
  // of this install's, so a lock asked after the switch is taken on theirs.
  const { theirs, elsewhere } = await theirStore(home, [claude('x')]);
  assert.equal(theirs.byKey(key).User_Credential__, store.byKey(key).User_Credential__);
  // Another install of this user is renewing b.
  store.byKey(key).Locked = { unixms: String(store.now()), unix: Math.floor(store.now() / 1000) };
  let api = store.api;
  home.sync.api = (...args) => api(...args);
  let switched = false;
  home.sync.sleep = async (ms) => {
    store.tick(ms);
    theirs.tick(ms);
    if (!switched) { switched = true; home.signInAs('session-2'); api = theirs.api; }
  };
  const before = theirs.calls.length;
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(theirs.calls.slice(before).map((c) => `${c.method} ${c.path}`), [`POST User/Credential/${theirs.byKey(key).User_Credential__}:lock`, `POST User/Credential/${theirs.byKey(key).User_Credential__}:unlock`], 'their row locked, not written, and released');
  assert.equal(theirs.byKey(key).Locked, null);
  await untouched({ home, theirs, elsewhere, key });
});

test('a pass that gives the removal up while it holds the lock and reads the session is seen: nothing is written', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  // Ids collide between the in-memory stores, so a write after the switch would land in their row.
  const { theirs, elsewhere } = await theirStore(home, [claude('x')]);
  let api = store.api;
  home.sync.api = (...args) => api(...args);
  let gaveUp;
  const givenUp = new Promise((resolve) => { gaveUp = resolve; });
  const log = home.sync.log;
  home.sync.log = (line) => { log(line); if (/was not recorded/.test(line)) gaveUp(); };
  const session = home.sync.session;
  let reads = 0;
  let pass = null;
  home.sync.session = async () => {
    // The removal's first read, then its read with the lock held: during that
    // one, `callback login --force` as them lands, and the reload it sends
    // runs a pass, which gives the removal up before the read answers.
    if (++reads === 2) {
      home.signInAs('session-2');
      api = theirs.api;
      pass = home.sync.sync('reload');
      await givenUp;
    }
    return session();
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal((await pass).added, 2, 'their x, and b from their row');
  assert.ok(![...store.calls, ...theirs.calls].some((c) => c.method === 'PATCH'), 'no write anywhere');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  await untouched({ home, theirs, elsewhere, key });
});

test('a removal is tied when it is marked: a pass that reads the new session before the removal\'s own first check does not tie it there', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home, [claude('x')]);
  home.signInAs('session-2');
  home.sync.api = theirs.api;
  // The removal's first sign-in check answers only once the reload's pass is over.
  let passOver;
  const over = new Promise((resolve) => { passOver = resolve; });
  const signedIn = home.sync.isSignedIn;
  let first = true;
  home.sync.isSignedIn = async () => {
    if (first) { first = false; await over; }
    return signedIn();
  };
  home.am.removeAccount(1);
  const r = await home.sync.sync('reload');
  passOver();
  assert.deepEqual(await home.settled(), [false]);
  await untouched({ home, theirs, elsewhere, key });
  assert.equal(r.added, 2, 'their x, and b from their row');
});

test('a proxy that started signed out takes its first sign-in for a change: a removal learned of at its reload is given up on', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store, signedIn: false });
  assert.equal((await home.sync.sync('start')).signedIn, false);
  const { theirs, elsewhere } = await theirStore(home);
  // The first `callback login`, as them; the reload it sends finds b gone from the config.
  home.signInAs('session-2');
  home.sync.api = theirs.api;
  home.am.removeAccount(1);
  const r = await home.sync.sync('reload');
  assert.deepEqual(await home.settled(), [false]);
  await untouched({ home, theirs, elsewhere, key });
  assert.equal(r.added, 1);
});

test('a proxy signed out after a pass, then signed in as another user: a removal learned of at that reload is given up on', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync('start');
  const { theirs, elsewhere } = await theirStore(home);
  home.signOut();
  assert.equal((await home.sync.sync('daily')).signedIn, false);
  home.signInAs('session-2');
  home.sync.api = theirs.api;
  home.am.removeAccount(1);
  const r = await home.sync.sync('reload');
  assert.deepEqual(await home.settled(), [false]);
  await untouched({ home, theirs, elsewhere, key });
  assert.equal(r.added, 1);
});

test('a sign-out that lands while the removal waits for the lock gives it up as signed out', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  // Another install of this user is renewing b. The in-memory store hands the
  // lock over at 30s whoever asks, so it is had after the sign-out too.
  store.byKey(key).Locked = { unixms: String(store.now()), unix: Math.floor(store.now() / 1000) };
  let signedOut = false;
  home.sync.sleep = async (ms) => {
    store.tick(ms);
    if (!signedOut) { signedOut = true; home.signOut(); }
  };
  const before = store.calls.length;
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.ok(!store.calls.slice(before).some((c) => c.method === 'PATCH'), 'nothing written');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', 'this install is signed out of callback\\.net').test(l)).length, 1, home.logs.join('\n'));
});

test('a removal made under a token saved before sign-ins were stamped is ended by a sign-in all the same', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  home.signInAs(''); // what callbackSessionOf reads from a token with no signed_in_at
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home);
  let api = async () => { throw new Error('fetch failed'); };
  home.sync.api = (...args) => api(...args);
  const signedIn = home.sync.isSignedIn;
  let first = true;
  home.sync.isSignedIn = async () => {
    if (first) { first = false; home.signInAs('session-2'); }
    return signedIn();
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  api = theirs.api;
  await home.sync.sync('reload');
  await untouched({ home, theirs, elsewhere, key });
});

test('a removal made before any check has read the session is tied to it by its first check', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  // Just started: no pass has read the session yet.
  const home = setup([claude('a'), claude('b')], { store });
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  const pauses = [];
  home.sync.sleep = async (ms) => {
    pauses.push(ms);
    store.tick(ms);
    if (ms === 60_000) { home.signInAs('session-2'); down = false; }
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(pauses, [60_000], 'tried, kept, then given up at the first retry');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
});

test('a timed retry under a session made since, with no row seen for the account, gives up before it lists the store', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  // Holding tokens it did not renew, home stores nothing; office stores the
  // rows after home's pass, so home has seen none.
  const home = setup([claude('a'), claude('b')], { store, minted: false });
  await home.sync.sync();
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  assert.equal(home.sync.rows.size, 0);
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  let after = -1;
  home.sync.sleep = async (ms) => {
    store.tick(ms);
    if (ms === 60_000) { home.signInAs('session-2'); down = false; after = store.calls.length; }
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.deepEqual(store.calls.slice(after).map((c) => `${c.method} ${c.path}`), [], 'not even a listing');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
});

test('a pass reads the session before it lists the rows: a sign-in during the listing adds nothing back from them', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const { theirs, elsewhere } = await theirStore(home);
  let down = true;
  let switchOnList = false;
  let api = store.api;
  home.sync.api = async (method, path, ...rest) => {
    if (down) throw new Error('fetch failed');
    const r = await api(method, path, ...rest);
    // The listing went out under this install's session; the sign-in as them
    // is saved before it answers.
    if (switchOnList && method === 'GET' && path === 'User/Credential') { switchOnList = false; home.signInAs('session-2'); api = theirs.api; }
    return r;
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  down = false;
  switchOnList = true;
  const r = await home.sync.sync();
  assert.equal(r.added, 0, 'nothing added from the rows listed under the session before');
  assert.deepEqual(home.am.accounts.map((a) => a.name), ['a']);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  await untouched({ home, theirs, elsewhere, key });
  assert.equal((await home.sync.sync()).added, 1, 'the next pass adds it from their row');
});

/**
 * A config path of the test's own, so the callback.net token file beside it is
 * too. TEAMROUTER_CONFIG wins over TEAMCLAUDE_CONFIG (envVar), so it is cleared
 * for the test, as tempConfig in callback-auth.test.js does: one exported for a
 * developer's own install would take these writes into their real token file.
 */
async function tokenFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-sync-'));
  const prev = { c: process.env.TEAMCLAUDE_CONFIG, r: process.env.TEAMROUTER_CONFIG };
  delete process.env.TEAMROUTER_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'config.json');
  t.after(async () => {
    if (prev.c === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev.c;
    if (prev.r !== undefined) process.env.TEAMROUTER_CONFIG = prev.r;
    await rm(dir, { recursive: true, force: true });
  });
  // Before anything is written: the token file is this test's, or the test stops here.
  assert.equal(getCallbackAuthPath(), join(dir, 'config.callback.json'));
}

test('the session is the sign-in the token file names: a renewal of it keeps a pending removal, a new sign-in ends one', async (t) => {
  await tokenFile(t);
  const signIn = { access_token: 'cb-at-1', refresh_token: 'cb-rt-1', client_id: 'oaap-test', obtained_at: 1, signed_in_at: 1 };
  await saveCallbackToken(signIn);
  const store = makeStore();
  const home = setup([claude('a'), claude('b'), claude('c')], { store, fromFile: true });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1); // b
  assert.deepEqual(await home.settled(), [false]);
  // callback.net renewed this install's session: other tokens, the same sign-in.
  await saveCallbackToken({ ...signIn, access_token: 'cb-at-2', refresh_token: 'cb-rt-2', obtained_at: 2 });
  down = false;
  assert.equal((await home.sync.sync()).added, 0);
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('b'))).Data), null, 'recorded under the renewed session');
  down = true;
  home.am.removeAccount(1); // c
  assert.deepEqual(await home.settled(), [false, false]);
  // `callback login` again: a sign-in of its own, whoever it signs in as.
  await saveCallbackToken({ ...signIn, access_token: 'cb-at-3', refresh_token: 'cb-rt-3', obtained_at: 3, signed_in_at: 3 });
  down = false;
  assert.equal((await home.sync.sync()).added, 1, 'given up, so its row adds it back');
  assert.equal(tombstoneOf(store.byKey(syncKeyFor(claude('c'))).Data), null, 'nothing written');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('c', SIGNED_IN_AGAIN).test(l)).length, 1, home.logs.join('\n'));
});

test('a token saved before sign-ins were stamped, renewed, is still the same session: a pending removal is kept and recorded', async (t) => {
  await tokenFile(t);
  const unstamped = { access_token: 'cb-at-1', refresh_token: 'cb-rt-1', client_id: 'oaap-test', obtained_at: 1 };
  await saveCallbackToken(unstamped);
  const store = makeStore();
  const home = setup([claude('a'), claude('b')], { store, fromFile: true });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  await saveCallbackToken({ ...unstamped, access_token: 'cb-at-2', refresh_token: 'cb-rt-2', obtained_at: 2 });
  down = false;
  assert.equal((await home.sync.sync()).added, 0);
  assert.notEqual(tombstoneOf(store.byKey(syncKeyFor(claude('b'))).Data), null, 'recorded under the renewed session');
  assert.ok(!home.logs.some((l) => /was not recorded/.test(l)), home.logs.join('\n'));
});

test('a removal pending for more than an hour is dropped, and does not tombstone a sign-in made on another install since', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  const removedAt = store.now();
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(home.sync.pendingRemovals.size, 1);
  // Past the hour, by the least the clock can tell. Here and in the next test
  // the hour is the test's own number, not REMOVAL_PENDING_MAX_MS: ticked by
  // the bound, they passed with a bound of a week, and between them they pin
  // it to the hour.
  store.tick(removedAt + H + 1 - store.now());
  // Signed in again on office meanwhile; then the store is back in reach of home.
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  assert.equal(await office.sync.storeSignIn(entry), true);
  down = false;
  const r = await home.sync.sync();
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', LAPSED).test(l)).length, 1, home.logs.join('\n'));
  assert.equal(tombstoneOf(store.byKey(key).Data), null, 'no tombstone over the sign-in');
  assert.equal(store.blob(key).accessToken, 'at-b-new', 'the sign-in stands');
  assert.equal(r.added, 1, 'the same pass adds the account back from its row');
  assert.equal(home.am.accounts[1].credential, 'at-b-new');
  assert.equal((await office.sync.sync()).evicted, 0, 'office keeps its fresh login');
  assert.deepEqual(office.am.accounts.map((a) => a.name), ['a', 'b']);
  assert.equal((await home.sync.sync()).added, 0);
  assert.equal(tombstoneOf(store.byKey(key).Data), null, 'nor by a later pass');
});

test('a removal given up on brings the account back enabled, without the settings it had here', async () => {
  const store = makeStore();
  const home = setup([claude('a'), claude('b', { priority: 7, disabled: true, routing: 'socks5://127.0.0.1:1080' })], { store });
  await home.sync.sync();
  assert.ok(home.am.accounts[1].routing, 'routed, before');
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  store.tick(2 * H);
  down = false;
  assert.equal((await home.sync.sync()).added, 1);
  const b = home.am.accounts.find((a) => a.name === 'b');
  // Priority, disabled and routing are this install's own and never travel: they went with the removal.
  assert.deepEqual({ disabled: b.disabled, priority: b.priority, routing: b.routing ?? null, status: b.status }, { disabled: false, priority: 0, routing: null, status: 'active' });
});

test('a removal pending for exactly an hour is still written by the pass', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const office = setup([claude('a'), claude('b')], { store });
  await office.sync.sync();
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  const removedAt = store.now();
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  store.tick(removedAt + H - store.now());
  down = false;
  assert.equal((await home.sync.sync()).added, 0);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null, 'within the bound: it lands');
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.ok(!home.logs.some((l) => /was not recorded for your other installs/.test(l)), home.logs.join('\n'));
  assert.equal((await office.sync.sync()).evicted, 1);
});

test('a timed retry that comes round after the hour drops the removal, and makes no call', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  let down = true;
  home.sync.api = async (...args) => { if (down) throw new Error('fetch failed'); return store.api(...args); };
  let after = -1;
  // The last pause runs long (the machine slept, say), and the store is back when it ends.
  home.sync.sleep = async (ms) => {
    store.tick(ms);
    if (ms === 15 * 60_000) { store.tick(REMOVAL_PENDING_MAX_MS); down = false; after = store.calls.length; }
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.ok(after >= 0);
  assert.deepEqual(store.calls.slice(after).map((c) => `${c.method} ${c.path}`), [], 'no lock, no write');
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', LAPSED).test(l)).length, 1, home.logs.join('\n'));
  assert.equal((await home.sync.sync()).added, 1, 'the next pass adds it back from its row');
});

test('a removal that passes the hour while it waits for the lock writes nothing, and releases the lock', async () => {
  const { store, key, home, release } = await removalWaitingOnLock();
  store.tick(REMOVAL_PENDING_MAX_MS);
  release();
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(home.sync.pendingRemovals.size, 0);
  assert.equal(store.byKey(key).Locked, null, 'the lock it took is released');
  assert.equal(home.logs.filter((l) => NOT_RECORDED('b', LAPSED).test(l)).length, 1, home.logs.join('\n'));
});

test('an API-key account of the same name does not count as the removed account being back', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b'), { name: 'b', type: 'apikey', apiKey: 'k-b' }], { store });
  const office = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  await office.sync.sync();
  home.am.removeAccount(1); // the OAuth b; the API-key namesake stays
  assert.deepEqual(await home.settled(), [true]);
  assert.notEqual(tombstoneOf(store.byKey(key).Data), null);
  assert.equal((await office.sync.sync()).evicted, 1);
});

test('a sign-in here made while the removal takes the lock is not written over', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('b'));
  const home = setup([claude('a'), claude('b')], { store });
  await home.sync.sync();
  const id = store.byKey(key).User_Credential__;
  const entry = claude('b', { accessToken: 'at-b-new', refreshToken: 'rt-b-new', expiresAt: store.now() + 8 * H });
  let first = true;
  home.sync.api = async (method, path, ...rest) => {
    const r = await store.api(method, path, ...rest);
    if (first && path === `User/Credential/${id}:lock`) { first = false; await home.sync.storeSignIn(entry); }
    return r;
  };
  home.am.removeAccount(1);
  assert.deepEqual(await home.settled(), [false]);
  assert.equal(tombstoneOf(store.byKey(key).Data), null);
  assert.equal(store.blob(key).accessToken, 'at-b-new', 'the sign-in stands');
});

test('a tombstone older than a week is deleted by whichever pass sees it', async () => {
  const store = makeStore();
  store.put(syncKeyFor(claude('old')), tombstone(store.now() - TOMBSTONE_TTL_MS - 1));
  store.put(syncKeyFor(claude('recent')), tombstone(store.now() - TOMBSTONE_TTL_MS + 60_000));
  const { sync, store: s } = setup([], { store });
  const r = await sync.sync();
  assert.equal(r.expired, 1);
  assert.equal(r.rows, 1);
  assert.equal(s.rows.size, 1);
  assert.equal(s.byKey(syncKeyFor(claude('old'))), null);
  assert.notEqual(s.byKey(syncKeyFor(claude('recent'))), null);
  // A week on, the other goes too.
  s.tick(2 * 60_000);
  assert.equal((await sync.sync()).expired, 1);
  assert.equal(s.rows.size, 0);
});

test('a removal with no row, or while signed out, records nothing and is not an error', async () => {
  const { am, sync, store, settled, signOut } = setup([claude('a'), claude('b')]);
  await sync.sync();
  signOut();
  am.removeAccount(1);
  await settled();
  assert.equal(tombstoneOf(store.byKey(syncKeyFor(claude('b'))).Data), null);
  assert.equal(sync.pendingRemovals.size, 0, 'nothing is left pending');
  assert.equal(await sync.onAccountRemoved({ name: 'k', type: 'apikey' }), false);
});

test('the store is read in pages', async () => {
  const store = makeStore();
  for (let i = 0; i < 230; i++) {
    const a = claude(`u${i}`);
    store.put(syncKeyFor(a), encodeBlob(a, tokensOf({ credential: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt }), { now: T0, by: 'x' }));
  }
  const { sync, admitted, store: s } = setup([], { store });
  const r = await sync.sync();
  assert.equal(r.rows, 230);
  assert.equal(admitted.length, 230);
  assert.equal(s.calls.filter((c) => c.method === 'GET' && c.path === 'User/Credential').length, 3);
});

// ── the refresh ──────────────────────────────────────────────

test('a refresh takes the lock, renews once, stores the result and releases', async () => {
  const { sync, am, store, refreshed } = setup([claude('a')]);
  await sync.sync();
  store.calls.length = 0;
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
  const fns = store.calls.map((c) => `${c.method} ${c.path.replace(/uscrd-\d+/, 'ID')}`);
  assert.deepEqual(fns, ['POST User/Credential/ID:lock', 'PATCH User/Credential/ID', 'POST User/Credential/ID:unlock']);
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])).Locked, null);
  const blob = store.blob(syncKeyFor(am.accounts[0]));
  assert.equal(blob.accessToken, 'rt-a-1-renewed-at');
  assert.equal(blob.refreshToken, 'rt-a-1-renewed-rt');
  // Persisting the refresh does not write the row a second time.
  await new Promise((r) => setImmediate(r));
  assert.equal(store.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('lock taken but the row already renewed: the other install\'s token is adopted, no refresh is sent', async () => {
  const { sync, am, store, refreshed, logs } = setup([claude('a')]);
  await sync.sync();
  // Another install renewed between this install's last look and now.
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  const renewed = { ...am.accounts[0], credential: 'at-a-office', refreshToken: 'rt-a-office', expiresAt: T0 + 16 * H };
  row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: T0 + 8 * H, by: 'office' }));
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, [], 'the provider was not asked');
  assert.equal(am.accounts[0].credential, 'at-a-office');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-office');
  assert.equal(row.Locked, null, 'released');
  assert.ok(logs.some((l) => /already renewed on office; taking that token/.test(l)), logs.join('\n'));
});

test('lock taken and the row holds other tokens with an earlier expiry: still adopted, no refresh is sent', async () => {
  // Another install renewed, but its clock (or a sign-in there) stamped an
  // expiry earlier than the one this install holds. Under the lock, a
  // different token is the other install's renewal, and ours the stale copy.
  const { sync, am, store, refreshed } = setup([claude('a')]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  const renewed = { ...am.accounts[0], credential: 'at-a-office', refreshToken: 'rt-a-office', expiresAt: T0 + 7 * H };
  row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: T0 + H, by: 'office' }));
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, [], 'the provider was not asked');
  assert.equal(am.accounts[0].credential, 'at-a-office');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-office');
  assert.equal(row.Locked, null, 'released');
});

test('lock taken and the row is this install\'s own older write: renewed, not taken back', async () => {
  // This install renewed but its PATCH never landed: the row still holds the
  // token it rotated away, signed by this install. Taking it would revive a
  // dead refresh token.
  const { sync, am, store, refreshed } = setup([claude('a')]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  const older = { ...am.accounts[0], credential: 'at-a-0', refreshToken: 'rt-a-0', expiresAt: T0 };
  row.Data = JSON.stringify(encodeBlob(older, tokensOf(older), { now: T0 - 8 * H, by: 'this-box' }));
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
});

test('lock refused: wait, re-read every 5s, adopt what the holder stores', async () => {
  const { sync, am, store, refreshed, sleeps } = setup([claude('a')]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) }; // held by another install, just now
  // ...which stores its renewal 12 seconds later.
  const storeAt = store.now() + 12_000;
  const renewed = { ...am.accounts[0], credential: 'at-a-mac', refreshToken: 'rt-a-mac', expiresAt: T0 + 16 * H };
  const origApi = store.api;
  const api = async (method, path, params, opts) => {
    if (method === 'GET' && path.endsWith(row.User_Credential__) && store.now() >= storeAt && !row.Data.includes('at-a-mac')) {
      row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: storeAt, by: 'mac' }));
      row.Locked = null;
    }
    return origApi(method, path, params, opts);
  };
  sync.api = api;
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, []);
  assert.equal(am.accounts[0].credential, 'at-a-mac');
  assert.deepEqual(sleeps, [5000, 5000, 5000], 'three waits of five seconds, then the renewal was there');
});

test('lock refused while the token is still good: keep it, nothing waits, the next request asks again', async () => {
  // Expiry checks read the real clock, so the token is placed against it:
  // inside the five-minute window that triggers a refresh, not yet expired.
  const soon = Date.now() + 2 * 60_000;
  const { sync, am, store, refreshed, sleeps, persisted, logs } = setup([claude('a', { expiresAt: soon })]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) };
  await am.ensureTokenFresh(0);
  assert.deepEqual(refreshed, [], 'the provider was not asked');
  assert.deepEqual(sleeps, [], 'and nothing waited');
  assert.equal(am.accounts[0].credential, 'at-a-1', 'the token in hand still serves');
  assert.equal(am.accounts[0].expiresAt, soon);
  assert.deepEqual(persisted, [], 'nothing changed, so nothing was written or announced');
  assert.equal(am.accounts[0]._lastRefreshAt, null);
  assert.ok(logs.some((l) => /another install is renewing its token; keeping the current one/.test(l)), logs.join('\n'));
  // The holder stores its renewal; the next request takes it through the lock
  // path, the row being readable again.
  const renewed = { ...am.accounts[0], credential: 'at-a-office', refreshToken: 'rt-a-office', expiresAt: Date.now() + 8 * H };
  row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: store.now(), by: 'office' }));
  row.Locked = null;
  await am.ensureTokenFresh(0);
  assert.equal(am.accounts[0].credential, 'at-a-office');
  assert.deepEqual(refreshed, []);
});

test('lock refused on a token that has expired, or that upstream rejected: wait for the holder', async () => {
  const expired = Date.now() - 60_000;
  const { sync, am, store, sleeps } = setup([claude('a', { expiresAt: expired })]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) };
  const renewed = { ...am.accounts[0], credential: 'at-a-mac', refreshToken: 'rt-a-mac', expiresAt: Date.now() + 8 * H };
  const origApi = store.api;
  sync.api = async (method, path, params, opts) => {
    if (method === 'GET' && path.endsWith(row.User_Credential__) && sleeps.length >= 2 && !row.Data.includes('at-a-mac')) {
      row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: store.now(), by: 'mac' }));
      row.Locked = null;
    }
    return origApi(method, path, params, opts);
  };
  await am.ensureTokenFresh(0); // not forced: the expiry alone is what makes it wait
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.equal(am.accounts[0].credential, 'at-a-mac');
});

test('lock refused and nothing stored within 30s: the lock is tried again, and taken once it has timed out', async () => {
  const { sync, am, store, refreshed, sleeps, logs } = setup([claude('a')]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) }; // a holder that never stores anything (crashed mid-renewal)
  await am.ensureTokenFresh(0, true);
  // 30s of waiting (six re-reads), then the lock — 30s old by the second round — is taken.
  assert.equal(sleeps.filter((ms) => ms === 5000).length >= 6, true, String(sleeps));
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
  assert.ok(logs.some((l) => /stored no renewal in 30s; trying the lock again/.test(l)), logs.join('\n'));
});

test('the store unreachable: nothing is renewed without the lock — a good token is kept, a dead one waits', async () => {
  // Expiry checks read the real clock, so the tokens are placed against it.
  const soon = Date.now() + 2 * 60_000;
  const { sync, am, store, refreshed, logs } = setup([claude('a', { expiresAt: soon })]);
  await sync.sync();
  sync.api = async () => { throw new Error('fetch failed'); };
  await am.ensureTokenFresh(0);
  assert.deepEqual(refreshed, [], 'the provider was not asked');
  assert.equal(am.accounts[0].credential, 'at-a-1', 'the token in hand still serves');
  assert.ok(logs.some((l) => /not renewing, the callback\.net lock could not be taken \(fetch failed\); keeping the current token/.test(l)), logs.join('\n'));

  // Upstream rejects it: still no renewal, and the account is not put in error
  // for it — the failure is the store's, and the next request asks again.
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, []);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0]._deadRefreshToken, null);

  // Back: renewed, under the lock.
  sync.api = store.api;
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
});

test('the store unreadable before the lock (the first listing fails): nothing is renewed', async () => {
  const { sync, am, refreshed } = setup([claude('a')]);
  // No pass yet, so the coordinator has to list; the listing fails.
  sync.api = async () => { throw new Error('fetch failed'); };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, []);
  assert.equal(am.accounts[0].status, 'active');
});

test('a lock call refused for any reason but "locked" (our callback.net session gone, say) renews nothing', async () => {
  const { sync, am, store, refreshed } = setup([claude('a')]);
  await sync.sync();
  sync.api = async (method, path, params, opts) => {
    if (path.endsWith(':lock')) throw Object.assign(new Error('Login required'), { token: 'error_login_required', loginRequired: true });
    return store.api(method, path, params, opts);
  };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, []);
});

test('a lock refused every round: the refresh gives up rather than renewing without it', async () => {
  const { sync, am, store, refreshed, logs } = setup([claude('a')]);
  await sync.sync();
  // A holder that takes the lock again every time it lapses and never stores.
  sync.api = async (method, path, params, opts) => {
    if (path.endsWith(':lock')) throw Object.assign(new Error('Credential is locked'), { token: 'error_credential_locked', code: 0 });
    return store.api(method, path, params, opts);
  };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, [], 'never renewed without the lock');
  assert.equal(am.accounts[0].status, 'active');
  assert.ok(logs.some((l) => /not renewing, the callback\.net lock was not to be had in 3 rounds/.test(l)), logs.join('\n'));
});

// A page in front of this install's token endpoint (a 403 that is not its
// refusal) keeps the token and holds its renewal for a short while. The hold
// is that refresh token's: a renewal another install stored, adopted by a
// pass meanwhile, is renewed under the lock when it needs renewing in turn.
test('a token adopted from the store inside a kept 403\'s hold is renewed under the lock, not held', async () => {
  const { sync, am, store, refreshed } = setup([claude('a', { expiresAt: Date.now() - 60_000 })], {
    refresh: (rt) => {
      if (rt === 'rt-a-1') throw Object.assign(new Error('Token refresh failed (403): <html>Access denied</html>'), { status: 403, grantRefused: false });
      return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: Date.now() + 8 * H };
    },
  });
  await sync.sync();
  await am.ensureTokenFresh(0);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].status, 'active', 'kept');
  // Another install renewed and stored; its access token expires within the renewal window.
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  const renewed = { ...am.accounts[0], credential: 'at-a-office', refreshToken: 'rt-a-office', expiresAt: Date.now() + 60_000 };
  row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: store.now(), by: 'office' }));
  await sync.sync();
  assert.equal(am.accounts[0].refreshToken, 'rt-a-office', 'adopted');
  await am.ensureTokenFresh(0);
  assert.deepEqual(refreshed, ['rt-a-1', 'rt-a-office']);
  assert.equal(am.accounts[0].credential, 'rt-a-office-renewed-at');
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).refreshToken, 'rt-a-office-renewed-rt');
});

test('an account the store has never seen gets its row first, and is renewed under that row\'s lock', async () => {
  const { am, store, refreshed, sent } = setup([claude('a')]);
  // No pass has run: the row does not exist.
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(sent[0].locked, true, 'the lock was held as the grant went out');
  const fns = store.calls.map((c) => `${c.method} ${c.path.replace(/uscrd-\d+/, 'ID')}`);
  assert.deepEqual(fns, ['GET User/Credential', 'POST User/Credential', 'POST User/Credential/ID:lock', 'PATCH User/Credential/ID', 'POST User/Credential/ID:unlock']);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
});

test('two installs first seeing one account at once: one row, one renewal, the other adopts', async () => {
  const store = makeStore();
  const office = setup([claude('a')], { store });
  const home = setup([claude('a')], { store });
  // Neither has run a pass. Office creates the row and takes the lock; home's
  // create meets the key, it reads office's row and is refused its lock.
  let release;
  const gate = new Promise((r) => { release = r; });
  office.am._refreshFn = async (rt) => { office.refreshed.push(rt); await gate; return { accessToken: 'at-office', refreshToken: 'rt-office', expiresAt: store.now() + 8 * H }; };
  const officeDone = office.am.ensureTokenFresh(0, true);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.ok(store.byKey(syncKeyFor(claude('a'))).Locked, 'office holds the lock');
  home.sync.sleep = async (ms) => { store.tick(ms); release(); await officeDone; };
  await home.am.ensureTokenFresh(0, true);
  await officeDone;
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  assert.deepEqual(home.refreshed, [], 'home never called the provider');
  assert.equal(home.am.accounts[0].credential, 'at-office');
  assert.equal(store.rows.size, 1);
});

test('a create that races another install\'s and fails with a plain error still finds that row, and waits on its lock', async () => {
  // Seen live: two installs creating one key at once, the loser told "There
  // was a database error", not error_key_exists.
  const store = makeStore();
  const { am, sync, refreshed } = setup([claude('a')], { store });
  const theirs = { ...claude('a'), credential: 'at-a-office', refreshToken: 'rt-a-office', expiresAt: T0 + 16 * H };
  sync.api = async (method, path, params, opts) => {
    if (method === 'POST' && path === 'User/Credential') {
      store.put(params.Key, encodeBlob(theirs, tokensOf(theirs), { now: T0, by: 'office' }));
      throw Object.assign(new Error('There was a database error while processing your request'), { code: 500 });
    }
    return store.api(method, path, params, opts);
  };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, [], 'office\'s row holds a renewal: taken, nothing sent');
  assert.equal(am.accounts[0].credential, 'at-a-office');
});

test('the renewal gets what is left of the lease, and a lease that ran out is not released', async () => {
  const store = makeStore();
  const { sync, am, sent } = setup([claude('a')], { store });
  await sync.sync();
  await am.ensureTokenFresh(0, true);
  // 30s lease, 2s kept for the clocks, 8s for storing the answer.
  assert.equal(sent[0].budgetMs, 20_000);

  // A provider call that overruns anyway: by the time it answers, the lease
  // has lapsed and another install has taken the lock. Releasing it now would
  // hand the lock to a third.
  const row = store.byKey(syncKeyFor(claude('a')));
  am.accounts[0]._lastRefreshAt = null;
  am._refreshFn = async (rt) => {
    store.tick(31_000);
    await store.api('POST', `User/Credential/${row.User_Credential__}:lock`, { timeout: 30 }); // office's
    return { accessToken: `${rt}-late-at`, refreshToken: `${rt}-late-rt`, expiresAt: store.now() + 8 * H };
  };
  const officeLock = () => row.Locked;
  await am.ensureTokenFresh(0, true);
  assert.ok(officeLock(), 'the other install\'s lock still stands');
  assert.ok(!store.calls.slice(-3).some((c) => c.path.endsWith(':unlock')), 'no release after the lease');
});

test('a lock call that eats the lease is not followed by a renewal', async () => {
  const { sync, am, store, refreshed } = setup([claude('a')]);
  await sync.sync();
  let slow = true;
  sync.api = async (method, path, params, opts) => {
    const r = await store.api(method, path, params, opts);
    if (path.endsWith(':lock') && slow) { slow = false; store.tick(20_000); } // the answer took 20s
    return r;
  };
  await am.ensureTokenFresh(0, true);
  // The first lock left 8s: too little, so it was released and taken again.
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(store.calls.filter((c) => c.path.endsWith(':lock')).length, 2);
});

test('a removed account is renewed under the lock, then released', async () => {
  const store = makeStore();
  const home = setup([claude('a')], { store });
  const office = setup([claude('a')], { store });
  await home.sync.sync();
  await office.sync.sync();
  home.am.removeAccount(0);
  await home.settled();
  await office.am.ensureTokenFresh(0, true);
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  assert.equal(office.sent[0].locked, true, 'the lock was held as the grant went out');
  const row = store.byKey(syncKeyFor(claude('a')));
  assert.equal(row.Locked, null, 'released after');
  const fns = store.calls.filter((c) => c.path.includes(row.User_Credential__)).map((c) => `${c.method} ${c.path.split(':')[1] || ''}`);
  const lockAt = fns.lastIndexOf('POST lock');
  assert.ok(lockAt >= 0 && fns.slice(lockAt + 1).includes('POST unlock'), fns.join(', '));
});

test('a removal finds the tombstone another install wrote since its last read, and leaves it as written', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('a'));
  const home = setup([claude('a')], { store });
  const office = setup([claude('a')], { store });
  await home.sync.sync();
  await office.sync.sync();
  home.am.removeAccount(0);
  await home.settled();
  const first = JSON.parse(store.byKey(key).Data)._deleted;
  store.tick(60_000);
  // Office still holds the row as its pass read it: live. Under the lock it finds the tombstone.
  office.am.removeAccount(0);
  assert.deepEqual(await office.settled(), [false]);
  assert.equal(JSON.parse(store.byKey(key).Data)._deleted, first, 'the first tombstone stands, not rewritten');
  assert.equal(store.byKey(key).Locked, null);
});

test('a renewal past its lease whose re-read fails stores its token as before', async () => {
  const store = makeStore();
  const key = syncKeyFor(claude('a'));
  let failRead = false;
  const office = setup([claude('a')], {
    store,
    refresh: async (rt) => {
      store.tick(31_000);
      failRead = true;
      return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H };
    },
  });
  await office.sync.sync();
  office.sync.api = async (method, path, ...rest) => {
    if (failRead && method === 'GET' && path.startsWith('User/Credential/')) { failRead = false; throw new Error('fetch failed'); }
    return store.api(method, path, ...rest);
  };
  await office.am.ensureTokenFresh(0, true);
  assert.equal(failRead, false, 'the re-read was made, and failed');
  assert.equal(store.blob(key).accessToken, 'rt-a-1-renewed-at');
  assert.deepEqual(office.persisted.map(([, t]) => t.accessToken), ['rt-a-1-renewed-at']);
});

test('a row gone between its read and its lock is found again, and locked', async () => {
  const { sync, am, store, refreshed, sent } = setup([claude('a')]);
  await sync.sync();
  // Deleted on the store's side; this install still has it cached.
  store.rows.clear();
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(sent[0].locked, true);
  assert.equal(store.blob(syncKeyFor(claude('a'))).accessToken, 'rt-a-1-renewed-at');
});

test('an account the store does not carry by identity is still renewed under the lock of the row that holds its token', async () => {
  const store = makeStore();
  const a = claude('a');
  store.put(syncKeyFor(a), encodeBlob({ ...a, credential: a.accessToken }, { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt }, { now: T0, by: 'office' }));
  // The same tokens here, imported without an identity.
  const { am, refreshed, sent } = setup([{ ...a, accountUuid: undefined, orgUuid: undefined }], { store });
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(sent[0].locked, true);

  // One whose token is nowhere in the store has nothing to race: renewed as it is.
  const lone = setup([{ ...claude('n'), accountUuid: undefined }], { store });
  await lone.am.ensureTokenFresh(0, true);
  assert.deepEqual(lone.refreshed, ['rt-n-1']);
});

// A renewal writes the row from the account that renewed it. One matched to
// the row by its refresh token alone carries no identity of its own.
test('a renewal by an account held without its identity keeps the row\'s identity and name, and another install adds it whole', async () => {
  const store = makeStore();
  const a = claude('a', { hasClaudeMax: true, rateLimitTier: 'tier-a' });
  const key = syncKeyFor(a);
  store.put(key, encodeBlob(a, { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: T0 - H }, { now: T0, by: 'office' }));
  // `teamclaude import` of that expired token renews it before reading the profile.
  const imported = { name: 'imported account', type: 'oauth', accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: T0 - H };
  const tokens = await refreshOutsideProxy(imported, async () => ({ accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 8 * H }),
    { force: true, api: store.api, isSignedIn: async () => true, log: () => {}, now: store.now, by: 'laptop' });
  assert.equal(tokens?.refreshToken, 'rt-a-2');
  const blob = store.blob(key);
  assert.equal(blob.refreshToken, 'rt-a-2', 'the renewal is stored');
  for (const f of ['accountUuid', 'orgUuid', 'orgName', 'hasClaudeMax', 'rateLimitTier']) assert.equal(blob[f], a[f], f);
  assert.equal(blob.name, 'a');
  // An install without the account adds it as the row describes it, and syncs it.
  const other = setup([], { store });
  await other.sync.sync();
  assert.equal(other.admitted.length, 1);
  assert.equal(other.admitted[0].name, 'a');
  assert.equal(isSyncable(other.admitted[0]), true);
});

test('a renewal by an account missing part of its identity keeps the rest from the row; what it has decides', async () => {
  const store = makeStore();
  const a = claude('a', { hasClaudeMax: true, rateLimitTier: 'tier-a' });
  store.put(syncKeyFor(a), encodeBlob(a, { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt }, { now: T0, by: 'office' }));
  const { am } = setup([claude('a', { orgName: undefined, hasClaudeMax: false })], { store });
  await am.ensureTokenFresh(0, true);
  const blob = store.blob(syncKeyFor(a));
  assert.equal(blob.refreshToken, 'rt-a-1-renewed-rt');
  assert.equal(blob.orgName, 'Org a');
  assert.equal(blob.rateLimitTier, 'tier-a');
  assert.equal(blob.hasClaudeMax, false, 'the account\'s own reading');
});

test('an account renewing under the lock of a row of another identity takes nothing from that row', async () => {
  const store = makeStore();
  const a = claude('a', { hasClaudeMax: true, rateLimitTier: 'tier-a' });
  // The row names a, yet holds the refresh token b has.
  store.put(syncKeyFor(a), encodeBlob(a, { accessToken: 'at-b-1', refreshToken: 'rt-b-1', expiresAt: T0 + 8 * H }, { now: T0, by: 'office' }));
  const { am, refreshed } = setup([claude('b')], { store });
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-b-1']);
  const blob = store.blob(syncKeyFor(a));
  assert.equal(blob.accountUuid, 'uuid-b');
  assert.equal(blob.hasClaudeMax, undefined);
  assert.equal(blob.rateLimitTier, undefined);
});

test('a Codex account renewing keeps its row\'s other fields, and takes nothing from a row of another Codex account', async () => {
  const store = makeStore();
  const c = codex('c', { rateLimitTier: 'tier-c' });
  store.put(syncKeyFor(c), encodeBlob({ ...c, name: 'c at the office' }, { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt }, { now: T0, by: 'office' }));
  const own = setup([codex('c')], { store });
  await own.am.ensureTokenFresh(0, true);
  let blob = store.blob(syncKeyFor(c));
  assert.equal(blob.refreshToken, 'rt-c-1-renewed-rt');
  assert.equal(blob.rateLimitTier, 'tier-c');
  assert.equal(blob.name, 'c', 'an account with its identity names the row, as before');
  // The row names c, yet holds the refresh token d has.
  store.put(`${KEY_PREFIX}codex.acct-c2`, encodeBlob({ ...c, accountId: 'acct-c2', name: 'c2' }, { accessToken: 'at-d-1', refreshToken: 'rt-d-1', expiresAt: T0 + 8 * H }, { now: T0, by: 'office' }));
  const other = setup([codex('d')], { store });
  await other.am.ensureTokenFresh(0, true);
  blob = store.blob(`${KEY_PREFIX}codex.acct-c2`);
  assert.equal(blob.refreshToken, 'rt-d-1-renewed-rt');
  assert.equal(blob.accountId, 'acct-d');
  assert.equal(blob.rateLimitTier, undefined);
});

// Every write over a row other than a sign-in keeps the row's fields the
// account lacks: the pass storing a renewal, the token listener, an emptying.
const rowWithMore = (store, tokens) => store.put(syncKeyFor(claude('a')), encodeBlob(claude('a', { rateLimitTier: 'tier-a' }), tokens, { now: T0, by: 'office' }));
const keptFromRow = (store) => {
  const blob = store.blob(syncKeyFor(claude('a')));
  assert.equal(blob.orgName, 'Org a');
  assert.equal(blob.rateLimitTier, 'tier-a');
  return blob;
};

test('the pass storing a renewal keeps the row\'s fields the account lacks', async () => {
  const store = makeStore();
  rowWithMore(store, { accessToken: 'at-a-0', refreshToken: 'rt-a-0', expiresAt: T0 + H });
  const { sync } = setup([claude('a', { orgName: undefined })], { store });
  assert.equal((await sync.sync()).pushed, 1);
  assert.equal(keptFromRow(store).refreshToken, 'rt-a-1');
});

test('a renewal stored from the token listener keeps the row\'s fields the account lacks', async () => {
  const store = makeStore();
  rowWithMore(store, { accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H });
  const { sync, am } = setup([claude('a', { orgName: undefined })], { store, minted: false });
  await sync.sync();
  am.accounts[0]._minted = true;
  await sync.onLocalTokens(0, { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 9 * H });
  assert.equal(keptFromRow(store).refreshToken, 'rt-a-2');
});

test('emptying a row that holds the rejected token keeps the row\'s fields the account lacks', async () => {
  const store = makeStore();
  rowWithMore(store, { accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H });
  const { sync, am } = setup([claude('a', { orgName: undefined })], { store });
  am.accounts[0].status = 'error';
  am.accounts[0]._deadRefreshToken = 'rt-a-1';
  assert.equal((await sync.sync()).emptied, 1);
  assert.equal(keptFromRow(store).refreshToken, '');
});

// Rewritten by another version between the read and the lock, the row holds
// nothing to keep: the renewal is stored as the account describes it.
test('a renewal by an account held without its identity is still stored over a row that no longer reads once locked', async () => {
  const store = makeStore();
  const a = claude('a');
  const row = store.put(syncKeyFor(a), encodeBlob(a, { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: T0 - H }, { now: T0, by: 'office' }));
  const api = async (method, path, params, opts) => {
    if (path.endsWith(':lock')) row.Data = JSON.stringify({ v: 2, by: 'newer' });
    return store.api(method, path, params, opts);
  };
  const imported = { name: 'imported account', type: 'oauth', accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: T0 - H };
  const tokens = await refreshOutsideProxy(imported, async () => ({ accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 8 * H }),
    { force: true, api, isSignedIn: async () => true, log: () => {}, now: store.now, by: 'laptop' });
  assert.equal(tokens?.refreshToken, 'rt-a-2');
  assert.equal(store.blob(syncKeyFor(a)).refreshToken, 'rt-a-2', 'the renewal is stored');
});

// A sign-in's entry is what the sign-in read: a plan field the sign-in no
// longer reads is not kept from the row.
test('a sign-in is stored as its entry stands, without what the row said before', async () => {
  const store = makeStore();
  const a = claude('a', { seatTier: 'team-premium', organizationType: 'claude_team' });
  store.put(syncKeyFor(a), encodeBlob(a, { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt }, { now: T0, by: 'office' }));
  const { sync } = setup([], { store });
  assert.equal(await sync.storeSignIn({ ...claude('a'), seatTier: null, organizationType: null, accessToken: 'at-a-login', refreshToken: 'rt-a-login', expiresAt: T0 + 8 * H }), true);
  const blob = store.blob(syncKeyFor(a));
  assert.equal(blob.refreshToken, 'rt-a-login');
  assert.equal(blob.seatTier, undefined);
  assert.equal(blob.organizationType, undefined);
});

test('a forced refresh waits for the lock holder even while the clock calls the token good', async () => {
  // The 401 said it is dead whatever the clock says; "keep it" is no answer.
  const { sync, am, store, refreshed, sleeps } = setup([claude('a', { expiresAt: Date.now() + 2 * 60_000 })]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) };
  const renewed = { ...am.accounts[0], credential: 'at-a-mac', refreshToken: 'rt-a-mac', expiresAt: Date.now() + 8 * H };
  sync.api = async (method, path, params, opts) => {
    if (method === 'GET' && path.endsWith(row.User_Credential__) && sleeps.length >= 1) {
      row.Data = JSON.stringify(encodeBlob(renewed, tokensOf(renewed), { now: store.now(), by: 'mac' }));
    }
    return store.api(method, path, params, opts);
  };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, []);
  assert.equal(am.accounts[0].credential, 'at-a-mac');
});

test('a CLI renewal goes through the same lock: refused while an install holds it, plain when signed out', async () => {
  const store = makeStore();
  const { sync } = setup([claude('a')], { store });
  await sync.sync();
  const row = store.byKey(syncKeyFor(claude('a')));
  const calls = [];
  const refresh = async (o) => { calls.push(o); return { accessToken: 'at-cli', refreshToken: 'rt-cli', expiresAt: store.now() + 8 * H }; };
  const opts = { api: store.api, now: store.now, isSignedIn: async () => true, log: () => {}, by: 'cli', sleep: async (ms) => { store.tick(ms); } };

  row.Locked = { unixms: String(store.now()) };
  // Still good by the clock: kept.
  assert.equal(await refreshOutsideProxy(claude('a', { expiresAt: Date.now() + 2 * 60_000 }), refresh, opts), null);
  // Expired, and the holder never stores: it gives up after its rounds, unrenewed.
  // (Each round's wait outlasts the lease, so it is re-taken in the fake: hold it.)
  const holdApi = async (method, path, params, o) => {
    if (path.endsWith(':lock')) throw Object.assign(new Error('Credential is locked'), { token: 'error_credential_locked' });
    return store.api(method, path, params, o);
  };
  await assert.rejects(refreshOutsideProxy(claude('a', { expiresAt: Date.now() - 1000 }), refresh, { ...opts, api: holdApi }), { code: 'CALLBACK_LOCK_UNAVAILABLE' });
  assert.deepEqual(calls, []);

  // Free: renewed under it, stored, released.
  row.Locked = null;
  const t = await refreshOutsideProxy(claude('a', { expiresAt: Date.now() - 1000 }), refresh, { ...opts, force: true });
  assert.equal(t.accessToken, 'at-cli');
  assert.equal(calls.length, 1);
  assert.equal(store.blob(syncKeyFor(claude('a'))).accessToken, 'at-cli');
  assert.equal(row.Locked, null);

  // Signed out of callback.net: a plain refresh, no store involved.
  const before = store.calls.length;
  await refreshOutsideProxy(claude('a'), refresh, { ...opts, isSignedIn: async () => false });
  assert.equal(calls.length, 2);
  assert.equal(store.calls.length, before);
});

test('a refresh the provider rejects releases the lock, then empties the row that held the rejected token', async () => {
  const { sync, am, store, recoveries } = setup([claude('a')], { refresh: async () => { throw Object.assign(new Error('refresh 400'), { status: 400 }); } });
  await sync.sync();
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(await recoveries[0], false, 'nothing to adopt');
  const key = syncKeyFor(am.accounts[0]);
  assert.equal(store.byKey(key).Locked, null, 'locked to empty it, and released');
  assert.equal(store.blob(key).refreshToken, '');
  assert.equal(needsSignIn(decodeBlob(store.byKey(key).Data)), true);
  // Emptied under its own lock, taken after the refresh released its own.
  const tail = store.calls.slice(-3).map((c) => `${c.method} ${c.path.replace(/^User\/Credential\/[^:]+/, 'row')}`);
  assert.deepEqual(tail, ['POST row:lock', 'PATCH row', 'POST row:unlock']);
  assert.equal(sync.summary().signInNeeded, 1);
});

test('a row another install holds the lock on, or has written a working token to since, is not emptied', async () => {
  const one = setup([claude('a')], { refresh: async () => { throw Object.assign(new Error('refresh 400'), { status: 400 }); } });
  await one.sync.sync();
  await one.am.ensureTokenFresh(0, true);
  await Promise.all(one.recoveries);
  const { store } = one;
  const key = syncKeyFor(one.am.accounts[0]);
  const rejected = JSON.stringify(encodeBlob(claude('a'), { accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H }, { now: T0, by: 'office' }));

  // The row holds the rejected token again, but another install holds its lock: left alone.
  store.byKey(key).Data = rejected;
  store.byKey(key).Locked = { unixms: String(store.now()) };
  assert.equal(await one.sync._markNeedsSignIn(one.am.accounts[0], one.sync.rows.get(key)), false);
  assert.equal(store.blob(key).refreshToken, 'rt-a-1');

  // Unlocked, but a working token was stored between our read and our lock: adopted, not emptied.
  store.byKey(key).Locked = null;
  const stale = { ...one.sync.rows.get(key) };
  store.byKey(key).Data = JSON.stringify(encodeBlob(claude('a'), { accessToken: 'at-a-new', refreshToken: 'rt-a-new', expiresAt: T0 + 9 * H }, { now: T0, by: 'office' }));
  assert.equal(await one.sync._markNeedsSignIn(one.am.accounts[0], stale), false);
  assert.equal(store.blob(key).refreshToken, 'rt-a-new');
  assert.equal(one.am.accounts[0].refreshToken, 'rt-a-new');
  assert.equal(one.am.accounts[0].status, 'active');
  assert.equal(store.byKey(key).Locked, null);
});

test('a pass of an account whose rejected token is still the stored one empties the row; one rejected only for its access token does not', async () => {
  const store = makeStore();
  store.put(syncKeyFor(claude('a')), encodeBlob(claude('a'), { accessToken: 'at-a-1', refreshToken: 'rt-a-1', expiresAt: T0 + 8 * H }, { now: T0, by: 'office' }));
  store.put(syncKeyFor(claude('b')), encodeBlob(claude('b'), { accessToken: 'at-b-1', refreshToken: 'rt-b-1', expiresAt: T0 + 8 * H }, { now: T0, by: 'office' }));
  const { sync, am } = setup([claude('a'), claude('b')], { store });
  am.accounts[0].status = 'error';
  am.accounts[0]._deadRefreshToken = 'rt-a-1';
  am.accounts[1].status = 'error'; // a 401 on the access token: its refresh token is not known dead
  const r = await sync.sync();
  assert.equal(r.emptied, 1);
  assert.equal(store.blob(syncKeyFor(claude('a'))).refreshToken, '');
  assert.equal(store.blob(syncKeyFor(claude('b'))).refreshToken, 'rt-b-1');
  // Once emptied, the next pass has nothing more to do with it.
  assert.equal((await sync.sync()).emptied, 0);
});

test('an emptied row is never taken: not adopted, not added, not a lock answer; a renewed token overwrites it, an unrenewed one does not', async () => {
  const store = makeStore();
  const dead = encodeBlob(claude('a'), { accessToken: 'at-a-0', refreshToken: '', expiresAt: T0 + 50 * H }, { now: T0, by: 'office' });
  store.put(syncKeyFor(claude('a')), dead);
  store.put(syncKeyFor(claude('n')), encodeBlob(claude('n'), { accessToken: 'at-n-0', refreshToken: '', expiresAt: T0 + 50 * H }, { now: T0, by: 'office' }));

  // An install that has not renewed its token: reads, takes nothing, writes nothing.
  const fresh = setup([claude('a')], { store, minted: false });
  const r1 = await fresh.sync.sync();
  assert.equal(r1.adopted + r1.added + r1.pushed, 0);
  assert.equal(fresh.am.accounts.length, 1, 'no account made from an emptied row');
  assert.equal(fresh.am.accounts[0].credential, 'at-a-1', 'a later expiry does not make it newer');
  assert.equal(store.blob(syncKeyFor(claude('a'))).refreshToken, '');

  // Its renewal, under the lock: the fresh token replaces the marker, whatever the expiry.
  await fresh.am.ensureTokenFresh(0, true);
  assert.deepEqual(fresh.refreshed, ['rt-a-1']);
  assert.equal(store.blob(syncKeyFor(claude('a'))).refreshToken, 'rt-a-1-renewed-rt');

  // A pass of an install holding a token it renewed replaces it too.
  store.byKey(syncKeyFor(claude('a'))).Data = JSON.stringify(dead);
  const renewing = setup([claude('a')], { store });
  assert.equal((await renewing.sync.sync()).pushed, 1);
  assert.equal(store.blob(syncKeyFor(claude('a'))).refreshToken, 'rt-a-1');

  // Under the lock, an emptied row is renewed over, never adopted.
  store.byKey(syncKeyFor(claude('a'))).Data = JSON.stringify(dead);
  await renewing.am.ensureTokenFresh(0, true);
  assert.deepEqual(renewing.refreshed, ['rt-a-1']);
  assert.equal(store.blob(syncKeyFor(claude('a'))).refreshToken, 'rt-a-1-renewed-rt');
});

// ── an account whose token was not renewed here ──────────────

test('a pass stores no account whose token this install did not renew, and still adopts into it', async () => {
  const store = makeStore();
  const b = claude('b');
  const fresher = { ...b, credential: 'at-b-9', refreshToken: 'rt-b-9', expiresAt: T0 + 20 * H };
  store.put(syncKeyFor(b), encodeBlob(fresher, tokensOf(fresher), { now: T0, by: 'office' }));
  const c = claude('c');
  const staler = { ...c, credential: 'at-c-0', refreshToken: 'rt-c-0', expiresAt: T0 };
  store.put(syncKeyFor(c), encodeBlob(staler, tokensOf(staler), { now: T0, by: 'office' }));
  const { sync, am } = setup([claude('a'), b, c], { store, minted: false });

  const r = await sync.sync('start');
  assert.equal(r.created, 0, 'a: no row made from a token read at launch');
  assert.equal(r.pushed, 0, 'c: its row is not overwritten by a token read at launch, newer or not');
  assert.equal(r.adopted, 1, 'b: reading is unchanged');
  assert.equal(am.accounts[1].credential, 'at-b-9');
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])), null);
  assert.equal(store.blob(syncKeyFor(c)).accessToken, 'at-c-0');
  assert.ok(!store.calls.some((x) => x.method === 'PATCH' || (x.method === 'POST' && x.path === 'User/Credential')));
});

test('a token that works is still not stored until renewed: a quota reading and the passes after it write nothing', async () => {
  const store = makeStore();
  const c = claude('c');
  const staler = { ...c, credential: 'at-c-0', refreshToken: 'rt-c-0', expiresAt: T0 };
  store.put(syncKeyFor(c), encodeBlob(staler, tokensOf(staler), { now: T0, by: 'office' }));
  const { sync, am } = setup([claude('a'), c], { store, minted: false });
  await sync.sync('start');

  am.applyUsageData(0, { five_hour: { utilization: 10 } });
  am.applyUsageData(1, { five_hour: { utilization: 10 } });
  await new Promise((r) => setImmediate(r));
  const r = await sync.sync('daily');
  assert.equal(r.created + r.pushed, 0);
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])), null);
  assert.equal(store.blob(syncKeyFor(c)).accessToken, 'at-c-0');
  assert.ok(!store.calls.some((x) => x.method === 'PATCH' || (x.method === 'POST' && x.path === 'User/Credential')));
});

test('a token read at launch with no row is renewed under the lock of a placeholder holding no token, which the renewal fills', async () => {
  const { am, store, refreshed, sent } = setup([claude('a')], { minted: false });
  const key = syncKeyFor(am.accounts[0]);
  let atGrant = null;
  am._refreshFn = async (rt) => {
    refreshed.push(rt);
    sent.push({ locked: !!store.byKey(key)?.Locked });
    atGrant = store.blob(key);
    return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H };
  };
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(sent[0].locked, true, 'the lock was held as the grant went out');
  assert.equal(atGrant.pending, true);
  assert.equal(atGrant.accountUuid, 'uuid-a');
  assert.ok(!('accessToken' in atGrant) && !('refreshToken' in atGrant), 'the launch token was never stored');
  assert.equal(decodeBlob(JSON.stringify(atGrant)), null, 'a placeholder reads as no blob');
  assert.equal(store.blob(key).accessToken, 'rt-a-1-renewed-at');
  assert.equal(store.byKey(key).Locked, null, 'released');
  assert.equal(am.accounts[0]._minted, true);
});

test('two installs holding the same launch token with no row: one renews, the other adopts (#554)', async () => {
  const store = makeStore();
  const one = setup([claude('a')], { store, minted: false });
  const two = setup([claude('a')], { store, minted: false });
  let release;
  const gate = new Promise((r) => { release = r; });
  one.am._refreshFn = async (rt) => { one.refreshed.push(rt); await gate; return { accessToken: 'at-one', refreshToken: 'rt-one', expiresAt: store.now() + 8 * H }; };
  const oneDone = one.am.ensureTokenFresh(0, true);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.ok(store.byKey(syncKeyFor(claude('a'))).Locked, 'one holds the placeholder\'s lock');
  two.sync.sleep = async (ms) => { store.tick(ms); release(); await oneDone; };
  await two.am.ensureTokenFresh(0, true);
  await oneDone;
  assert.deepEqual(one.refreshed, ['rt-a-1']);
  assert.deepEqual(two.refreshed, [], 'two never called the provider');
  assert.equal(two.am.accounts[0].credential, 'at-one');
  assert.equal(two.am.accounts[0].refreshToken, 'rt-one');
  assert.equal(store.rows.size, 1);
  assert.equal(store.blob(syncKeyFor(claude('a'))).accessToken, 'at-one');
});

test('a placeholder left by a renewal that failed for now is no account, no sign-in needed, and the next renewal locks it', async () => {
  const store = makeStore();
  const one = setup([claude('a')], { store, minted: false, refresh: () => { throw Object.assign(new Error('Token refresh failed (429)'), { status: 429 }); } });
  await one.am.ensureTokenFresh(0, true);
  assert.equal(one.am.accounts[0].status !== 'error', true, 'a 429 is not a rejection');
  const key = syncKeyFor(claude('a'));
  assert.equal(store.blob(key).pending, true);

  await one.sync.sync();
  assert.deepEqual(one.sync.summary().signInNeeded, 0);
  assert.equal(store.blob(key).pending, true, 'a pass of the unrenewed account writes nothing');
  const other = setup([claude('b')], { store });
  assert.equal((await other.sync.sync()).added, 0, 'no account made from a placeholder');

  const two = setup([claude('a')], { store, minted: false });
  await two.am.ensureTokenFresh(0, true);
  assert.deepEqual(two.refreshed, ['rt-a-1']);
  assert.ok(store.calls.filter((c) => c.path.endsWith(':lock')).length >= 2, 'both renewals took the lock');
  assert.equal(store.blob(key).accessToken, 'rt-a-1-renewed-at');
  assert.equal(store.rows.size, 2);
});

// ── an account in error ──────────────────────────────────────

test('a pass never writes an account in error over its row, and adopts a different token whatever its expiry', async () => {
  const store = makeStore();
  const a = claude('a');
  // The store holds an older token than the dead one here — a sign-in elsewhere
  // that this install's rejected copy would otherwise "beat" on expiry.
  const elsewhere = { ...a, credential: 'at-a-elsewhere', refreshToken: 'rt-a-elsewhere', expiresAt: T0 + 2 * H };
  store.put(syncKeyFor(a), encodeBlob(elsewhere, tokensOf(elsewhere), { now: T0, by: 'office' }));
  const { sync, am } = setup([a], { store });
  am.accounts[0].status = 'error';
  am.accounts[0]._deadRefreshToken = 'rt-a-1';

  const r = await sync.sync();
  assert.equal(r.adopted, 1);
  assert.equal(r.pushed, 0);
  assert.ok(!store.calls.some((c) => c.method === 'PATCH'), 'the row is not written');
  assert.equal(store.blob(syncKeyFor(a)).accessToken, 'at-a-elsewhere');
  assert.equal(am.accounts[0].credential, 'at-a-elsewhere');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-elsewhere');
  assert.equal(am.accounts[0].status, 'active');
});

test('an account in error whose row holds the same token, or the rejected one, is left in error and the row untouched', async () => {
  const store = makeStore();
  const a = claude('a');
  store.put(syncKeyFor(a), encodeBlob({ ...a, credential: a.accessToken }, { accessToken: 'at-a-0', refreshToken: 'rt-a-dead', expiresAt: T0 }, { now: T0, by: 'office' }));
  const { sync, am } = setup([a], { store });
  am.accounts[0].status = 'error';
  am.accounts[0]._deadRefreshToken = 'rt-a-dead';
  const r = await sync.sync();
  assert.equal(r.adopted + r.pushed, 0);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].credential, 'at-a-1');
  assert.ok(!store.calls.some((c) => c.method === 'PATCH'));
});

test('an account in error with no row is not stored, and a re-import of its rejected refresh token is not either', async () => {
  const { sync, am, store } = setup([claude('a'), claude('b')]);
  am.accounts[0].status = 'error';
  const r = await sync.sync();
  assert.equal(r.created, 1, 'b only');
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])), null);

  // b's refresh token was rejected; an import brings a new access token with it.
  am.accounts[1]._deadRefreshToken = 'rt-b-1';
  am.updateAccountTokens(1, { accessToken: 'at-b-2', refreshToken: 'rt-b-1', expiresAt: T0 + 30 * H });
  await new Promise((res) => setImmediate(res));
  assert.equal(store.blob(syncKeyFor(am.accounts[1])).accessToken, 'at-b-1');
});

test('an account that goes into error takes a token another install stored since, and is back in rotation', async () => {
  // Signed in again on another install while this one's refresh is in flight:
  // the lock read still showed this install's token, so it renewed, and the
  // provider rejected it. The new token is in the store by then.
  let signInElsewhere = () => {};
  const { sync, am, store, recoveries } = setup([claude('a')], { refresh: async () => { signInElsewhere(); throw Object.assign(new Error('refresh 400'), { status: 400 }); } });
  await sync.sync();
  const key = syncKeyFor(am.accounts[0]);
  const row = store.byKey(key);
  const elsewhere = { ...claude('a'), credential: 'at-a-new', refreshToken: 'rt-a-new', expiresAt: T0 + 9 * H };
  signInElsewhere = () => { row.Data = JSON.stringify(encodeBlob(elsewhere, tokensOf(elsewhere), { now: T0, by: 'office' })); };
  // This install's own token still looks the newest by expiry.
  am.accounts[0].expiresAt = T0 + 50 * H;

  await am.ensureTokenFresh(0, true);
  await Promise.all(recoveries);
  assert.equal(recoveries.length, 1);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].credential, 'at-a-new');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-new');
  assert.equal(store.blob(key).accessToken, 'at-a-new', 'the row is never written back over');

  // A credential rejection with nothing new in the store: it stays in error.
  am.markCredentialRejected(0, '401');
  assert.equal(await recoveries[1], false);
  assert.equal(am.accounts[0].status, 'error');
});

// The remedy for a refusal is a sign-in, and one made on another install
// reaches this one through the store.
test('a sign-in on another install brings an account upstream refused here back at the next pass', async () => {
  const store = makeStore();
  const home = setup([claude('a')], { store });
  await home.sync.sync();
  home.am.markRefused(home.am.accounts[0], { code: 'account_on_hold', message: 'on hold', link: null });
  await home.sync.sync();
  assert.equal(home.am.accounts[0].status, 'error', 'nothing new in the store');
  const office = setup([], { store });
  await office.sync.storeSignIn({ ...claude('a'), accessToken: 'at-a-login', refreshToken: 'rt-a-login', expiresAt: T0 + 8 * H });
  await home.sync.sync();
  assert.equal(home.am.accounts[0].status, 'active');
  assert.equal(home.am.accounts[0].credential, 'at-a-login');
});

test('two installs renewing one account at once: one renews, the other adopts', async () => {
  // Both fleets share one store; the "office" install holds the lock while it
  // renews, and the "home" install, refused, waits and takes the result.
  const store = makeStore();
  const office = setup([claude('a')], { store });
  const home = setup([claude('a')], { store });
  await office.sync.sync();
  await home.sync.sync();
  // Office renews slowly: its provider call takes 7 seconds of store time.
  let release;
  const gate = new Promise((r) => { release = r; });
  office.am._refreshFn = async (rt) => { office.refreshed.push(rt); await gate; return { accessToken: 'at-office', refreshToken: 'rt-office', expiresAt: store.now() + 8 * H }; };
  const officeDone = office.am.ensureTokenFresh(0, true);
  await new Promise((r) => setImmediate(r)); // office has the lock
  // Home's first wait is where the office finishes: its sleep lets the office's
  // provider call return and its PATCH land before home looks again.
  home.sync.sleep = async (ms) => { store.tick(ms); release(); await officeDone; };
  const homeDone = home.am.ensureTokenFresh(0, true);
  await officeDone;
  await homeDone;
  assert.deepEqual(office.refreshed, ['rt-a-1']);
  assert.deepEqual(home.refreshed, [], 'home never called the provider');
  assert.equal(home.am.accounts[0].credential, 'at-office');
  assert.equal(home.am.accounts[0].refreshToken, 'rt-office');
  assert.equal(store.blob(syncKeyFor(claude('a'))).accessToken, 'at-office');
});

test('the daily pass is scheduled and stopped', async () => {
  const { sync, store } = setup([claude('a')]);
  const r = await sync.start();
  assert.equal(r.created, 1);
  assert.ok(sync._timer, 'armed');
  sync.stop();
  assert.equal(sync._timer, null);
  assert.deepEqual(sync.summary(), { lastSyncAt: store.now(), lastError: null, rows: 1, tombstones: 0, signInNeeded: 0 });
});
