import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCompactBeforeSwitch, decideCompactBeforeSwitch, promptTooLongCounts, promptTooLongBody,
  CompactAsks, compactBeforeSwitchStatus, SESSION_GAP_MS, DEFAULT_MARGIN, DEFAULT_MIN_BODY_BYTES, DEFAULT_COOLDOWN_SECONDS,
} from '../src/compact-before-switch.js';
import { AccountManager } from '../src/account-manager.js';

// compactBeforeSwitch (issue #709): the setting, the decision and the record of
// who was asked, without a server. The request path is covered in
// compact-before-switch-server.test.js.

const DEFAULTS = { margin: DEFAULT_MARGIN, minBodyBytes: DEFAULT_MIN_BODY_BYTES, cooldownMs: DEFAULT_COOLDOWN_SECONDS * 1000 };
const MINUTE = 60_000;

test('the setting is off unless it is true or an object', () => {
  for (const raw of [undefined, null, false, 0, 1, 'true', 'on', []]) {
    assert.equal(resolveCompactBeforeSwitch(raw), null, `${JSON.stringify(raw)} is off`);
  }
  assert.deepEqual(resolveCompactBeforeSwitch(true), DEFAULTS);
  assert.deepEqual(resolveCompactBeforeSwitch({}), DEFAULTS);
  assert.deepEqual(DEFAULTS, { margin: 0.04, minBodyBytes: 400_000, cooldownMs: 1_800_000 });
});

test('each field that is not a usable number takes its default', () => {
  assert.deepEqual(
    resolveCompactBeforeSwitch({ margin: 0.1, minBodyBytes: 1000, cooldownSeconds: 60 }),
    { margin: 0.1, minBodyBytes: 1000, cooldownMs: 60_000 },
  );
  for (const margin of [0, 1, -0.1, 2, '0.1', NaN, null]) {
    assert.equal(resolveCompactBeforeSwitch({ margin })?.margin, DEFAULT_MARGIN, `margin ${margin}`);
  }
  for (const v of [0, -1, '1000', Infinity, null]) {
    assert.equal(resolveCompactBeforeSwitch({ minBodyBytes: v })?.minBodyBytes, DEFAULT_MIN_BODY_BYTES, `minBodyBytes ${v}`);
    assert.equal(resolveCompactBeforeSwitch({ cooldownSeconds: v })?.cooldownMs, DEFAULT_COOLDOWN_SECONDS * 1000, `cooldownSeconds ${v}`);
  }
  // One bad field does not cost the others.
  assert.deepEqual(
    resolveCompactBeforeSwitch({ margin: 'wide', minBodyBytes: 5000 }),
    { ...DEFAULTS, minBodyBytes: 5000 },
  );
});

// The facts of a request that is asked; each test changes one.
function facts(over = {}) {
  return {
    settings: DEFAULTS,
    bodyBytes: 431_702,
    pinKey: 'sess~conv',
    sessionId: 'sess',
    windows: [
      { bucket: 'unified5h', utilization: 0.95, threshold: 0.98 },
      { bucket: 'unified7d', utilization: 0.40, threshold: 0.98 },
    ],
    asks: new CompactAsks({ now: () => 1_000_000 }),
    ...over,
  };
}

test('a long conversation inside the margin of its 5-hour threshold is asked', () => {
  const d = decideCompactBeforeSwitch(facts());
  assert.equal(d.ask, true);
  assert.equal(d.window?.bucket, 'unified5h');
});

test('the weekly window that gates the model asks as well', () => {
  const d = decideCompactBeforeSwitch(facts({ windows: [
    { bucket: 'unified5h', utilization: 0.10, threshold: 0.98 },
    { bucket: 'unified7dFable', utilization: 0.87, threshold: 0.90 },
  ] }));
  assert.equal(d.ask, true);
  assert.equal(d.window?.bucket, 'unified7dFable');
});

test('the margin is measured from each window\'s own threshold', () => {
  const at = (/** @type {number} */ utilization, /** @type {number} */ threshold) =>
    decideCompactBeforeSwitch(facts({ windows: [{ bucket: 'unified5h', utilization, threshold }] }));
  assert.equal(at(0.939, 0.98).reason, 'not-near');
  assert.equal(at(0.94, 0.98).ask, true, 'the margin is inclusive at its lower edge');
  assert.equal(at(0.979, 0.98).ask, true);
  assert.equal(at(0.98, 0.98).reason, 'at-threshold');
  assert.equal(at(0.57, 0.6).ask, true, 'a lowered threshold moves the margin with it');
  assert.equal(at(0.95, 0.6).reason, 'at-threshold');
});

