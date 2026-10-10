import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { pressureOf, pressureRank, decideBand } from '../src/band-decision.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

function mgr(names, opts = {}) {
  const { expiry, ...rest } = opts;
  return new AccountManager(names.map(n => oauth(n)), 0.98,
    expiry ? { expiryRouting: { enabled: true, tolerance: 2 }, ...rest } : rest);
}

// A plan that meters a shared weekly window (Max): both shared windows stated.
function weekly(am, i, used5h, used7d, hours) {
  am.updateQuota(i, {
    'anthropic-ratelimit-unified-5h-utilization': String(used5h),
    'anthropic-ratelimit-unified-7d-utilization': String(used7d),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + hours * H) / 1000)),
  });
}

// A plan with no shared weekly window (a Team seat): the 5-hour window alone.
function weekless(am, i, used5h) {
  am.updateQuota(i, { 'anthropic-ratelimit-unified-5h-utilization': String(used5h) });
}

// ---------------------------------------------------------------------------
// The fact itself
// ---------------------------------------------------------------------------

test('a reading with a 5h window and no 7d one states the plan has no shared weekly', () => {
  const am = mgr(['a']);
  const q = am.accounts[0].quota;
  assert.equal(q.weeklyWindowStated, null, 'never read: nothing is stated');
  am.updateQuota(0, {});
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d_oi-utilization': '0.1' });
  assert.equal(q.weeklyWindowStated, null, 'no shared window stated, nothing concluded');
  weekless(am, 0, 0.1);
  assert.equal(q.weeklyWindowStated, false);
  weekly(am, 0, 0.1, 0.2, 50);
  assert.equal(q.weeklyWindowStated, true, 'a plan that gains a weekly says so on its next response');
});

test('the usage probe states the same fact from the whole payload', () => {
  const am = mgr(['a']);
  const q = am.accounts[0].quota;
  am.applyUsageData(0, { fiveHour: { utilization: 0.1, resetAt: Date.now() + H }, sevenDay: null });
  assert.equal(q.weeklyWindowStated, false);
  am.applyUsageData(0, { fiveHour: { utilization: 0.1, resetAt: Date.now() + H }, sevenDay: { utilization: 0.3, resetAt: Date.now() + 50 * H } });
  assert.equal(q.weeklyWindowStated, true);
  am.applyUsageData(0, { error: 'HTTP 500' });
  assert.equal(q.weeklyWindowStated, true, 'a failed probe concludes nothing');
});

test('a weekly reset clears the reading, not the fact, so a weekly plan is rediscovered', () => {
  const am = mgr(['a']);
  const q = am.accounts[0].quota;
  weekly(am, 0, 0.1, 0.5, 50);
  q.unified7dReset = Date.now() - 1;
  am.refreshExpiredQuotas();
  assert.equal(q.unified7d, null);
  assert.equal(q.weeklyWindowStated, true);
  // Unknown again, not absent: discovery puts it ahead of a measured account.
  const other = mgr(['a', 'b']);
  weekly(other, 0, 0.1, 0.5, 50);
  other.accounts[0].quota.unified7dReset = Date.now() - 1;
  other.refreshExpiredQuotas();
  weekly(other, 1, 0.1, 0.3, 20);
  assert.equal(other.selectActiveAccount().name, 'a');
});

test('the fact survives a restart', () => {
  const am = mgr(['a']);
  weekless(am, 0, 0.1);
  const again = mgr(['a']);
  again.restoreQuotaState(am.exportQuotaState());
  assert.equal(again.accounts[0].quota.weeklyWindowStated, false);
});

// ---------------------------------------------------------------------------
// The decision layer
// ---------------------------------------------------------------------------

test('a stated-absent window is its own absence and ranks after every measured account', () => {
  const now = 1_800_000_000_000;
  const none = pressureOf({ index: 0, priority: 0, utilization: null, resetAt: null, windowAbsent: true }, now);
  assert.deepEqual(none, { kind: 'absent', reason: 'no-window' });
  assert.equal(pressureRank(none), Infinity);
  assert.ok(pressureRank({ kind: 'known', value: 0 }) < pressureRank(none), 'after even a passed reset');
  assert.equal(pressureRank(pressureOf({ index: 0, priority: 0, utilization: null, resetAt: null }, now)), -Infinity,
    'a never-read account is still discovery');
});

