import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { CredentialSync, refreshOutsideProxy, syncKeyFor, isSyncable, encodeBlob, decodeBlob, entryFromBlob, tombstoneOf, tombstone, KEY_PREFIX, TOMBSTONE_TTL_MS } from '../src/credential-sync.js';

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
function setup(entries, { store = makeStore(), signedIn = true, refresh } = {}) {
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
  const sleeps = [];
  const removals = [];
  const sync = new CredentialSync({
    accountManager: am, api: store.api, by: 'this-box', now: store.now, log: (l) => logs.push(l),
    isSignedIn: async () => signed,
    sleep: async (ms) => { sleeps.push(ms); store.tick(ms); },
    addAccount: (entry) => { admitted.push(entry); return am.addAccount(entry); },
    evictAccount: (account) => { evicted.push(account.name); am.removeAccount(account.index); },
  });
  am.setRefreshCoordinator((account, refresh, info) => sync.coordinateRefresh(account, refresh, info)); // as index.js wires it
  am.onAccountRemoved((account) => { removals.push(sync.onAccountRemoved(account)); });
  const recoveries = [];
  am.onAccountError((account) => { recoveries.push(sync.onAccountError(account)); });
  // Every tombstone write a removal started, settled.
  const settled = () => Promise.all(removals);
  return { am, sync, store, refreshed, sent, persisted, admitted, evicted, logs, sleeps, settled, recoveries, signOut: () => { signed = false; }, signIn: () => { signed = true; } };
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
  assert.deepEqual(await sync.sync(), { signedIn: false, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, rows: 0 });
  assert.equal(store.calls.length, 0);
  // A refresh is a plain refresh.
  await am.ensureTokenFresh(0, true);
  assert.equal(store.calls.length, 0);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
});

test('the first pass stores every syncable account, and only those', async () => {
  const { sync, store } = setup([claude('a'), codex('c'), { name: 'k', type: 'apikey', apiKey: 'k' }, claude('g', { upstream: 'https://gw.example' })]);
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 2, added: 0, evicted: 0, expired: 0, rows: 0 });
  assert.deepEqual([...store.rows.values()].map((x) => x.Key).sort(), [`${KEY_PREFIX}anthropic.uuid-a.org-a`, `${KEY_PREFIX}codex.acct-c`]);
  const blob = store.blob(`${KEY_PREFIX}anthropic.uuid-a.org-a`);
  assert.equal(blob.accessToken, 'at-a-1');
  assert.equal(blob.by, 'this-box');
  // A second pass changes nothing.
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, rows: 2 });
});

test('a row with no local account becomes one, with its tokens and identity but none of another install\'s settings', async () => {
  const store = makeStore();
  const other = { ...claude('b'), credential: 'at-b-7', refreshToken: 'rt-b-7', expiresAt: T0 + 6 * H, priority: 9, disabled: true };
  store.put(syncKeyFor(other), encodeBlob(other, tokensOf(other), { now: T0, by: 'office' }));
  store.put('someone-elses-key', { whatever: true });
  const { sync, am, admitted, logs } = setup([claude('a')], { store });
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 1, added: 1, evicted: 0, expired: 0, rows: 1 });
  assert.deepEqual(admitted, [{ name: 'b', type: 'oauth', accountUuid: 'uuid-b', orgUuid: 'org-b', orgName: 'Org b', accessToken: 'at-b-7', refreshToken: 'rt-b-7', expiresAt: T0 + 6 * H }]);
  assert.equal(am.accounts[1].name, 'b');
  assert.equal(am.accounts[1].priority, 0);
  assert.equal(am.accounts[1].disabled, false);
  assert.ok(logs.some((l) => /"b" added from callback.net \(signed in on office\)/.test(l)), logs.join('\n'));
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
  assert.deepEqual(r, { signedIn: true, adopted: 1, pushed: 1, created: 0, added: 0, evicted: 0, expired: 0, rows: 2 });
  assert.equal(am.accounts[0].credential, 'at-a-9');
  assert.equal(am.accounts[0].refreshToken, 'rt-a-9');
  assert.equal(am.accounts[0].expiresAt, T0 + 20 * H);
  // Adopting persists like any token change, and does not come back round as a write.
  assert.deepEqual(persisted, [['a', { accessToken: 'at-a-9', refreshToken: 'rt-a-9', expiresAt: T0 + 20 * H }]]);
  assert.equal(s.calls.filter((c) => c.method === 'PATCH').length, 1, 'one PATCH: b');
  assert.equal(s.blob(syncKeyFor(b)).accessToken, 'at-b-1');
  assert.equal(s.blob(syncKeyFor(b)).by, 'this-box');
});

test('a local token change is stored; one the store already holds is not echoed', async () => {
  const { sync, am, store } = setup([claude('a')]);
  await sync.sync();
  const writes = () => store.calls.filter((c) => c.method === 'PATCH' || (c.method === 'POST' && c.path === 'User/Credential')).length;
  const before = writes();
  // An import or a client refresh the proxy saw.
  am.updateAccountTokens(0, { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 9 * H });
  await new Promise((r) => setImmediate(r));
  assert.equal(writes(), before + 1);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-2');
  // The same tokens again: nothing to store.
  am.updateAccountTokens(0, { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 9 * H });
  await new Promise((r) => setImmediate(r));
  assert.equal(writes(), before + 1);
});

test('a row of ours that does not read is rewritten; a store that fails leaves the fleet as it was', async () => {
  const store = makeStore();
  store.put(syncKeyFor(claude('a')), { v: 99, garbage: true });
  const { sync, am } = setup([claude('a')], { store });
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 1, created: 0, added: 0, evicted: 0, expired: 0, rows: 1 });
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
  assert.deepEqual(await home.sync.sync(), { signedIn: true, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, rows: 2 });
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
  assert.deepEqual(office.sync.summary(), { lastSyncAt: store.now(), lastError: null, rows: 1, tombstones: 1 });
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

test('a refresh the provider rejects releases the lock and leaves the row as it was', async () => {
  const { sync, am, store } = setup([claude('a')], { refresh: async () => { throw Object.assign(new Error('refresh 400'), { status: 400 }); } });
  await sync.sync();
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])).Locked, null);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-1');
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
  assert.deepEqual(sync.summary(), { lastSyncAt: store.now(), lastError: null, rows: 1, tombstones: 0 });
});
