import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, distributionMode } from '../src/account-manager.js';
import { SessionTracker, LOAD_WINDOW_MS, MAX_ROUTED } from '../src/session-tracker.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function mgr(names, opts = {}) {
  const am = new AccountManager(names.map(n => oauth(n)), 0.98, { distributeSessions: 'load', ...opts });
  for (const a of am.accounts) a.probing = false;
  return am;
}

// ── Mode plumbing ───────────────────────────────────────────────────────────

test('distributionMode: "load" is a fourth mode and round-trips', () => {
  assert.equal(distributionMode('load'), 'load');
  assert.equal(distributionMode('LOAD '), 'load');
  assert.equal(distributionMode('adaptive'), 'adaptive');
  assert.equal(distributionMode(true), 'even');
  assert.equal(mgr(['a', 'b']).distributionMode, 'load');
});

// ── Tracker counter ──────────────────────────────────────────────────────────

test('SessionTracker.recentRequestsFor counts routed requests inside the window and forgets older ones', () => {
  let now = 1_000_000;
  const t = new SessionTracker({ now: () => now });
  t.noteRouted(0, now); t.noteRouted(0, now + 1); t.noteRouted(1, now + 2);
  assert.equal(t.recentRequestsFor(0, now + 2), 2);
  assert.equal(t.recentRequestsFor(1, now + 2), 1);
  assert.equal(t.recentRequestsFor(2, now + 2), 0);
  now += LOAD_WINDOW_MS + 5;
  assert.equal(t.recentRequestsFor(0, now), 0, 'entries older than the window are pruned');
  assert.equal(t.recentRequestsFor(1, now), 0);
  t.noteRouted(0, now);
  assert.equal(t.recentRequestsFor(0, now), 1);
  // A partial prune keeps the counts of what remains exact.
  t.noteRouted(1, now + 1000); t.noteRouted(0, now + 2000);
  assert.equal(t.recentRequestsFor(0, now + LOAD_WINDOW_MS + 500), 1, 'only the entry inside the window remains');
  assert.equal(t.recentRequestsFor(1, now + LOAD_WINDOW_MS + 500), 1);
});

test('SessionTracker: the routed ring is bounded and survives a reindex', () => {
  const now = 5_000_000;
  const t = new SessionTracker({ now: () => now });
  for (let i = 0; i < MAX_ROUTED + 10; i++) t.noteRouted(i % 2, now);
  assert.equal(t.recentRequestsFor(0, now) + t.recentRequestsFor(1, now), MAX_ROUTED);
  t.remapAccounts(idx => (idx === 0 ? 7 : null));
  assert.equal(t.recentRequestsFor(7, now), MAX_ROUTED / 2);
  assert.equal(t.recentRequestsFor(1, now), 0, 'entries for a removed account are dropped');
  assert.equal(t.recentRequestsFor(0, now), 0, 'the old index no longer counts');
});

test('SessionTracker.noteRouted ignores a null account', () => {
  const t = new SessionTracker();
  t.noteRouted(null);
  assert.equal(t.recentRequestsFor(0), 0);
});

// ── Placement ───────────────────────────────────────────────────────────────

test('load mode places a new session on the account with the fewest recent requests, not the fewest sessions', () => {
  const am = mgr(['a', 'b', 'c']);
  // One busy session on "a" (100 requests), one quiet session each on "b" (3) and "c" (3).
  am.recordSession('s-a', 0); for (let i = 0; i < 99; i++) am.sessionTracker.noteRouted(0);
  am.recordSession('s-b', 1); for (let i = 0; i < 2; i++) am.sessionTracker.noteRouted(1);
  am.recordSession('s-c', 2); for (let i = 0; i < 2; i++) am.sessionTracker.noteRouted(2);
  am.recordSession('s-c2', 2); // "c" now has MORE sessions than "a", but far fewer requests
  const placed = am.getActiveAccount(null, null, null, 's-new');
  assert.notEqual(placed.name, 'a', 'the account carrying the load is not chosen');
  assert.equal(placed.name, 'b', 'fewest requests wins; among equals the even keys decide (b has fewer sessions than c)');
});

test('load mode keeps the pin: a placed session routes back to its account while it is still busy elsewhere', () => {
  const am = mgr(['a', 'b']);
  const first = am.getActiveAccount(null, null, null, 's-1');
  am.recordSession('s-1', first.index);
  // Pile requests on the other account so load alone would now prefer `first`'s sibling.
  const other = am.accounts.find(a => a.index !== first.index);
  am.recordSession('s-2', other.index);
  for (let i = 0; i < 50; i++) am.sessionTracker.noteRouted(first.index);
  assert.equal(am.getActiveAccount(null, null, null, 's-1').index, first.index, 'existing session stays pinned');
  assert.equal(am.getActiveAccount(null, null, null, 's-3').index, other.index, 'a new one goes to the quieter account');
});

test('load mode: an idle fleet falls through to the even tie-break (every account at zero)', () => {
  const am = mgr(['a', 'b', 'c']);
  const counts = {};
  for (let i = 0; i < 6; i++) {
    const acc = am.getActiveAccount(null, null, null, `s-${i}`);
    am.recordSession(`s-${i}`, acc.index);
    counts[acc.name] = (counts[acc.name] || 0) + 1;
  }
  assert.deepEqual(Object.values(counts).sort(), [2, 2, 2], 'spreads evenly when nothing distinguishes the accounts');
});

test('even mode is unchanged by the routed counter', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  am.recordSession('s-a', 0); for (let i = 0; i < 99; i++) am.sessionTracker.noteRouted(0);
  am.recordSession('s-b1', 1); am.recordSession('s-b2', 1);
  assert.equal(am.getActiveAccount(null, null, null, 's-new').name, 'a', 'even still counts sessions: a has 1, b has 2');
});

test('status reports recentRequests per account in every mode', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  am.recordSession('s-a', 0); am.sessionTracker.noteRouted(0); am.sessionTracker.noteRouted(0);
  am.recordSession('s-b', 1);
  const rows = am.getStatus().accounts;
  assert.equal(rows.find(r => r.name === 'a').recentRequests, 3);
  assert.equal(rows.find(r => r.name === 'b').recentRequests, 1);
});
