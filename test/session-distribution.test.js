import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { SessionTracker } from '../src/session-tracker.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function mgr(names, opts = {}) {
  return new AccountManager(names.map((n) => oauth(n)), 0.98, opts);
}

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

// Set an account's shared and Fable weekly buckets: [used, hours-to-reset].
function weekly(am, index, shared, fable) {
  const now = Date.now();
  const q = am.accounts[index].quota;
  q.unified7d = shared[0];
  q.unified7dReset = now + shared[1] * H;
  q.unified7dFable = fable[0];
  q.unified7dFableReset = now + fable[1] * H;
  am.accounts[index].probing = false;
}

test('distribution off: session id does not change quota-driven selection', () => {
  const am = mgr(['a', 'b']); // distributeSessions defaults false
  // Two different sessions both land on the current account (index 0), as before.
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  const s2 = am.getActiveAccount(null, null, null, 'sess-2');
  assert.equal(s1.name, 'a');
  assert.equal(s2.name, 'a');
});

test('distribution on: a new session goes to the least-loaded account', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  // Session 1 routes and is recorded on 'a'.
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  assert.equal(s1.name, 'a');
  // Session 2, now that 'a' carries an active session, should spill to 'b'.
  const s2 = am.getActiveAccount(null, null, null, 'sess-2');
  assert.equal(s2.name, 'b');
});

test('distribution on: an existing session stays pinned to its account (cache affinity)', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const first = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', first.index);
  // Load up 'b' with two other sessions so it is now the busier account.
  am.recordSession('sess-x', 1);
  am.recordSession('sess-y', 1);
  // sess-1 must still return its original account, not the (now) less-loaded one.
  const again = am.getActiveAccount(null, null, null, 'sess-1');
  assert.equal(again.index, first.index);
});

test('distribution on: three sessions spread across three accounts', () => {
  const am = mgr(['a', 'b', 'c'], { distributeSessions: true });
  const seen = new Set();
  for (const sid of ['s1', 's2', 's3']) {
    const acc = am.getActiveAccount(null, null, null, sid);
    am.recordSession(sid, acc.index);
    seen.add(acc.name);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('distribution on: priority still wins over session load-balancing', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 1 }), // less preferred
  ], 0.98, { distributeSessions: true });
  // Even as 'a' accrues sessions, new sessions stay on the higher-priority 'a'
  // (its whole tier is just one account) rather than spilling to lower-priority 'b'.
  for (const sid of ['s1', 's2', 's3']) {
    const acc = am.getActiveAccount(null, null, null, sid);
    am.recordSession(sid, acc.index);
    assert.equal(acc.name, 'a');
  }
});

test('distribution on: a pinned session whose account is exhausted re-routes', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  am.recordSession('sess-1', 0);
  am.accounts[0].status = 'exhausted'; // 'a' no longer available
  const acc = am.getActiveAccount(null, null, null, 'sess-1');
  assert.equal(acc.name, 'b');
});

test('distribution on: a Fable diversion does not move the session\'s Opus pin', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  // 'a' resets soonest overall, so a new session lands there; its Fable weekly
  // is spent, so only Fable requests have to be served elsewhere.
  weekly(am, 0, [0.1, 50], [0.99, 50]);
  weekly(am, 1, [0.1, 100], [0.1, 100]);

  const opus = am.getActiveAccount(null, OPUS, null, 's1');
  am.recordSession('s1', opus.index, OPUS);
  assert.equal(opus.name, 'a');

  const fable = am.getActiveAccount(null, FABLE, null, 's1');
  am.recordSession('s1', fable.index, FABLE);
  assert.equal(fable.name, 'b', 'Fable must divert off the spent bucket');

  // 'b' was never evaluated for Opus, and its Opus cache is cold.
  const again = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(again.name, 'a', 'the Opus pin followed the Fable diversion');
});

