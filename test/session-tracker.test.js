import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS, SESSION_ACTIVE_TTL_MS } from '../src/session-tracker.js';

// A tracker whose clock we drive by hand.
function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

test('touch records a session and pins it to the serving account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 2, clock.t);
  assert.equal(st.pinnedAccount('s1', clock.t), 2);
  assert.equal(st.pinnedAccount('unknown', clock.t), null);
});

test('a later touch re-pins the session (failover moves it)', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, clock.t);
  st.touch('s1', 3, clock.t);
  assert.equal(st.pinnedAccount('s1', clock.t), 3);
});

test('touch with no session id is a no-op', () => {
  const st = new SessionTracker();
  assert.equal(st.touch(null, 1), null);
  assert.equal(st.touch(undefined, 1), null);
});

test('a session is forgotten after the known (1h) idle window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', clock.t), null);
  assert.equal(st.stats(clock.t).known, 0);
});

test('a session stays known but goes inactive past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 1);
  assert.equal(stats.active, 0);
  assert.equal(st.activeCountFor(1, clock.t), 0);
});

test('an in-flight request keeps a session active well past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 1, clock.t); // routed to account 1
  // A 5-minute completion — far longer than the 2-min active window.
  clock.t += SESSION_ACTIVE_TTL_MS * 3;
  assert.equal(st.stats(clock.t).active, 1, 'still active while in flight');
  assert.equal(st.activeCountFor(1, clock.t), 1, 'still counts as load on its account');
  // Request finishes; recency now governs and it stays active a bit longer.
  st.endRequest('s1', clock.t);
  assert.equal(st.stats(clock.t).active, 1);
  // Then idles out of the active window.
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.stats(clock.t).active, 0);
});

test('an in-flight session is never expired, even past the 1h known window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS * 2; // a 2h+ stream
  assert.equal(st.pinnedAccount('s1', clock.t), 0, 'pin survives while in flight');
  assert.equal(st.stats(clock.t).known, 1);
  // Only after it finishes and idles out does it get forgotten.
  st.endRequest('s1', clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', clock.t), null);
});

test('concurrent requests on one session balance in/out via inFlight', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.beginRequest('s1', clock.t);
  st.touch('s1', 2, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  st.endRequest('s1', clock.t); // one still in flight
  assert.equal(st.activeCountFor(2, clock.t), 1);
  st.endRequest('s1', clock.t); // now idle
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('activeCountFor counts only recently-active sessions on that account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, clock.t);
  st.touch('b', 0, clock.t);
  st.touch('c', 1, clock.t);
  assert.equal(st.activeCountFor(0, clock.t), 2);
  assert.equal(st.activeCountFor(1, clock.t), 1);
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('stats reports known, active, and per-account active distribution', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, clock.t);
  st.touch('b', 0, clock.t);
  st.touch('c', 1, clock.t);
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 3);
  assert.equal(stats.active, 3);
  assert.deepEqual(stats.perAccount, { 0: 2, 1: 1 });
});

test('stats sweeps forgotten sessions out of the map', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('old', 0, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('new', 1, clock.t);
  st.stats(clock.t);
  assert.equal(st.sessions.has('old'), false);
  assert.equal(st.sessions.has('new'), true);
});
