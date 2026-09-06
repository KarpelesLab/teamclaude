import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

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
// end — the order the server does it in. A request carries no rollover state of
// its own; what a fixture models instead is the TRIED SET, which is what makes
// several selections one request rather than several (see serveFailingOver).
function serve(am, sessionId, model, { exclude = null } = {}) {
  am.beginSession(sessionId);
  const account = am.getActiveAccount(exclude, model, null, sessionId);
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

test('a window re-reported slightly LATER is not a rollover either', () => {
  // The forward half of the same drift, and the half ROLLOVER_MIN_JUMP_MS is
  // for. The two writers of a reset disagree on precision, so one instant
  // arrives as two values up to a second apart. Backward is not a jump under any
  // rule; FORWARD is, unless the comparison has a floor.
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const q = am.accounts[first.index].quota;
  for (const drift of [500, 60_000, 30 * 60_000]) {
    q.unified7dReset += drift;
    assert.equal(serve(am, 's1', OPUS).index, first.index,
      `a ${drift}ms forward drift read as a rollover`);
  }
  // And a real week still does move it, so the floor is a floor and not a mute.
  rollWindow(am, first.index);
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'the floor swallowed a genuine weekly roll');
});

test('a reading taken on one account is not evidence about another', () => {
  // The comparison is scoped to the account the observation NAMES. Two accounts'
  // weeks are unrelated numbers, so without that check the fleet would preempt
  // off whichever account held the further-dated window every single request.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.4, 10, now);
  bucket(am, 1, 'unified7d', 0.4, 10, now);
  assert.equal(serve(am, null, OPUS).name, 'a');
  assert.equal(am._currentObs.idx, 0, 'the fixture must have the reading on a');
  // b's window is a full week further out than the reading held for a. Compared
  // against a's number that is a jump; compared as what it is — a different
  // account's clock, which nothing has read — it is nothing at all.
  am.accounts[1].quota.unified7dReset = now + 10 * H + WEEK;
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), false,
    'a\'s reading was read as evidence about b');

  // The same for a session's pin.
  const am2 = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am2, 0, 'unified7d', 0.4, 10, now);
  bucket(am2, 1, 'unified7d', 0.4, 10, now);
  assert.equal(serve(am2, 's1', OPUS).name, 'a');
  am2.accounts[1].quota.unified7dReset = now + 10 * H + WEEK;
  assert.equal(am2._pinRolledOver('s1', am2.accounts[1], OPUS), false,
    'the pin\'s reading of a was read as evidence about b');
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

