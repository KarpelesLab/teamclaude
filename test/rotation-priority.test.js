import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Make an account "exhausted" so _selectNext skips it, isolating the priority sort.
function exhaust(am, idx) {
  am.accounts[idx].status = 'exhausted';
}

test('default priority (all 0) preserves the existing selection (first available)', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  // No quota known anywhere → weeklyReset is -Infinity for all, ties on priority 0,
  // so the first available account is chosen, matching pre-priority behavior.
  const next = am._selectNext();
  assert.equal(next.name, 'a');
});

test('lower priority value is preferred over config order', () => {
  const am = new AccountManager([
    oauth('a', { priority: 5 }),
    oauth('b', { priority: 1 }),
    oauth('c', { priority: 3 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('within the same priority, the existing heuristic breaks the tie', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 0 }),
  ], 0.98);
  // Give both a known weekly reset; the sooner-expiring one should win the tie.
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 1000;
  assert.equal(am._selectNext().name, 'b');
});

test('priority is respected even when a higher-priority account is also available', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: -1 }), // most preferred
    oauth('c', { priority: 10 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('exhausted highest-priority account is skipped, next priority wins', () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }),
    oauth('b', { priority: 2 }),
  ], 0.98);
  exhaust(am, 0);
  assert.equal(am._selectNext().name, 'b');
});
