import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS as TTL, MAX_SESSIONS, MAX_AFFINITY_PINS, MAX_ROUTED, LOAD_WINDOW_MS, readRoutedBucket } from '../src/session-tracker.js';
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
const H = 3600_000;
const WEEK = 7 * 24 * H;
const ON = { enabled: true, preempt: true };
const subscriptions = (order = [0, 1]) => order.map(i =>
  ({ ...accounts[i], type: 'oauth', accessToken: 'synthetic', expiresAt: Date.now() + TTL }));
const roundTrip = value => JSON.parse(JSON.stringify(value));

// Two subscriptions with expiry routing on, both on one known weekly window.
function fleet(order, reset) {
  const am = manager(subscriptions(order), { expiryRouting: ON });
  for (const account of am.accounts) {
    Object.assign(account.quota, { unified7d: 0.4, unified7dReset: reset });
    account.probing = false;
  }
  return am;
}

// One complete request, in the order the server makes it.
function serve(am, sessionId, exclude = null) {
  am.beginSession(sessionId);
  const account = am.getActiveAccount(exclude, OPUS, null, sessionId);
  if (account) am.recordSession(sessionId, account.index, OPUS);
  am.endSession(sessionId);
  return account;
}

// A new daemon from the source's saved state, quota first as startup does.
function restart(source, order) {
  const am = manager(subscriptions(order), { expiryRouting: ON });
  am.restoreQuotaState(roundTrip(source.exportQuotaState()));
  am.restoreAffinityState(roundTrip(source.exportAffinityState()));
  return am;
}

// What the quota probe writes when an account's weekly window rolls.
function roll(am, id) {
  const quota = am.accounts.find(a => a.id === id).quota;
  quota.unified7d = 0;
  quota.unified7dReset += WEEK;
}

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
  assert.deepEqual(saved, Object.assign(snapshot(row({ lastSeen: 100, pins: [
    { bucket: 'unified7d', account: identify(1), at: 90 },
    { bucket: 'custom-route-bucket', account: identify(2), at: 95 },
  ] }), { key: opaque, sessionId: null, conversation: null, lastSeen: 90,
    pins: [{ bucket: 'unified7d', account: identify(1), at: 90 }], threads: [] }), { routed: [{ account: identify(1), minute: 0, count: 1 }] }));
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
  assert.deepEqual([state.inFlight, state.count, state.starved, state.refs.size, state.tokens.size, fresh.recentRequestsFor(1)], [0,0,0,0,0,1]);
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

// Break caught: a reading saved from an observation of another account, which
// would be compared against the pinned account's windows after a restart.
test('a pin saves the rollover reading taken on its own account, and no other', () => {
  const tracker = new SessionTracker({ now: () => 100 });
  tracker.touch(KEY, 1, 'unified7d', 90);
  tracker.touch(KEY, 2, 'other', 95);
  tracker.touch(KEY, 0, 'bare', 95);
  Object.assign(tracker.refsFor(KEY, 'unified7d', true), { idx: 1, windows: new Map([['unified7d', 5000]]),
    handedBack: new Map([['unified7d', 9000]]), provider: 'anthropic' });
  // A reading left on another account by a preemption the next request has not followed yet.
  Object.assign(tracker.refsFor(KEY, 'other', true), { idx: 0, windows: new Map([['unified7d', 7000]]) });
  assert.deepEqual(tracker.exportAffinity(identify).sessions[0].pins, [
    { bucket: 'unified7d', account: identify(1), at: 90,
      reading: { windows: { unified7d: 5000 }, handedBack: { unified7d: 9000 }, provider: 'anthropic' } },
    { bucket: 'other', account: identify(2), at: 95 },
    { bucket: 'bare', account: identify(0), at: 95 },
  ]);
});

// Break caught: a restored pin baselining the post-roll reset on its first
// request, so a roll that happened while the conversation was quiet never moves it.
test('a pin restored after its account rolled moves off it, as the uninterrupted daemon does', () => {
  const reset = Date.now() + 10 * H;
  for (const when of ['before', 'after']) {
    for (const order of [[0, 1], [1, 0]]) {
      const source = fleet([0, 1], reset);
      assert.equal(serve(source, 'alpha', new Set([1])).id, 'a');
      if (when === 'before') roll(source, 'a');
      const restored = restart(source, order);
      if (when === 'after') {
        roll(source, 'a');
        roll(restored, 'a');
      }
      const live = serve(source, 'alpha').id;
      assert.equal(live, 'b', 'the uninterrupted daemon moves off the rolled account');
      assert.equal(serve(restored, 'alpha').id, live, `${when} restart, order ${order}`);
    }
  }
});

