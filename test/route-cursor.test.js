import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Account selection keeps one cursor per route rather than a single global one.
// Traffic that alternates between routes (a third-party backend serving its own
// models while Claude accounts serve everything else) would otherwise register
// every request as a rotation: the cursor points at the other route's account,
// that account fails the route check, and selection "switches" away from it. The
// switch arms the storm-control ramp, which caps concurrency to the account it
// lands on — so steady interleaved traffic pins both accounts near the ramp
// floor even though nothing failed over.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}

const SPLIT_ROUTES = [
  { name: 'backend', match: ['k3*'], accounts: ['backend'] },
  { name: 'claude', match: ['*'], accounts: ['a', 'b'] },
];

function split() {
  return new AccountManager([oauth('a'), oauth('b'), apikey('backend', { priority: 100 })], 0.98, {
    routes: SPLIT_ROUTES,
  });
}

/** Run fn with console.log captured; returns the lines it emitted. */
function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test('alternating between routes neither arms the ramp nor logs a rotation', () => {
  const am = split();

  const lines = captureLog(() => {
    for (let i = 0; i < 4; i++) {
      assert.equal(am.getActiveAccount(null, 'k3').name, 'backend');
      assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'a');
    }
  });

  for (const account of am.accounts) {
    assert.equal(account.rampStartedAt, null, `interleaving must not ramp "${account.name}"`);
  }
  assert.deepEqual(lines.filter(l => /Switched to account/.test(l)), []);
});

test('a route keeps serving from its own account while another route moves', () => {
  const am = split();

  assert.equal(am.getActiveAccount(null, 'k3').name, 'backend');
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'a');

  // The Claude route fails over to its second account; the backend route's
  // cursor is independent and must not follow.
  am.setDisabled(0, true);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'b');
  assert.equal(am.getActiveAccount(null, 'k3').name, 'backend');
});

test('failover inside one route still arms the ramp on the account it lands on', () => {
  const am = split();

  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'a');
  am.setDisabled(0, true);

  const lines = captureLog(() => {
    assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'b');
  });

  assert.equal(am.accounts[1].rampStartedAt !== null, true, 'a real failover must ramp its target');
  assert.equal(lines.some(l => /Switched to account "b"/.test(l)), true);
});

test('the first request on a route is not a rotation', () => {
  const am = split();

  const lines = captureLog(() => {
    assert.equal(am.getActiveAccount(null, 'k3').name, 'backend');
  });

  assert.equal(am.accounts[2].rampStartedAt, null, 'nothing failed over — no ramp');
  assert.deepEqual(lines.filter(l => /Switched to account/.test(l)), []);
});
