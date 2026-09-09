import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const H = 3600_000;
const WEEK = 7 * 24 * H;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const GPT = 'gpt-5.6-sol';

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

// A Codex subscription. The provider partition makes currentIndex a slot one
// fleet owns and the other BORROWS, which the borrowed-cursor arms below turn on.
function codexAccount(name) {
  return { ...oauth(name), provider: 'codex', accountId: 'acct-' + name };
}

// A shared API key. Only subscriptions are partitioned, so a key declaring no
// provider is eligible for either app's traffic while reading as the default.
function sharedKey(name) {
  return { name, type: 'apikey', apiKey: 'k-' + name };
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

// A request's exclusion set, empty. With the knob on the refresh spends a session
// reset only for a caller carrying one; a call without it runs no switch.
const asRequest = () => new Set();

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

test('a retry re-entering past a session pin leaves the pin\'s reading on the account that rolled', () => {
  // The pin names the preemption's destination while the pin's reading is still
  // on the account that rolled. A retry failing over FROM it takes no reading.
  const am = mgr(['a', 'b', 'c'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);

  am.beginSession('s1');
  const moved = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(moved.name, 'b', 'the rollover did not move the pin to b');
  am.recordSession('s1', moved.index, OPUS);
  // The destination refuses, so the same request re-enters with it tried.
  const back = am.getActiveAccount(new Set([moved.index]), OPUS, null, 's1');
  assert.equal(back.name, 'c', 'the refusal did not fall back off the pinned destination');
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').idx, 0,
    'the pin\'s reading was taken on the account the request was refused by');

  am.recordSession('s1', back.index, OPUS);
  am.endSession('s1');
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').idx, 0,
    'the pin\'s reading left the account that rolled');
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

test('a retry re-entering past the current account leaves the reading on the account that rolled', () => {
  // The cursor sits on the preemption's destination while the reading is still on
  // the account that rolled, which is the state the fail-back's protection needs.
  const am = mgr(['a', 'b', 'c'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 20);
  bucket(am, 2, 'unified7d', 0.4, 30);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  assert.equal(am.getActiveAccount(null, OPUS, null, null).name, 'b',
    'the rollover did not preempt');
  // The destination refuses, so the same request re-enters with it tried.
  assert.equal(am.getActiveAccount(new Set([1]), OPUS, null, null).name, 'c',
    'the refusal did not fall back off the destination');

  assert.equal(am._currentObs.idx, 0,
    'the reading was taken on the account the request was refused by');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the roll is no longer read on the account that rolled');
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
    'the retry was read as a confirmed stay and spent the roll');
});

test('a stay a second request confirms releases the roll it was pushed off', () => {
  // The held roll is the fail-back's protection and nothing more. Holding it past
  // a confirmed stay would preempt off that account every time traffic returned.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  assert.equal(serve(am, null, OPUS).name, 'b', 'the rollover did not preempt');
  // The preemption AIMED at b, so the next request is the first to rest there and
  // the one after confirms. `serve()` drives no response, so this spells it out.
  assert.equal(serve(am, null, OPUS).name, 'b', 'the first request did not rest on b');
  const carried = am.observedGeneration(null, OPUS);
  assert.equal(serve(am, null, OPUS).name, 'b', 'the second request did not rest on b');
  am.confirmStay(am.accounts[1], carried, null, 'anthropic');

  // b is out of the way, so the traffic comes back to a on its own.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1]) }).name, 'a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), false,
    'a roll the fleet already moved off was charged a second time');
  assert.equal(serve(am, null, OPUS).name, 'a',
    'the return to an escaped roll preempted off it again');
});

test('a success on a borrowed cursor does not release the roll its owner holds', () => {
  // currentIndex is ONE slot every provider shares. A borrower hands the INDEX
  // back but not the observation, which the walk left naming its own account.
  const am = new AccountManager(
    [codexAccount('c'), codexAccount('c2'), oauth('a')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The opening placement a daemon launch makes, so the codex fleet owns the cursor.
  am.selectActiveAccount();

  const codexReq = (exclude = null) => am.getActiveAccount(exclude, GPT, null, null, 'codex');
  const claudeReq = () => am.getActiveAccount(null, OPUS, null, null, 'anthropic');

  assert.equal(codexReq().name, 'c', 'the fixture must start on c');
  rollWindow(am, 0);
  assert.equal(codexReq().name, 'c2', 'the roll did not preempt off c');
  // The first request to REST on c2, which is what puts c's roll into the hold.
  assert.equal(codexReq().name, 'c2', 'the preemption did not settle on c2');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on c2 did not hold c\'s roll');

  // Two borrowed requests, each served. The first MOVES the observation onto a
  // and so cannot confirm; the second finds it there and can.
  for (const attempt of ['first', 'second']) {
    const carried = am.observedGeneration(null, OPUS);
    const account = claudeReq();
    assert.equal(account.name, 'a', `the ${attempt} borrowed request left the anthropic account`);
    am.confirmStay(account, carried, null, 'anthropic');
  }
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'a success on the borrowed cursor released the roll its owner was holding');

  // c2 out of the way, so the codex traffic falls back onto c, which still owes.
  assert.equal(codexReq(new Set([1])).name, 'c', 'the fail-back did not reach c');
  assert.equal(am._currentRolledOver(am.accounts[0], GPT), true,
    'the fail-back onto c first-sighted the week c gained');
  assert.equal(codexReq().name, 'c2',
    'the codex request after the fail-back settled on the account its roll pushed it off');
});

test('a borrowed cursor\'s success settles the roll of its own provider', () => {
  // The converse, and why the gate asks which provider a roll belongs to. A
  // cursor test would refuse every confirmation the borrowing fleet ever offers.
  const am = new AccountManager(
    [codexAccount('c'), oauth('a'), oauth('b')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The codex fleet owns the cursor, so every anthropic request below borrows it.
  am.selectActiveAccount();

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');
  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');

  assert.equal(codexReq().name, 'c', 'the fixture must start on c');
  assert.equal(claudeReq().name, 'a', 'the anthropic traffic must start on a');
  rollWindow(am, 1);
  assert.equal(claudeReq().name, 'b', 'the roll did not preempt off a');
  // The first request to REST on b, which is what puts a's roll into the hold.
  assert.equal(claudeReq().name, 'b', 'the preemption did not settle on b');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'resting on b did not hold a\'s roll');

  // The server's handshake spelled out, as above. This one finds the observation
  // already resting on b and is served, and both accounts are anthropic's.
  const carried = am.observedGeneration(null, OPUS);
  const served = claudeReq();
  assert.equal(served.name, 'b', 'the confirming request left b');
  am.confirmStay(served, carried, null, 'anthropic');
  assert.equal(am._currentObs.unescaped, null,
    'the success left its own provider\'s roll owed');

  // b out of the way: the roll is settled, so a is read whole and traffic stays.
  assert.equal(claudeReq(new Set([2])).name, 'a', 'the fail-back did not reach a');
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), false,
    'a roll the traffic already moved off was charged a second time');
  assert.equal(claudeReq().name, 'a',
    'the request after the fail-back preempted off a settled roll');
});

