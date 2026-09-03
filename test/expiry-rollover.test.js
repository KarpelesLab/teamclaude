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

// One complete request for `sessionId`: select, record where it was sent, and
// end — the order the server does it in.
//
// The scratch object is the request itself. server.js keeps one per client
// request on its ctx and hands it to every selection that request makes, so a
// fixture that models a request has to model that too: it is where the rollover
// a preemption owes is carried while the request is in flight. A `carried`
// passed in is a fixture driving several selections through ONE request.
function serve(am, sessionId, model, { exclude = null, carried = {} } = {}) {
  am.beginSession(sessionId);
  const account = am.getActiveAccount(exclude, model, null, sessionId, carried);
  if (account) am.recordSession(sessionId, account.index, model);
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

test('a route-pinned request does not advance the current account\'s reference', () => {
  // A manual route pin routes without ever consulting currentIndex, so it is
  // not the sticky walk sitting still on its account and must not price it.
  // Refreshing there would let traffic that never asked the question answer it,
  // and the rollover the walk owes would go quiet without anything moving.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  serve(am, null, OPUS);
  rollWindow(am, 0);
  assert.equal(am.setRoutePin('fable', 0).ok, true);
  // Route-pinned traffic flows, and the current walk's comparison is untouched.
  serve(am, null, FABLE);
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true);
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

test('an alternative blocked for a NON-quota reason still reads as stuck', () => {
  // The question is whether anything else could take the traffic, not whether
  // anything else is under a threshold. Upstream's own `rejected` verdict bars
  // an account with no threshold behind it, and a fleet held up by that is as
  // stuck as one held up by spent quota.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  serve(am, null, OPUS);
  am.accounts[1].quota.unifiedStatus = 'rejected';
  am.accounts[1].quota.unifiedStatusSeenAt = Date.now();
  rollWindow(am, 0);
  const lines = [];
  const real = console.log;
  console.log = msg => lines.push(String(msg));
  try {
    assert.equal(serve(am, null, OPUS).name, 'a');
  } finally {
    console.log = real;
  }
  const held = lines.filter(l => /rolled over its unified7d window/.test(l));
  assert.equal(held.length, 1, `expected one held-rollover line, got: ${JSON.stringify(lines)}`);
  assert.match(held[0], /no eligible account/);
});

test('a rollover the re-rank answers by staying does not report a stuck fleet', () => {
  // Two eligible accounts, and the one that rolled is still the better pick on
  // every term — so the re-rank hands it straight back. That is the ordering
  // agreeing with the sticky choice, not the fleet having nowhere to put the
  // traffic, and an operator must not be sent looking for the second.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.1, 10);
  bucket(am, 1, 'unified7d', 0.9, 200);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);
  const lines = [];
  const real = console.log;
  console.log = msg => lines.push(String(msg));
  try {
    assert.equal(serve(am, null, OPUS).name, 'a');
  } finally {
    console.log = real;
  }
  const held = lines.filter(l => /rolled over its unified7d window/.test(l));
  assert.equal(held.length, 1, `expected one held-rollover line, got: ${JSON.stringify(lines)}`);
  assert.match(held[0], /and still ranks best for it — staying there/);
  assert.doesNotMatch(held[0], /no eligible account/);
});

// ---------------------------------------------------------------------------
// The rollover is acted on by whichever pass actually decides the request
// ---------------------------------------------------------------------------

// One complete ADVISOR request: the executor model plus the second model an
// advisor request carries. That pass returns as soon as it succeeds, so for
// this request it is the final selection and not a rehearsal for a later one.
function serveAdvisor(am, sessionId, model, advisorModel) {
  am.beginSession(sessionId);
  const account = am.getActiveAccount(null, model, advisorModel, sessionId);
  if (account) am.recordSession(sessionId, account.index, model);
  am.endSession(sessionId);
  return account;
}

test('an advisor request re-ranks off a rolled current account', () => {
  // The advisor-constrained pass returns its account straight to the caller, so
  // it IS the final selection. An all-advisor workload that never re-ranks would
  // sit on the account that just gained a full week for as long as it lasts.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serveAdvisor(am, null, OPUS, FABLE).name, 'a');
  rollWindow(am, 0);
  assert.equal(serveAdvisor(am, null, OPUS, FABLE).name, 'b');
  // And it stays there, exactly as the plain walk does.
  assert.equal(serveAdvisor(am, null, OPUS, FABLE).name, 'b');
});

test('an advisor request with nowhere to go still says the rollover is stuck', () => {
  // The instrument that reports a stuck rollover must not be behind the same
  // gate as the action it reports on, or the one path that cannot move is also
  // the one path that cannot say so.
  const am = mgr(['a'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  serveAdvisor(am, null, OPUS, FABLE);
  rollWindow(am, 0);
  const lines = [];
  const real = console.log;
  console.log = msg => lines.push(String(msg));
  try {
    assert.equal(serveAdvisor(am, null, OPUS, FABLE).name, 'a');
  } finally {
    console.log = real;
  }
  assert.ok(lines.some(l => /rolled over its unified7d window but no eligible account/.test(l)),
    `expected a stuck-rollover line on the advisor path, got: ${JSON.stringify(lines)}`);
});

// ---------------------------------------------------------------------------
// The window that prices a choice is the window whose roll moves it
// ---------------------------------------------------------------------------

// A learned, model-scoped weekly bucket — the kind upstream reports for a family
// the static table has never heard of.
function scoped(am, index, family, used, hours, base = Date.now()) {
  am.accounts[index].quota.scopedWeekly = {
    ...(am.accounts[index].quota.scopedWeekly || {}),
    [family]: { utilization: used, resetAt: base + hours * H },
  };
}

test('a rollover of the SCOPED governing window moves a pinned session', () => {
  // Ranking reads the scoped bucket when it is the one that binds. Identify the
  // window by the shared weekly instead and the scoped window can gain a full
  // week with no event at all, while the session pinned there goes on spending
  // the quota this feature exists to preserve.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  scoped(am, 1, 'opus', 0.50, 10, now);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  // a's scoped window rolls a full week forward; the shared weekly does not move.
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  assert.equal(serve(am, 's1', OPUS).name, 'b');
});

test('a rollover of the scoped window moves the sticky current account too', () => {
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  scoped(am, 1, 'opus', 0.50, 10, now);
  assert.equal(serve(am, null, OPUS).name, 'a');
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  assert.equal(serve(am, null, OPUS).name, 'b');
});

// ---------------------------------------------------------------------------
// A drain is bounded by the window that priced it
// ---------------------------------------------------------------------------

test('a draining session rejoins the ordinary walk when its window rolls', () => {
  // The drain keeps a session on its account to preserve the cache it built
  // there. That trade is priced against the window the account had; when that
  // window rolls a week forward the account is the one the fleet should be
  // spending LAST, and an active session renews its own idle timer forever, so
  // nothing else ends the drain.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  // The daemon establishes the current account at startup (index.js), which is
  // what gives the ordinary walk a baseline to measure against. Session traffic
  // alone never reaches that walk, so without this the session would leave the
  // drain correctly and then first-sight the rolled window.
  am.selectActiveAccount();
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  am.setDistributeSessions(false);
  assert.equal(am.sessionStats().draining, 1, 'the session should be draining');
  // While the window holds, the drain does its job: the session stays put.
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  assert.notEqual(serve(am, 's1', OPUS).name, 'a',
    'a draining session rode its account through a rollover');
});

test('a draining session whose pin is not the current account still owes its roll', () => {
  // THE FIXTURE ABOVE IS BLIND, and this is the same scenario with the blindness
  // removed. It leaves currentIndex on the pin, so when the drain releases the
  // session into the ordinary walk that walk sees the same jump and records the
  // debt the drain path itself never recorded. The session walk never calls
  // _setCurrent, so on any fleet that has been distributing, the cursor is
  // commonly somewhere else — and then nothing records it at all.
  const am = mgr(['a', 'b', 'c'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  am.selectActiveAccount();
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');
  // The cursor moves off the pin, which is what session traffic alone cannot do.
  assert.equal(am.setCurrentAccount(1), true);
  am.setDistributeSessions(false);
  assert.equal(am.sessionStats().draining, 1, 'the session should be draining');

  rollWindow(am, 0);
  // The drain releases the session; the ordinary walk is on b, which has not
  // rolled, so the request settles there and nothing has spoken for a's roll.
  const carried = {};
  am.beginSession('s1');
  const first = am.getActiveAccount(null, OPUS, null, 's1', carried);
  assert.equal(first.name, 'b', 'the released session should have taken the cursor\'s account');
  am.recordSession('s1', first.index, OPUS);
  // b is refused and c is over threshold, so the retry falls back onto a.
  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS, null, 's1', carried);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.recordSession('s1', retry.index, OPUS);
  am.endSession('s1');

  am.accounts[2].quota.unified7d = 0.4;
  assert.notEqual(serve(am, 's1', OPUS).name, 'a',
    'the drain walk released the session without recording the roll it was owed');
});

// ---------------------------------------------------------------------------
// An observation describes the stay it was taken in
// ---------------------------------------------------------------------------

test('an operator\'s manual switch survives its own next request', () => {
  // An observation kept across stays compares the account's window against what
  // it was the last time traffic sat here, which for an account that rolled
  // while traffic was elsewhere is a rollover already spent. Selecting it again
  // then reads that old roll as new and moves straight back off, so the switch
  // never takes effect. b is the sooner-expiring account once a has rolled, so a false
  // rollover has somewhere to go and this asserts more than "nothing moved".
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, null, OPUS).name, 'a');
  // Traffic moves to b, and a rolls unobserved while it is away.
  assert.equal(am.setCurrentAccount(1), true);
  assert.equal(serve(am, null, OPUS).name, 'b');
  rollWindow(am, 0);
  // The operator puts it back on a. That is a new stay, priced on a's window as
  // it stands now.
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the manual switch was undone by a spent rollover');
  assert.equal(serve(am, null, OPUS).name, 'a');
});

test('a session re-pinned to an account it left is not preempted by the old roll', () => {
  // The session leaves a because a cannot serve it, not because anything rolled,
  // so nothing banks a's window. a rolls while the session is away, and the
  // session is later forced back. The re-pin is a new stay; the roll it was not
  // there for belongs to the old one and has no claim on this traffic.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, 's1', OPUS).name, 'a');

  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should divert while a is out');
  rollWindow(am, 0);
  am.setDisabled(0, false);

  // b goes out in turn, so the session is forced back onto a and re-pinned there.
  am.setDisabled(1, true);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  am.setDisabled(1, false);

  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the prior tenure\'s roll preempted the new one');
});

// ---------------------------------------------------------------------------
// The reference's vocabulary is the named window, on the write side too
// ---------------------------------------------------------------------------

test('the current account\'s baseline is written under the window selection used', () => {
  // The writer once established from the request bucket with no model, so every
  // window took the flat branch: selection chose the account on its scoped
  // window and stored the shared one, leaving the baseline describing a window
  // nothing was spending. A scoped reset could then return without ever reading
  // as a jump.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  scoped(am, 1, 'opus', 0.50, 10, now);
  am.selectActiveAccount();
  assert.equal(am._currentRef.windows.get('scoped:opus'), now + 10 * H,
    'the scoped window was not written on becoming current');
  assert.equal(serve(am, null, OPUS).name, 'a');
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  assert.equal(serve(am, null, OPUS).name, 'b');
});

test('an Opus rollover is not consumed by Haiku traffic', () => {
  // Opus and Haiku share the static request bucket `unified7d` while resolving
  // to different windows the moment either is metered by a scoped bucket. Keyed
  // by the bucket, the event owed on one is spent by the other: an unrelated
  // family pays the cache-miss move while the family that rolled keeps riding
  // the window that just gained a week.
  const HAIKU = 'claude-haiku-4-5';
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  // b is the better account for Haiku, so Haiku stays on a only because the
  // sticky current account holds it there. Anything that re-ranks Haiku moves
  // it, which is what makes a spurious preemption visible rather than absorbed.
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 20, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  scoped(am, 1, 'opus', 0.50, 10, now);
  assert.equal(serve(am, null, OPUS).name, 'a');
  assert.equal(serve(am, null, HAIKU).name, 'a');

  // Only the Opus-scoped window rolls, and the event is DETECTED AND HELD —
  // owed, not yet settled, which is the state the two families shared a key in.
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true, 'the Opus roll was not detected');

  // Haiku is governed by the shared weekly, which did not move. It must not be
  // preempted by an event owed on a window it does not spend.
  assert.equal(serve(am, null, HAIKU).name, 'a', 'Haiku paid for a window that never rolled');
  // And the Opus event is still there to be acted on by Opus traffic.
  assert.equal(serve(am, null, OPUS).name, 'b', 'the Opus rollover was consumed elsewhere');
});

