import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { CredentialSync, syncKeyFor, isSyncable, encodeBlob, decodeBlob, entryFromBlob, KEY_PREFIX } from '../src/credential-sync.js';

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
      if (row.Locked && clock - Number(row.Locked.unixms) < (params?.timeout ?? 60) * 1000) throw err(0, 'error_credential_locked', 'Credential is locked');
      row.Locked = stamp();
      return view(row);
    }
    if (fn === 'unlock') { row.Locked = null; return view(row); }
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
  const am = new AccountManager(entries, 0.98, {
    refreshFn: async (rt) => { refreshed.push(rt); return refresh ? refresh(rt) : { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H }; },
    codexRefreshFn: async (rt) => { refreshed.push(rt); return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: store.now() + 8 * H }; },
  });
  const persisted = [];
  am.onTokenRefresh((idx, tokens) => { persisted.push([am.accounts[idx].name, tokens]); sync.onLocalTokens(idx, tokens); });
  const admitted = [];
  const logs = [];
  let signed = signedIn;
  const sleeps = [];
  const sync = new CredentialSync({
    accountManager: am, api: store.api, by: 'this-box', now: store.now, log: (l) => logs.push(l),
    isSignedIn: async () => signed,
    sleep: async (ms) => { sleeps.push(ms); store.tick(ms); },
    addAccount: (entry) => { admitted.push(entry); return am.addAccount(entry); },
  });
  am.setRefreshCoordinator((account, refresh) => sync.coordinateRefresh(account, refresh));
  am.onAccountRemoved((account) => sync.onAccountRemoved(account));
  return { am, sync, store, refreshed, persisted, admitted, logs, sleeps, signOut: () => { signed = false; }, signIn: () => { signed = true; } };
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
});

// ── the pass ─────────────────────────────────────────────────

test('signed out, nothing happens', async () => {
  const { sync, store, am } = setup([claude('a')], { signedIn: false });
  assert.deepEqual(await sync.sync(), { signedIn: false, adopted: 0, pushed: 0, created: 0, added: 0, rows: 0 });
  assert.equal(store.calls.length, 0);
  // A refresh is a plain refresh.
  await am.ensureTokenFresh(0, true);
  assert.equal(store.calls.length, 0);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
});

test('the first pass stores every syncable account, and only those', async () => {
  const { sync, store } = setup([claude('a'), codex('c'), { name: 'k', type: 'apikey', apiKey: 'k' }, claude('g', { upstream: 'https://gw.example' })]);
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 2, added: 0, rows: 0 });
  assert.deepEqual([...store.rows.values()].map((x) => x.Key).sort(), [`${KEY_PREFIX}anthropic.uuid-a.org-a`, `${KEY_PREFIX}codex.acct-c`]);
  const blob = store.blob(`${KEY_PREFIX}anthropic.uuid-a.org-a`);
  assert.equal(blob.accessToken, 'at-a-1');
  assert.equal(blob.by, 'this-box');
  // A second pass changes nothing.
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 0, created: 0, added: 0, rows: 2 });
});

test('a row with no local account becomes one, with its tokens and identity but none of another install\'s settings', async () => {
  const store = makeStore();
  const other = { ...claude('b'), credential: 'at-b-7', refreshToken: 'rt-b-7', expiresAt: T0 + 6 * H, priority: 9, disabled: true };
  store.put(syncKeyFor(other), encodeBlob(other, tokensOf(other), { now: T0, by: 'office' }));
  store.put('someone-elses-key', { whatever: true });
  const { sync, am, admitted, logs } = setup([claude('a')], { store });
  const r = await sync.sync('start');
  assert.deepEqual(r, { signedIn: true, adopted: 0, pushed: 0, created: 1, added: 1, rows: 1 });
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
  assert.deepEqual(r, { signedIn: true, adopted: 1, pushed: 1, created: 0, added: 0, rows: 2 });
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
  assert.deepEqual(await sync.sync(), { signedIn: true, adopted: 0, pushed: 1, created: 0, added: 0, rows: 1 });
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-1');

  const broken = setup([claude('b')], { store: { ...makeStore(), api: async () => { throw new Error('fetch failed'); } } });
  await assert.rejects(broken.sync.sync('start'), /fetch failed/);
  assert.match(broken.sync.summary().lastError, /fetch failed/);
  assert.equal(broken.am.accounts[0].credential, 'at-b-1');
});