test('a success on a shared key for another provider\'s request leaves the roll held', () => {
  // Only SUBSCRIPTIONS are partitioned, so the account a request landed on says
  // nothing about which fleet it belonged to.
  const am = new AccountManager(
    [oauth('a1'), oauth('a2'), sharedKey('kn')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The anthropic fleet owns the cursor, so the codex request below borrows it.
  am.selectActiveAccount();

  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');
  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');

  assert.equal(claudeReq().name, 'a1', 'the fixture must start on a1');
  rollWindow(am, 0);
  assert.equal(claudeReq().name, 'a2', 'the roll did not preempt off a1');
  // The first request to REST on a2, which is what puts a1's roll into the hold.
  assert.equal(claudeReq().name, 'a2', 'the preemption did not settle on a2');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on a2 did not hold a1\'s roll');

  // The key is the only account the codex fleet has, so its traffic borrows the
  // cursor and lands there. The handshake as above: move, then rest and serve.
  assert.equal(codexReq().name, 'kn', 'the codex request did not reach the shared key');
  const carried = am.observedGeneration(null, GPT);
  const served = codexReq();
  assert.equal(served.name, 'kn', 'the confirming codex request left the shared key');
  am.confirmStay(served, carried, null, 'codex');
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'a codex success released the roll the anthropic fleet was holding');

  // a2 and the key out of the way, so anthropic falls back onto a1, still owed.
  assert.equal(claudeReq(new Set([1, 2])).name, 'a1', 'the fail-back did not reach a1');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the fail-back onto a1 first-sighted the week a1 gained');
  assert.equal(claudeReq().name, 'a2',
    'the anthropic request after the fail-back settled on the account its roll pushed it off');
});

test('a hold one fleet creates on a shared key outlives the other fleet\'s success', () => {
  // The held account is the KEY, which declares no provider and reads as the
  // default while serving either app. Its declaration says nothing about which
  // fleet was pushed off it, so the hold names the fleet whose reading it is.
  const am = new AccountManager(
    [sharedKey('kn'), codexAccount('c'), oauth('a')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The key has the soonest window, so the daemon's opening placement starts there.
  am.selectActiveAccount();

  const codexReq = (exclude = null) => am.getActiveAccount(exclude, GPT, null, null, 'codex');
  // The anthropic subscription is excluded so this traffic reaches the key
  // WITHOUT moving the cursor. A cursor move hands the roll back before any
  // confirmation, which is a different rule than the one under test.
  const claudeReq = () => am.getActiveAccount(new Set([2]), OPUS, null, null, 'anthropic');

  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  rollWindow(am, 0);
  assert.equal(codexReq().name, 'c', 'the key\'s roll did not preempt the codex traffic');
  // The first codex request to REST on c, which is what puts the key's roll
  // into the hold.
  assert.equal(codexReq().name, 'c', 'the preemption did not settle on c');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on c did not hold the key\'s roll');
  assert.equal(am._currentObs.unescaped?.provider, 'codex',
    'the hold does not name the fleet whose reading it preserves');

  // Anthropic traffic now rests on the same key and is served. The first request
  // MOVES the observation onto the key and so cannot confirm; the second rests.
  assert.equal(claudeReq().name, 'kn', 'the anthropic request did not reach the shared key');
  const carried = am.observedGeneration(null, OPUS);
  const served = claudeReq();
  assert.equal(served.name, 'kn', 'the confirming anthropic request left the shared key');
  am.confirmStay(served, carried, null, 'anthropic');
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'an anthropic success released the roll the codex fleet was pushed off');
  assert.equal(am._currentObs.unescaped?.provider, 'codex',
    'the surviving hold no longer names the fleet whose reading it preserves');
});