// The advisor sub-inference spends its family's quota on the serving account,
// but selection degrades to executor-only when no account can serve both models
// and upstream then drops the advisor call. Which happened is not visible here,
// so the family is left unclaimed: no Fable pin is recorded. The session's next
// Fable request still stays on the account the session already uses (the
// existing-pin fallback), and moves only once that account cannot serve it.
test('distribution on: an advisor sub-inference does not pin its own family', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  weekly(am, 0, [0.1, 50], [0.1, 50]);
  weekly(am, 1, [0.1, 100], [0.1, 100]);

  const acc = am.getActiveAccount(null, OPUS, FABLE, 's1');
  am.recordSession('s1', acc.index, OPUS);
  assert.equal(acc.name, 'a');
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7dFable'), null, 'the advisor family is not claimed');
  // Load 'a' up: load-balancing alone would send Fable elsewhere, but the
  // session already sits on 'a' and 'a' can serve Fable, so it stays.
  am.recordSession('other-1', 0, FABLE);
  am.recordSession('other-2', 0, FABLE);
  assert.equal(am.getActiveAccount(null, FABLE, null, 's1').name, 'a');
  // Once 'a' cannot serve Fable the unclaimed family routes on its own merits.
  weekly(am, 0, [0.1, 50], [0.99, 50]);
  assert.equal(am.getActiveAccount(null, FABLE, null, 's1').name, 'b');
});

test('distribution on: a pin is not honored when it cannot serve the advisor', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  weekly(am, 0, [0.1, 50], [0.99, 50]); // 'a' cannot serve a Fable advisor
  weekly(am, 1, [0.1, 100], [0.1, 100]);
  am.recordSession('s1', 0, OPUS);
  assert.equal(am.getActiveAccount(null, OPUS, FABLE, 's1').name, 'b');
});

test('distribution on: a session on two families counts as load on both accounts', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s1', 1, FABLE);
  const status = am.getStatus();
  assert.equal(status.sessions.active, 1, 'one session');
  assert.equal(status.accounts[0].sessions, 1);
  assert.equal(status.accounts[1].sessions, 1, 'and it is load on both accounts it is spending');
});

// Route pins are already renumbered on removal; session pins name positions in
// the same list. Left alone, a pin above the removed slot points at the account
// that moved into it, which is a live account the session was never routed to.
test('removing an account moves a session pin instead of handing it to a neighbour', () => {
  const am = mgr(['a', 'b', 'c'], { distributeSessions: true });
  am.recordSession('s1', 1, OPUS); // pinned to 'b'
  am.removeAccount(0);             // 'a' goes away; 'b' and 'c' shift down one
  assert.equal(am.getActiveAccount(null, OPUS, null, 's1').name, 'b');
});

// Three accounts, not two: with only one left after the removal there is a
// single possible answer and the assertion holds whether or not the pin moved.
// Here 'c' resets soonest, so an unpinned session prefers it, while a pin left
// at index 0 would name 'b' once the list shifts.
test('removing the account a session is pinned to drops the pin and re-routes it', () => {
  const am = mgr(['a', 'b', 'c'], { distributeSessions: true });
  weekly(am, 0, [0.1, 90], [0.1, 90]);
  weekly(am, 1, [0.1, 90], [0.1, 90]);
  weekly(am, 2, [0.1, 10], [0.1, 10]);
  am.recordSession('s1', 0, OPUS); // pinned to 'a'
  am.removeAccount(0);             // 'a' goes; 'b' becomes 0, 'c' becomes 1
  assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), null, 'the pin went with the account');
  assert.equal(am.getActiveAccount(null, OPUS, null, 's1').name, 'c', 're-routes on merit, not onto the neighbour');
});

test('getStatus exposes session counts (known/active/perAccount) and the mode flag', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  am.recordSession('s1', 0);
  am.recordSession('s2', 1);
  const status = am.getStatus();
  assert.equal(status.sessions.known, 2);
  assert.equal(status.sessions.active, 2);
  assert.equal(status.sessions.distribute, true);
  assert.equal(status.accounts[0].sessions, 1);
  assert.equal(status.accounts[1].sessions, 1);
});

test('setDistributeSessions applies a config change live', () => {
  const am = mgr(['a', 'b']); // off: both sessions funnel onto the current account
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'a');
  am.setDistributeSessions(true);
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'b');
  am.setDistributeSessions(false); // reload with the field removed disables it
  assert.equal(am.getActiveAccount(null, null, null, 'sess-3').name, 'a');
});

