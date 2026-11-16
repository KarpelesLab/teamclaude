import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS as TTL, MAX_SESSIONS, MAX_AFFINITY_PINS } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';
import * as config from '../src/config.js';
import { affinityAccounts } from '../test-helpers/affinity-fixtures.js';

const OPUS = 'claude-opus-5';
const DIGEST = 'abcdefghijklmnopqrstuv';
const KEY = `client/${DIGEST}`;
const accounts = affinityAccounts();
const manager = (rows = accounts, opts = {}) => new AccountManager(rows, 0.98, { distributeSessions: true, ...opts });
const identify = idx => ({ id: `id-${idx}`, provider: 'anthropic' });
const resolve = ref => /^id-\d+$/.test(ref.id) ? Number(ref.id.slice(3)) : null;
const row = (extra = {}) => ({ key: KEY, sessionId: 'client', conversation: DIGEST, lastSeen: 100,
  pins: [{ bucket: 'unified7d', account: identify(1), at: 90 }], threads: ['msg_1'], ...extra });
const snapshot = (...sessions) => ({ version: 1, sessions });

// Break caught: restoring numeric positions instead of stable entry identities.
test('restart keeps each account identity through every three-account permutation', () => {
  const source = manager();
  source.recordSession('alpha', 1, OPUS);
  source.recordSession('beta', 2, OPUS);
  const saved = JSON.parse(JSON.stringify(source.exportAffinityState()));
  for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const restored = manager(order.map(i => ({ ...accounts[i], name: 'renamed', apiKey: 'rotated' })));
    restored.restoreAffinityState(saved);
    assert.equal(restored.getActiveAccount(null, OPUS, null, 'alpha').id, 'b');
    assert.equal(restored.getActiveAccount(null, OPUS, null, 'beta').id, 'c');
    const again = manager(accounts);
    again.restoreAffinityState(JSON.parse(JSON.stringify(restored.exportAffinityState())));
    assert.equal(again.getActiveAccount(null, OPUS, null, 'alpha').id, 'b');
  }
});

test('codec preserves independent buckets, conversation ownership and times, only', () => {
  const tracker = new SessionTracker({ now: () => 100 });
  tracker.beginRequest(KEY, 80, { sessionId: 'client', conversation: DIGEST, client: 'private-client', dimensions: { project: 'private-project' } });
  tracker.touch(KEY, 1, 'unified7d', 90);
  tracker.touch(KEY, 2, 'custom-route-bucket', 95);
  tracker.recordTokens(KEY, 'unified7d', { input_tokens: 123 }, 95);
  tracker.recordOutcome(KEY, false, 95);
  tracker.recordThreadMessage(KEY, 'msg_1', null, 95);
  tracker.noteRouted(1, 95);
  const opaque = 'opaque:arbitrary-key';
  tracker.touch(opaque, 1, 'unified7d', 90);
  const saved = tracker.exportAffinity(identify);
  assert.deepEqual(saved, snapshot(row({ lastSeen: 100, pins: [
    { bucket: 'unified7d', account: identify(1), at: 90 },
    { bucket: 'custom-route-bucket', account: identify(2), at: 95 },
  ] }), { key: opaque, sessionId: null, conversation: null, lastSeen: 90,
    pins: [{ bucket: 'unified7d', account: identify(1), at: 90 }], threads: [] }));
  const fresh = new SessionTracker({ now: () => 100 });
  fresh.restoreAffinity(JSON.parse(JSON.stringify(saved)), resolve);
  assert.equal(fresh.pinnedAccount(opaque, 'unified7d'), 1);
  assert.equal(fresh.sessions.get(opaque).sessionId, null);
  assert.equal(fresh.sessions.get(opaque).conversation, null);
  assert.equal(fresh.pinnedAccount(KEY, 'custom-route-bucket'), 2);
  assert.deepEqual(fresh.threadOwner('client', 'msg_1'), { key: KEY, conversation: DIGEST });
  assert.equal(fresh.threadOwner('another-client', 'msg_1'), null);
  const state = fresh.sessions.get(KEY);
  assert.equal(state.firstSeen, 100);
  assert.equal(state.lastSeen, 100);
  assert.deepEqual([state.inFlight, state.count, state.starved, state.refs.size, state.tokens.size, fresh.recentRequestsFor(1)], [0,0,0,0,0,0]);
  assert.equal(state.client, null);
  assert.equal(state.dimensions, null);
});

