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

// One complete request for `sessionId`: select, record where it was served, and
// end — the order the server does it in.
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

test('two requests in flight leave the rollover owed, in either finishing order', () => {
  // The concurrency half of preempt-exactly-once, and why preemption is a
  // comparison rather than an event. One request is preempted off the rolled
  // account; a sibling has its only destination excluded and comes back to it.
  // Neither SETTLES the traffic anywhere, so neither prices the account, and
  // which response lands first cannot change what the next selection sees.
  for (const order of ['moved-last', 'moved-first']) {
    const am = pinnedFleet(ON);
    const first = serve(am, 's1', OPUS);
    const other = 1 - first.index;
    rollWindow(am, first.index);

    am.beginSession('s1');
    am.beginSession('s1');
    const a1 = am.getActiveAccount(null, OPUS, null, 's1');
    assert.equal(a1.index, other, 'the rollover did not preempt');
    const a2 = am.getActiveAccount(new Set([other]), OPUS, null, 's1');
    assert.equal(a2.index, first.index, 'the sibling did not fall back');

    const moved = () => { am.recordSession('s1', a1.index, OPUS); am.endSession('s1'); };
    const back = () => { am.recordSession('s1', a2.index, OPUS); am.endSession('s1'); };
    for (const t of (order === 'moved-last' ? [back, moved] : [moved, back])) t();

    assert.equal(serve(am, 's1', OPUS).index, other, `order ${order}: the rollover was forgotten`);
  }
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
  // Ranking reads the scoped bucket when it is the one that binds. If the
  // rollover watcher still identifies the window by the shared weekly, the
  // scoped window can gain a full week with no event at all — and the session
  // pinned there goes on spending exactly the quota this feature exists to
  // preserve. Same window for the gate, the ranking and the event, or the
  // feature contradicts itself.
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
// The watcher's vocabulary is the named window, on the write side too
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

// Two requests whose selections straddle a rollover and whose responses land in
// a caller-chosen order. Both selections preempt; neither settles the traffic
// anywhere, so the two runs differ by scheduling alone.
function twoInFlight(order) {
  const am = mgr(['a', 'b'], ON, { distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.4, 10);
  bucket(am, 1, 'unified7d', 0.4, 10);
  assert.equal(serve(am, 's1', OPUS).name, 'a');
  rollWindow(am, 0);

  // R1 selects first, detects the rollover, and is sent off a. Still in flight.
  am.beginSession('s1');
  const r1 = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(r1.name, 'b', 'R1 should have been preempted off the rolled account');

  // R2 selects later and fails over to b, so it retries with b excluded and
  // lands back on a — the fallback that leaves the rollover owed.
  am.beginSession('s1');
  const r2 = am.getActiveAccount(new Set([1]), OPUS, null, 's1');
  assert.equal(r2.name, 'a', 'R2 should have fallen back onto the rolled account');

  const t1 = () => { am.recordSession('s1', r1.index, OPUS); am.endSession('s1'); };
  const t2 = () => { am.recordSession('s1', r2.index, OPUS); am.endSession('s1'); };
  for (const t of (order === 'r1-last' ? [t2, t1] : [t1, t2])) t();
  return am;
}

test('a response from an attempt that settled nothing cannot forget the rollover', () => {
  // Where a request was SERVED is not where selection settled it. A response
  // from an attempt that was preempted, or from one that failed back onto the
  // rolled account, says nothing about that window having become acceptable —
  // and which of them lands first cannot change what the next selection sees.
  for (const order of ['r2-last', 'r1-last']) {
    const am = twoInFlight(order);
    assert.notEqual(serve(am, 's1', OPUS).name, 'a',
      `terminal order ${order}: a response that settled nothing forgot the rollover`);
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