test('a stated-absent window stays in the band', () => {
  const now = 1_800_000_000_000;
  const d = decideBand({ now, enabled: true, tolerance: 2, accounts: [
    { index: 0, priority: 0, utilization: 0.2, resetAt: now + 10 * H },
    { index: 1, priority: 0, utilization: null, resetAt: null, windowAbsent: true },
  ] });
  assert.equal(d.kind, 'banded');
  assert.deepEqual(d.keep, [0, 1]);
});

// ---------------------------------------------------------------------------
// Selection, every path that used to read the absence as discovery
// ---------------------------------------------------------------------------

for (const expiry of [false, true]) {
  const knob = `expiry routing ${expiry ? 'on' : 'off'}`;

  test(`startup picks a weekly account over a weekless one (${knob})`, () => {
    const am = mgr(['team', 'max'], { expiry });
    weekless(am, 0, 0.1);
    weekly(am, 1, 0.1, 0.3, 50);
    assert.equal(am.selectActiveAccount().name, 'max');
  });

  test(`a never-read account still goes first (${knob})`, () => {
    const am = mgr(['fresh', 'max'], { expiry });
    weekly(am, 1, 0.1, 0.3, 50);
    assert.equal(am.selectActiveAccount().name, 'fresh');
  });

  test(`rotation reaches a weekless seat only when no weekly account is left (${knob})`, () => {
    const am = mgr(['max1', 'team', 'max2'], { expiry });
    weekly(am, 0, 0.99, 0.3, 50);
    weekless(am, 1, 0.1);
    weekly(am, 2, 0.1, 0.3, 90);
    am.currentIndex = 0;
    assert.equal(am._selectNext(new Set([0]), OPUS)?.name, 'max2');
    assert.equal(am._selectNext(new Set([0, 2]), OPUS)?.name, 'team');
  });

  test(`a weekless current account yields when a weekly account's session resets (${knob})`, () => {
    const am = mgr(['team', 'max'], { expiry });
    weekless(am, 0, 0.1);
    weekly(am, 1, 0.9, 0.3, 50);
    am.currentIndex = 0;
    am._switchOnSessionReset([am.accounts[1]], expiry ? OPUS : null);
    assert.equal(am.currentIndex, 1);
  });

  test(`a family the seat meters is ranked on that window, not as weekless (${knob})`, () => {
    const am = mgr(['team', 'max'], { expiry });
    weekless(am, 0, 0.1);
    am.updateQuota(0, {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.05',
      'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 10 * H) / 1000)),
    });
    weekly(am, 1, 0.1, 0.3, 50);
    am.accounts[1].quota.unified7dFable = 0.5;
    am.accounts[1].quota.unified7dFableReset = Date.now() + 100 * H;
    assert.equal(am._pickBestAvailable(null, FABLE)?.name, 'team', 'its Fable window resets first');
    assert.equal(am._pickBestAvailable(null, OPUS)?.name, 'max');
  });
}

test('even distribution still spreads load onto a weekless seat; it only loses ties', () => {
  const am = mgr(['team', 'max'], { distributeSessions: true });
  weekless(am, 0, 0.1);
  weekly(am, 1, 0.1, 0.3, 50);
  const placed = [];
  for (let i = 0; i < 4; i++) {
    const id = `s${i}`;
    const acc = am.getActiveAccount(null, OPUS, null, id);
    am.recordSession(id, acc.index, OPUS);
    am.beginSession(id);
    placed.push(acc.name);
  }
  assert.deepEqual(placed, ['max', 'team', 'max', 'team']);
});

test('the 5-hour window still gates a weekless seat', () => {
  const am = mgr(['team']);
  weekless(am, 0, 0.99);
  assert.equal(am._isNearQuota(am.accounts[0], OPUS), true);
});