test('sliding idle lifetime survives days of activity and repeated restarts without renewal', async t => {
  let now = 0;
  let tracker = new SessionTracker({ now: () => now });
  for (let turn = 0; turn < 60; turn++) {
    tracker.touch('active', 1, 'unified7d');
    now += TTL / 2;
  }
  const lastSeen = now - TTL / 2;
  for (let restart = 0; restart < 3; restart++) {
    const saved = tracker.exportAffinity(identify);
    tracker = new SessionTracker({ now: () => now });
    tracker.restoreAffinity(saved, resolve);
    assert.equal(tracker.sessions.get('active').lastSeen, lastSeen);
  }
  now = lastSeen + TTL;
  assert.equal(tracker.pinnedAccount('active', 'unified7d'), 1, 'exact boundary is live');
  now++;
  const fresh = new SessionTracker({ now: () => now });
  fresh.restoreAffinity(snapshot(row({ lastSeen, pins: [{ bucket: 'unified7d', account: identify(1), at: lastSeen }], inFlight: 99 })), resolve);
  assert.equal(fresh.sessions.size, 0, 'disk inFlight cannot revive idle state');
  assert.equal(tracker.exportAffinity(identify).sessions.length, 0);
  for (const active of [false, true]) await t.test(active ? 'in-flight beyond TTL' : 'backward wall clock', () => {
    now = TTL * 2;
    const live = new SessionTracker({ now: () => now });
    if (active) live.beginRequest('clock');
    live.touch('clock', 1, 'unified7d');
    const seen = now;
    now = active ? seen + TTL + 1 : seen - 100;
    if (!active) {
      const idle = new SessionTracker({ now: () => now });
      const beforeUse = JSON.parse(JSON.stringify(live.exportAffinity(identify)));
      idle.restoreAffinity(beforeUse, resolve);
      assert.equal(idle.sessions.get('clock')?.lastSeen, now, 'a time ahead of the clock is read as now');
      assert.equal(idle.pinnedAccount('clock', 'unified7d'), 1);
      live.beginRequest('clock');
      live.touch('clock', 2, 'sibling');
      assert.equal(live.pinnedAccount('clock', 'unified7d'), 1, 'untouched family remains live');
    }
    const saved = JSON.parse(JSON.stringify(live.exportAffinity(identify)));
    assert.equal(saved.sessions[0]?.lastSeen, now);
    assert.equal(live.sessions.get('clock').lastSeen, active ? seen : now, 'export does not mutate live use');
    assert.equal(saved.sessions[0].pins.find(p => p.bucket === 'unified7d')?.at, seen, 'pin timestamp is preserved');
    const restored = new SessionTracker({ now: () => now });
    restored.restoreAffinity(saved, resolve);
    assert.equal(restored.pinnedAccount('clock', 'unified7d'), 1);
    if (!active) assert.equal(restored.pinnedAccount('clock', 'sibling'), 2);
    assert.equal(restored.sessions.get('clock').inFlight, 0);
    now = saved.sessions[0].lastSeen + TTL + 1;
    assert.equal(restored.pinnedAccount('clock', 'unified7d'), null);
    if (active) {
      live.endRequest('clock');
      now += TTL + 1;
      assert.equal(live.exportAffinity(identify).sessions.length, 0);
    }
  });
});

