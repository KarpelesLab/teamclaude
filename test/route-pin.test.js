import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Ephemeral per-route manual pins (distinct from the keep-warm account pin in
// account-pin.test.js): a pin biases selection for a route's models while the
// pinned account is eligible, and falls back to best-available otherwise.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('a route pin biases getActiveAccount toward the pinned account for matching models', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  // Without a pin, selection lands on the default (index 0).
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');

  assert.deepEqual(am.setRoutePin('bulk', 1), { ok: true });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'b'); // pin wins
  // A model the route does NOT match is unaffected by the pin.
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'a');
});

test('a pinned account that is ineligible falls back to best-available', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('bulk', 1);
  // b's shared 5h bucket is spent → ineligible for everything.
  am.accounts[1].quota.unified5h = 0.999;
  am.accounts[1].quota.unified5hReset = Date.now() + 3600_000;

  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a'); // fell back
});

test('setRoutePin rejects an account the route does not allow', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'], accounts: ['a'] }], // only a
  });
  const res = am.setRoutePin('bulk', 1); // b is not in the route
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not allow/);
  assert.equal(am.getRoutePin('bulk'), null);
});

test('an auto fable route is pinnable by its family name', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) { acc.quota.unified7dFable = 0.1; acc.quota.unified7dFableReset = Date.now() + 3600_000; }
  assert.ok(am.getRoutes().some(r => r.name === 'fable' && r.autocreated), 'auto fable route detected');

  assert.deepEqual(am.setRoutePin('fable', 1), { ok: true });
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'b');
  assert.equal(am.getRoutes().find(r => r.name === 'fable').pinned, 'b');
});

test('clearRoutePin removes the bias', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('bulk', 1);
  am.clearRoutePin('bulk');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4').name, 'a');
});

test('removing an account keeps route pins pointing at the right account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('bulk', 2);        // pin c
  am.removeAccount(0);              // drop a → indices shift down
  assert.equal(am.getRoutePin('bulk')?.name, 'c'); // still c, now at index 1

  am.removeAccount(am.accounts.findIndex(x => x.name === 'c')); // remove the pinned account
  assert.equal(am.getRoutePin('bulk'), null);       // pin dropped
});

test('reloading routes drops pins for routes that no longer exist', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'bulk', match: ['*opus*'] }],
  });
  am.setRoutePin('bulk', 1);
  am.setRoutes([{ name: 'other', match: ['*haiku*'] }]); // 'bulk' gone
  assert.equal(am.getRoutePin('bulk'), null);
});
