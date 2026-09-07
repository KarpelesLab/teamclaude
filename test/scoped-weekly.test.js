import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { scopedWeeklyLimits } from '../src/oauth.js';

// The model-scoped weekly buckets are upstream's list, not ours: a payload
// carries slots like seven_day_opus / seven_day_cowork / seven_day_omelette
// alongside the Fable one, and that set changes. Hard-coding two families meant
// a third was metered against the SHARED weekly bucket and could overshoot its
// own cap silently. These read the names out of the response instead.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

// Shaped like the real /api/oauth/usage payload.
const payload = {
  five_hour: { utilization: 44, resets_at: '2026-09-02T08:50:00Z' },
  seven_day: { utilization: 18, resets_at: '2026-09-02T18:00:00Z' },
  limits: [
    { kind: 'session', group: 'session', percent: 44, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 18, resets_at: '2026-09-02T18:00:00Z', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 95, resets_at: '2026-09-05T00:00:00Z', scope: { model: { display_name: 'Opus' } } },
  ],
};

test('every scoped weekly limit is read, keyed by the name upstream used', () => {
  const scoped = scopedWeeklyLimits(payload);
  assert.deepEqual(Object.keys(scoped).sort(), ['fable', 'opus']);
  assert.equal(scoped.fable.utilization, 0);
  assert.equal(scoped.opus.utilization, 0.95, 'percent is normalized to a 0-1 fraction');
  assert.equal(scoped.opus.resetAt, Date.parse('2026-09-05T00:00:00Z'),
    'reset parses to a timestamp');
});

test('unscoped and non-weekly entries are not mistaken for family buckets', () => {
  const scoped = scopedWeeklyLimits(payload);
  assert.equal(scoped.all, undefined);
  assert.equal(scoped.session, undefined);
});

test('a malformed or empty payload yields no buckets rather than throwing', () => {
  assert.deepEqual(scopedWeeklyLimits(null), {});
  assert.deepEqual(scopedWeeklyLimits({}), {});
  assert.deepEqual(scopedWeeklyLimits({ limits: 'nope' }), {});
  assert.deepEqual(scopedWeeklyLimits({ limits: [{ group: 'weekly', scope: { model: {} } }] }), {});
});

test('a family with no dedicated field is still gated by its own cap', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, {
    sevenDay: { utilization: 0.18, resetAt: Date.now() + 3 * 24 * 3600_000 },
    scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() + 3 * 24 * 3600_000 } },
  });

  // Shared weekly has plenty of room; the Opus-scoped bucket does not.
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-5'), false, 'Opus is gated by its own bucket');
  assert.equal(am._isAvailable(am.accounts[0], 'claude-haiku-4-5'), true, 'other families are unaffected');
});

test('the shared weekly still gates when it is the tighter of the two', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, {
    sevenDay: { utilization: 0.99, resetAt: Date.now() + 3 * 24 * 3600_000 },
    scopedWeekly: { opus: { utilization: 0.1, resetAt: Date.now() + 3 * 24 * 3600_000 } },
  });
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-5'), false, 'a scoped bucket cannot unlock a spent shared one');
});

test('a bucket that drops out of the payload stops gating', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const reset = Date.now() + 3 * 24 * 3600_000;
  am.applyUsageData(0, { sevenDay: { utilization: 0.2, resetAt: reset }, scopedWeekly: { opus: { utilization: 0.99, resetAt: reset } } });
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-5'), false);

  am.applyUsageData(0, { sevenDay: { utilization: 0.2, resetAt: reset }, scopedWeekly: {} });
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-5'), true, 'a remembered copy must not outlive the report');
});

test('the dedicated Fable/Sonnet fields still win — the quota shape is unchanged', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const reset = Date.now() + 3 * 24 * 3600_000;
  am.applyUsageData(0, {
    sevenDay: { utilization: 0.2, resetAt: reset },
    sevenDayFable: { utilization: 0.99, resetAt: reset },
    scopedWeekly: { fable: { utilization: 0.99, resetAt: reset } },
  });
  assert.equal(am.accounts[0].quota.unified7dFable, 0.99, 'F7 bar keeps its field');
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5-1'), false);
});

test('scoped buckets survive a restart', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const reset = Date.now() + 3 * 24 * 3600_000;
  am.applyUsageData(0, { sevenDay: { utilization: 0.2, resetAt: reset }, scopedWeekly: { opus: { utilization: 0.99, resetAt: reset } } });

  const restored = new AccountManager([oauth('a')], 0.98);
  restored.restoreQuotaState(am.exportQuotaState());
  assert.equal(restored._isAvailable(restored.accounts[0], 'claude-opus-5'), false);
});

test('a scoped bucket whose window has passed stops gating without a new probe', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.applyUsageData(0, {
    sevenDay: { utilization: 0.2, resetAt: Date.now() + 3 * 24 * 3600_000 },
    scopedWeekly: { opus: { utilization: 0.99, resetAt: Date.now() - 1 } }, // window already over
  });
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-5'), true);
  assert.equal(am.accounts[0].quota.scopedWeekly.opus, undefined, 'the expired entry is dropped');
});