// A time ahead of the clock (the clock was stepped back between the save and
// this start, or the file is damaged) would never reach its idle expiry and
// would be the last record evicted at the cap.
test('restored times ahead of the clock are clamped to now, so they expire and are evicted like any other', () => {
  let now = 10 * TTL;
  const tracker = new SessionTracker({ now: () => now });
  tracker.restoreAffinity(snapshot(
    row({ key: 'ahead', lastSeen: now + 30 * TTL, pins: [{ bucket: 'unified7d', account: identify(1), at: now + 40 * TTL }] }),
    row({ key: 'behind', lastSeen: now - 5, pins: [{ bucket: 'unified7d', account: identify(2), at: now - 9 }] }),
    row({ key: 'max', lastSeen: Number.MAX_VALUE, pins: [{ bucket: 'unified7d', account: identify(1), at: Number.MAX_VALUE }] }),
  ), resolve);
  for (const key of ['ahead', 'max']) {
    assert.equal(tracker.sessions.get(key).lastSeen, now, key);
    assert.equal(tracker.sessions.get(key).firstSeen, now, key);
    assert.equal(tracker.sessions.get(key).pins.get('unified7d').at, now, key);
  }
  assert.equal(tracker.sessions.get('behind').lastSeen, now - 5, 'a time in the past is kept as saved');
  assert.equal(tracker.sessions.get('behind').pins.get('unified7d').at, now - 9);
  assert.equal(tracker.pinnedAccount('ahead', 'unified7d'), 1);
  now += TTL + 1;
  assert.equal(tracker.pinnedAccount('ahead', 'unified7d'), null, 'idle for the known window after the restore, it is forgotten');
  assert.equal(tracker.pinnedAccount('max', 'unified7d'), null);
  assert.equal(tracker.exportAffinity(identify).sessions.length, 0);
});

test('malformed versions, keys, timestamps and duplicate records cannot create affinity', () => {
  for (const bad of [null, {}, { version: 2, sessions: [row()] }, { version: 1, sessions: {} }]) {
    const tracker = new SessionTracker({ now: () => 100 });
    assert.doesNotThrow(() => tracker.restoreAffinity(bad, resolve));
    assert.equal(tracker.sessions.size, 0);
  }
  const badRows = [null, {}, row({ key: '' }), row({ sessionId: 's'.repeat(129) }),
    row({ conversation: 'x'.repeat(23) }), row({ lastSeen: -1 }),
    row({ lastSeen: '100' }), row({ pins: {}, threads: {} })];
  for (const bad of badRows) {
    const rejected = new SessionTracker({ now: () => 100 });
    rejected.restoreAffinity(JSON.parse(JSON.stringify(snapshot(bad))), resolve);
    assert.equal(rejected.sessions.size, 0, JSON.stringify(bad));
  }
  const tracker = new SessionTracker({ now: () => 100 });
  tracker.restoreAffinity(snapshot(row(), row({ pins: [], threads: ['msg_other'] })), resolve);
  assert.equal(tracker.sessions.size, 1);
  assert.equal(tracker.pinnedAccount(KEY, 'unified7d'), 1);
  assert.equal(tracker.threadOwner('client', 'msg_other'), null);
  const invalidPins = [null, {}, { bucket: '', account: identify(1), at: 90 },
    { bucket: 'string-time', account: identify(1), at: '90' }, { bucket: 'null-time', account: identify(1), at: null },
    { bucket: 'negative', account: identify(1), at: -1 }, { bucket: 'missing', account: {}, at: 90 }];
  for (const pin of invalidPins) {
    const clean = new SessionTracker({ now: () => 100 });
    clean.restoreAffinity(JSON.parse(JSON.stringify(snapshot(row({ lastSeen: 95, pins: [pin], threads: ['msg_1', '', 123, 'x'.repeat(129)] })))), resolve);
    assert.equal(clean.pinnedAccounts(KEY).length, 0, JSON.stringify(pin));
    assert.deepEqual(clean.exportAffinity(identify).sessions[0].threads, ['msg_1']);
  }
});