test('an account at either threshold is not asked, even with the other window inside the margin', () => {
  const d = decideCompactBeforeSwitch(facts({ windows: [
    { bucket: 'unified5h', utilization: 0.95, threshold: 0.98 },
    { bucket: 'unified7d', utilization: 0.99, threshold: 0.98 },
  ] }));
  assert.deepEqual(d, { ask: false, reason: 'at-threshold' });
});

test('everything short of the full set of facts forwards', () => {
  assert.equal(decideCompactBeforeSwitch(facts({ settings: null })).reason, 'off');
  assert.equal(decideCompactBeforeSwitch(facts({ sessionId: null })).reason, 'no-session');
  assert.equal(decideCompactBeforeSwitch(facts({ pinKey: null })).reason, 'no-session');
  assert.equal(decideCompactBeforeSwitch(facts({ bodyBytes: 399_999 })).reason, 'small-body');
  assert.equal(decideCompactBeforeSwitch(facts({ bodyBytes: 400_000 })).ask, true, 'minBodyBytes is inclusive');
  assert.equal(decideCompactBeforeSwitch(facts({ bodyBytes: NaN })).reason, 'small-body');
  assert.equal(decideCompactBeforeSwitch(facts({ windows: null })).reason, 'no-account');
  assert.equal(decideCompactBeforeSwitch(facts({ windows: [] })).reason, 'no-account');
  // Readings upstream has not reported are not a reason to ask.
  assert.equal(decideCompactBeforeSwitch(facts({ windows: [
    { bucket: 'unified5h', utilization: null, threshold: 0.98 },
    { bucket: 'unified7d', utilization: null, threshold: 0.98 },
  ] })).reason, 'not-near');
});

test('the decision writes nothing: deciding twice asks twice until the caller records', () => {
  const f = facts();
  assert.equal(decideCompactBeforeSwitch(f).ask, true);
  assert.equal(decideCompactBeforeSwitch(f).ask, true);
  assert.equal(f.asks.asked, 0);
  assert.equal(f.asks.conversations.size, 0);
});

test('a conversation is asked once per cooldown, whatever its size', () => {
  let t = 1_000_000;
  const asks = new CompactAsks({ now: () => t });
  const f = facts({ asks });
  assert.equal(decideCompactBeforeSwitch(f).ask, true);
  asks.record(f.pinKey, f.sessionId, f.bodyBytes, DEFAULTS.cooldownMs);
  // The compaction request: the same conversation, a little larger.
  assert.equal(decideCompactBeforeSwitch({ ...f, bodyBytes: f.bodyBytes + 2000 }).reason, 'conversation-cooldown');
  t += DEFAULTS.cooldownMs - 1;
  assert.equal(decideCompactBeforeSwitch({ ...f, bodyBytes: f.bodyBytes * 2 }).reason, 'conversation-cooldown');
  t += 1;
  assert.equal(decideCompactBeforeSwitch(f).ask, true, 'asked again once the cooldown has run');
});

test('a client session is asked once per two minutes, then only on a body as large as the one asked', () => {
  let t = 1_000_000;
  const asks = new CompactAsks({ now: () => t });
  const f = facts({ asks });
  asks.record(f.pinKey, f.sessionId, f.bodyBytes, DEFAULTS.cooldownMs);
  // The turn retried after compaction opens with the summary: a new key.
  const compacted = { ...f, pinKey: 'sess~summary' };
  assert.equal(decideCompactBeforeSwitch({ ...compacted, bodyBytes: f.bodyBytes * 2 }).reason, 'session-gap');
  t += SESSION_GAP_MS;
  // System prompt and tools keep it above minBodyBytes, under what was asked.
  assert.equal(decideCompactBeforeSwitch({ ...compacted, bodyBytes: 410_000 }).reason, 'session-smaller');
  assert.equal(decideCompactBeforeSwitch({ ...compacted, bodyBytes: f.bodyBytes }).ask, true, 'grown back to the size asked');
  // Another client session is not this one's business.
  assert.equal(decideCompactBeforeSwitch({ ...compacted, sessionId: 'other', pinKey: 'other~c', bodyBytes: 410_000 }).ask, true);
  t += DEFAULTS.cooldownMs;
  assert.equal(decideCompactBeforeSwitch({ ...compacted, bodyBytes: 410_000 }).ask, true, 'the session record expires with the cooldown');
});

