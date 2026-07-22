import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function mgr(names, opts = {}) {
  return new AccountManager(names.map((n) => oauth(n)), 0.98, opts);
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