test('restore bounds conversations and newest thread IDs, retaining thread-only records', () => {
  const tracker = new SessionTracker({ now: () => 100_000 });
  const rows = Array.from({ length: MAX_SESSIONS + 2 }, (_, i) => row({
    key: `s${i}`, sessionId: `s${i}`, conversation: null, lastSeen: i, pins: [],
    threads: Array.from({ length: 35 }, (_, j) => `msg_${j}`),
  }));
  tracker.restoreAffinity(snapshot(...rows), resolve);
  assert.equal(tracker.sessions.size, MAX_SESSIONS);
  assert.equal(tracker.threadOwner('s0', 'msg_34'), null);
  assert.equal(tracker.threadOwner('s2', 'msg_2'), null);
  assert.ok(tracker.threadOwner('s2', 'msg_3'));
  const saved = tracker.exportAffinity(identify);
  assert.equal(saved.sessions.length, MAX_SESSIONS);
  assert.equal(saved.sessions[0].key, `s${MAX_SESSIONS + 1}`);
});

test('missing, ambiguous and changed-provider identities drop pins but keep threads', () => {
  const source = manager();
  source.sessionTracker.beginRequest(KEY, undefined, { sessionId: 'client', conversation: DIGEST });
  source.recordSession(KEY, 1, OPUS);
  source.sessionTracker.recordThreadMessage(KEY, 'msg_1');
  const saved = source.exportAffinityState();
  for (const rows of [accounts.filter(a => a.id !== 'b'), [...accounts, { ...accounts[1] }],
    accounts.map(a => a.id === 'b' ? { ...a, provider: 'codex' } : a)]) {
    const fresh = manager(rows);
    fresh.restoreAffinityState(saved);
    assert.equal(fresh.sessionTracker.pinnedAccount(KEY, 'unified7d'), null);
    assert.ok(fresh.sessionTracker.threadOwner('client', 'msg_1'));
  }
  const anonymous = manager([{ ...accounts[0], id: undefined }]);
  anonymous.recordSession('anon', 0, OPUS);
  assert.equal(anonymous.exportAffinityState().sessions.length, 0);
});

// Disabling an account leaves the pins on it in place while the server runs;
// a restart in between must not be what loses them.
test('a pin on a disabled account is saved and restored dormant, and serves again once the account is enabled', () => {
  const source = manager();
  source.recordSession('alpha', 1, OPUS);
  source.setDisabled(1, true);
  const saved = JSON.parse(JSON.stringify(source.exportAffinityState()));
  assert.deepEqual(saved.sessions[0].pins.map(p => p.account), [{ id: 'b', provider: 'anthropic' }]);
  const fresh = manager(accounts.map(a => a.id === 'b' ? { ...a, disabled: true } : a));
  fresh.restoreAffinityState(saved);
  assert.equal(fresh.accounts[fresh.sessionTracker.pinnedAccount('alpha', 'unified7d')].id, 'b');
  assert.notEqual(fresh.getActiveAccount(null, OPUS, null, 'alpha').id, 'b', 'a disabled account is not routed to');
  fresh.setDisabled(fresh.accounts.findIndex(a => a.id === 'b'), false);
  assert.equal(fresh.getActiveAccount(null, OPUS, null, 'alpha').id, 'b');
});

test('one saved conversation restores a bounded number of pins and no oversized bucket key', () => {
  const tracker = new SessionTracker({ now: () => 100 });
  const pins = [{ bucket: 'b'.repeat(129), account: identify(1), at: 90 },
    ...Array.from({ length: MAX_AFFINITY_PINS + 5 }, (_, i) => ({ bucket: `bucket-${i}`, account: identify(1), at: 90 }))];
  tracker.restoreAffinity(JSON.parse(JSON.stringify(snapshot(row({ pins })))), resolve);
  const restored = tracker.sessions.get(KEY).pins;
  assert.equal(restored.size, MAX_AFFINITY_PINS);
  assert.equal(restored.has('b'.repeat(129)), false);
  assert.ok(restored.has('bucket-0'));
  assert.equal(tracker.exportAffinity(identify).sessions[0].pins.length, MAX_AFFINITY_PINS);
});