test('with no rollover across the restart each restored pin stays where the uninterrupted daemon keeps it', () => {
  const source = fleet([0, 1], Date.now() + 10 * H);
  source.accounts[1].quota.unified7dReset = Date.now() + 100 * H;
  assert.equal(serve(source, 'alpha', new Set([1])).id, 'a');
  assert.equal(serve(source, 'beta', new Set([0])).id, 'b');
  for (const order of [[0, 1], [1, 0]]) {
    const restored = restart(source, order);
    for (const am of [source, restored]) am.accounts.find(a => a.id === 'a').quota.unified7dReset += 30 * 60_000;
    for (let turn = 0; turn < 3; turn++) {
      for (const [name, am] of [['source', source], ['restored', restored]]) {
        assert.equal(serve(am, 'alpha').id, 'a', `${name}, order ${order}, turn ${turn}`);
        assert.equal(serve(am, 'beta').id, 'b', `${name}, order ${order}, turn ${turn}`);
      }
    }
  }
});

test('a snapshot saved without readings restores as before, and the next save carries one', () => {
  const reset = Date.now() + 10 * H;
  const source = fleet([0, 1], reset);
  assert.equal(serve(source, 'alpha', new Set([1])).id, 'a');
  const saved = roundTrip(source.exportAffinityState());
  for (const s of saved.sessions) for (const pin of s.pins) delete pin.reading;
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.sessions[0].pins[0]).sort(), ['account', 'at', 'bucket']);
  const restored = manager(subscriptions(), { expiryRouting: ON });
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  restored.restoreAffinityState(saved);
  assert.equal(restored.accounts[restored.sessionTracker.pinnedAccount('alpha', 'unified7d')].id, 'a');
  assert.equal(restored.sessionTracker.sessions.get('alpha').refs.size, 0);
  assert.equal(serve(restored, 'alpha').id, 'a');
  assert.deepEqual(restored.exportAffinityState().sessions[0].pins[0].reading?.windows, { unified7d: reset });
  roll(restored, 'a');
  assert.equal(serve(restored, 'alpha').id, 'b', 'the reading taken on the first request watches again');
});

test('a malformed or oversized reading is dropped and its pin kept', () => {
  const windows = { unified7d: 5000 };
  const many = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`w${i}`, 5000 + i]));
  const restore = pin => {
    const tracker = new SessionTracker({ now: () => 100 });
    tracker.restoreAffinity(roundTrip(snapshot(row({ pins: [pin] }))), resolve);
    return tracker;
  };
  const bad = [null, 'x', [], { windows: null }, { windows: [] }, { windows: [['unified7d', 5000]] },
    { windows: { unified7d: '5000' } }, { windows: { unified7d: -1 } }, { windows: { unified7d: null } },
    { windows: { '': 5000 } }, { windows: { ['w'.repeat(129)]: 5000 } }, { windows: { unified7d: 5000, w: -1 } },
    { windows: many(65) }, { windows, handedBack: 'x' }, { windows, handedBack: { unified7d: -1 } },
    { windows, provider: '' }, { windows, provider: 7 }];
  for (const reading of bad) {
    const tracker = restore({ bucket: 'unified7d', account: identify(1), at: 90, reading });
    assert.equal(tracker.pinnedAccount(KEY, 'unified7d'), 1, JSON.stringify(reading));
    assert.equal(tracker.sessions.get(KEY).refs.size, 0, JSON.stringify(reading));
  }
  const unresolved = restore({ bucket: 'unified7d', account: { id: 'missing', provider: 'anthropic' }, at: 90, reading: { windows } });
  assert.equal(unresolved.sessions.get(KEY).refs.size, 0);
  assert.deepEqual(unresolved.threadOwner('client', 'msg_1'), { key: KEY, conversation: DIGEST });
  const t = restore({ bucket: 'unified7d', account: identify(1), at: 90,
    reading: { windows: many(64), handedBack: { w0: 9000 }, provider: 'anthropic' } });
  const ref = t.refsFor(KEY, 'unified7d');
  assert.equal(ref?.idx, 1);
  assert.deepEqual(Object.fromEntries(ref.windows), many(64));
  assert.deepEqual(Object.fromEntries(ref.handedBack), { w0: 9000 });
  assert.equal(ref.provider, 'anthropic');
  assert.deepEqual([ref.unescaped, ref.gen], [null, 0]);
});