test('the fleet that created a hold on a shared key settles it with its own success', () => {
  // The converse, and the loss the cursor rule leaves behind: codex traffic can
  // never settle a roll it was pushed off a key that reads as anthropic.
  const am = new AccountManager(
    [sharedKey('kn'), codexAccount('c'), oauth('a')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  am.selectActiveAccount();

  const codexReq = (exclude = null) => am.getActiveAccount(exclude, GPT, null, null, 'codex');

  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  rollWindow(am, 0);
  assert.equal(codexReq().name, 'c', 'the key\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'c', 'the preemption did not settle on c');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on c did not hold the key\'s roll');

  const carried = am.observedGeneration(null, GPT);
  const served = codexReq();
  assert.equal(served.name, 'c', 'the confirming codex request left c');
  am.confirmStay(served, carried, null, 'codex');
  assert.equal(am._currentObs.unescaped, null,
    'the fleet the roll pushed off could not settle it with its own success');

  // c out of the way: the roll is settled, so the key is read whole on return.
  assert.equal(codexReq(new Set([1])).name, 'kn', 'the codex fail-back did not reach the key');
  assert.equal(am._currentRolledOver(am.accounts[0], GPT), false,
    'a roll the codex fleet already settled was charged a second time');
});

test('a roll held at a shared key is settled by any fleet the key serves', () => {
  // A pin is one slot per bucket too, and a session that has served both apps
  // holds a roll one of them was pushed off. The key is the only destination
  // either app has here, so it holds ONE reading for whichever of them it is
  // serving, and the success of the fleet resting there settles the roll the
  // other was pushed off.
  const am = new AccountManager(
    [codexAccount('c'), sharedKey('kn')], 0.98,
    { expiryRouting: ON, distributeSessions: true },
  );
  for (const [i, hours] of [[0, 10], [1, 20]]) bucket(am, i, 'unified7d', 0.4, hours);

  const req = (model, provider) => {
    am.beginSession('s1');
    const account = am.getActiveAccount(null, model, null, 's1', provider);
    if (account) am.recordSession('s1', account.index, model);
    am.endSession('s1');
    return account;
  };
  const held = () => am.sessionTracker.refsFor('s1', 'unified7d').unescaped;

  assert.equal(req(GPT, 'codex').name, 'c', 'the session must start on the codex subscription');
  rollWindow(am, 0);
  assert.equal(req(GPT, 'codex').name, 'kn', 'the roll did not move the pin off c');
  // The first request to REST on the key, which is what puts c's roll into the hold.
  assert.equal(req(GPT, 'codex').name, 'kn', 'the preemption did not settle on the key');
  assert.equal(held()?.idx, 0, 'the fixture must have held c\'s roll on the pin');
  assert.equal(held()?.provider, 'codex', 'the pin\'s hold does not name the fleet it belongs to');

  // The key is the only account anthropic has here, so its traffic rests on the
  // same pin the codex hold hangs off and is served there.
  const carriedClaude = am.observedGeneration('s1', OPUS);
  assert.equal(req(OPUS, 'anthropic').name, 'kn', 'the anthropic request left the shared key');
  am.confirmStay(am.accounts[1], carriedClaude, 's1', 'anthropic');
  assert.equal(held(), null,
    'an anthropic success at the shared key did not settle the roll the codex fleet was pushed off');
});

test('a roll no borrowing fleet can ever settle is released by the fleet that owns the destination', () => {
  // The destination is a subscription the holding fleet is never routed to, so
  // no success of that fleet can arrive there to settle the roll. Refusing the
  // only fleet that can be served there would hold it until the window rolls
  // again. The stamp is untouched; what changed is who the release accepts.
  const am = new AccountManager(
    [sharedKey('kn'), oauth('a'), codexAccount('c')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');
  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');

  // No opening placement: the first codex request establishes the reading, so
  // the hold the anthropic escape creates is the codex fleet's.
  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  assert.equal(am._currentObs.provider, 'codex', 'the reading on the key is not the codex fleet\'s');
  assert.equal(claudeReq().name, 'kn', 'the anthropic request did not rest on the same key');

  rollWindow(am, 0);
  assert.equal(claudeReq().name, 'a', 'the key\'s roll did not preempt the anthropic traffic');
  assert.equal(claudeReq().name, 'a', 'the preemption did not settle on a');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on a did not hold the key\'s roll');
  assert.equal(am._currentObs.unescaped?.provider, 'codex',
    'the hold does not name the fleet whose reading it preserves');

  const carried = am.observedGeneration(null, OPUS);
  const served = claudeReq();
  assert.equal(served.name, 'a', 'the confirming anthropic request left a');
  am.confirmStay(served, carried, null, 'anthropic');
  assert.equal(am._currentObs.unescaped, null,
    'the owner\'s success did not settle the roll it was pushed off');
});

test('a roll the fleet that owns the destination was pushed off is settled by its own success', () => {
  // The mirror of the arm above and its discriminator: the same fixture with the
  // fleets the other way round leaves the hold naming the fleet the destination
  // does serve, so the ordinary rule already releases it. A release rule that
  // read the stamp rather than the destination would move this one too.
  const am = new AccountManager(
    [sharedKey('kn'), oauth('a'), codexAccount('c')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');
  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');

  assert.equal(claudeReq().name, 'kn', 'the anthropic fixture must start on the shared key');
  assert.equal(am._currentObs.provider, 'anthropic',
    'the reading on the key is not the anthropic fleet\'s');
  assert.equal(codexReq().name, 'kn', 'the codex request did not rest on the same key');

  rollWindow(am, 0);
  // The key is in the tried set, so no rest of the owner's precedes the escape.
  assert.equal(claudeReq(new Set([0])).name, 'a', 'the key\'s roll did not push the owner onto a');
  assert.equal(claudeReq(new Set([0])).name, 'a', 'the escape did not settle on a');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'resting on a did not hold the key\'s roll');
  assert.equal(am._currentObs.unescaped?.provider, 'anthropic',
    'the hold does not name the fleet whose reading it preserves');

  const carried = am.observedGeneration(null, OPUS);
  const served = claudeReq(new Set([0]));
  assert.equal(served.name, 'a', 'the confirming anthropic request left a');
  am.confirmStay(served, carried, null, 'anthropic');
  assert.equal(am._currentObs.unescaped, null,
    'the fleet the roll pushed off could not settle it with its own success');
});

test('a roll held at a shared key is settled by the fleet that rests there', () => {
  // The cursor leg of the pin arm above. The destination is a key both fleets
  // are served at, so the reading there is nobody's alone: the fleet resting on
  // it settles the roll the other was pushed off, and the fail-back finds its
  // origin whole.
  const am = new AccountManager(
    [sharedKey('kn1'), sharedKey('kn2'), codexAccount('c')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');
  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');

  // No opening placement: the codex request establishes the reading on the first
  // key, so the roll it is pushed off names the codex fleet.
  assert.equal(codexReq().name, 'kn1', 'the codex fixture must start on the first key');
  assert.equal(claudeReq().name, 'kn1', 'the anthropic traffic did not rest on the same key');

  rollWindow(am, 0);
  assert.equal(claudeReq().name, 'kn2', 'the key\'s roll did not preempt onto the second key');
  assert.equal(claudeReq().name, 'kn2', 'the preemption did not settle on the second key');
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'resting on the second key did not hold the first key\'s roll');
  assert.equal(am._currentObs.unescaped?.provider, 'codex',
    'the hold does not name the fleet whose reading it preserves');

  const carried = am.observedGeneration(null, OPUS);
  const served = claudeReq();
  assert.equal(served.name, 'kn2', 'the confirming anthropic request left the second key');
  am.confirmStay(served, carried, null, 'anthropic');
  assert.equal(am._currentObs.unescaped, null,
    'a confirmed stay at a key both fleets reach did not settle the roll');

  // The roll is settled, so the origin is read whole on return.
  assert.equal(claudeReq(new Set([1])).name, 'kn1', 'the fail-back did not reach the first key');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), false,
    'a roll the shared key already settled was charged a second time');
});

test('removing an account renumbers a held roll without changing whose it is', () => {
  // The renumbering is nobody's success, so it settles nothing: a hold that came
  // back naming no fleet could never be settled by the one it was taken for.
  const am = new AccountManager(
    [oauth('a'), sharedKey('kn'), codexAccount('c')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 40], [1, 10], [2, 20]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The key's window is the soonest, so the opening placement starts there and
  // `a` sits out of the way with the furthest one.
  am.selectActiveAccount();

  const codexReq = (exclude = null) => am.getActiveAccount(exclude, GPT, null, null, 'codex');

  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  rollWindow(am, 1);
  assert.equal(codexReq().name, 'c', 'the key\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'c', 'the preemption did not settle on c');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'resting on c did not hold the key\'s roll');

  am.removeAccount(0);
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'the held roll did not follow the key to its new index');
  assert.equal(am._currentObs.unescaped?.provider, 'codex',
    'the renumbering dropped the fleet the held roll belongs to');
});

test('removing the account the reading rests on keeps every other roll', () => {
  // The removal settles the roll of the account that went away and no other, so
  // what the reading was holding for the rest is still owed to them. It moves
  // onto a reading that names nobody, which is where a fail-back finds it.
  // Windows far enough apart that each roll has one destination, so the chain
  // below is deterministic: a2's roll held over a1's, with the reading on a3.
  const am = mgr(['a1', 'a2', 'a3', 'a4'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30], [3, 40]]) bucket(am, i, 'unified7d', 0.4, hours);
  assert.equal(serve(am, null, OPUS).name, 'a1', 'the fixture must start on a1');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'a2', 'a1\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a2', 'the preemption did not settle on a2');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'a3', 'a2\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a3', 'the second preemption did not settle on a3');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'the fixture must hold a2\'s roll');
  assert.equal(am._currentObs.unescaped?.prev?.idx, 0, 'the fixture must hold a1\'s roll under it');

  am.removeAccount(2);
  assert.notEqual(am._currentObs, null, 'removing the resting account discarded the whole chain');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'a2\'s held roll did not survive the removal');
  assert.equal(am._currentObs.unescaped?.prev?.idx, 0, 'a1\'s held roll did not survive the removal');

  // a4 inherited the removed slot and is excluded, so the traffic reaches a1
  // through a cursor move and never rests on the account it came from.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a1',
    'the forced fail-back did not reach a1');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the fail-back onto a1 did not find the week a1 gained still held');
});