test('the session record keeps the largest body asked while its cooldown runs', () => {
  let t = 0;
  const asks = new CompactAsks({ now: () => t });
  asks.record('s~big', 's', 900_000, DEFAULTS.cooldownMs);
  t += 3 * MINUTE;
  asks.record('s~small', 's', 500_000, DEFAULTS.cooldownMs);
  t += 3 * MINUTE;
  assert.equal(asks.blocks('s~third', 's', 600_000, DEFAULTS.cooldownMs), 'session-smaller');
  assert.equal(asks.blocks('s~third', 's', 900_000, DEFAULTS.cooldownMs), null);
  assert.equal(asks.asked, 2);
});

test('the record is bounded: expired entries are swept and the cap evicts the oldest', () => {
  let t = 0;
  const asks = new CompactAsks({ now: () => t, maxEntries: 3 });
  for (let i = 0; i < 5; i++) { asks.record(`s${i}~c`, `s${i}`, 500_000, DEFAULTS.cooldownMs); t += 1000; }
  assert.deepEqual([...asks.conversations.keys()], ['s2~c', 's3~c', 's4~c']);
  assert.deepEqual([...asks.sessions.keys()], ['s2', 's3', 's4']);
  // Evicted means eligible again, never blocked.
  assert.equal(asks.blocks('s0~c', 's0', 500_000, DEFAULTS.cooldownMs), null);
  t += DEFAULTS.cooldownMs;
  asks.record('late~c', 'late', 500_000, DEFAULTS.cooldownMs);
  assert.deepEqual([...asks.conversations.keys()], ['late~c'], 'a record sweeps what has expired');
  assert.deepEqual([...asks.sessions.keys()], ['late']);
  assert.equal(asks.asked, 6, 'the counter is not part of what is swept');
});

test('the message carries bytes/4 and a maximum just below it', () => {
  // The request measured in #709: 431,702 bytes, 107,922 tokens by the client's count.
  assert.deepEqual(promptTooLongCounts(431_702), { tokens: 107_926, maximum: 107_000 });
  assert.deepEqual(promptTooLongCounts(400_000), { tokens: 100_000, maximum: 99_000 }, 'strictly below on a round number');
  for (const bytes of [1, 7, 4000, 4001, 400_000, 431_702, 3_999_999, 64 * 1024 * 1024]) {
    const { tokens, maximum } = promptTooLongCounts(bytes);
    assert.ok(maximum >= 1 && maximum < tokens, `${bytes} bytes: ${tokens} > ${maximum}`);
    assert.ok(tokens - maximum <= 1000, `${bytes} bytes: the gap stays small`);
  }
  assert.deepEqual(JSON.parse(promptTooLongBody(431_702)), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'prompt is too long: 107926 tokens > 107000 maximum' },
  });
});

// The account side: which account holds a conversation, and how close it is to
// switching, read without selecting.

const HOUR = 3600_000;
const oauth = (/** @type {string} */ name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 12 * HOUR, ...extra });

test('switchWindows reports the 5-hour window and the weekly window that gates the model, with per-account thresholds', () => {
  const am = new AccountManager(
    [oauth('a'), oauth('b', { switchThreshold: { unified5h: 0.8, unified7dFable: 0.5 } })],
    { default: 0.98, unified7d: 0.9 },
  );
  const [a, b] = am.accounts;
  Object.assign(a.quota, { unified5h: 0.5, unified7d: 0.7, unified7dFable: 0.2 });
  Object.assign(b.quota, { unified5h: 0.5, unified7d: 0.3, unified7dFable: 0.45 });
  assert.deepEqual(am.switchWindows(a, 'claude-opus-4-5'), [
    { bucket: 'unified5h', utilization: 0.5, threshold: 0.98 },
    { bucket: 'unified7d', utilization: 0.7, threshold: 0.9 },
  ]);
  // Fable is gated by the higher of its own bucket and the shared weekly, held
  // to the Fable bucket's threshold, exactly as selection gates it.
  assert.deepEqual(am.switchWindows(a, 'claude-fable-5'), [
    { bucket: 'unified5h', utilization: 0.5, threshold: 0.98 },
    { bucket: 'unified7dFable', utilization: 0.7, threshold: 0.98 },
  ]);
  assert.deepEqual(am.switchWindows(b, 'claude-fable-5'), [
    { bucket: 'unified5h', utilization: 0.5, threshold: 0.8 },
    { bucket: 'unified7dFable', utilization: 0.45, threshold: 0.5 },
  ]);
  const unread = new AccountManager([oauth('c')], 0.98);
  assert.deepEqual(unread.switchWindows(unread.accounts[0], null).map(w => w.utilization), [null, null]);
});