test('a preemption with nowhere to go leaves the roll where the next request finds it', () => {
  const am = pinnedFleet(ON);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);
  // The only destination is excluded, so this request comes back to the account
  // it was trying to leave. The traffic did not move, so the reading does not
  // advance over the jump.
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

test('a route-pinned request does not advance the current account\'s reading over its roll', () => {
  // A manual route pin routes without ever consulting currentIndex. The reading
  // is still taken — the cursor is where the last request left it either way —
  // but it cannot advance over a jump, so a roll the sticky walk has not
  // answered for is still there when that walk next runs.
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

test('a manual switch takes a FIRST reading, and never overwrites one', () => {
  // An operator's switch is an aim, and an aim may take a reading only where
  // there is none to lose. Parked on an account nothing has ever read, the fleet
  // would first-sight its next roll for no reason; parked on one whose roll is
  // outstanding, overwriting would spend it. Both are checked here.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(am.setCurrentAccount(1), true);
  assert.equal(am._currentObs.idx, 1, 'the switch left the cursor unread');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the roll after the switch was not caught');
  assert.equal(am.setCurrentAccount(9), false);

  // And the other half: a switch onto an account that still owes a roll must not
  // wipe it. Here b has rolled and the cursor is already reading b.
  const am2 = mgr(['a', 'b'], ON);
  bucket(am2, 0, 'unified7d', 0.4, 20);
  bucket(am2, 1, 'unified7d', 0.4, 10);
  assert.equal(am2.setCurrentAccount(1), true);
  assert.equal(serve(am2, null, OPUS).name, 'b');
  rollWindow(am2, 1);
  assert.equal(am2.setCurrentAccount(1), true, 're-switching to the same account');
  assert.equal(serve(am2, null, OPUS).name, 'a', 'the switch overwrote an outstanding roll');
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

test('a draining session whose pin is not the current account keeps its roll', () => {
  // The same scenario with the cursor moved off the pin. The session walk never
  // calls _setCurrent, so on any fleet that has been distributing the cursor is
  // commonly somewhere else, and then only the session's own observation speaks
  // for the pin's window.
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
  am.beginSession('s1');
  const first = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(first.name, 'b', 'the released session should have taken the cursor\'s account');
  am.recordSession('s1', first.index, OPUS);
  // b is refused and c is over threshold, so the retry falls back onto a.
  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS, null, 's1');
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.recordSession('s1', retry.index, OPUS);
  am.endSession('s1');

  am.accounts[2].quota.unified7d = 0.4;
  // The session's own observation still holds a's pre-roll reading — the drain
  // walk skipping its pin, and the fail-back landing on it, both wrote nothing.
  assert.equal(am._pinRolledOver('s1', am.accounts[0], OPUS), true,
    'the drain walk spent the roll of the pin it released');

  // AND HERE IS THE BOUNDARY. Releasing the drain ends this session's affinity:
  // it is ordinary traffic from now on, governed by the CURSOR's observation,
  // which has never read a. So the fail-back onto a is a first sight for the
  // walk that now routes this session, and the fleet stays there. Nothing
  // available to a per-choice observation separates that fail-back from a
  // legitimate return: the two differ only in what the request has already
  // tried, which is the request's own history.
  assert.equal(serve(am, 's1', OPUS).name, 'a');
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

test('the current account\'s reading is written under the window selection used', () => {
  // Establishing from the request bucket alone would take the flat branch for
  // every window: selection chooses the account on its scoped window and stores
  // the shared one, leaving the reading describing a window nothing is spending,
  // and a scoped reset then returns without ever reading as a jump.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  scoped(am, 1, 'opus', 0.50, 10, now);
  am.selectActiveAccount();
  assert.equal(am._currentObs.windows.get('scoped:opus'), now + 10 * H,
    'the scoped window was not written under its own name');
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

test('a reading re-established elsewhere and back drops a window the account no longer presents', () => {
  // A scoped entry is deleted outright once its reset passes, so a reading taken
  // during the gap mentions nothing for that window. Merely moving the mentioned
  // windows forward would leave the earlier value in place, and the reset would
  // read as a fresh rollover the moment upstream reported it again. The
  // establish branch writes the account WHOLE for exactly this reason.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 300, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  assert.equal(serve(am, null, OPUS).name, 'a');
  assert.equal(am._currentObs.windows.get('scoped:opus'), now + 10 * H);

  // The scoped window goes absent, and the traffic goes elsewhere and comes back
  // — the account is read again while it is reporting nothing for that window.
  delete am.accounts[0].quota.scopedWeekly.opus;
  assert.equal(am.setCurrentAccount(1), true);
  assert.equal(serve(am, null, OPUS).name, 'b');
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a');
  assert.equal(am._currentObs.windows.get('scoped:opus'), undefined,
    'the absent window kept a value from an earlier stay');

  // Upstream reports it again, well past where it last stood. That is a first
  // sight, not a rollover.
  scoped(am, 0, 'opus', 0.50, 200, now);
  assert.equal(serve(am, null, OPUS).name, 'a', 'a reappearing window read as a rollover');
});

test('staying put through an absence keeps the reading, so a real roll still shows', () => {
  // The other half of the same rule. An account the traffic never left is not a
  // fresh start just because upstream stopped reporting one of its windows: the
  // same-account branch advances only the window this request was governed by,
  // so the reading survives the gap and a window cannot roll behind a cleared
  // reading and arrive looking brand new.
  const am = mgr(['a', 'b'], ON);
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 300, now);
  bucket(am, 1, 'unified7d', 0.10, 20, now);
  scoped(am, 0, 'opus', 0.50, 10, now);
  serve(am, null, OPUS);
  assert.equal(am._currentObs.windows.get('scoped:opus'), now + 10 * H);

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
// and is served there. What it must not do is take a READING there — the pin
// names the destination because a request was AIMED at it, and that request is
// still out and may yet come back. Both requests are begun before either
// selects, which is what the session's in-flight count is for.
function twoInFlight(order) {
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);

  am.beginSession('s1');
  am.beginSession('s1');

  // The rollover fires and sends this request to b, which pins it there.
  const dest = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(dest.name, 'b', 'the rollover should have sent the request off a');
  am.recordSession('s1', dest.index, OPUS);

  const stayPut = () => {
    const a = am.getActiveAccount(null, OPUS, null, 's1');
    assert.equal(a.name, 'b', 'the sibling should have been served by b');
    am.recordSession('s1', a.index, OPUS);
  };
  const failBack = () => {
    // b refused it, so the same request retries with b in its own tried set.
    const a = am.getActiveAccount(new Set([dest.index]), OPUS, null, 's1');
    assert.equal(a.name, 'a', 'the refused request should have fallen back onto a');
    am.recordSession('s1', a.index, OPUS);
  };
  for (const step of (order === 'sibling-last' ? [failBack, stayPut] : [stayPut, failBack])) step();
  am.endSession('s1');
  am.endSession('s1');
  return am;
}

test('an attempt that settled nothing decides nothing, in either scheduling', () => {
  // Where a request was SENT is not where it came to rest. A request refused by
  // its destination says nothing about the window it was pushed off having
  // become acceptable, and neither does a sibling served there while the first
  // is still in the air — so which of them runs first cannot change what the
  // next selection sees.
  for (const order of ['sibling-last', 'sibling-first']) {
    const am = twoInFlight(order);
    assert.notEqual(serve(am, 's1', OPUS).name, 'a',
      `scheduling ${order}: an attempt that settled nothing took a reading anyway`);
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

test('removing an account renumbers a reading taken after a preemption', () => {
  // The same renumbering, for the reading a session takes on the account a
  // rollover moved it to. It names its account by the same bare position the
  // pins do, and left behind across a removal it is compared against whatever
  // account inherited the slot.
  const am = mgr(['a', 'b', 'c', 'd'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2, 3]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  // The next request finds the pin on b and reads it there.
  assert.equal(serve(am, 's1', OPUS).name, 'b');
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').idx, 1,
    'the reading should name b');

  // 'a' is removed, so b/c/d each shift down one slot and the reading's index is
  // stale by exactly one.
  am.removeAccount(0);
  assert.equal(am.accounts.find(a => a.name === 'b').index, 0, 'b did not move down');

  // b's own window rolls. Read through a renumbered reading that is a genuine
  // rollover; read through a stale one it is a comparison against c.
  am.accounts[0].quota.unified7dReset += WEEK;
  assert.notEqual(serve(am, 's1', OPUS).name, 'b',
    'the reading did not follow its account down a slot');
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

test('observations are not accumulated when the knob cannot use them', () => {
  // An observation exists to answer a preemption question. With the feature off
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
  am.beginSession(sessionId);
  const first = am.getActiveAccount(null, model, null, sessionId);
  if (first) am.recordSession(sessionId, first.index, model);
  // The growing tried set is what makes this the SAME request. It is also what
  // tells the reading apart from a fresh arrival: a sticky choice naming an
  // account this request has already tried is a failed attempt, so no reading is
  // taken and the roll it was pushed off is still there to be found.
  const retry = am.getActiveAccount(new Set([dead]), model, null, sessionId);
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

test('a fail-back onto a FAMILY roll leaves the rollover owed', () => {
  // Every fail-back arm above rolls `unified7d`. An aim consulting only that
  // window would find the shared weekly still and replace the whole reading, so
  // the fail-back would first-sight the week a family bucket had just gained.
  // Which window rolled is not a fact about whether an aim may discard the
  // reading.
  const am = pinnedFleet(ON);
  bucket(am, 0, 'unified7dFable', 0.4, 10);
  bucket(am, 1, 'unified7dFable', 0.4, 10);
  const first = serve(am, 's1', FABLE);
  const other = 1 - first.index;
  rollWindow(am, first.index, 'unified7dFable');

  const { first: moved, retry } = serveFailingOver(am, 's1', FABLE, other);
  assert.equal(moved.index, other, 'the family rollover did not preempt');
  assert.equal(retry.index, first.index, 'the retry did not fall back onto the rolled account');

  assert.equal(serve(am, 's1', FABLE).index, other,
    'the aim spent the family rollover the shared window said nothing about');
});

test('the same family fail-back on the current account', () => {
  // The path that is live by default, and the one the aim at _setCurrent takes.
  const am = mgr(['a', 'b'], ON);
  for (const i of [0, 1]) {
    bucket(am, i, 'unified7d', 0.4, 10);
    bucket(am, i, 'unified7dFable', 0.4, 10);
  }
  assert.equal(serve(am, null, FABLE).name, 'a');
  rollWindow(am, 0, 'unified7dFable');

  const { first, retry } = serveFailingOver(am, null, FABLE, 1);
  assert.equal(first.name, 'b', 'the family rollover did not preempt');
  assert.equal(retry.name, 'a', 'the retry did not bounce back onto the rolled account');

  assert.equal(serve(am, null, FABLE).name, 'b',
    'the aim spent the family rollover the shared window said nothing about');
});

test('a retry that never left the destination does not spend the origin roll', () => {
  // A short-wait 429 and a 401 retry the SAME account, and the server releases
  // its in-flight slot before recursing into selection with the tried set
  // untouched. So the retry arrives looking exactly like a fresh request finding
  // the traffic at rest on the preemption's destination — and it is not one:
  // nothing was served there, and this one goes on to be refused.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  assert.equal(am.getActiveAccount(null, OPUS, null, null).name, 'b',
    'the rollover did not preempt');
  // The retry: same request, same account, an empty tried set either way.
  assert.equal(am.getActiveAccount(null, OPUS, null, null).name, 'b',
    'the retry did not stay on the account it was aimed at');
  // Then that account refuses outright and the request falls back.
  assert.equal(am.getActiveAccount(new Set([1]), OPUS, null, null).name, 'a',
    'the refusal did not fall back onto the rolled account');

  assert.equal(serve(am, null, OPUS).name, 'b',
    'the retry was read as a completed stay and spent the roll');
});

test('a stay a second request confirms releases the roll it was pushed off', () => {
  // The held roll is the fail-back's protection and nothing more. Once a second
  // request has found the traffic where the last one left it, the move stuck and
  // the origin's roll is escaped — holding it any longer would preempt off that
  // account every time the fleet came back to it, for a rollover it has already
  // been moved off once.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  assert.equal(serve(am, null, OPUS).name, 'b', 'the rollover did not preempt');
  // The preemption AIMED at b; the next request is the first to rest there, and
  // the one after it is the second to find the traffic where the last one left
  // it. That is the confirmation.
  assert.equal(serve(am, null, OPUS).name, 'b', 'the first request did not rest on b');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the second request did not confirm the stay');

  // b is out of the way, so the traffic comes back to a on its own.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1]) }).name, 'a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), false,
    'a roll the fleet already moved off was charged a second time');
  assert.equal(serve(am, null, OPUS).name, 'a',
    'the return to an escaped roll preempted off it again');
});

test('removing an account renumbers a session pin\'s held roll too', () => {
  // The pin's observation holds one the same way the cursor's does, and it is
  // renumbered by a different function in a different module — so it gets its
  // own arm rather than resting on the cursor's.
  const am = mgr(['a', 'b', 'c', 'd'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2, 3]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  // One request rests on b, which holds a's roll without confirming the stay.
  assert.equal(serve(am, 's1', OPUS).name, 'b');
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').unescaped?.idx, 0,
    'the fixture must have held a\'s roll on the pin');

  am.removeAccount(0);
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').unescaped, null,
    'the pin\'s held roll outlived the account it was taken on');
});

test('removing an account renumbers a held roll rather than aiming it elsewhere', () => {
  // The held reading names its account by index like every other, so the shift
  // reaches it too: left behind, it would be handed back on the next fail-back to
  // whichever account inherited the slot.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const i of [0, 1, 2]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);
  // The roll preempts to b, and one arrival there holds a's roll without
  // confirming the stay.
  assert.equal(am.getActiveAccount(null, OPUS, null, null).name, 'b');
  assert.equal(am.getActiveAccount(null, OPUS, null, null).name, 'b');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'the fixture must have held a\'s roll');

  am.removeAccount(0);
  assert.equal(am._currentObs.unescaped, null,
    'the held roll outlived the account it was taken on');
});

test('a destination is measured from the first request that rests on it', () => {
  // A preemption aims at b and takes no reading there, so a roll on b before any
  // request has rested there is a first sight — the same as for an account a
  // brand-new session is placed on. That cost is asserted here, not hidden.
  const am = mgr(['a', 'b', 'c'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  // The next request rests on b and reads it.
  assert.equal(serve(am, 's1', OPUS).name, 'b');
  // From here b's own roll is caught.
  rollWindow(am, 1);
  assert.equal(serve(am, 's1', OPUS).name, 'c',
    'the destination\'s own rollover was not caught once it had been read');
});

test('the current account is measured from the first request that rests on it', () => {
  // The same on the path that is live by default.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'the rollover did not move the current account');
  assert.equal(serve(am, null, OPUS).name, 'b');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c',
    'the destination\'s own rollover was not caught once it had been read');
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

test('a session that leaves an account and comes back while OFF is measured afresh', () => {
  // The same A→B→A shape with the knob off for the excursion: the knob going off
  // drops the observation outright, so there is nothing from the first stay for
  // the return to be measured against.
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
    'a roll from a stay the session was not present for forced a preemption');
});


test('nothing survives the knob being off, so a roll from that interval is a first sight', () => {
  // The lifetime is the guarantee: switching off drops every observation, so an
  // interval in which nothing was watching leaves nothing behind, and the first
  // request after the knob comes back takes an honest first sight. The cost is
  // one roll per off/on cycle, a roll nobody was watching for; the gain is that
  // "off means inert" needs no reader to remember it.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').idx, first.index);
  rollWindow(am, first.index);
  am.setExpiryRouting({ enabled: false });
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d'), null,
    'an observation survived the knob going off');
  assert.equal(am._currentObs, null, 'the current observation survived the knob going off');
  am.setExpiryRouting(ON);
  assert.equal(serve(am, 's1', OPUS).index, first.index,
    'a roll nothing was watching for was charged to the session anyway');
  // And the next roll AFTER the knob came back is caught, so the clear is a
  // reset rather than a silencing.
  rollWindow(am, first.index);
  assert.notEqual(serve(am, 's1', OPUS).index, first.index,
    'the first roll after the knob came back was missed');
});

test('turning preemption off alone also drops the observations', () => {
  // `preempt: false` leaves the band on and the comparison off, so the same
  // reasoning applies: nothing reads an observation, so none may be kept.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  serve(am, 's1', OPUS);
  am.setExpiryRouting({ enabled: true, preempt: false });
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d'), null);
  assert.equal(am._currentObs, null);
});

test('a session that leaves an account and comes back is measured from the stay it is in', () => {
  // AN INDEX IS NOT AN IDENTITY. The session leaves a and returns to it, and a
  // rolls while it is away; a reading from the FIRST stay would read as
  // continuous and charge the session a cache-breaking preemption for a roll it
  // was not there for. No counter is needed to tell the two apart: the session
  // came to REST on b, and resting elsewhere is what retires the observation of
  // a, so the return to a is read from what a presents then.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');

  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should have moved to b');
  // A second request on b, which is what makes it a stay rather than an aim.
  assert.equal(serve(am, 's1', OPUS).name, 'b');
  rollWindow(am, 0);
  am.setDisabled(0, false);

  // b goes out in turn, so the session is forced back onto a.
  am.setDisabled(1, true);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  am.setDisabled(1, false);

  assert.equal(serve(am, 's1', OPUS).name, 'a',
    'a roll from a stay the session was not present for preempted it anyway');
});

test('re-enabling distribution does not revive a roll from a finished stay', () => {
  // The same property at a different boundary, distribution being turned back
  // on. There is no transition to reconcile at: the observation moved when the
  // session came to rest on b, and every boundary reads the same state.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');

  am.setDistributeSessions(false);
  am.setDisabled(0, true);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the session should have moved to b');
  assert.equal(serve(am, 's1', OPUS).name, 'b');
  rollWindow(am, 0);
  am.setDisabled(0, false);
  am.setDisabled(1, true);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the session should have returned to a');
  am.setDisabled(1, false);

  am.setDistributeSessions(true);
  assert.equal(serve(am, 's1', OPUS).name, 'a',
    'a reading from a finished stay was read as a current roll');
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

// THE DEFAULT-OFF GUARANTEE IS NOT A UNIT TEST. The promise in docs/routing.md
// is byte-identity with the behaviour the knob is off for, and that behaviour
// also lets a status preview consume a session reset and suppress the switch. So
// an arm asserting "the preview changes nothing" fails with the knob off too,
// and would be a false gate. The claim is differential by nature and is measured
// that way, by flagoff-sweep.mjs over generated fleets.

test('the real paint performs the 5h switch; only the status preview skips it', () => {
  // The docs record the skipped switch as a limitation of the two surfaces, and
  // it holds for one: _render calls the combined clear-AND-switch, so the paint
  // IS the switch, while the preview path clears the window through the
  // availability read and never reaches the switch at all. The sentence
  // describing that is gated here rather than left to be read against the code.
  function fleet() {
    const am = mgr(['cur', 'reset'], ON);
    const now = Date.now();
    bucket(am, 0, 'unified7d', 0.5, 200, now);
    bucket(am, 1, 'unified7d', 0.5, 20, now);   // its weekly expires sooner
    assert.equal(am.setCurrentAccount(0), true);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = now - 1000;   // the reset the switch acts on
    return am;
  }

  const painted = fleet();
  const tui = new TUI({
    accountManager: painted, config: { accounts: [], routes: [], blockedModels: [], proxy: { port: 1 } },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { tui._render(true); } finally { process.stdout.write = write; }
  assert.equal(painted.accounts[painted.currentIndex].name, 'reset',
    'the paint did not run the switch its own refresh call performs');
  assert.equal(painted.accounts[1].quota.unified5h, null, 'the paint did not clear the expired window');

  const previewed = fleet();
  for (const a of previewed.accounts) previewed._isNearQuota(a, null);
  assert.equal(previewed.accounts[previewed.currentIndex].name, 'cur',
    'the preview ran a switch the documented limitation says it skips');
  assert.equal(previewed.accounts[1].quota.unified5h, null, 'the preview did not clear the expired window');
});

test('a repaint takes no reading, so it cannot spend the roll of the account it leaves', () => {
  // TUI._render calls the refresh with no request arguments, every few seconds
  // idle and twice a second under load, and the 5h switch inside it can move the
  // cursor, as it does with the knob off. What it must not do is take a READING,
  // because nothing arrived anywhere: a paint is not a place a reading is taken
  // from.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');

  rollWindow(am, 0);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  // The paint the TUI makes before any of this reaches a request. It may move
  // the cursor; it may not touch what the cursor was reading.
  const before = am._currentObs.windows.get('unified7d');
  am.refreshExpiredQuotas();
  assert.equal(am._currentObs.idx, 0, 'the paint re-read the account it switched to');
  assert.equal(am._currentObs.windows.get('unified7d'), before,
    'the paint advanced the reading of the account it left');
  // And the roll is still there for the next request to find.
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the paint spent the roll of the account it moved off');
});

test('leaving because an account is unavailable does not spend its roll', () => {
  // The availability gate sits BEFORE the rollover question, and there is
  // nothing to discharge: skipping an unavailable account writes nothing, and
  // the reading is still there when the traffic returns.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');

  // a rolls AND goes over its 5h gate in the same instant, so the walk skips it
  // on availability before it ever asks about the roll.
  rollWindow(am, 0);
  am.accounts[0].quota.unified5h = 0.99;

  const first = am.getActiveAccount(null, OPUS);
  assert.notEqual(first.name, 'a', 'the unavailable account should have been left');

  // a becomes usable again and the retry falls back onto it.
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.accounts[2].quota.unified7d = 0.4;

  assert.notEqual(serve(am, null, OPUS).name, 'a',
    'the fail-back onto the rolled account adopted its new week');
});

test('the session-reset switch routes by the request\'s own window', () => {
  // `model` has to be consulted at every one of the switch's decision points —
  // availability, ranking and band membership — or a Fable request is handed an
  // account the Fable picker excludes. Threading a parameter is not using it.
  const am = mgr(['cur', 'reset'], ON);
  const now = Date.now();
  // cur is fine for Fable. The account whose 5h just reset is NOT: its Fable
  // weekly is spent, though its shared weekly looks the better buy.
  bucket(am, 0, 'unified7dFable', 0.10, 50, now);
  bucket(am, 0, 'unified7d', 0.50, 50, now);
  bucket(am, 1, 'unified7dFable', 0.99, 40, now);
  bucket(am, 1, 'unified7d', 0.10, 40, now);
  assert.equal(am.setCurrentAccount(0), true);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = now - 1000;

  // A Fable request drives the refresh, so the switch is asked about Fable.
  am.refreshExpiredQuotas(FABLE);
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'the switch installed an account the Fable picker excludes');
});

test('the session-reset switch admits on the order the pick uses', () => {
  // Model-scoped availability beside an admission test and a tiebreak reading
  // the raw shared weekly would admit or refuse a Fable request on a clock
  // nothing else in the decision consulted. Here the Fable order is the same in
  // both runs and only the shared clocks differ; a model-aware switch cannot
  // tell them apart.
  function fleetWith(sharedOnReset) {
    const am = mgr(['cur', 'reset'], ON);
    const now = Date.now();
    // cur's shared weekly expires EARLY and its Fable weekly LATE; the candidate
    // is the other way round, so the two clocks order the pair oppositely.
    bucket(am, 0, 'unified7d', 0.5, 100, now);
    bucket(am, 0, 'unified7dFable', 0.5, 300, now);
    bucket(am, 1, 'unified7d', 0.5, sharedOnReset, now);
    bucket(am, 1, 'unified7dFable', 0.5, 10, now);
    assert.equal(am.setCurrentAccount(0), true);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = now - 1000;
    assert.equal(am._rankedReset(am.accounts[1], FABLE) < am._rankedReset(am.accounts[0], FABLE), true,
      'the fixture must have the candidate ranking first for Fable');
    am.refreshExpiredQuotas(FABLE);
    return am.accounts[am.currentIndex].name;
  }

  // 200h: the candidate's SHARED weekly expires later than cur's, which is the
  // only thing that differs from the run below.
  assert.equal(fleetWith(200), 'reset',
    'the switch refused a candidate its own ranking puts first');
  assert.equal(fleetWith(50), 'reset', 'the aligned control did not switch');
});

test('with the knob OFF the switch is handed no model, whatever the request carries', () => {
  // THE CHEAPEST CONTROL FOR THE DEFAULT-OFF PROMISE, and it needs no base tree:
  // with the knob off the model argument cannot change anything, because the
  // switch is handed none. Threading a request's model through would make its
  // candidate filter `_isAvailable(acc, model)` where base's is
  // `_isAvailable(acc)`, a live routing change on the path that promises none.
  const build = () => {
    const am = mgr(['cur', 'reset'], undefined);
    const now = Date.now();
    bucket(am, 0, 'unified7dFable', 0.10, 50, now);
    bucket(am, 0, 'unified7d', 0.50, 50, now);
    // The reset candidate is spent for FABLE and healthy on the shared weekly,
    // which is the only shape in which the two filters can disagree.
    bucket(am, 1, 'unified7dFable', 0.99, 40, now);
    bucket(am, 1, 'unified7d', 0.10, 40, now);
    assert.equal(am.setCurrentAccount(0), true);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = now - 1000;
    return am;
  };
  const cursorAfter = model => {
    const am = build();
    am.refreshExpiredQuotas(model);
    return am.accounts[am.currentIndex].name;
  };
  assert.equal(cursorAfter(undefined), cursorAfter(FABLE),
    'the knob-off switch behaved differently for a Fable request than for none');
  assert.equal(cursorAfter(null), cursorAfter(FABLE),
    'the knob-off switch consulted the model it was handed');
  // And it agrees with the knob-off behaviour: the switch takes the account
  // whose weekly expires sooner, unfiltered by family.
  assert.equal(cursorAfter(FABLE), 'reset');
});

test('an all-clockless fleet still ranks by the discovery bias, not by load', () => {
  // The band returns passthrough when nothing has a measured pressure, and
  // reading that as "nothing to hold off" would zero the whole term, letting the
  // 95%-spent account win on session count by the one route that empties the
  // band rather than filling it.
  const am = mgr(['spent-clockless', 'ample-clockless'], ON, { distributeSessions: true });
  for (const i of [0, 1]) {
    am.accounts[i].quota.unified7d = 0.10;
    am.accounts[i].quota.unified7dReset = null;   // no clock anywhere in the fleet
    am.accounts[i].quota.unified5h = 0.1;
    am.accounts[i].probing = false;
  }
  am.accounts[0].quota.unified7dFable = 0.95;
  am.accounts[1].quota.unified7dFable = 0.05;

  am.beginSession('s1');
  am.recordSession('s1', 1, FABLE);
  assert.equal(am._pickLeastLoaded(null, FABLE).name, 'ample-clockless',
    'a measured 95%-spent account won on session count with no clock in the fleet');
  am.endSession('s1');
});

// ---------------------------------------------------------------------------
// Every site that MOVES a request off an account answers for what it was owed
// ---------------------------------------------------------------------------

test('the 5h session-reset switch cannot spend the roll of the account it leaves', () => {
  // A MOVER THAT NEVER MENTIONS A ROLLOVER. It runs from refreshExpiredQuotas at
  // the head of selection, so it can take a request off a current account whose
  // weekly window has just rolled, before the walk has looked at it once. It is
  // an aim: the reading was taken at the top of this pass, before the switch
  // ran, and the switch does not touch it.
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

  const first = am.getActiveAccount(null, OPUS);
  assert.equal(first.name, 'b', 'the session reset should have moved the request to b');

  // b is refused and c is over threshold, so the retry falls back onto a.
  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.accounts[2].quota.unified7d = 0.4;

  assert.notEqual(serve(am, null, OPUS).name, 'a',
    'the reset switch spent the roll of the account it moved the request off');
});

test('the requalification rerank cannot spend the roll of the account it leaves', () => {
  // A SECOND MOVER THAT IS NOT A DETECTOR: it reranks and RETURNS before the
  // rollover branch runs, so the response that teaches an account its quota can
  // be the same response that reveals its window rolled. `requalify` is what
  // updateQuota sets when a probed account's weekly limit becomes known.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(am.setCurrentAccount(0), true);
  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');

  rollWindow(am, 0);
  am.accounts[0].requalify = true;

  const first = am.getActiveAccount(null, OPUS);
  assert.notEqual(first.name, 'a', 'the rerank should have moved the request off a');

  am.accounts[2].quota.unified7d = 0.99;
  const retry = am.getActiveAccount(new Set([first.index]), OPUS);
  assert.equal(retry.name, 'a', 'the retry should have fallen back onto the rolled account');
  am.accounts[2].quota.unified7d = 0.4;

  assert.notEqual(serve(am, null, OPUS).name, 'a',
    'the rerank spent the roll of the account it moved the request off');
});


test('a knob toggled mid-request cannot leave a roll half-answered', () => {
  // The reload arrives between the preemption and the retry its destination
  // forced. Turning the knob off drops every observation, so the retry and the
  // request after it are measured from what the accounts present when the knob
  // comes back rather than from a reading nothing was watching over. Nothing
  // travels with a request, so the toggle resets the comparison and the traffic
  // stays where the retry left it.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  const first = serve(am, 's1', OPUS);
  const other = 1 - first.index;
  rollWindow(am, first.index);

  am.beginSession('s1');
  const sent = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(sent.index, other, 'the rollover did not preempt');
  am.recordSession('s1', sent.index, OPUS);

  am.setExpiryRouting({ enabled: false });
  am.setExpiryRouting(ON);

  const retry = am.getActiveAccount(new Set([other]), OPUS, null, 's1');
  assert.equal(retry.index, first.index, 'the retry did not fall back');
  am.recordSession('s1', retry.index, OPUS);
  am.endSession('s1');

  // No observation survived the toggle, so the next request takes a first sight
  // of the account it finds the pin on and stays there. It does NOT thrash, and
  // it does not act on a roll it has no record of.
  assert.equal(serve(am, 's1', OPUS).index, first.index,
    'a roll no observation remembered moved the traffic anyway');
  // The next roll after the knob came back is caught, so the toggle reset the
  // comparison rather than silencing it.
  rollWindow(am, first.index);
  assert.equal(serve(am, 's1', OPUS).index, other,
    'the first roll after the toggle was missed');
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
