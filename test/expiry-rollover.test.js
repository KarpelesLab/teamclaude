import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600_000;
const WEEK = 7 * 24 * H;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

// The knob spelled out at every call site: `undefined` here means the config key
// is genuinely absent, never a default standing in for it.
function mgr(names, expiry, extra = {}) {
  return new AccountManager(names.map(oauth), 0.98, { expiryRouting: expiry, ...extra });
}

function bucket(am, index, key, used, hours) {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = Date.now() + hours * H;
  am.accounts[index].probing = false;
}

// One complete request for `sessionId`: select, pin, confirm what was served,
// and end. The order the server does it in, because the settlement depends on
// it — a rollover resolves only when the session next falls quiet.
function serve(am, sessionId, model, { exclude = null } = {}) {
  const decision = {};
  am.beginSession(sessionId);
  const account = am.getActiveAccount(exclude, model, null, sessionId, decision);
  if (account) {
    am.recordSession(sessionId, account.index, model);
    am.confirmRouted(sessionId, account.index, model, decision);
  }
  am.endSession(sessionId);
  return account;
}

// Push an account's window a full week forward, as a real weekly roll does.
function rollWindow(am, index, key = 'unified7d') {
  am.accounts[index].quota[`${key}Reset`] += WEEK;
}

// A two-account fleet with distribution on, both sitting on equal weekly quota
// so nothing but a rollover can move a pin.
function pinnedFleet(expiry) {
  const am = mgr(['a', 'b'], expiry, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  return am;
}

const ON = { enabled: true, preempt: true };

// ---------------------------------------------------------------------------
// A rollover moves a pin. Nothing else does.
// ---------------------------------------------------------------------------

test('a session pin holds still across ordinary traffic', () => {
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  for (let i = 0; i < 6; i++) {
    assert.equal(serve(am, 's1', OPUS).index, first.index, `request ${i + 2} moved the pin`);
  }
});

test('a rollover on the pinned account re-routes the session, exactly once', () => {
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  rollWindow(am, first.index);
  const moved = serve(am, 's1', OPUS);
  assert.notEqual(moved.index, first.index, 'the rollover did not move the pin');
  // Settled: the event is banked against its post-roll window, so the session
  // now stays where the preemption put it rather than bouncing every request.
  for (let i = 0; i < 4; i++) {
    assert.equal(serve(am, 's1', OPUS).index, moved.index, `request ${i + 2} moved again`);
  }
});

test('DRAINING the pinned account never preempts — the anti-thrash property', () => {
  // The drain is this session's own traffic. A threshold rule would re-route on
  // the drain it just caused, spending a prompt-cache miss per crossing while
  // the same account is still the one worth spending.
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  for (const used of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97]) {
    am.accounts[first.index].quota.unified7d = used;
    assert.equal(serve(am, 's1', OPUS).index, first.index, `drain to ${used} moved the pin`);
  }
  // Past the switch threshold the account is simply unavailable, which is the
  // eligibility gate rather than a pressure decision.
  am.accounts[first.index].quota.unified7d = 0.99;
  assert.notEqual(serve(am, 's1', OPUS).index, first.index);
});

test('a window CLEARED and re-reported at the same instant is not a rollover', () => {
  // _clearExpiredQuotas nulls a utilization and its reset together, so a bucket
  // passes through a null gap on its way to the next window. The gap must not
  // read as a jump, and the window on the far side of it must still be measured
  // against the value from before.
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const q = am.accounts[first.index].quota;
  const before = q.unified7dReset;
  q.unified7d = null;
  q.unified7dReset = null;
  assert.equal(serve(am, 's1', OPUS).index, first.index, 'the null gap moved the pin');
  // Same window re-reported, second-precision apart: still not a rollover.
  q.unified7d = 0.4;
  q.unified7dReset = before - 500;
  assert.equal(serve(am, 's1', OPUS).index, first.index, 're-reporting the window moved the pin');
});

