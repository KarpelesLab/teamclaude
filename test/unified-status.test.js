import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { unavailableLine } from '../src/status-renderer.js';

// Upstream reports its own verdict in `anthropic-ratelimit-unified-status`.
// TeamClaude stored and displayed it but never acted on it, so an operator could
// see `allowed` next to an account the proxy was refusing to use, with no way to
// tell whose decision that was (issue #166).

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}
const STALE_MS = 1000;
const manager = (names = ['a']) => new AccountManager(names.map(oauth), 0.98, { statusStaleMs: STALE_MS });

// Healthy local counters: nothing but the upstream signal can bar the account.
function healthy(account) {
  account.quota.unified5h = 0.1;
  account.quota.unified7d = 0.2;
  account.quota.unified7dReset = Date.now() + 3 * 24 * 3600_000;
}

test('a fresh upstream rejection takes the account out of rotation', () => {
  const am = manager();
  healthy(am.accounts[0]);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });

  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am.unavailableReason(am.accounts[0]), 'upstream-rejected');
});

test('allowed and allowed_warning do not bar anything', () => {
  for (const status of ['allowed', 'allowed_warning']) {
    const am = manager();
    healthy(am.accounts[0]);
    am.updateQuota(0, { 'anthropic-ratelimit-unified-status': status });
    assert.equal(am.unavailableReason(am.accounts[0]), null, status);
  }
});

test('a stale rejection is dropped rather than barring the account forever', () => {
  const am = manager();
  healthy(am.accounts[0]);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(am._isAvailable(am.accounts[0]), false);

  // The signal is a snapshot of one response; nothing revalidates it while the
  // account idles, so it must not outlive its window.
  am.accounts[0].quota.unifiedStatusSeenAt -= STALE_MS + 1;

  assert.equal(am._isAvailable(am.accounts[0]), true, 'local counters decide again');
  assert.equal(am.accounts[0].quota.unifiedStatus, null, 'and the stale verdict is dropped');
});

test('a rejection restored with no timestamp starts the clock, it is not trusted forever', () => {
  const am = manager();
  healthy(am.accounts[0]);
  am.accounts[0].quota.unifiedStatus = 'rejected';   // e.g. a pre-upgrade state file

  assert.equal(am._isAvailable(am.accounts[0]), false, 'trusted for one window');
  const seenAt = am.accounts[0].quota.unifiedStatusSeenAt;
  assert.ok(seenAt, 'the clock is started on first use');

  am.accounts[0].quota.unifiedStatusSeenAt = seenAt - STALE_MS - 1;
  assert.equal(am._isAvailable(am.accounts[0]), true, 'and it expires a window later');
});

test('a later response supersedes the rejection', () => {
  const am = manager();
  healthy(am.accounts[0]);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(am._isAvailable(am.accounts[0]), false);

  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'allowed' });
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('rotation still finds a sibling when one account is upstream-rejected', () => {
  const am = manager(['a', 'b']);
  am.accounts.forEach(healthy);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });

  const picked = am.getActiveAccount();
  assert.ok(picked, 'a rejected account must not empty the fleet');
  assert.equal(picked.name, 'b');
});

test('the reason names WHOSE decision it was', () => {
  const am = manager(['a', 'b', 'c']);
  am.accounts.forEach(healthy);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  am.accounts[1].quota.unified5h = 0.99;              // local threshold, upstream silent
  am.accounts[2].disabled = true;

  assert.equal(am.unavailableReason(am.accounts[0]), 'upstream-rejected');
  assert.equal(am.unavailableReason(am.accounts[1]), 'quota');
  assert.equal(am.unavailableReason(am.accounts[2]), 'disabled');
});

test('getStatus reports the reason per account', () => {
  const am = manager(['a', 'b']);
  am.accounts.forEach(healthy);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });

  const status = am.getStatus();
  assert.equal(status.accounts[0].unavailable, 'upstream-rejected');
  assert.equal(status.accounts[1].unavailable, null);
});

test('the status view spells the reason out for an operator', () => {
  const paint = { dim: s => s, yellow: s => s };
  assert.match(unavailableLine({ unavailable: 'upstream-rejected' }, paint), /upstream reports quota rejected/);
  assert.match(unavailableLine({ unavailable: 'quota' }, paint), /local switch threshold/);
  assert.equal(unavailableLine({ unavailable: null }, paint), null, 'a healthy account gets no line');
});

test('a rejection does not outlive the 5-hour window that produced it', () => {
  const am = manager();
  healthy(am.accounts[0]);
  am.accounts[0].quota.unified5hReset = Date.now() + 1000;
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(am._isAvailable(am.accounts[0]), false);
  am.accounts[0].quota.unified5hReset = Date.now() - 1; // the session window rolled over
  assert.equal(am._isAvailable(am.accounts[0]), true, 'the rejection went with the window');
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
});