test('removing an account no roll was taken on leaves the chain where it is', () => {
  // The bystander case, and the discriminator for the arm above: the reading
  // still names the account it rests on, so nothing about the chain moves.
  // Windows far enough apart that each roll has one destination, so the chain
  // below is deterministic: a2's roll held over a1's, with the reading on a3.
  const am = mgr(['a1', 'a2', 'a3', 'a4'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30], [3, 40]]) bucket(am, i, 'unified7d', 0.4, hours);
  assert.equal(serve(am, null, OPUS).name, 'a1', 'the fixture must start on a1');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'a2', 'a1\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a2', 'the preemption did not settle on a2');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'a3', 'a2\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a3', 'the second preemption did not settle on a3');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'the fixture must hold a2\'s roll');
  assert.equal(am._currentObs.unescaped?.prev?.idx, 0, 'the fixture must hold a1\'s roll under it');

  am.removeAccount(3);
  assert.notEqual(am._currentObs, null, 'removing a bystander discarded the whole chain');
  assert.equal(am._currentObs.unescaped?.idx, 1,
    'a2\'s held roll did not survive a bystander\'s removal');
  assert.equal(am._currentObs.unescaped?.prev?.idx, 0,
    'a1\'s held roll did not survive a bystander\'s removal');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a1',
    'the forced fail-back did not reach a1');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the fail-back onto a1 did not find the week a1 gained still held');
});

test('the account a removal clamps the cursor onto is handed the roll it is owed', () => {
  // The clamp takes the account the cursor rested on, so the account it lands on
  // is an arrival: every other arrival is offered whatever the chain still holds
  // for it. Unoffered, the roll is charged a second time the next time traffic
  // rests there.
  const am = mgr(['p', 'q', 'r', 's'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30], [3, 40]]) bucket(am, i, 'unified7d', 0.4, hours);
  assert.equal(serve(am, null, OPUS).name, 'p', 'the fixture must start on p');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'q', 'p\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'q', 'the preemption did not settle on q');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'r', 'q\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'r', 'the second preemption did not settle on r');
  rollWindow(am, 2);
  assert.equal(serve(am, null, OPUS).name, 's', 'r\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 's', 'the third preemption did not settle on s');
  assert.equal(am._currentObs.unescaped?.idx, 2, 'the fixture must hold r\'s roll');

  // s goes away and the cursor has nothing above it to move to, so it clamps
  // back onto r: an arrival no selection made.
  am.removeAccount(3);
  assert.equal(am._currentObs?.idx, 2,
    'the cursor clamped onto r without being handed the reading r is owed');
  assert.equal(am._currentRolledOver(am.accounts[2], OPUS), true,
    'the account the clamp landed on did not find the week it gained still held');
  assert.equal(serve(am, null, OPUS).name, 'p',
    'the fleet parked on the account whose window had just rolled');
});

test('the account a removal shifts under the cursor is handed a reading of its own', () => {
  // The same arrival with the clamp not involved: the removal takes the account
  // the cursor rested on from the middle of the list, so the cursor index is
  // unchanged and a4 inherits the slot a3 left. Nothing is owed to a4 on the
  // chain, so what the arrival owes it is a reading of its own -- left nameless,
  // the reading would answer for a4 with evidence taken on a3.
  const am = mgr(['a1', 'a2', 'a3', 'a4'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30], [3, 40]]) bucket(am, i, 'unified7d', 0.4, hours);
  assert.equal(serve(am, null, OPUS).name, 'a1', 'the fixture must start on a1');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'a2', 'a1\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a2', 'the preemption did not settle on a2');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'a3', 'a2\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'a3', 'the second preemption did not settle on a3');
  assert.equal(am.currentIndex, 2, 'the fixture must rest on a3');

  am.removeAccount(2);
  assert.equal(am.accounts[2].name, 'a4', 'a4 did not inherit the slot a3 left');
  assert.equal(am._currentObs?.idx, 2,
    'the account that inherited the slot under the cursor was left unnamed by the reading');
});

