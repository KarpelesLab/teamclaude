import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// `quota.observedAt` records when a reading was TAKEN, so consumers can tell a
// live number from a days-old one. Before it existed, a state-file-backed probe
// that succeeded "now" while reading a 12-day-old file was indistinguishable
// from a fresh reading, and a spent weekly window could render as free capacity.

test('applyUsageData stamps observedAt at apply time when the source supplies none', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const before = Date.now();
  am.applyUsageData(0, { sevenDay: { utilization: 0.16 } });
  const after = Date.now();

  const { observedAt } = am.accounts[0].quota;
  assert.ok(observedAt >= before && observedAt <= after,
    `observedAt ${observedAt} should sit within [${before}, ${after}]`);
});

test('applyUsageData honors a source-supplied observedAt (stale state file)', () => {
  const am = new AccountManager([oauth('sakana-fugu')], 0.98);
  const twelveDaysAgo = Date.now() - 12 * 86400_000;

  // A probe that runs now but reads a file written 12 days ago must NOT be
  // reported as fresh: the reading is old even though the probe just succeeded.
  am.applyUsageData(0, {
    sevenDay: { utilization: 1.0 },
    observedAt: twelveDaysAgo,
  });

  const q = am.accounts[0].quota;
  assert.equal(q.observedAt, twelveDaysAgo);
  assert.equal(q.unified7d, 1.0, 'last-good value is preserved, not blanked');
  assert.ok(Date.now() - q.observedAt > 3600_000, 'reading is older than the stale threshold');
});

test('applyUsageData ignores a non-finite observedAt and falls back to now', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  for (const bad of [NaN, Infinity, 'yesterday', {}]) {
    am.accounts[0].quota.observedAt = undefined;
    am.applyUsageData(0, { sevenDay: { utilization: 0.5 }, observedAt: bad });
    const { observedAt } = am.accounts[0].quota;
    assert.ok(Number.isFinite(observedAt), `observedAt should be finite for input ${String(bad)}`);
    assert.ok(Math.abs(Date.now() - observedAt) < 5000);
  }
});

test('updateQuota stamps observedAt only when a unified header was present', () => {
  const am = new AccountManager([oauth('a')], 0.98);

  // A response with no unified headers must not refresh the observation time,
  // otherwise an upstream that stops reporting quota keeps looking current.
  am.updateQuota(0, { 'content-type': 'application/json' });
  assert.equal(am.accounts[0].quota.observedAt, undefined,
    'a header-less response must not stamp freshness');

  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.42' });
  const stamped = am.accounts[0].quota.observedAt;
  assert.ok(Number.isFinite(stamped), 'a unified header stamps the observation time');
  assert.equal(am.accounts[0].quota.unified7d, 0.42);

  // A later header-less response leaves the earlier stamp untouched.
  am.updateQuota(0, {});
  assert.equal(am.accounts[0].quota.observedAt, stamped);
});

test('an account that never reported quota has no observedAt (distinct from 0% used)', () => {
  const am = new AccountManager([oauth('antigravity')], 0.98);
  const q = am.accounts[0].quota;
  assert.equal(q.observedAt, undefined);
  assert.equal(q.unified5h, null);
  assert.equal(q.unified7d, null);
});

test('observedAt survives export/restore so a restored reading keeps its real age', () => {
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  const twelveDaysAgo = Date.now() - 12 * 86400_000;
  am1.applyUsageData(0, { sevenDay: { utilization: 1.0 }, observedAt: twelveDaysAgo });

  const [entry] = am1.exportQuotaState();
  assert.equal(entry.quota.observedAt, twelveDaysAgo, 'observedAt must be persisted');

  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1', orgUuid: 'o1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  assert.equal(am2.accounts[0].quota.observedAt, twelveDaysAgo,
    'a restored reading keeps its original age, not the restart time');
});