test('a start with preemption off restores pins without readings, and turning it on reads afresh', () => {
  const source = fleet([0, 1], Date.now() + 10 * H);
  assert.equal(serve(source, 'alpha', new Set([1])).id, 'a');
  const saved = roundTrip(source.exportAffinityState());
  assert.ok(saved.sessions[0].pins[0].reading);
  for (const expiryRouting of [undefined, { enabled: true, preempt: false }]) {
    const off = manager(subscriptions(), { expiryRouting });
    off.restoreQuotaState(roundTrip(source.exportQuotaState()));
    off.restoreAffinityState(saved);
    const label = JSON.stringify(expiryRouting ?? null);
    assert.equal(off.accounts[off.sessionTracker.pinnedAccount('alpha', 'unified7d')].id, 'a', label);
    assert.equal(off.sessionTracker.sessions.get('alpha').refs.size, 0, label);
    roll(off, 'a');
    off.setExpiryRouting(ON);
    assert.equal(serve(off, 'alpha').id, 'a', label);
  }
});

// Break caught: quota restored by the first saved row whose identity matches,
// which for one person's entry with no organization beside one that names its
// organization hands one entry the other's reset, and the restored reading
// then reads that as a roll.
test('a pin restored on one of two entries for the same person keeps that entry quota and stays', () => {
  const rows = () => [
    { id: 'legacy', name: 'legacy', accountUuid: 'person-1' },
    { id: 'work', name: 'work', accountUuid: 'person-1', orgUuid: 'org-work', orgName: 'Work' },
  ].map(a => ({ ...a, type: 'oauth', accessToken: 'synthetic', expiresAt: Date.now() + TTL }));
  const resets = { legacy: Date.now() + 155 * H, work: Date.now() + 8 * H };
  const source = manager(rows(), { expiryRouting: ON });
  for (const account of source.accounts) {
    Object.assign(account.quota, { unified7d: 0.4, unified7dReset: resets[account.id] });
    account.probing = false;
  }
  assert.equal(serve(source, 'alpha', new Set([0])).id, 'work');
  const restored = manager(rows(), { expiryRouting: ON });
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  restored.restoreAffinityState(roundTrip(source.exportAffinityState()));
  const live = serve(source, 'alpha').id;
  assert.equal(live, 'work', 'the uninterrupted daemon keeps the pin');
  assert.equal(serve(restored, 'alpha').id, live, 'the restored daemon keeps it too');
  for (const account of restored.accounts) assert.equal(account.quota.unified7dReset, resets[account.id], account.id);
});

// Load mode breaks a re-rank tie on the requests each account carried in the
// last LOAD_WINDOW_MS, so a restored rollover decides as the uninterrupted
// daemon does only if that window comes back with the pins.
test('a restored rollover in load mode keeps the conversation where the uninterrupted daemon keeps it', t => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 10, 21, 12);
  const RESUME = T0 + 8 * MIN;
  const ROLL = RESUME - 30_000;
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const opts = { distributeSessions: 'load', expiryRouting: ON };
  const source = manager(subscriptions(), opts);
  const quota = (am, id, used, reset) => {
    const account = am.accounts.find(a => a.id === id);
    account.probing = false;
    Object.assign(account.quota, { unified7d: used, unified7dReset: reset });
  };
  quota(source, 'a', 0.4, ROLL - 5_000);
  quota(source, 'b', 0.4, RESUME + 80 * H);
  assert.equal(serve(source, 'X', new Set([1])).id, 'a');
  for (let i = 0; i < 5; i++) {
    t.mock.timers.setTime(RESUME - 90_000 + i * 3_000);
    assert.equal(serve(source, 'lane', i ? null : new Set([0])).id, 'b');
  }
  t.mock.timers.setTime(ROLL);
  quota(source, 'a', 0, ROLL + WEEK);
  t.mock.timers.setTime(RESUME - 10_000);
  const restored = manager(subscriptions(), opts);
  restored.restoreQuotaState(roundTrip(source.exportQuotaState()));
  restored.restoreAffinityState(roundTrip(source.exportAffinityState()));
  t.mock.timers.setTime(RESUME);
  const load = am => [0, 1].map(idx => am.sessionTracker.recentRequestsFor(idx));
  const before = { live: load(source), restored: load(restored) };
  const live = serve(source, 'X').id;
  assert.equal(live, 'a', 'the uninterrupted daemon keeps X on the rolled account carrying less load');
  assert.equal(serve(restored, 'X').id, live, `requests per account: live ${before.live}, restored ${before.restored}`);
  assert.deepEqual(before.restored, before.live);
});