test('a removal that takes the reading\'s account but not the cursor\'s hands nothing back', () => {
  // A borrowed walk moves the reading without the cursor, so the account a
  // removal takes can be the reading's while the cursor rests where it was.
  // Nobody arrived anywhere: the cursor is on the account it was already on, and
  // the rolls the reading was holding for others are still owed to them. An
  // offer here would hand the cursor's account its own roll back and empty a
  // chain the removal only renumbered.
  const am = new AccountManager(
    [oauth('a'), sharedKey('kn'), codexAccount('c')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 40], [1, 10], [2, 20]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The key's window is the soonest, so the opening placement starts there.
  am.selectActiveAccount();

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');

  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  rollWindow(am, 1);
  assert.equal(codexReq().name, 'c', 'the key\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'c', 'the preemption did not settle on c');
  assert.equal(am._currentObs.unescaped?.idx, 1, 'resting on c did not hold the key\'s roll');
  assert.equal(am.currentIndex, 1,
    'the fixture must leave the cursor on the key the borrowed walk moved past');

  am.removeAccount(2);
  assert.equal(am._currentObs?.idx, null,
    'a removal that only took the reading\'s account stamped the reading onto the cursor\'s');
  assert.equal(am._currentObs?.unescaped?.idx, 1,
    'the roll the reading held for the key was handed back to a key nobody arrived at');
});

test('an arrival a removal makes is offered nothing against a reading that is not its own', () => {
  // The other side of the arm above: here the removal DOES take the account the
  // cursor rested on, so the cursor lands on a new one. But a borrowed walk has
  // carried the reading two accounts further on, so the reading is not that
  // arrival's to be read against: offering it would hand the landed account a
  // roll it is still owed elsewhere and stamp the walk's reading onto an account
  // the walk never reached.
  const am = new AccountManager(
    [oauth('a'), sharedKey('kn'), codexAccount('c1'), codexAccount('c2')], 0.98,
    { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 50], [1, 10], [2, 20], [3, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // The key's window is the soonest, so the opening placement puts the cursor
  // there and the anthropic side never moves it again.
  am.selectActiveAccount();

  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');

  assert.equal(codexReq().name, 'kn', 'the codex fixture must start on the shared key');
  rollWindow(am, 1);
  assert.equal(codexReq().name, 'c1', 'the key\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'c1', 'the preemption did not settle on c1');
  rollWindow(am, 2);
  assert.equal(codexReq().name, 'c2', 'c1\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'c2', 'the second preemption did not settle on c2');
  assert.equal(am._currentObs?.idx, 3, 'the fixture must leave the reading on c2');
  assert.equal(am.currentIndex, 1,
    'the fixture must leave the cursor two accounts behind the reading');

  // kn is the cursor's account, so the cursor lands on c1 -- and the reading
  // still names c2, which is where the walk actually is.
  am.removeAccount(1);
  assert.equal(am.accounts[am.currentIndex].name, 'c1', 'the cursor did not land on c1');
  assert.equal(am._currentObs?.idx, 2,
    'the reading the walk left on c2 was stamped onto the account the cursor landed on');
  assert.equal(am._currentObs?.unescaped?.idx, 1,
    'c1\'s roll was handed back at a removal no traffic arrived at c1 through');
});

test('a borrowed walk\'s confirmed serve at a shared key releases the roll it was holding', () => {
  // A borrower resting on the owner's cursor account writes the OWNER's rolled
  // reading into the hold, so the hold names the owner. The destination is a key
  // both fleets are served at, though, and such a key holds ONE reading for
  // whoever it is serving: the borrower's own confirmed serve there settles the
  // roll the owner was pushed off, exactly as the owner's would.
  const am = new AccountManager(
    [oauth('a1'), sharedKey('kn')], 0.98, { expiryRouting: ON },
  );
  for (const [i, hours] of [[0, 10], [1, 20]]) bucket(am, i, 'unified7d', 0.4, hours);

  const claudeReq = (exclude = null) => am.getActiveAccount(exclude, OPUS, null, null, 'anthropic');
  const codexReq = () => am.getActiveAccount(null, GPT, null, null, 'codex');

  // No opening placement: that would baseline the observation outside a walk and
  // leave it naming no fleet. The first anthropic request establishes it instead.
  assert.equal(claudeReq().name, 'a1', 'the anthropic traffic must start on a1');
  rollWindow(am, 0);
  assert.equal(claudeReq().name, 'kn', 'a1\'s roll did not preempt the anthropic traffic');

  // The key is the only account the codex fleet has, so its request borrows the
  // cursor and is the first to rest on the key, which is what holds a1's roll.
  assert.equal(codexReq().name, 'kn', 'the codex request did not reach the shared key');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'the borrowed walk did not hold a1\'s roll');
  assert.equal(am._currentObs.unescaped?.provider, 'anthropic',
    'the hold names the fleet that wrote it instead of the one whose reading it is');

  // The borrower is served at the key, so its success is evidence about the one
  // reading the key holds. The owner's continuation goes with the roll: once the
  // borrower has settled it there is nothing left for a second success to settle.
  const carriedCodex = am.observedGeneration(null, GPT);
  const servedCodex = codexReq();
  assert.equal(servedCodex.name, 'kn', 'the confirming codex request left the shared key');
  am.confirmStay(servedCodex, carriedCodex, null, 'codex');
  assert.equal(am._currentObs.unescaped, null,
    'a codex success at the key both fleets reach did not settle the roll a1 was pushed off');
});

test('a walk that moves an observation makes the reading its own fleet\'s', () => {
  // The other face of the same rule. A stamp that only fills a blank leaves the
  // reading naming whichever fleet moved it first, so a fleet preempted off a
  // roll of its own could not settle it: the hold would name a fleet whose
  // success is no evidence, and every fail-back would find the roll standing.
  const am = new AccountManager(
    [sharedKey('key'), codexAccount('cx1'), codexAccount('cx2')], 0.98, { expiryRouting: ON },
  );
  for (const [i, used, hours] of [[0, 0.10, 90], [1, 0.50, 10], [2, 0.40, 20]]) {
    bucket(am, i, 'unified7d', used, hours);
  }

  const claudeReq = () => am.getActiveAccount(null, OPUS, null, null, 'anthropic');
  // The key excluded, so the codex walk MOVES the observation rather than resting
  // where the anthropic walk already left it.
  const codexReq = (exclude = new Set([0])) => am.getActiveAccount(exclude, GPT, null, null, 'codex');

  // No opening placement: that would baseline the observation outside a walk and
  // leave it naming no fleet. The key is all the anthropic partition has.
  assert.equal(claudeReq().name, 'key', 'the anthropic traffic must come to rest on the shared key');
  assert.equal(am._currentObs.idx, 0, 'the anthropic walk did not take the reading on the key');
  assert.equal(am._currentObs.provider, 'anthropic',
    'the reading the anthropic walk established names another fleet');

  assert.equal(codexReq().name, 'cx1', 'the codex walk did not move the observation onto cx1');
  assert.equal(am._currentObs.idx, 1, 'the codex walk did not move the reading with the cursor');
  assert.equal(am._currentObs.provider, 'codex',
    'the walk that moved the reading left it naming the fleet it was taken from');

  // cx1 rolls, and the codex fleet is pushed off a roll that is now its own.
  rollWindow(am, 1);
  assert.equal(codexReq().name, 'cx2', 'cx1\'s roll did not preempt the codex traffic');
  assert.equal(codexReq().name, 'cx2', 'the preemption did not settle on cx2');

  const carried = am.observedGeneration(null, GPT);
  const served = codexReq();
  assert.equal(served.name, 'cx2', 'the confirming codex request left cx2');
  am.confirmStay(served, carried, null, 'codex');

  // cx2 out of the way, so the traffic returns to the account it was pushed off.
  assert.equal(codexReq(new Set([0, 2])).name, 'cx1', 'the fail-back did not reach cx1');
  assert.equal(am._currentRolledOver(am.accounts[1], GPT), false,
    'the codex fleet could not settle a roll it was itself pushed off');
});

test('a confirmation that names no fleet settles nothing', () => {
  // The control on the plainest fixture: one provider, one roll, a success that
  // would release it. A caller naming no fleet has not answered which one it is.
  const am = mgr(['a', 'b'], ON);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, null, OPUS).name, 'a');
  rollWindow(am, 0);

  assert.equal(serve(am, null, OPUS).name, 'b', 'the rollover did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the first request did not rest on b');
  const carried = am.observedGeneration(null, OPUS);
  assert.equal(serve(am, null, OPUS).name, 'b', 'the second request did not rest on b');
  am.confirmStay(am.accounts[1], carried, null);
  assert.equal(am._currentObs.unescaped?.idx, 0,
    'a confirmation naming no fleet released the roll anyway');

  // b out of the way, so the traffic comes back to a — still owing its roll.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1]) }).name, 'a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the fail-back found a roll that nothing had settled already released');
  assert.equal(serve(am, null, OPUS).name, 'b',
    'the request after the fail-back stayed on the account the roll pushed it off');
});

test('a second escape does not forget the first roll', () => {
  // Neither preemption is settled, so the fleet is away from both accounts and
  // owes each its own reading. The second escape must not answer for the first:
  // the roll handed back on a fail-back is all that keeps an account from being
  // preempted off the week it just gained, every time traffic returns.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // One fleet throughout, so the opening placement leaving the reading unstamped
  // costs nothing: the first hold takes the fleet that observes the roll.
  am.selectActiveAccount();

  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  // The first request to REST on b, which is what holds a's roll.
  assert.equal(serve(am, null, OPUS).name, 'b', 'the preemption did not settle on b');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c', 'b\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'c', 'the second preemption did not settle on c');

  // b and c out of the way, so the traffic is forced back onto a.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the second escape forgot the roll the first was pushed off');
  assert.equal(serve(am, null, OPUS).name, 'c',
    'the fleet parked on the week a had just gained');

  // The hand-back to a settles nothing for b, which is still owed its own.
  assert.equal(serve(am, null, OPUS, { exclude: new Set([0, 2]) }).name, 'b',
    'the forced fail-back did not reach b');
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), true,
    'handing a its roll back took b\'s with it');

  // The same forced fail-back with one escape outstanding controls for the
  // fixture: what the assertions above measure is the second escape.
  const one = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(one, i, 'unified7d', 0.4, hours);
  one.selectActiveAccount();
  assert.equal(serve(one, null, OPUS).name, 'a', 'the control must start on a');
  rollWindow(one, 0);
  assert.equal(serve(one, null, OPUS).name, 'b', 'the control\'s roll did not preempt');
  assert.equal(serve(one, null, OPUS).name, 'b', 'the control did not settle on b');
  assert.equal(serve(one, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the control\'s fail-back did not reach a');
  assert.equal(one._currentRolledOver(one.accounts[0], OPUS), true,
    'the control lost a\'s roll with nothing else outstanding');
});

test('a fail-back to the account of the most recent escape is still handed its roll', () => {
  // The other end of the chain from the arm above: the newest escape is handed
  // back too, and is not lost to the older one still outstanding.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  am.selectActiveAccount();

  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the preemption did not settle on b');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c', 'b\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'c', 'the second preemption did not settle on c');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([0, 2]) }).name, 'b',
    'the forced fail-back did not reach b');
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), true,
    'the fail-back to the newest escape was handed nothing');
});

