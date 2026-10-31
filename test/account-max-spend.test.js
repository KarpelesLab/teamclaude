import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { resolveMaxSpendMinor, spendCapReached } from '../src/model.js';

// accounts[].maxSpend: a money ceiling on an account that can bill past its
// plan. Unlike a usage cap it is not about quota at all — it is judged against
// the month-to-date extra-usage figure upstream reports in `quota.spend`.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const usd = (usedMinor, extra = {}) => ({ enabled: true, usedMinor, limitMinor: 1_000_000, currency: 'USD', exponent: 2, ...extra });
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

function fleet(maxSpend) {
  return new AccountManager([oauth('a'), oauth('budget', { maxSpend })], 0.98);
}

test('the cap is written in dollars and compared in cents', () => {
  assert.equal(resolveMaxSpendMinor(20, usd(0)), 2000);
  assert.equal(resolveMaxSpendMinor(12.5, usd(0)), 1250);
  assert.equal(resolveMaxSpendMinor(20, { exponent: 0, currency: 'JPY' }), 20);
  // Absent, negative, non-numeric or absurd: no cap rather than a wrong one.
  for (const bad of [null, undefined, -1, '20', NaN, Infinity]) assert.equal(resolveMaxSpendMinor(bad, usd(0)), null, String(bad));
  assert.equal(resolveMaxSpendMinor(20, { exponent: 12 }), null);
});

test('reached at the cap, not before; 0 means "not one cent" and still admits an unspent account', () => {
  assert.equal(spendCapReached(20, usd(1999)), false);
  assert.equal(spendCapReached(20, usd(2000)), true);
  assert.equal(spendCapReached(20, usd(5000)), true);
  assert.equal(spendCapReached(0, usd(0)), false);
  assert.equal(spendCapReached(0, usd(1)), true);
});

test('an account that cannot bill is never spend-capped, and an unknown spend record is no evidence', () => {
  assert.equal(spendCapReached(20, usd(5000, { enabled: false })), false);
  assert.equal(spendCapReached(20, null), false);
  assert.equal(spendCapReached(20, undefined), false);
});

test('at the cap with no quota reading the account receives nothing: rotation and the probe skip it', () => {
  const am = fleet(20);
  const [a, budget] = am.accounts;
  // No bucket has been read: unknown is no proof a request would be free.
  Object.assign(budget.quota, { spend: usd(2000) });
  assert.equal(am.capExceeded(budget, OPUS), 'spend');
  assert.equal(am.capExceeded(a, OPUS), null, 'no cap on the other account');
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
  // Every account out: the other one is over the switch threshold (a
  // preference the exhausted-fleet probe may override), this one is over its
  // budget (which it may not). The probe goes to the other account, and with
  // that one excluded nothing is left at all.
  Object.assign(a.quota, { unified7d: 0.99 });
  am._nextProbeAt = 0;
  assert.equal(am._selectProbe(null, OPUS)?.name, 'a');
  assert.equal(am.getActiveAccount(new Set([a.index]), OPUS), null);
});

test('under the cap the account serves normally, and a new month lifts the cap by itself', () => {
  const am = fleet(20);
  const budget = am.accounts[1];
  Object.assign(budget.quota, { spend: usd(1435) });
  assert.equal(am.capExceeded(budget, OPUS), null);
  assert.equal(am.unavailableReason(budget, OPUS), null);
  Object.assign(budget.quota, { spend: usd(2000) });
  assert.equal(am.capExceeded(budget, OPUS), 'spend');
  // Upstream's month-to-date figure resets: the next reading clears the cap.
  Object.assign(budget.quota, { spend: usd(0) });
  assert.equal(am.capExceeded(budget, OPUS), null);
});

test('the money cap is judged ahead of, and independently from, the usage caps', () => {
  const am = new AccountManager([oauth('both', { maxSpend: 20, maxUsage: 0.5 })], 0.98);
  const acct = am.accounts[0];
  Object.assign(acct.quota, { unified5h: 1.0, unified7d: 0.6, spend: usd(2000) });
  assert.equal(am.capExceeded(acct, OPUS), 'spend');
  Object.assign(acct.quota, { unified5h: 0.1, spend: usd(0) });
  assert.equal(am.capExceeded(acct, OPUS), 'unified7d');
});

// ── Past the cap: held to included quota ────────────────────

const FABLE = 'claude-fable-5-1';
const H = 3600_000;