test('a tenure drops a baseline for a window the account no longer presents', () => {
  // A scoped entry is deleted outright once its reset passes, so a tenure that
  // begins during the gap mentions nothing for that window. Merely moving the
  // mentioned baselines forward leaves an earlier tenure's value in place, and
  // the reset reads as a fresh rollover the moment upstream reports it again.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  am.selectActiveAccount();
  assert.equal(am._currentRef.windows.get('scoped:opus'), now + 10 * H);

  // The scoped window goes absent, and a tenure begins elsewhere and comes back
  // — the account is re-chosen while it is reporting nothing for that window.
  delete am.accounts[0].quota.scopedWeekly.opus;
  assert.equal(am.setCurrentAccount(1), true);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(am._currentRef.windows.get('scoped:opus'), undefined,
    'the absent window kept its previous tenure\'s reference');

  // Upstream reports it again, well past its earlier value. That is a first
  // sight in this tenure, not a rollover.
  scoped(am, 0, 'opus', 0.50, 200, now);
  assert.equal(serve(am, null, OPUS).name, 'a', 'a reappearing window read as a rollover');
});

test('staying put through an absence keeps the reference, so a real roll still shows', () => {
  // The other half of the same rule. An account the traffic never left is not a
  // new tenure just because upstream stopped reporting one of its windows, so
  // the reference survives the gap — otherwise a window could roll behind a
  // cleared reading and arrive looking brand new.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 20, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  serve(am, null, OPUS);
  assert.equal(am._currentRef.windows.get('scoped:opus'), now + 10 * H);

  // The window goes absent and comes back a full week on, with the account
  // current throughout.
  delete am.accounts[0].quota.scopedWeekly.opus;
  assert.equal(serve(am, null, OPUS).name, 'a', 'the gap itself moved the traffic');
  scoped(am, 0, 'opus', 0.50, 10 + 24 * 7, now);
  assert.equal(serve(am, null, OPUS).name, 'b', 'the roll behind the gap was lost');
});