test('restored affinity obeys current quota, exclusions, model routes and manual selection', () => {
  const source = manager();
  source.recordSession('alpha', 1, OPUS);
  const saved = source.exportAffinityState();
  const fresh = manager(accounts.map(a => ({ ...a, type: 'oauth', accessToken: 'synthetic', expiresAt: Date.now() + TTL })));
  fresh.restoreAffinityState(saved);
  assert.equal(fresh.getActiveAccount(new Set([1]), OPUS, null, 'alpha').id, 'a');
  fresh.accounts[1].quota.unified7d = 1;
  fresh.accounts[1].quota.unified7dReset = Date.now() + TTL;
  assert.equal(fresh.getActiveAccount(null, OPUS, null, 'alpha').id, 'a');
  const routed = manager(accounts, { routes: [{ name: 'opus', match: ['*opus*'], accounts: ['a'] }] });
  routed.restoreAffinityState(saved);
  assert.equal(routed.getActiveAccount(null, OPUS, null, 'alpha').id, 'a');
  const modelOwned = manager(accounts.map(a => a.id === 'a' ? { ...a, models: [OPUS] } : a));
  modelOwned.restoreAffinityState(saved);
  assert.equal(modelOwned.getActiveAccount(null, OPUS, null, 'alpha').id, 'a');
  const subscriptions = manager(accounts.map(a => ({ ...a, type: 'oauth', provider: a.id === 'a' ? 'codex' : 'anthropic', accessToken: 'synthetic', expiresAt: Date.now() + TTL })));
  subscriptions.restoreAffinityState(saved);
  assert.equal(subscriptions.getActiveAccount(null, 'gpt-5', null, 'alpha', 'codex').id, 'a');
  const pinned = manager(accounts, { routes: [{ name: 'opus', match: ['*opus*'] }] });
  pinned.restoreAffinityState(saved);
  pinned.routePins.set('opus', 0);
  assert.equal(pinned.getActiveAccount(null, OPUS, null, 'alpha').id, 'a');
});

// Break caught: simultaneous atomic writes completing out of order, or queued
// ticks snapshotting too early and overwriting final shutdown data.
test('state persister serializes and coalesces callers using the latest state', async () => {
  let value = 1;
  const writes = [], releases = [];
  const persist = config.createStatePersister(() => ({ value }), { save: state => {
    writes.push(state);
    return new Promise(resolve => releases.push(resolve));
  } });
  const first = persist();
  value = 2;
  const pending = Array.from({ length: 20 }, () => persist());
  value = 3;
  assert.deepEqual(writes, [{ value: 1 }]);
  releases.shift()();
  await first;
  assert.deepEqual(writes, [{ value: 1 }, { value: 3 }]);
  let finished = false;
  const all = Promise.all(pending).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  releases.shift()();
  await all;
  assert.equal(finished, true);
  assert.equal(writes.length, 2);
});

test('failed state save reports once, does not poison pending or subsequent saves', async () => {
  const errors = [], writes = [];
  let rejectFirst;
  const persist = config.createStatePersister(() => writes.length + 1, { onError: err => errors.push(err.message), save: value => {
    writes.push(value);
    return value === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve();
  } });
  const first = persist();
  const second = persist();
  rejectFirst(new Error('synthetic disk failure'));
  await Promise.all([first, second]);
  await persist();
  assert.deepEqual(errors, ['synthetic disk failure']);
  assert.deepEqual(writes, [1,2,3]);
});