test('a confirmed stay settles the roll its own move escaped and no other', () => {
  // A serve at the destination is evidence that the move onto it stuck, and that
  // move escaped one roll. It says nothing about an account the fleet left
  // earlier and has not been back to.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  am.selectActiveAccount();

  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the preemption did not settle on b');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c', 'b\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'c', 'the second preemption did not settle on c');

  // The stamp of the move onto c, read before the request that confirms it.
  const carried = am.observedGeneration(null, OPUS);
  assert.equal(serve(am, null, OPUS).name, 'c', 'the confirming request left c');
  am.confirmStay(am.accounts[2], carried, null, 'anthropic');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([0, 2]) }).name, 'b',
    'the forced fail-back did not reach b');
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), false,
    'a roll the fleet already moved off was charged a second time');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'a stay at c settled a roll that move never escaped');
});

test('a stay confirming a move that escaped nothing settles nothing', () => {
  // An operator's switch mints a stamp of its own without escaping anything, so
  // the roll still outstanding is left at the head of the chain. A serve after
  // it confirms that move, which owes nobody a settlement.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  am.selectActiveAccount();

  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the preemption did not settle on b');

  am.setCurrentAccount(2);
  const carried = am.observedGeneration(null, OPUS);
  assert.equal(serve(am, null, OPUS).name, 'c', 'the confirming request left the switch\'s account');
  am.confirmStay(am.accounts[2], carried, null, 'anthropic');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'a stay confirming a move that escaped nothing released a roll anyway');
});

