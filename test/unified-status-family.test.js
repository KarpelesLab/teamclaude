import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A Fable-cap 429 carries `unified-status: rejected` alongside
// `7d_oi-status: rejected`, while the shared `5h` and `7d` statuses on the same
// response say `allowed`. That rejection belongs to the family bucket, which
// already bars the account for Fable; it must not park the account for every
// other model until statusStaleMs runs out.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}
const manager = () => new AccountManager([oauth('a')], 0.98, { statusStaleMs: 30 * 60_000 });

const FABLE = 'claude-fable-5-1';
const HAIKU = 'claude-haiku-4-5-20251001';
const reset = String(Math.floor(Date.now() / 1000) + 3 * 24 * 3600);

// Verbatim shape of the response that parked a live account (only values changed).
const fableCapHit = {
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-5h-reset': reset,
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.52',
  'anthropic-ratelimit-unified-7d-reset': reset,
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',
  'anthropic-ratelimit-unified-7d_oi-reset': reset,
  'anthropic-ratelimit-unified-status': 'rejected',
};

test('a family-only rejection bars the family, not the account', () => {
  const am = manager();
  am.updateQuota(0, fableCapHit);
  const a = am.accounts[0];

  assert.equal(am.unavailableReason(a, FABLE), 'quota', 'Fable is spent, by its own bucket');
  assert.equal(am.unavailableReason(a, HAIKU), null, 'other families still route here');
  assert.equal(a.quota.unifiedStatus, 'allowed', 'the shared verdict is what the shared buckets said');
});

test('a rejection the shared buckets confirm still parks the account', () => {
  const am = manager();
  am.updateQuota(0, {
    ...fableCapHit,
    // Upstream says the shared 5h bucket is spent while the local reading is
    // still under the threshold: the verdict, not the counter, is what bars it.
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '0.90',
  });
  assert.equal(am.unavailableReason(am.accounts[0], HAIKU), 'upstream-rejected');
});

test('a bare rejection with no per-bucket statuses keeps the old behaviour', () => {
  const am = manager();
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[0].quota.unified7d = 0.2;
  am.accounts[0].quota.unified7dReset = Date.now() + 3 * 24 * 3600_000;
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(am.unavailableReason(am.accounts[0], HAIKU), 'upstream-rejected');
});