// ---------------------------------------------------------------------------
// A terminal that settled nothing decides nothing
// ---------------------------------------------------------------------------

// A preempted request whose destination refuses it, and an ordinary sibling
// selected while it is still in the air, running in a caller-chosen order.
//
// The sibling did nothing wrong: it arrives, finds the pin on the destination
// and settles there. What it must not be able to do is answer for a rollover it
// never incurred — the debt belongs to the request that was sent, and only that
// request comes back to it.
function twoInFlight(order) {
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);

  const sent = {};
  const sibling = {};
  am.beginSession('s1');
  am.beginSession('s1');

  // The rollover fires and sends this request to b, which pins it there.
  const dest = am.getActiveAccount(null, OPUS, null, 's1', sent);
  assert.equal(dest.name, 'b', 'the rollover should have sent the request off a');
  am.recordSession('s1', dest.index, OPUS);

  const stayPut = () => {
    const a = am.getActiveAccount(null, OPUS, null, 's1', sibling);
    assert.equal(a.name, 'b', 'the sibling should have been served by b');
    am.recordSession('s1', a.index, OPUS);
  };
  const failBack = () => {
    // b refused it, so the same request retries with b in its own tried set.
    const a = am.getActiveAccount(new Set([dest.index]), OPUS, null, 's1', sent);
    assert.equal(a.name, 'a', 'the refused request should have fallen back onto a');
    am.recordSession('s1', a.index, OPUS);
  };
  for (const step of (order === 'sibling-last' ? [failBack, stayPut] : [stayPut, failBack])) step();
  am.endSession('s1');
  am.endSession('s1');
  return am;
}