test('a rollover is tracked per bucket, so alternating models see no false jump', () => {
  // A session sending Opus turns and Fable turns holds two pins. Comparing one
  // bucket's reset against the other's would read as a jump every time the
  // model alternated.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  for (const i of [0, 1]) {
    bucket(am, i, 'unified7d', 0.4, 10);
    bucket(am, i, 'unified7dFable', 0.4, 200); // a very different instant
  }
  const opus = serve(am, 's1', OPUS);
  const fable = serve(am, 's1', FABLE);
  for (let i = 0; i < 4; i++) {
    assert.equal(serve(am, 's1', OPUS).index, opus.index, 'the Opus pin moved');
    assert.equal(serve(am, 's1', FABLE).index, fable.index, 'the Fable pin moved');
  }
});

test('only the family whose window rolled is re-routed', () => {
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  for (const i of [0, 1]) {
    bucket(am, i, 'unified7d', 0.4, 10);
    bucket(am, i, 'unified7dFable', 0.4, 10);
  }
  const opus = serve(am, 's1', OPUS);
  const fable = serve(am, 's1', FABLE);
  rollWindow(am, fable.index, 'unified7dFable');
  assert.notEqual(serve(am, 's1', FABLE).index, fable.index, 'the Fable pin did not move');
  assert.equal(serve(am, 's1', OPUS).index, opus.index, 'the Opus pin moved on another family\'s roll');
});

test('a preemption that fails back onto the rolled account stays owed', () => {
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);
  // The only destination is excluded, so this request comes back to the account
  // it was trying to leave. Nothing moved, so nothing may be banked.
  assert.equal(serve(am, 's1', OPUS, { exclude: new Set([other]) }).index, first.index);
  // The next unconstrained request preempts again rather than having settled on
  // the account that just gained a full week.
  assert.equal(serve(am, 's1', OPUS).index, other);
});

test('a session settles only once it is QUIESCENT, not on the first request to finish', () => {
  // The concurrency half of preempt-exactly-once. Two requests are in flight at
  // the same time: the faster is served off the rolled account, the slower fails
  // back onto it. Settling when the faster one ends banks a move the slower one
  // undoes, and the session then rides the rolled account for a week with
  // nothing owed.
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);

  am.beginSession('s1');
  am.beginSession('s1');

  // The faster request preempts off the rolled account.
  const d1 = {};
  const a1 = am.getActiveAccount(null, OPUS, null, 's1', d1);
  assert.equal(a1.index, other, 'the rollover did not preempt');
  am.recordSession('s1', a1.index, OPUS);
  am.confirmRouted('s1', a1.index, OPUS, d1);
  am.endSession('s1');           // one still in flight: nothing may settle here

  // The slower one has its only destination excluded and comes back.
  const d2 = {};
  const a2 = am.getActiveAccount(new Set([other]), OPUS, null, 's1', d2);
  assert.equal(a2.index, first.index);
  am.recordSession('s1', a2.index, OPUS);
  am.confirmRouted('s1', a2.index, OPUS, d2);
  am.endSession('s1');           // quiescent: the last word is the rolled account

  // Nothing stuck, so the event is still owed and the next request preempts.
  assert.equal(serve(am, 's1', OPUS).index, other);
});

test('preempt: false leaves the pin where it is across a rollover', () => {
  const am = pinnedFleet({ enabled: true, preempt: false });
  const first = serve(am, 's1', OPUS);
  rollWindow(am, first.index);
  assert.equal(serve(am, 's1', OPUS).index, first.index);
});

test('with the knob off a rollover moves nothing', () => {
  const am = pinnedFleet(undefined);
  const first = serve(am, 's1', OPUS);
  rollWindow(am, first.index);
  assert.equal(serve(am, 's1', OPUS).index, first.index);
});

// ---------------------------------------------------------------------------
// The sticky current account
// ---------------------------------------------------------------------------

test('a rollover on the current account re-ranks instead of staying parked', () => {
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, null, OPUS);
  assert.equal(first.name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b');
  // And it stays there: the event settled on the request that moved it.
  assert.equal(serve(am, null, OPUS).name, 'b');
});