test('a snapshot saved without a request window restores pins as before, with an empty window', () => {
  const source = new SessionTracker({ now: () => 100 });
  source.touch(KEY, 1, 'unified7d', 90);
  source.noteRouted(1, 90);
  const saved = roundTrip(source.exportAffinity(identify));
  assert.ok(Array.isArray(saved.routed), 'the window is saved beside the conversations');
  delete saved.routed;
  assert.deepEqual(Object.keys(saved).sort(), ['sessions', 'version']);
  const restored = new SessionTracker({ now: () => 100 });
  restored.restoreAffinity(saved, resolve);
  assert.equal(restored.pinnedAccount(KEY, 'unified7d'), 1);
  assert.equal(restored.recentRequestsFor(1), 0);
  assert.equal(restored._routed.length, 0);
  assert.equal(restored.exportAffinity(identify).routed, undefined, 'an empty window writes no field');
});

test('a malformed request bucket is dropped alone, and the restored window is bounded', () => {
  const now = 15 * 60_000;
  const good = { account: identify(1), minute: 14, count: 1 };
  /** @type {Array<[unknown, string]>} */
  const bad = [[null, 'not-an-object'], ['x', 'not-an-object'], [7, 'not-an-object'], [[], 'not-an-object'],
    [{}, 'account-invalid'], [{ ...good, account: null }, 'account-invalid'], [{ ...good, account: {} }, 'account-invalid'],
    [{ ...good, account: { id: '', provider: 'anthropic' } }, 'account-invalid'],
    [{ ...good, account: { id: 'id-2' } }, 'account-invalid'], [{ ...good, account: { id: 'id-2', provider: 7 } }, 'account-invalid'],
    [{ ...good, minute: NaN }, 'minute-not-integer'], [{ ...good, minute: Infinity }, 'minute-not-integer'],
    [{ ...good, minute: null }, 'minute-not-integer'], [{ ...good, minute: 14.5 }, 'minute-not-integer'],
    [{ ...good, minute: -1 }, 'minute-negative'],
    [{ ...good, count: 1.5 }, 'count-not-integer'], [{ ...good, count: '2' }, 'count-not-integer'],
    [{ ...good, count: null }, 'count-not-integer'], [{ ...good, count: 0 }, 'count-not-positive'],
    [{ ...good, count: -3 }, 'count-not-positive'], [{ ...good, minute: 3 }, 'outside-window'],
    [{ ...good, account: { id: 'missing', provider: 'anthropic' } }, 'account-unresolved']];
  assert.deepEqual(readRoutedBucket(good, resolve, now), { kind: 'ok', at: now - 1, idx: 1, count: 1 });
  assert.deepEqual(readRoutedBucket({ ...good, minute: 15 }, resolve, now), { kind: 'ok', at: now, idx: 1, count: 1 }, 'the current minute is stamped no later than now');
  assert.deepEqual(readRoutedBucket({ ...good, minute: 16 }, resolve, now), { kind: 'ok', at: now, idx: 1, count: 1 }, 'a minute after now is stamped at now');
  for (const idx of [-1, 1.5, null]) {
    assert.deepEqual(readRoutedBucket(good, () => idx, now), { kind: 'dropped', reason: 'account-unresolved' }, `resolved to ${idx}`);
  }
  for (const [bucket, reason] of bad) {
    const name = `case ${JSON.stringify(bucket) ?? String(bucket)}`;
    assert.deepEqual(readRoutedBucket(bucket, resolve, now), { kind: 'dropped', reason }, name);
    const tracker = new SessionTracker({ now: () => now });
    tracker.restoreAffinity({ ...snapshot(row()), routed: [good, bucket] }, resolve);
    assert.deepEqual(Object.fromEntries(tracker._routedCounts), { 1: 1 }, name);
    assert.equal(tracker.pinnedAccount(KEY, 'unified7d'), 1, name);
  }
  for (const routed of [null, 'x', {}, 5]) {
    const tracker = new SessionTracker({ now: () => now });
    tracker.restoreAffinity({ ...snapshot(row()), routed }, resolve);
    assert.equal(tracker._routed.length, 0, `field ${JSON.stringify(routed)}`);
    assert.equal(tracker.pinnedAccount(KEY, 'unified7d'), 1, `field ${JSON.stringify(routed)}`);
  }
  const flood = new SessionTracker({ now: () => now });
  flood.restoreAffinity({ ...snapshot(), routed: [
    { account: identify(2), minute: 5, count: MAX_ROUTED },
    { account: identify(1), minute: 9, count: 3 },
  ] }, resolve);
  assert.equal(flood._routed.length, MAX_ROUTED, 'never more entries than the ring holds');
  assert.equal(flood.recentRequestsFor(1), 3, 'the newest requests are the ones kept');
  assert.equal(flood.recentRequestsFor(2), MAX_ROUTED - 3);
});