test('an attempt that settled nothing decides nothing, in either scheduling', () => {
  // Where a request was SENT is not where it settled. A request that was
  // refused by its destination says nothing about the window it was pushed off
  // having become acceptable, and neither does a sibling that happened to be
  // served there — so which of them runs first cannot change what the next
  // selection sees.
  for (const order of ['sibling-last', 'sibling-first']) {
    const am = twoInFlight(order);
    assert.notEqual(serve(am, 's1', OPUS).name, 'a',
      `scheduling ${order}: an attempt that settled nothing forgot the rollover`);
  }
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

test('removing an account renumbers an aim as well as a settled baseline', () => {
  // A preemption's aim names its destination by the same bare position the pins
  // do, and it is read by the very next request on that session. Left behind
  // across a removal it is compared against whatever account inherited the slot,
  // which is what renumbering the pins prevents — so the enumeration is both
  // halves of the reference, not just the settled one.
  const am = mgr(['a', 'b', 'c', 'd'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2, 3]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  // The preemption aims at b and the session lands there, with no settle yet:
  // b's reading exists only as the aim.
  assert.equal(serve(am, 's1', OPUS).name, 'b');

  // 'a' is removed, so b/c/d each shift down one slot and the aim's index is
  // stale by exactly one.
  am.removeAccount(0);
  assert.equal(am.accounts.find(a => a.name === 'b').index, 0, 'b did not move down');

  // b's own window rolls. Read through a renumbered aim that is a genuine
  // rollover; read through a stale one it is a comparison against c.
  am.accounts[0].quota.unified7dReset += WEEK;
  assert.notEqual(serve(am, 's1', OPUS).name, 'b',
    'the aim did not follow its account down a slot');
});

test('removing an account renumbers the CURRENT account\'s baselines too', () => {
  // The current account keeps its own reference, which no session owns and so no
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

test('references are not accumulated when the knob cannot use them', () => {
  // A reference exists to answer a preemption question. With the feature off
  // there is no question, and a client-supplied session id must not be able to
  // grow state that nothing will ever read.
  const off = mgr(['a', 'b'], undefined, { distributeSessions: true });
  bucket(off, 0, 'unified7d', 0.4, 10);
  bucket(off, 1, 'unified7d', 0.4, 10);
  serve(off, 's1', OPUS);
  assert.equal(off.sessionTracker.refsFor('s1', 'unified7d'), null);

  const on = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(on, 0, 'unified7d', 0.4, 10);
  bucket(on, 1, 'unified7d', 0.4, 10);
  serve(on, 's1', OPUS);
  assert.equal(on.sessionTracker.refsFor('s1', 'unified7d').windows.size > 0, true);
});

// ---------------------------------------------------------------------------
// One account can owe on more than one window at a time
// ---------------------------------------------------------------------------

const HAIKU = 'claude-haiku-4-5';

test('a rerank that stays put does not mask another family\'s roll on the same account', () => {
  // The rerank answers for the window the request was governed by. Two of an
  // account's windows can roll at once, and a request that looked at one and
  // decided to stay says nothing about the other — each window is compared
  // against its own reference.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 10, now);
  bucket(am, 1, 'unified7d', 0.90, 200, now);
  scoped(am, 0, 'opus', 0.20, 10, now);
  serve(am, null, OPUS);
  serve(am, null, HAIKU);

  // Both of a's windows roll. a still ranks best for Opus, so that request
  // stays; the shared window's roll must survive that.
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must keep Opus on a');
  assert.equal(am._currentRolledOver(am.accounts[0], HAIKU), true,
    'the shared window\'s roll was masked by the Opus rerank');
});

test('two windows rolling on one account are two log lines, not a duplicate', () => {
  // The held-rollover throttle keys on the window. Keyed on the request bucket,
  // a family metered by a learned scoped bucket and the shared weekly beside it
  // share a key, and the second one to roll is silenced as a repeat of the first.
  const am = mgr(['a'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 10, now);
  scoped(am, 0, 'opus', 0.20, 10, now);
  serve(am, null, OPUS);
  serve(am, null, HAIKU);
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  rollWindow(am, 0);

  const lines = [];
  const real = console.log;
  console.log = msg => lines.push(String(msg));
  try {
    serve(am, null, OPUS);
    serve(am, null, HAIKU);
  } finally {
    console.log = real;
  }
  const held = lines.filter(l => /rolled over its .* window/.test(l));
  assert.equal(held.length, 2, `expected one line per window, got: ${JSON.stringify(held)}`);
  assert.ok(held.some(l => /scoped:opus window/.test(l)), 'the scoped window was never named');
  assert.ok(held.some(l => /unified7d window/.test(l)), 'the shared window was never named');
});

// ---------------------------------------------------------------------------
// A retry is the same request, and a destination it could not use settles nothing
// ---------------------------------------------------------------------------

// One client request that has to fail over, in the order server.js runs it: the
// account is selected, the pin is recorded before the destination's token is
// refreshed and long before the upstream fetch, and only then does the
// destination turn out to be unusable, which adds it to the request's tried set
// and re-enters selection. Nothing runs between the two selections here, while
// in production a refresh and a fetch are awaited in that gap and other requests
// are selected inside them; those interleavings are gated in
// expiry-rollover-server.test.js.
function serveFailingOver(am, sessionId, model, dead) {
  const carried = {};
  am.beginSession(sessionId);
  const first = am.getActiveAccount(null, model, null, sessionId, carried);
  if (first) am.recordSession(sessionId, first.index, model);
  const retry = am.getActiveAccount(new Set([dead]), model, null, sessionId, carried);
  if (retry) am.recordSession(sessionId, retry.index, model);
  am.endSession(sessionId);
  return { first, retry };
}

test('a retry that falls back onto the rolled account leaves the rollover owed', () => {
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);

  const { first: moved, retry } = serveFailingOver(am, 's1', OPUS, other);
  assert.equal(moved.index, other, 'the rollover did not preempt');
  assert.equal(retry.index, first.index, 'the retry did not fall back onto the rolled account');

  // The request came back because its destination was unusable, not because the
  // session settled onto the window that just gained a full week.
  assert.equal(serve(am, 's1', OPUS).index, other,
    'the failed fail-back priced the rolled account');
});

test('a retry that bounces back to the rolled current account leaves it owed', () => {
  // The same cascade on the path that is live by default: distributeSessions is
  // off, so current-account stickiness is what an operator gets by turning on
  // expiry routing alone.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  const { first, retry } = serveFailingOver(am, null, OPUS, 1);
  assert.equal(first.name, 'b', 'the rollover did not preempt');
  assert.equal(retry.name, 'a', 'the retry did not bounce back onto the rolled account');

  assert.equal(serve(am, null, OPUS).name, 'b',
    'the bounce first-sighted the rolled reset');
});

test('a destination that rolls after the move is not adopted post-roll', () => {
  // A successful preemption is an arrival, and what the destination's window read
  // on arrival is what its own next roll has to be measured against. Read at the
  // following request instead, a roll in between is adopted as the starting point
  // and disappears — the session parks on the account that just gained a week
  // while sooner-expiring quota goes on expiring.
  const am = mgr(['a', 'b', 'c'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  rollWindow(am, 1);
  assert.equal(serve(am, 's1', OPUS).name, 'c',
    'the destination\'s own rollover was consumed by the arrival');
});

test('a current account that rolls after the move is not adopted post-roll', () => {
  // The reading comes from the aim on this path, and the property has to survive
  // that: remove the aim and this is the test that says so.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'the rollover did not move the current account');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c',
    'the destination\'s own rollover was consumed by the arrival');
});

// ---------------------------------------------------------------------------
// Turning the feature on mid-flight
// ---------------------------------------------------------------------------

test('hot-enabling the feature ends a drain a rollover should have ended', () => {
  // index.js applies distributeSessions before expiryRouting, so one reload can
  // put every live session into the drain and then turn preemption on. A drain
  // is bounded by nothing but a rollover, and a session that entered it without
  // an observation can never acquire one: the drain's honored path takes none.
  const am = mgr(['a', 'b'], undefined, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  // As the daemon does at startup, and for the reason the drain test above
  // gives: leaving the drain hands the session to the ordinary walk, which
  // measures against the current account's reference rather than the pin's.
  am.selectActiveAccount();
  const first = serve(am, 's1', OPUS);
  am.setDistributeSessions(false);
  am.setExpiryRouting(ON);
  assert.equal(am.drainingCount(), 1, 'the fixture must leave s1 draining');
  rollWindow(am, first.index);
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'the draining session never saw the roll that bounds its drain');
});

test('hot-enabling the feature does not miss the first rollover after it', () => {
  const am = mgr(['a', 'b'], undefined, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  am.setExpiryRouting(ON);
  rollWindow(am, first.index);
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'the first roll after the knob went on was read as a first sight');
});

test('re-applying the same setting does not re-read what is already being watched', () => {
  // Only the OFF → ON transition takes a reading. Every config reload while the
  // feature is already on re-applies the same object, and a server notified once
  // a minute would otherwise re-read every reference each time — leaving nothing
  // a roll could ever be measured against, and no rollover ever detected.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  rollWindow(am, first.index);
  // A reload lands between the roll and the request that should act on it.
  am.setExpiryRouting({ enabled: true, preempt: true });
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'a reload re-read the reference and swallowed the roll it was owed');
});

test('a session that leaves an account and comes back while off is a new tenure', () => {
  // AN INDEX IS NOT AN IDENTITY, here for the third time. The seed asked whether
  // the reference names the account the pin now names, and A→B→A returns to a
  // matching index — so a reference from the FIRST stay on a reads as continuous,
  // and a roll that happened while the session was away is treated as newly owed.
  // The session pays a cache-breaking preemption for a rollover that belongs to a
  // tenure it was not there for.
  //
  // What has to match is not the slot but THIS pinning: any new tenure, on the
  // same account or another, cannot be described by a reference taken in an
  // earlier one.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');

  am.setExpiryRouting({ enabled: false });
  // The session is forced to b and back to a, all while nothing is watching, and
  // a's window rolls while the session is away.
  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should have moved to b');
  rollWindow(am, 0);
  am.setDisabled(0, false);
  am.setDisabled(1, true);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the session should have returned to a');
  am.setDisabled(1, false);

  am.setExpiryRouting(ON);
  assert.equal(serve(am, 's1', OPUS).name, 'a',
    'a roll from a tenure the session was not present for forced a preemption');
});

test('an arrival is not a debt, so a rollover owes only the window that rolled', () => {
  // A request that SETTLES on an account records what every window there read —
  // that is what an arrival is, and it is how the account is measured if the
  // request comes back to it. A request PUSHED OFF an account records the one
  // window that rolled. When the same request does both, in that order, the debt
  // must not inherit the arrival's other windows: it did not price them as a
  // rollover, and restoring them on fail-back rewinds whatever a sibling settled
  // on them in between.
  //
  // The production shape is the same-account retry — a short-wait 429 re-enters
  // selection with the tried set untouched — after a roll in flight.
  const am = mgr(['a', 'b', 'c'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 20, now);
  bucket(am, 2, 'unified7d', 0.10, 30, now);
  scoped(am, 0, 'opus', 0.90, 15, now);
  assert.equal(am.setCurrentAccount(0), true);

  // An Opus request settles on a, recording an arrival for BOTH of a's windows.
  const carried = {};
  am.getActiveAccount(null, OPUS, null, null, carried);
  assert.equal(am._governingWindow(am.accounts[0], OPUS).window, 'scoped:opus',
    'the fixture must have the scoped window governing Opus on a');

  // a's Opus window rolls under the request, and the same-account retry — the
  // tried set is empty, so selection is free to look again — is pushed off a.
  am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
  const moved = am.getActiveAccount(null, OPUS, null, null, carried);
  assert.notEqual(moved.name, 'a', 'the retry should have been pushed off a');

  // A sibling settles a's SHARED window at a new value while the request is away.
  const siblingAt = now + 500 * H;
  am.accounts[0].quota.unified7dReset = siblingAt;
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(am._currentRef.windows.get('unified7d'), siblingAt,
    'the fixture must have the sibling\'s reading settled on a');

  // The Opus request fails back onto a. It is owed a's scoped window and nothing
  // else, so the sibling's shared reading stands.
  am.getActiveAccount(new Set([moved.index]), OPUS, null, null, carried);
  assert.equal(am._currentRef.windows.get('unified7d'), siblingAt,
    'the debt inherited the arrival\'s windows and rewound the sibling');
});

test('a knob switched off and back on does not re-read a roll already owed', () => {
  // The destructive direction of the same rule, and the one a control that only
  // re-applies ON never reaches. ABSENT and STALE are different states: a pin
  // with no reading has none because nothing was watching when it was made, and
  // seeding it is the honest first sight. A pin that HAS one holds it from when
  // the knob was last on, has not moved since, and may be owed a rollover right
  // now — re-taking it answers a question nobody asked and spends the debt in
  // silence, which is the failure this feature exists to prevent.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  rollWindow(am, first.index);
  am.setExpiryRouting({ enabled: false });
  am.setExpiryRouting(ON);
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'the seed re-read a window the session was still owed a rollover on');
});

test('a reading naming an account the session has left is re-taken on enable', () => {
  // The third state. A reading that is merely STALE — same account, taken when
  // the knob was last on — may be owed a rollover right now and must be left
  // alone. A reading naming a DIFFERENT account is not that: the session moved
  // while nothing was watching, so it describes a tenure that is over and is not
  // a comparison at all — the reading is matched on the account, finds a
  // mismatch, and the account the session is actually on gets its next roll
  // first-sighted.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  const first = serve(am, 's1', OPUS);
  assert.equal(first.name, 'a');

  // The knob goes off, a goes out of service, and the session moves to b. No
  // reading is taken for b: session references are only written while the knob
  // is on, so the one in the tracker still names a.
  am.setExpiryRouting({ enabled: false });
  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should have moved to b');
  am.setDisabled(0, false);

  am.setExpiryRouting(ON);
  rollWindow(am, 1);
  assert.notEqual(serve(am, 's1', OPUS).name, 'b',
    'the seed kept a reading naming the account the session had left');
});

test('re-enabling distribution does not revive a debt from an old tenure', () => {
  // The tenure stamp is only reconciled at the knob's off-to-on transition, and
  // this is a different boundary: distribution being turned back on. The pin has
  // moved twice since the reference was stamped, so a reading from the FIRST
  // stay was being read as current debt and the session paid a preemption for a
  // roll that happened while it was somewhere else.
  //
  // The reader asks the question the seed asks, so a stamp from a finished stay
  // answers nothing wherever it is read.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');

  // Distribution off: the session drains, is forced to b, and comes back to a,
  // so its pin is in its third tenure while the reference still names the first.
  am.setDistributeSessions(false);
  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should have moved to b');
  rollWindow(am, 0);
  am.setDisabled(0, false);
  am.setDisabled(1, true);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the session should have returned to a');
  am.setDisabled(1, false);

  am.setDistributeSessions(true);
  assert.equal(serve(am, 's1', OPUS).name, 'a',
    'a reading from a finished tenure was read as current debt');
});

test('an account known to be nearly spent does not win on having fewer sessions', () => {
  // Admission is unconditional: using an account is how its missing window gets
  // reported. But a bounded absence is not an unknown, and admitting it as a
  // discovery would let a 95%-spent account into the band and then win on load,
  // because load is compared before pressure.
  const am = mgr(['spent-clockless', 'ample-expiring'], ON, { distributeSessions: true });
  const q = am.accounts[0].quota;
  q.unified7dFable = 0.95;        // measured, and nearly gone
  q.unified7dFableReset = null;   // with no clock
  q.unified7d = 0.10;
  q.unified7dReset = Date.now() + 200 * H;
  am.accounts[0].probing = false;
  bucket(am, 1, 'unified7dFable', 0.05, 1);
  bucket(am, 1, 'unified7d', 0.10, 200);

  // The ample account carries a session; the spent one carries none, which is
  // the whole of its advantage under a load-first comparison.
  am.beginSession('s1');
  am.recordSession('s1', 1, FABLE);

  assert.equal(am._pickLeastLoaded(null, FABLE).name, 'ample-expiring',
    'a measured 95%-spent account won on session count');
  // Still admitted, because being used is how its window gets reported.
  assert.deepEqual(am._bandedCandidates(null, FABLE).map(a => a.name),
    ['spent-clockless', 'ample-expiring']);
  am.endSession('s1');
});

// ---------------------------------------------------------------------------
// Every site that MOVES a request off an account answers for what it was owed
// ---------------------------------------------------------------------------

test('the 5h session-reset switch records what the account it leaves was owed', () => {
  // A MOVER THAT NEVER ASKS ABOUT ROLLOVERS. It runs from refreshExpiredQuotas
  // at the head of selection, so it can take a request off a current account
  // whose weekly window has just rolled — before the walk has looked at it once.
  // Nothing in its body mentions a rollover, which is exactly why an invariant
  // ranging over rollover CHECKS could not see it.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');

  // a's weekly rolls, and b's 5h window expires in the same instant — so the
  // reset switch moves the request to b before the walk sees a's jump.
  rollWindow(am, 0);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  const carried = {};
  const first = am.getActiveAccount(null, OPUS, null, null, carried);
  assert.equal(first.name, 'b', 'the session reset should have moved the request to b');

  // b is refused and c is over threshold, so the retry falls back onto a.
  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS, null, null, carried);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.accounts[2].quota.unified7d = 0.4;

  assert.notEqual(serve(am, null, OPUS).name, 'a',
    'the reset switch moved the request off a rolled account without recording the debt');
});

test('the requalification rerank records what the account it leaves was owed', () => {
  // A SECOND MOVER THAT IS NOT A DETECTOR: it reranks and RETURNS before the
  // rollover branch runs, so the response that teaches an account's quota can be
  // the same response that reveals its window rolled, and the move is made with
  // nothing captured. `requalify` is what updateQuota sets when a probed
  // account's weekly limit becomes known.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');

  rollWindow(am, 0);
  am.accounts[0].requalify = true;

  const carried = {};
  const first = am.getActiveAccount(null, OPUS, null, null, carried);
  assert.notEqual(first.name, 'a', 'the rerank should have moved the request off a');

  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS, null, null, carried);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.accounts[2].quota.unified7d = 0.4;

  assert.notEqual(serve(am, null, OPUS).name, 'a',
    'the rerank moved the request off a rolled account without recording the debt');
});

test('the preview observes a session reset without consuming it', () => {
  // AN OBSERVER THAT CONSUMES THE EVENT IS NOT AN OBSERVER. The preview's
  // availability check reaches _clearExpiredQuotas, which performs half the reset
  // transition — clearing the expired window. With the switch that is its other
  // half running only for whoever observed the clear, a TUI render cancels the
  // switch the next real request is owed.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 100);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(am.setCurrentAccount(0), true);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  // The status view asks its question. It must answer without deciding anything.
  am.previewRouteIndex(OPUS);

  assert.equal(serve(am, null, OPUS).name, 'b',
    'the preview consumed the reset and suppressed the switch it belonged to');
});

test('a knob toggled while a preemption is in flight cannot spend it', () => {
  // The reload arrives mid-request, between the preemption and the retry its
  // destination forced. What the request is owed is not in the tracker for a
  // seed to reach — it is on the request — so seeding cannot answer for it.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);

  const carried = {};
  am.beginSession('s1');
  const sent = am.getActiveAccount(null, OPUS, null, 's1', carried);
  assert.equal(sent.index, other, 'the rollover did not preempt');
  am.recordSession('s1', sent.index, OPUS);

  am.setExpiryRouting({ enabled: false });
  am.setExpiryRouting(ON);

  const retry = am.getActiveAccount(new Set([other]), OPUS, null, 's1', carried);
  assert.equal(retry.index, first.index, 'the retry did not fall back');
  am.recordSession('s1', retry.index, OPUS);
  am.endSession('s1');

  assert.equal(serve(am, 's1', OPUS).index, other,
    'a reload mid-flight spent the rollover the request was carrying');
});

// ---------------------------------------------------------------------------
// The status view and the next selection name the same account
// ---------------------------------------------------------------------------

test('the preview names the account the next request would actually get', () => {
  // previewRouteIndex is what the TUI and the status JSON show. It mirrors the
  // priority preemption but not the rollover one, so after a roll an operator
  // watching the feature fire sees the parked account until some other request
  // moves the cursor.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);
  const preview = am.previewRouteIndex(OPUS);
  const actual = am.getActiveAccount(null, OPUS);
  assert.equal(preview, actual.index,
    'the status view and the next selection disagree across a rollover');
});