test('a request that never consulted currentIndex may not settle its rollover', () => {
  // A route pin routes without reference to the current account, so confirming
  // it would swallow an event that walk never acted on — leaving `current`
  // parked on the account that just gained a week until the next roll.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  serve(am, null, OPUS);
  rollWindow(am, 0);
  // Detected but not acted on, then confirmed by a request from a different
  // walk (viaCurrent absent, as the pinned path leaves it).
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true);
  am.confirmRouted(null, 1, OPUS, {});
  // Still owed, so the next current-account request still preempts.
  assert.equal(serve(am, null, OPUS).name, 'b');
});

test('a manual switch takes a baseline with it, so its next roll is still seen', () => {
  // Parked on an account established without one, the fleet reads that
  // account's next weekly roll as a first sight and never preempts off it.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(am.setCurrentAccount(1), true);
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'a');
  assert.equal(am.setCurrentAccount(9), false);
});

test('a rollover with nowhere to go says so instead of looking like success', () => {
  const am = mgr(['a'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  serve(am, null, OPUS);
  rollWindow(am, 0);
  const lines = [];
  const real = console.log;
  console.log = msg => lines.push(String(msg));
  try {
    assert.equal(serve(am, null, OPUS).name, 'a');
  } finally {
    console.log = real;
  }
  assert.ok(lines.some(l => /rolled over its unified7d window but no eligible account/.test(l)),
    `expected a stuck-rollover line, got: ${JSON.stringify(lines)}`);
});

// ---------------------------------------------------------------------------
// Bookkeeping lifetime
// ---------------------------------------------------------------------------

test('removing an account renumbers the baselines rather than aiming them elsewhere', () => {
  const am = mgr(['a', 'b', 'c'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2]) bucket(am, i, 'unified7d', 0.4, 10);
  // s1 takes 'a'; s2 then spreads onto 'b', which is the pin this test is about
  // because removing 'a' shifts it down a slot.
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  assert.equal(serve(am, 's2', OPUS).name, 'b');

  am.removeAccount(0);
  const b = am.accounts.find(a => a.name === 'b');
  assert.equal(b.index, 0, 'b did not move down into the freed slot');
  assert.equal(am.sessionTracker.pinnedAccount('s2', 'unified7d'), 0, 's2\'s pin did not follow b');

  // b's own window rolls. The baseline must have followed it to its new index,
  // or this reads as a first sight and the session rides the rolled account.
  am.accounts[0].quota.unified7dReset += WEEK;
  assert.equal(serve(am, 's2', OPUS).name, 'c');
});

test('removing an account renumbers the CURRENT account\'s baselines too', () => {
  // The current account keeps its own watcher, which no session owns and so no
  // session's renumbering reaches. Left behind, its baseline names a slot that
  // now holds a different account and the next roll reads as a first sight.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const i of [0, 1, 2]) bucket(am, i, 'unified7d', 0.4, 10);
  assert.equal(am.setCurrentAccount(2), true);
  am.removeAccount(0);
  const c = am.accounts.find(a => a.name === 'c');
  assert.equal(c.index, 1, 'c did not move down into the freed slot');
  assert.equal(am.currentIndex, 1, 'current did not follow c');
  am.accounts[1].quota.unified7dReset += WEEK;
  assert.equal(serve(am, null, OPUS).name, 'b');
});

test('baselines are not accumulated for sessions nothing will ever consult', () => {
  // The only reader of a pin's baseline is the distribution path, so with
  // distribution off seeding one per client-supplied session id is growth for
  // nothing.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  serve(am, 's1', OPUS);
  assert.equal(am.sessionTracker.windowsFor('s1'), null);

  const on = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(on, 0, 'unified7d', 0.4, 10);
  bucket(on, 1, 'unified7d', 0.4, 10);
  serve(on, 's1', OPUS);
  assert.ok(on.sessionTracker.windowsFor('s1'));
});