// Silence the selection and window-reset log lines.
function quietly(fn) {
  const was = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = was; }
}

// Past its cap, with quota left: 5h 20%, weekly 30%, Fable 40%, all fresh.
function capped(extra = {}) {
  const am = new AccountManager([oauth('a'), oauth('budget', { maxSpend: 10, allowExtraUsage: true, ...extra })], 0.98);
  const budget = am.accounts[1];
  Object.assign(budget.quota, {
    spend: usd(2000),
    unified5h: 0.2, unified5hReset: Date.now() + 4 * H,
    unified7d: 0.3, unified7dReset: Date.now() + 72 * H,
    unified7dFable: 0.4, unified7dFableReset: Date.now() + 72 * H,
  });
  return { am, a: am.accounts[0], budget };
}

test('past the cap, a request on included quota is still served: it bills nothing', () => {
  const { am, budget } = capped();
  assert.equal(am.unavailableReason(budget), null, 'status read (no model)');
  assert.equal(am.unavailableReason(budget, OPUS), null);
  assert.equal(am.unavailableReason(budget, FABLE), null);
  assert.equal(am.getStatus().accounts.find(r => r.name === 'budget').unavailable, null);
  // Picked by a normal selection once the other account is out.
  Object.assign(am.accounts[0].quota, { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'budget');
});

test('past the cap, a spent shared bucket bars every request', () => {
  for (const spent of [{ unified5h: 1.0 }, { unified7d: 1.0 }, { unified7d: 1.3 }]) {
    const { am, budget } = capped();
    Object.assign(budget.quota, spent);
    const label = JSON.stringify(spent);
    assert.equal(am.unavailableReason(budget), 'spend-capped', label);
    assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped', label);
    assert.equal(am.unavailableReason(budget, FABLE), 'spend-capped', label);
  }
});

test('the margin is 1.0, not the switch threshold: 0.99 is still free quota', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unified7d: 0.99 });
  assert.equal(am.capExceeded(budget, OPUS), null);
  // Over the threshold it is a rotation preference, not the money cap.
  assert.equal(am.unavailableReason(budget, OPUS), 'quota');
});

test('past the cap, a spent family bucket bars that family only', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unified7dFable: 1.0 });
  assert.equal(am.unavailableReason(budget, FABLE), 'spend-capped');
  assert.equal(am.unavailableReason(budget, OPUS), null);
  assert.equal(am.unavailableReason(budget), null);
});

test('past the cap, a family the plan does not meter is governed by the shared buckets', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unified7dSonnet: null, unified7dSonnetReset: null });
  assert.equal(am.unavailableReason(budget, SONNET), null);
  Object.assign(budget.quota, { unified7d: 1.0 });
  assert.equal(am.unavailableReason(budget, SONNET), 'spend-capped');
});

test('past the cap, a spent scoped weekly bucket bars its family', () => {
  const { am, budget } = capped();
  budget.quota.scopedWeekly = { opus: { utilization: 1.0, resetAt: Date.now() + 72 * H } };
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
  assert.equal(am.capBars(budget, FABLE, OPUS), 'spend', 'as the advisor too');
  budget.quota.scopedWeekly.opus.utilization = 0.5;
  assert.equal(am.unavailableReason(budget, OPUS), null);
});

test('past the cap, an unknown shared reading binds', () => {
  for (const unknown of [{ unified5h: null }, { unified7d: null }]) {
    const { am, budget } = capped();
    Object.assign(budget.quota, unknown);
    assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped', JSON.stringify(unknown));
  }
});

test('past the cap, a reading past its window reset is unknown, not the old number', () => {
  for (const bucket of ['unified5h', 'unified7d']) {
    const { am, budget } = capped();
    // A low reading whose window has since reset: the new window is unread.
    Object.assign(budget.quota, { [bucket]: 0.1, [`${bucket}Reset`]: Date.now() - 1000 });
    assert.equal(quietly(() => am.unavailableReason(budget, OPUS)), 'spend-capped', bucket);
  }
});

test('past the cap, a fresh upstream rejected verdict binds', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() });
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
});

test('a plan that meters no weekly window is judged on its session window alone', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unified7d: null, unified7dReset: null, weeklyWindowStated: false });
  assert.equal(am.unavailableReason(budget, OPUS), null);
  Object.assign(budget.quota, { unified5h: 1.0 });
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
});