test('a stay whose stamp the reading has left and returned to settles nothing', () => {
  // The hold belongs to the stamp of the move that made it. Once the reading
  // has moved away and come back, its stamp is a later one, so a confirmation
  // under the old stamp settles nothing.
  const am = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  am.selectActiveAccount();

  assert.equal(serve(am, null, OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the preemption did not settle on b');
  assert.equal(am._currentObs.unescaped?.idx, 0, 'the fixture must hold a\'s roll');

  const carried = am.observedGeneration(null, OPUS);
  am.setCurrentAccount(2);
  am.setCurrentAccount(1);
  assert.notEqual(am._currentObs.gen, carried.current,
    'the arm tests nothing unless the reading actually left b and returned');
  am.confirmStay(am.accounts[1], carried, null, 'anthropic');

  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'a stay under a stamp the reading had left and returned to released a roll anyway');
});

test('a session\'s confirmation releases under the bucket its stamp was taken under', () => {
  // The stamp is read before the walk and the confirmation lands after the
  // response, so a route edit can arrive between them. Resolving the bucket again
  // would settle one this session has no observation under.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  am.setRoutes([{ name: 'fable', match: ['*fable*'], bucket: 'unified7d' }]);
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);

  assert.equal(serve(am, 's1', FABLE).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', FABLE).name, 'b', 'the rollover did not move the pin off a');
  // The first request to REST on b, which is what puts a's roll into the hold.
  assert.equal(serve(am, 's1', FABLE).name, 'b', 'the preemption did not settle on b');
  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').unescaped?.idx, 0,
    'the fixture must have held a\'s roll on the pin');

  // The server's handshake with an operator inside it: the stamp, the request,
  // the route saved while it is upstream, and the confirmation on its response.
  const carried = am.observedGeneration('s1', FABLE);
  assert.equal(serve(am, 's1', FABLE).name, 'b', 'the confirming request left b');
  am.setRoutes([{ name: 'fable', match: ['*fable*'] }]); // the override dropped
  assert.equal(am._weeklyBucketFor(FABLE), 'unified7dFable',
    'the edit did not move the model to another bucket');
  am.confirmStay(am.accounts[1], carried, 's1', 'anthropic');

  assert.equal(am.sessionTracker.refsFor('s1', 'unified7d').unescaped, null,
    'the confirmation settled a bucket resolved after the response instead of the stamp\'s');

  // Opus is governed by the bucket the edit left behind, so it reads what the
  // confirmation settled. b out of the way, the session falls back onto a.
  assert.equal(serve(am, 's1', OPUS, { exclude: new Set([1]) }).name, 'a',
    'the fail-back did not reach a');
  assert.equal(am._pinRolledOver('s1', am.accounts[0], OPUS), false,
    'the fail-back was handed back a roll the confirmation had settled');
  assert.equal(serve(am, 's1', OPUS).name, 'a',
    'the session was preempted off a again for a roll its own stay had settled');
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

test('removing the account a pin\'s reading names keeps the roll it holds', () => {
  // The pin store answers the same question the cursor store does, by different
  // code. The ref names the account that went away, but the roll it holds is
  // another account's and is still owed there, so the ref stays on naming nobody
  // until traffic returning to that account is handed it.
  const am = mgr(['a', 'b', 'c', 'd'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2, 3]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  const ref = () => am.sessionTracker.refsFor('s1', 'unified7d');
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  // One request rests on b, which holds a's roll without confirming the stay.
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the arrival did not settle on b');
  assert.equal(ref()?.unescaped?.idx, 0, 'the fixture must have held a\'s roll on the pin');

  am.removeAccount(1);
  assert.notEqual(ref(), null, 'removing the account the ref names discarded the roll it held');
  assert.equal(ref()?.unescaped?.idx, 0, 'a\'s held roll did not survive the removal');
  // What stays behind names nobody, and a reading of nobody's carries nothing
  // but the rolls: the stamp and the gen of the account that went away would
  // answer a later confirmation as though the reading were still that account's.
  assert.equal(ref()?.idx, null, 'the ref kept naming an account after that account went away');
  assert.equal(ref()?.gen, 0, 'the nameless ref kept the gen of the reading the removal ended');
  assert.equal(ref()?.provider, null,
    'the nameless ref kept the fleet stamp of a reading it no longer holds');

  // The pin went with b, so this request re-routes rather than returning to a
  // pin; the ref is read whatever the pin loop left, which is where a's roll is
  // handed back.
  assert.equal(serve(am, 's1', OPUS, { exclude: new Set([1, 2]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(am._pinRolledOver('s1', am.accounts[0], OPUS), true,
    'the fail-back onto a did not find the week a gained still held');
});

test('a pin ref that stayed on for one roll goes away with it', () => {
  // The other half of the one drop rule the arm above turns on: a ref naming
  // nobody is kept only by what it holds, so once the last roll on it goes with
  // the account it was taken on there is nothing left to be evidence about.
  const am = mgr(['a', 'b', 'c', 'd'], ON, { distributeSessions: true });
  for (const i of [0, 1, 2, 3]) bucket(am, i, 'unified7d', 0.4, 10 + i * 10);
  const ref = () => am.sessionTracker.refsFor('s1', 'unified7d');
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must start on a');
  rollWindow(am, 0);
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the rollover did not move the pin to b');
  assert.equal(serve(am, 's1', OPUS).name, 'b', 'the arrival did not settle on b');
  assert.equal(ref()?.unescaped?.idx, 0, 'the fixture must have held a\'s roll on the pin');

  am.removeAccount(1);
  assert.equal(ref()?.idx, null, 'the ref the removal left behind still names an account');
  am.removeAccount(0);
  assert.equal(ref(), null, 'the ref outlived the one roll that was keeping it');
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

test('removing an account renumbers every roll an observation is holding', () => {
  // The shift reaches the whole chain, not just its newest link: a hold left
  // behind names whichever account inherited the slot, and would be handed back
  // to it on the next fail-back.
  const am = mgr(['a', 'b', 'c', 'd'], ON);
  for (const [i, hours] of [[0, 40], [1, 10], [2, 20], [3, 30]]) bucket(am, i, 'unified7d', 0.4, hours);
  // b has the soonest window, so the opening placement starts there and a sits
  // out of the way with the furthest one, held by nobody when it is removed.
  am.selectActiveAccount();
  assert.equal(serve(am, null, OPUS).name, 'b', 'the fixture must start on b');
  assert.equal(serve(am, null, OPUS).name, 'b', 'the fixture did not rest on b');
  rollWindow(am, 1);
  assert.equal(serve(am, null, OPUS).name, 'c', 'b\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'c', 'the preemption did not settle on c');
  rollWindow(am, 2);
  assert.equal(serve(am, null, OPUS).name, 'd', 'c\'s roll did not preempt');
  assert.equal(serve(am, null, OPUS).name, 'd', 'the second preemption did not settle on d');

  am.removeAccount(0);
  assert.equal(am.accounts[0].name, 'b', 'the removal did not shift the list down');
  assert.equal(serve(am, null, OPUS, { exclude: new Set([0, 2]) }).name, 'c',
    'the forced fail-back did not reach c');
  assert.equal(am._currentRolledOver(am.accounts[1], OPUS), true,
    'the newest held roll did not follow c to its new index');
  assert.equal(serve(am, null, OPUS, { exclude: new Set([1, 2]) }).name, 'b',
    'the forced fail-back did not reach b');
  assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
    'the older held roll did not follow b to its new index');

  // Removing an account the chain DOES name: only its own link goes, and every
  // other escape stands. Above, the removed account was held by nobody.
  const two = mgr(['a', 'b', 'c'], ON);
  for (const [i, hours] of [[0, 10], [1, 20], [2, 30]]) bucket(two, i, 'unified7d', 0.4, hours);
  two.selectActiveAccount();
  assert.equal(serve(two, null, OPUS).name, 'a', 'the second fixture must start on a');
  rollWindow(two, 0);
  assert.equal(serve(two, null, OPUS).name, 'b', 'a\'s roll did not preempt');
  assert.equal(serve(two, null, OPUS).name, 'b', 'the preemption did not settle on b');
  rollWindow(two, 1);
  assert.equal(serve(two, null, OPUS).name, 'c', 'b\'s roll did not preempt');
  assert.equal(serve(two, null, OPUS).name, 'c', 'the second preemption did not settle on c');

  two.removeAccount(1);
  assert.equal(serve(two, null, OPUS, { exclude: new Set([1]) }).name, 'a',
    'the forced fail-back did not reach a');
  assert.equal(two._currentRolledOver(two.accounts[0], OPUS), true,
    'removing the account of one escape took the roll of another with it');
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
// and would be a false gate. Each knob-off arm below is narrower: it names one
// behaviour the disabled path must keep, and fails if this feature reached it.

test('a paint clears the window; with the knob on the switch waits for a request', () => {
  // The two request-less surfaces differ: the preview never reaches the switch,
  // while the paint calls the combined clear-and-switch and takes it when off.
  function fleet(expiry) {
    const am = mgr(['cur', 'reset'], expiry);
    const now = Date.now();
    bucket(am, 0, 'unified7d', 0.5, 200, now);
    bucket(am, 1, 'unified7d', 0.5, 20, now);   // its weekly expires sooner
    assert.equal(am.setCurrentAccount(0), true);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = now - 1000;   // the reset the switch acts on
    return am;
  }
  function paint(am) {
    const tui = new TUI({
      accountManager: am, config: { accounts: [], routes: [], blockedModels: [], proxy: { port: 1 } },
      saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    });
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try { tui._render(true); } finally { process.stdout.write = write; }
  }

  const off = fleet(undefined);
  paint(off);
  assert.equal(off.accounts[off.currentIndex].name, 'reset',
    'the knob-off paint did not run the switch its own refresh call performs');
  assert.equal(off.accounts[1].quota.unified5h, null, 'the knob-off paint did not clear the expired window');

  const on = fleet(ON);
  paint(on);
  assert.equal(on.accounts[1].quota.unified5h, null, 'the paint did not clear the expired window');
  assert.equal(on.accounts[on.currentIndex].name, 'cur',
    'the paint took a routing decision on a reset no request had asked about');
  assert.equal(on.accounts[1].sessionResetPending, true,
    'the paint consumed the event instead of leaving it for a request');
  on.refreshExpiredQuotas(null, asRequest());
  assert.equal(on.accounts[on.currentIndex].name, 'reset',
    'the reset the paint left pending never reached the request');

  // Neither setting lets the preview reach the switch, because it never calls the
  // refresh. The event is not lost: it is recorded and deferred to a request.
  for (const expiry of [undefined, ON]) {
    const previewed = fleet(expiry);
    for (const a of previewed.accounts) previewed._isNearQuota(a, null);
    assert.equal(previewed.accounts[previewed.currentIndex].name, 'cur',
      'the preview ran a switch the documented limitation says it skips');
    assert.equal(previewed.accounts[1].quota.unified5h, null, 'the preview did not clear the expired window');
    previewed.refreshExpiredQuotas(null, asRequest());
    assert.equal(previewed.accounts[previewed.currentIndex].name, 'reset',
      'the reset the preview uncovered never reached the next request');
  }
});

test('a repaint takes no reading, so it cannot spend the roll of the account it leaves', () => {
  // TUI._render calls the refresh with no request arguments, every few seconds
  // idle and twice a second under load. What it must not do on either setting is
  // take a READING: a paint is not a place a reading is taken from.
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

  // A Fable request drives the refresh, so the switch is asked about Fable. The
  // exclusion set is what makes it a request rather than a poll.
  am.refreshExpiredQuotas(FABLE, asRequest());
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
    am.refreshExpiredQuotas(FABLE, asRequest());
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

test('the preview does not mirror the session walk it never consults', () => {
  // A session pin resolves ahead of the non-session walk the preview mirrors, so
  // with distribution on the two can name different accounts.
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a', 'the fixture must pin s1 to a');
  assert.equal(am.setCurrentAccount(1), true, 'the fixture must move the cursor off the pin');
  assert.notEqual(am.previewRouteIndex(OPUS), am.getActiveAccount(null, OPUS, null, 's1').index,
    'the preview answered for a session walk it does not consult');
});

test('the preview names the account the next request would actually get', () => {
  // previewRouteIndex is what the TUI and the status JSON show, and it mirrors
  // both preemptions the non-session walk makes, so an operator sees the truth.
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