/** Everything selection could have moved, to show that asking moved none of it. */
function routingState(/** @type {any} */ am) {
  return JSON.stringify({
    current: am.currentIndex,
    cursors: [...am.routeCursors], providers: [...am.providerCursors],
    pins: am.sessionTracker.livePins(),
    routed: am.accounts.map((/** @type {any} */ a) => am.sessionTracker.recentRequestsFor(a.index)),
    active: am.accounts.map((/** @type {any} */ a) => am.sessionTracker.activeCountFor(a.index)),
    sessions: am.sessionTracker.stats().known,
  });
}

test('conversationHost with distribution off: the pinned account, only while it is the one rotation serves from', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.conversationHost('s~c', 'claude-opus-4-5'), null, 'no request on record, so no account holds it');
  const first = am.getActiveAccount(null, 'claude-opus-4-5', null, 's~c');
  am.recordSession('s~c', first.index, 'claude-opus-4-5');
  const before = routingState(am);
  assert.equal(am.conversationHost('s~c', 'claude-opus-4-5'), first);
  assert.equal(am.conversationHost('s~other', 'claude-opus-4-5'), null, 'another conversation of the session has no pin');
  assert.equal(am.conversationHost(null, 'claude-opus-4-5'), null);
  // At its threshold the account can no longer serve the conversation.
  first.quota.unified5h = 0.99;
  assert.equal(am.conversationHost('s~c', 'claude-opus-4-5'), null);
  first.quota.unified5h = 0.5;
  assert.equal(routingState(am), before, 'asking moved no cursor, pin or load count');
  // The fleet has moved on: the pin names an account rotation left.
  const other = am.accounts[1 - first.index];
  am.setCurrentAccount(other.index);
  assert.equal(am.conversationHost('s~c', 'claude-opus-4-5'), null);
});

test('conversationHost with distribution on: each conversation\'s own pin, unless a better priority outranks it', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { distributeSessions: true });
  const one = am.getActiveAccount(null, 'claude-opus-4-5', null, 's1~c');
  am.recordSession('s1~c', one.index, 'claude-opus-4-5');
  am.beginSession('s1~c');
  const two = am.getActiveAccount(null, 'claude-opus-4-5', null, 's2~c');
  am.recordSession('s2~c', two.index, 'claude-opus-4-5');
  assert.notEqual(one, two, 'setup: distribution spread the two conversations');
  const before = routingState(am);
  assert.equal(am.conversationHost('s1~c', 'claude-opus-4-5'), one);
  assert.equal(am.conversationHost('s2~c', 'claude-opus-4-5'), two);
  assert.equal(routingState(am), before);
  // Selection would move a pinned conversation to a strictly better priority.
  one.priority = 5;
  assert.equal(am.conversationHost('s1~c', 'claude-opus-4-5'), null);
  assert.equal(am.conversationHost('s2~c', 'claude-opus-4-5'), two);
});

test('conversationHost never names an account of another provider', () => {
  const am = new AccountManager([oauth('codex', { provider: 'codex' }), oauth('a')], 0.98);
  am.recordSession('s~c', 0, 'claude-opus-4-5');
  assert.equal(am.conversationHost('s~c', 'claude-opus-4-5'), null);
});

test('status reports the setting as resolved, and the counter', () => {
  const asks = new CompactAsks();
  assert.deepEqual(compactBeforeSwitchStatus(undefined, asks), { enabled: false, asked: 0 });
  assert.deepEqual(compactBeforeSwitchStatus('yes', null), { enabled: false, asked: 0 });
  asks.record('s~c', 's', 500_000, 1000);
  assert.deepEqual(compactBeforeSwitchStatus(true, asks), { enabled: true, margin: 0.04, minBodyBytes: 400_000, cooldownSeconds: 1800, asked: 1 });
  assert.deepEqual(
    compactBeforeSwitchStatus({ margin: 0.1, cooldownSeconds: 'soon' }, asks),
    { enabled: true, margin: 0.1, minBodyBytes: 400_000, cooldownSeconds: 1800, asked: 1 },
  );
  assert.deepEqual(compactBeforeSwitchStatus(false, asks), { enabled: false, asked: 1 }, 'the counter outlives the setting');
});