test('a session\'s first request of a second family stays on the account it already uses', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const SONNET = 'claude-sonnet-5';
  const first = am.getActiveAccount(null, OPUS, null, 's1');
  am.recordSession('s1', first.index, OPUS);
  // No Sonnet pin yet. Least-loaded would count s1's own Opus pin as load on
  // `first` and send Sonnet to the sibling; the session must stay put instead.
  assert.equal(am.getActiveAccount(null, SONNET, null, 's1').name, first.name);
});

test('the fallback pin is skipped when that account cannot serve the family', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const first = am.getActiveAccount(null, OPUS, null, 's1');
  am.recordSession('s1', first.index, OPUS);
  // Fable is spent on the pinned account; the request must go elsewhere.
  first.quota.unified7dFable = 0.99;
  first.quota.unified7dFableReset = Date.now() + 24 * H;
  assert.notEqual(am.getActiveAccount(null, FABLE, null, 's1').name, first.name);
});

// ── draining a distribution toggle (on → off) ─────────────────────────────────
// Turning distribution off used to cut every pinned session over to the current
// account on its very next request: each one loses the prompt cache it built on
// its old account, and they all land on one account at once. Draining keeps the
// sessions that already exist on their accounts and only stops distributing NEW
// ones, so affinity winds down as sessions finish instead of snapping.

test('draining: a session pinned before the flip keeps its account', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  const s2 = am.getActiveAccount(null, null, null, 'sess-2');
  am.recordSession('sess-2', s2.index);
  assert.equal(s2.name, 'b');
  am.setDistributeSessions(false);
  // A hard cut would send sess-2 to the current account ('a') and throw away the
  // prompt cache it has on 'b'.
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'b');
  assert.equal(am.getStatus().sessions.draining, 2);
});

test('draining: a session started after the flip is not distributed', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  am.setDistributeSessions(false);
  // With distribution still on this would have spilled to 'b'. Draining protects
  // only the sessions that existed at the flip.
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'a');
});

test('draining: a session whose pinned account is exhausted rejoins normal rotation', () => {
  const am = mgr(['a', 'b', 'c'], { distributeSessions: true });
  am.recordSession('sess-1', 1);          // pinned to 'b'
  am.recordSession('sess-x', 0);          // make 'a' the busiest account so that
  am.recordSession('sess-y', 0);          // least-loaded would pick 'c', not 'a'
  am.setDistributeSessions(false);
  am.accounts[1].status = 'exhausted';    // the pin is no longer usable
  // It has to move regardless, so it moves by the normal walk (current account),
  // not by least-loaded — and it leaves the drain instead of re-checking a dead pin.
  assert.equal(am.getActiveAccount(null, null, null, 'sess-1').name, 'a');
  assert.equal(am.getStatus().sessions.draining, 2);
});

test('draining: re-enabling distribution cancels the drain', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  am.setDistributeSessions(false);
  assert.equal(am.getStatus().sessions.draining, 1);
  am.setDistributeSessions(true);
  const status = am.getStatus();
  assert.equal(status.sessions.draining, 0);
  assert.equal(status.sessions.distribute, true);
});

test('draining: ends once the pre-flip sessions age out', () => {
  let now = 1_000_000;
  const tracker = new SessionTracker({ knownTtlMs: 1000, activeTtlMs: 500, now: () => now });
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98,
    { distributeSessions: true, sessionTracker: tracker });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  am.setDistributeSessions(false);
  assert.equal(am.getStatus().sessions.draining, 1);
  now += 2000; // past the known TTL — the session is forgotten, so nothing to drain
  assert.equal(am.getStatus().sessions.draining, 0);
});

test('setDistributeSessions(false, { drain: false }) cuts over immediately', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  const s2 = am.getActiveAccount(null, null, null, 'sess-2');
  am.recordSession('sess-2', s2.index);
  assert.equal(s2.name, 'b');
  am.setDistributeSessions(false, { drain: false });
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'a');
  assert.equal(am.getStatus().sessions.draining, 0);
});

test('draining: turning distribution off when it was already off starts no drain', () => {
  const am = mgr(['a', 'b']); // never enabled
  am.recordSession('sess-1', 0);
  am.setDistributeSessions(false);
  assert.equal(am.getStatus().sessions.draining, 0);
});
