import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// The scenario these tests guard against (reproduced live in a sandbox): a 429
// burst throttles every account with a long retry-after hold; the hold lives
// only in memory and nothing revalidates it, so teamclaude keeps refusing with
// synthetic 429s even after upstream is healthy again, until a restart wipes
// the holds. Revalidation lets a live probe clear a stale hold instead.

test('within the floor, a rate-limit hold is respected verbatim (no probe)', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.markRateLimited(0, 3600);
  am.markRateLimited(1, 3600);
  assert.equal(am.getActiveAccount(), null, 'freshly throttled fleet must refuse');
});

test('after the floor, a throttled account becomes a revalidation probe target', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.markRateLimited(0, 3600);
  am.markRateLimited(1, 3600);
  // Simulate the floor having elapsed (holds still far in the future).
  am.accounts[0].throttledAt = Date.now() - am.throttleProbeFloorMs - 1;
  am.accounts[1].throttledAt = Date.now() - am.throttleProbeFloorMs - 1;

  const probe = am.getActiveAccount();
  assert.ok(probe, 'expected a revalidation probe, not a refusal');
  assert.equal(probe.status, 'throttled', 'probe target is still formally throttled');

  // Probing stays rate-limited to one per probe interval.
  assert.equal(am.getActiveAccount(exclude(probe)), null, 'second probe inside the interval must refuse');
});

test('a non-429 response clears the hold and returns the account to rotation', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.markRateLimited(0, 3600);
  am.accounts[0].throttledAt = Date.now() - am.throttleProbeFloorMs - 1;
  const probe = am.getActiveAccount();
  assert.ok(probe);

  // server.js calls this on any non-429 upstream response.
  am.clearRateLimited(probe.index);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
  assert.equal(am.accounts[0].throttledAt, null);
  // Normal selection works again with no probe gate involved.
  assert.equal(am.getActiveAccount()?.name, 'a');
});

test('a probe that 429s again re-arms the hold and pushes the next probe out a full floor', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.markRateLimited(0, 3600);
  am.accounts[0].throttledAt = Date.now() - am.throttleProbeFloorMs - 1;
  assert.ok(am.getActiveAccount(), 'probe allowed after floor');

  // Upstream said 429 again: forwardRequest re-arms via markRateLimited.
  am.markRateLimited(0, 3600);
  am._nextProbeAt = 0; // even with the probe interval open...
  assert.equal(am.getActiveAccount(), null, '...the fresh floor blocks an immediate re-probe');
});

test('clearRateLimited is a no-op on accounts that are not throttled', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].status = 'error';
  am.clearRateLimited(0);
  assert.equal(am.accounts[0].status, 'error', 'must not resurrect an errored account');
  am.clearRateLimited(99); // out of range: must not throw
});

test('constructor floor option is honored', () => {
  const am = new AccountManager([oauth('a')], 0.98, { throttleProbeFloorMs: 5 });
  am.markRateLimited(0, 3600);
  assert.equal(am.getActiveAccount(), null, 'inside the tiny floor');
  am.accounts[0].throttledAt = Date.now() - 6;
  assert.ok(am.getActiveAccount(), 'past the tiny floor');
});

test('natural hold expiry still clears state fully', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.markRateLimited(0, 1);
  am.accounts[0].rateLimitedUntil = Date.now() - 1; // expired
  const acct = am.getActiveAccount();
  assert.equal(acct?.name, 'a');
  assert.equal(am.accounts[0].throttledAt, null, 'expiry must reset throttledAt too');
});

function exclude(account) {
  return new Set([account.index]);
}