test('requests saved in a minute after a clock stepped back are counted, as the uninterrupted window counts them', () => {
  const MIN = 60_000;
  const live = new SessionTracker({ now: () => 4 * MIN });
  live.noteRouted(2, MIN);
  for (let i = 0; i < 5; i++) live.noteRouted(1, 3 * MIN + i * 1000);
  const saved = roundTrip(live.exportAffinity(identify));
  const back = 2 * MIN;
  const restored = new SessionTracker({ now: () => back });
  restored.restoreAffinity(saved, resolve);
  assert.deepEqual([1, 2].map(idx => restored.recentRequestsFor(idx, back)), [1, 2].map(idx => live.recentRequestsFor(idx, back)));
});

test('restored request counts follow the account identity, not the index that saved them', () => {
  const source = new SessionTracker({ now: () => 60_000 });
  source.noteRouted(0, 10_000);
  source.noteRouted(1, 20_000);
  source.noteRouted(1, 21_000);
  source.noteRouted(2, 30_000);
  source.noteRouted(2, 31_000);
  source.noteRouted(2, 32_000);
  const saved = roundTrip(source.exportAffinity(identify));
  // id-0 is gone, id-2 now sits first and id-1 second.
  const now = { 'id-2': 0, 'id-1': 1 };
  const restored = new SessionTracker({ now: () => 60_000 });
  restored.restoreAffinity(saved, ref => now[ref.id] ?? null);
  assert.deepEqual([restored.recentRequestsFor(0), restored.recentRequestsFor(1), restored.recentRequestsFor(2)], [3, 2, 0]);
  const again = restored.exportAffinity(i => ({ id: Object.keys(now).find(k => now[k] === i), provider: 'anthropic' })).routed;
  assert.deepEqual(again.sort((x, y) => x.account.id.localeCompare(y.account.id)), [{ account: identify(1), minute: 0, count: 2 }, { account: identify(2), minute: 0, count: 3 }]);
});

test('restored requests leave the window on schedule, and buckets already past it are dropped', () => {
  const MIN = 60_000;
  // Requests spread over the window, some already older than it at the restart.
  const times = [];
  for (let at = 1_000; at < 25 * MIN; at += 37_000) times.push(at);
  const save = 25 * MIN;
  const start = save + 3 * MIN;
  const live = new SessionTracker({ now: () => save });
  for (const at of times) live.noteRouted(1, at);
  const saved = roundTrip(live.exportAffinity(identify));
  const fresh = new SessionTracker({ now: () => start });
  fresh.restoreAffinity({ ...saved, routed: [{ account: identify(2), minute: 1, count: 4 }, ...saved.routed] }, resolve);
  const inWindow = times.filter(at => at >= start - LOAD_WINDOW_MS).length;
  assert.equal(fresh._routed.length, inWindow, 'a bucket that ended before the window is not restored');
  assert.equal(fresh.recentRequestsFor(2, start), 0);
  for (let at = start; at <= start + LOAD_WINDOW_MS + MIN; at += 1_000) {
    const expected = times.filter(t => t >= at - LOAD_WINDOW_MS).length;
    const early = times.filter(t => t >= at - LOAD_WINDOW_MS - MIN && t < at - LOAD_WINDOW_MS).length;
    const got = fresh.recentRequestsFor(1, at);
    assert.ok(got >= expected && got <= expected + early, `at ${at}: ${got} restored, ${expected} uninterrupted`);
  }
  const last = times.at(-1);
  assert.equal(fresh.recentRequestsFor(1, last + LOAD_WINDOW_MS + MIN), 0, 'gone within a minute of the request it stands for');
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