test('a plan that meters no session window is judged on its weekly window alone', () => {
  const { am, budget } = capped();
  Object.assign(budget.quota, { unified5h: null, unified5hReset: null, sessionWindowStated: false });
  assert.equal(am.unavailableReason(budget, OPUS), null);
  Object.assign(budget.quota, { unified7d: 1.0 });
  assert.equal(am.unavailableReason(budget, OPUS), 'spend-capped');
});

test("past the cap, the advisor's family must be free too, unless the advisor is only preferred", () => {
  {
    const { am, budget } = capped();
    Object.assign(budget.quota, { unified7dFable: 1.0 });
    assert.equal(am.capBars(budget, OPUS), null, 'the executor alone is free');
    assert.equal(am.capBars(budget, OPUS, FABLE), 'spend');
    assert.equal(am.unavailableReason(budget, OPUS, FABLE), 'spend-capped');
  }
  const { am, budget } = capped();
  am.advisorEligibility = 'prefer';
  Object.assign(budget.quota, { unified7dFable: 1.0 });
  assert.equal(am.capBars(budget, OPUS, FABLE), null);
});

test('past the cap, a maxUsage cap still binds below 1.0', () => {
  const { am, budget } = capped({ maxUsage: 0.15 });
  assert.equal(am.capExceeded(budget, OPUS), 'unified5h');
  assert.equal(am.unavailableReason(budget, OPUS), 'capped');
});

// The paid fallback is where a capped account would bill: with every account
// at 100% it is the one path that admits a request past it.
test('a spent fleet bills an opted-in account under its cap, never one past it', () => {
  const spentFleet = maxSpend => {
    const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, maxSpend })], 0.98);
    for (const acct of am.accounts) Object.assign(acct.quota, { unified5h: 0.2, unified7d: 1.0 });
    am.accounts[1].quota.spend = usd(2000);
    am._nextProbeAt = Date.now() + 60_000;
    return am;
  };
  // Under its cap the paid tier bills it…
  const under = spentFleet(50);
  assert.equal(quietly(() => under.getActiveAccount(null, OPUS))?.name, 'paid');
  assert.equal(quietly(() => under.pickAlternate(new Set([0]), OPUS))?.name, 'paid');
  // …past it, neither the walk, a hop nor the exhausted-fleet probe does.
  const over = spentFleet(10);
  assert.equal(quietly(() => over.getActiveAccount(null, OPUS)), null);
  assert.equal(quietly(() => over.pickAlternate(new Set([0]), OPUS)), null);
  over._nextProbeAt = 0;
  assert.equal(quietly(() => over._selectProbe(null, OPUS))?.name, 'a');
});

test('a capped account between the threshold and 1.0 is still the free fallback pick', () => {
  const { am, a, budget } = capped();
  Object.assign(a.quota, { unified7d: 1.0 });
  Object.assign(budget.quota, { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS))?.name, 'budget');
  assert.equal(am.getStatus().accounts.find(r => r.name === 'budget').onExtraUsage, false);
});

test('the cap rides along in status JSON and applies live on a config reload', async () => {
  const am = fleet(20);
  // Status JSON carries both the cap and, once it binds, the reason — the
  // attach-mode TUI and a `status --json` reader draw both from there.
  Object.assign(am.accounts[1].quota, { spend: usd(2000) });
  const row = am.getStatus().accounts.find(a => a.name === 'budget');
  assert.equal(row.maxSpend, 20);
  assert.equal(row.unavailable, 'spend-capped');
  assert.equal(am.getStatus().accounts.find(a => a.name === 'a').maxSpend, null);
  // Back under the cap before the reload half, so the lower cap it installs is
  // what bars the account below, not the figure set here.
  Object.assign(am.accounts[1].quota, { spend: usd(0) });
  const { syncAccountsFromDisk } = await import('../src/sync-accounts.js');
  const disk = { accounts: [ { ...oauth('a'), id: am.accounts[0].id }, { ...oauth('budget'), id: am.accounts[1].id, maxSpend: 5 } ] };
  const cfg = { accounts: disk.accounts.map(a => ({ ...a })) };
  await syncAccountsFromDisk(disk, cfg, am);
  assert.equal(am.accounts[1].maxSpend, 5);
  Object.assign(am.accounts[1].quota, { spend: usd(500) });
  assert.equal(am.capExceeded(am.accounts[1], OPUS), 'spend');
});