test('an account removed here stays out, until it is signed in here again', async () => {
  const store = makeStore();
  const { sync, am, admitted } = setup([claude('a'), claude('b')], { store });
  await sync.sync();
  assert.equal(store.rows.size, 2);

  am.removeAccount(1); // b leaves this install
  assert.deepEqual(Object.keys(sync.exportState().ignored), [syncKeyFor(claude('b'))]);
  await sync.sync();
  assert.equal(admitted.length, 0, 'the row did not bring b back');
  assert.equal(store.rows.size, 2, 'the row is still there for the other installs');

  // Signed in again here: the account is back, so its removal is forgotten.
  am.addAccount(claude('b', { accessToken: 'at-b-5', refreshToken: 'rt-b-5', expiresAt: T0 + 30 * H }));
  await sync.sync();
  assert.deepEqual(sync.exportState().ignored, {});
  assert.equal(store.blob(syncKeyFor(claude('b'))).accessToken, 'at-b-5');

  // The remembered removals survive a restart through the state file.
  const again = new CredentialSync({ accountManager: am, addAccount: () => null, api: store.api, state: { ignored: { k1: T0, bad: 'x' } } });
  assert.deepEqual(again.exportState(), { ignored: { k1: T0 } });
});

test('forget deletes the row for everyone and leaves the local account alone', async () => {
  const { sync, am, store } = setup([claude('a'), claude('b')]);
  await sync.sync();
  assert.equal(await sync.forget(am.accounts[1]), true);
  assert.equal(store.rows.size, 1);
  assert.equal(am.accounts.length, 2);
  assert.equal(await sync.forget(am.accounts[1]), false);
  assert.equal(await sync.forget({ name: 'k', type: 'apikey' }), false);
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

test('lock refused and nothing stored within 30s: the lock is tried again, and taken once it has timed out', async () => {
  const { sync, am, store, refreshed, sleeps, logs } = setup([claude('a')]);
  await sync.sync();
  const row = store.byKey(syncKeyFor(am.accounts[0]));
  row.Locked = { unixms: String(store.now()) }; // a holder that never stores anything (crashed mid-renewal)
  await am.ensureTokenFresh(0, true);
  // 30s of waiting (six re-reads), then the lock — 60s old by the second round — is taken.
  assert.equal(sleeps.filter((ms) => ms === 5000).length >= 6, true, String(sleeps));
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
  assert.ok(logs.some((l) => /stored no renewal in 30s; trying the lock again/.test(l)), logs.join('\n'));
});

test('the store being unreachable never stops a refresh', async () => {
  const { sync, am, store, refreshed, logs } = setup([claude('a')]);
  await sync.sync();
  sync.api = async () => { throw new Error('fetch failed'); };
  store.tick(H); // the renewal, when it comes, expires later than the stored token
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  assert.equal(am.accounts[0].credential, 'rt-a-1-renewed-at');
  assert.ok(logs.some((l) => /lock for "a" failed \(fetch failed\); renewing without it/.test(l)), logs.join('\n'));
  // Back later, the next pass stores what was renewed meanwhile.
  sync.api = store.api;
  const r = await sync.sync();
  assert.equal(r.pushed, 1);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'rt-a-1-renewed-at');
});

test('a refresh the provider rejects releases the lock and leaves the row as it was', async () => {
  const { sync, am, store } = setup([claude('a')], { refresh: async () => { throw Object.assign(new Error('refresh 400'), { status: 400 }); } });
  await sync.sync();
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(store.byKey(syncKeyFor(am.accounts[0])).Locked, null);
  assert.equal(store.blob(syncKeyFor(am.accounts[0])).accessToken, 'at-a-1');
});

test('an account the store has never seen is renewed plainly, then stored', async () => {
  const { am, store, refreshed } = setup([claude('a')]);
  // No pass has run: the row does not exist.
  await am.ensureTokenFresh(0, true);
  assert.deepEqual(refreshed, ['rt-a-1']);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.blob(syncKeyFor(am.accounts[0]))?.accessToken, 'rt-a-1-renewed-at');
  assert.ok(!store.calls.some((c) => c.path.endsWith(':lock')), 'nothing to lock yet');
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
  assert.deepEqual(sync.summary(), { lastSyncAt: store.now(), lastError: null, rows: 1, ignored: 0 });
});
