import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { unavailableLine } from '../src/status-renderer.js';

// `accounts[].allowExtraUsage`: an account with paid overage on upstream may be
// leaned on once every account is out of free quota, instead of the fleet
// answering a synthetic 429. Rotation itself is untouched — these tests pin
// three things: nothing changes while any account is under its threshold; an
// account past its threshold but under 100% still serves for free before any
// money moves; and once no free quota is left, the paid account serves unless
// a hard gate says it must not.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// Every account at 100% of its weekly quota (past the 0.98 switch threshold
// AND out of free headroom), and the probe slot spent, so the walk reaches the
// point where without the opt-in it answers null.
function spentFleet(accounts) {
  const am = new AccountManager(accounts, 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 1.0 });
  am._nextProbeAt = Date.now() + 60_000;
  return am;
}

// Silence the transition lines for the unit tests; the one test about logging
// captures them itself.
function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

// ── selection ────────────────────────────────────────────────

test('with every account spent, the opted-in account serves instead of null', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  am.currentIndex = 0;
  const picked = quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(picked?.name, 'paid');
  // It is not a normal pick: the account still reads as out of quota.
  assert.equal(am.unavailableReason(picked, OPUS), 'quota');
});

test('without the opt-in the spent fleet still answers null', () => {
  const am = spentFleet([oauth('a'), oauth('b')]);
  assert.equal(am.getActiveAccount(null, OPUS), null);
});

// ── free quota first ─────────────────────────────────────────

// The switch threshold is a rotation preference: an account between it and
// 100% still has quota the operator pays for. Billing another account while
// that is unused is the one thing this feature must never do.
test('a normal account at 0.99 is used before the paid account, which is NOT billed', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 1;
  for (let i = 0; i < 3; i++) assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  assert.equal(am.accounts[1].usage.totalRequests, 0);
  const [a, paid] = am.getStatus().accounts;
  assert.equal(a.onExtraUsage, false);
  assert.equal(paid.onExtraUsage, false);
  // Still a fallback pick, not a normal one: `a` reads as over threshold.
  assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'quota');
});

test('a per-bucket threshold leaves free quota the fallback uses before paying', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], { unified7d: 0.85 });
  setQuota(am.accounts[0], { unified7d: 0.90 });
  setQuota(am.accounts[1], { unified7d: 1.0 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

test('billing starts only once every account is at 100%, and is marked from then on', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  setQuota(am.accounts[0], { unified7d: 1.0 });
  setQuota(am.accounts[1], { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    // The opted-in account is the one with free quota left: it serves, unmarked.
    assert.equal(am.getActiveAccount(null, OPUS).name, 'paid');
    assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
    assert.equal(lines.filter(l => l.includes('extra usage')).length, 0);
    assert.equal(lines.filter(l => l.includes('free quota it has left')).length, 1);
    // It reaches 100%: the same account now bills, and says so once.
    setQuota(am.accounts[1], { unified7d: 1.0 });
    for (let i = 0; i < 3; i++) assert.equal(am.getActiveAccount(null, OPUS).name, 'paid');
  } finally {
    console.log = log;
  }
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
  assert.equal(lines.filter(l => l.includes('on extra usage')).length, 1);
});

test('among spent-but-free accounts: priority, then the most free quota left, opted in or not', () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }),
    oauth('b', { priority: 0 }),
    oauth('paid', { allowExtraUsage: true, priority: 0 }),
  ], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.985 });
  setQuota(am.accounts[1], { unified7d: 0.995 });
  setQuota(am.accounts[2], { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  assert.equal(quietly(() => am.getActiveAccount(new Set([2]), OPUS)).name, 'b');
  assert.equal(am.getStatus().accounts[2].onExtraUsage, false);
});

test('an account in error or entitlement cooldown counts as unable to serve, not as free quota to wait for', () => {
  for (const arm of [a => { a.status = 'error'; }, a => { a.entitlementDeniedUntil = Date.now() + 60_000; }]) {
    const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
    setQuota(am.accounts[0], { unified7d: 0.5 });
    setQuota(am.accounts[1], { unified7d: 1.0 });
    am._nextProbeAt = Date.now() + 60_000;
    arm(am.accounts[0]);
    assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
    assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
  }
});

test('a free-quota fallback is not a fleet with no opt-in: it still answers 429 past the threshold', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(am.getActiveAccount(null, OPUS), null);
});

test('rotation is unchanged: an opted-in account still rotates away at the threshold', () => {
  const am = new AccountManager([oauth('paid', { allowExtraUsage: true }), oauth('b')], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 0.5 });
  am.currentIndex = 0;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'b');
});

test('never chosen while any normal account has headroom, even a lower-priority one', () => {
  const am = new AccountManager([
    oauth('paid', { allowExtraUsage: true, priority: 0 }),
    oauth('last-resort', { priority: 9 }),
  ], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 0.5 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'last-resort');
});

test('the free revalidation probe goes first when it is due', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, priority: 1 })], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 1.0 });
  // Probe due: it may find stale headroom on `a`, which costs nothing.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  // The probed account refused, so this request retries with it tried and the
  // probe slot spent: the fallback takes it rather than a 429.
  assert.equal(quietly(() => am.getActiveAccount(new Set([0]), OPUS)).name, 'paid');
});

test('priority orders several fallback accounts, then least utilization', () => {
  const am = spentFleet([
    oauth('a'),
    oauth('paid-low', { allowExtraUsage: true, priority: 5 }),
    oauth('paid-hi', { allowExtraUsage: true, priority: 1 }),
    oauth('paid-hi-deeper', { allowExtraUsage: true, priority: 1 }),
  ]);
  setQuota(am.accounts[2], { unified7d: 1.10 });
  setQuota(am.accounts[3], { unified7d: 1.40 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid-hi');
  // With the preferred tier excluded (it just failed this request), the lower one.
  assert.equal(quietly(() => am.getActiveAccount(new Set([2, 3]), OPUS)).name, 'paid-low');
});

test('a stale upstream `rejected` verdict is overridden like the threshold', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  setQuota(am.accounts[1], { unified7d: 0.5, unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now(), spend: { enabled: true, usedMinor: 0 } });
  assert.equal(am.unavailableReason(am.accounts[1], OPUS), 'upstream-rejected');
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  // Under 100% by the counters, so it is not marked as billing on the pick
  // alone — only once the month's spend is seen to rise.
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
  am.accounts[1].quota.spend.usedMinor = 250;
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
});

test('a rejected account is never the free pick, even under 100% and not opted in', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.5, unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() });
  setQuota(am.accounts[1], { unified7d: 1.0 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
});

test('a spent family bucket falls back for that family only', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.3, unified7dFable: 1.0 });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 0;
  assert.equal(quietly(() => am.getActiveAccount(null, FABLE)).name, 'paid');
  // Opus is under every limit: it stays where the fleet was, and the cursor
  // was not dragged onto the paid account by a Fable-only diversion.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
});

// ── hard gates still bind ────────────────────────────────────

test('hard gates are not overridden', async (t) => {
  const cases = {
    disabled: a => { a.disabled = true; },
    'live 429 hold': a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; a.throttledAt = Date.now(); },
    error: a => { a.status = 'error'; },
    'maxUsage cap': a => { a.maxUsage = 1.2; setQuota(a, { unified7d: 1.25 }); },
    'entitlement cooldown': a => { a.entitlementDeniedUntil = Date.now() + 60_000; },
    'overage off upstream': a => { a.quota.spend = { enabled: false }; },
  };
  for (const [name, arm] of Object.entries(cases)) {
    await t.test(name, () => {
      const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
      arm(am.accounts[1]);
      assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
    });
  }
});

test('a maxUsage above 1.0 is a spend limit: overage serves until it binds', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true, maxUsage: 1.5 })]);
  setQuota(am.accounts[1], { unified7d: 1.2 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  setQuota(am.accounts[1], { unified7d: 1.5 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
});

test('unknown spend is allowed, known-enabled spend is allowed', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  assert.equal(am.accounts[1].quota.spend, null);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  am.accounts[1].quota.spend = { enabled: true };
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
});

test('route ownership still binds the fallback', () => {
  const am = spentFleet([
    oauth('owner', { models: [FABLE] }),
    oauth('paid', { allowExtraUsage: true }),
  ]);
  // A model owned by another account never lands on the paid one.
  assert.equal(quietly(() => am.getActiveAccount(null, FABLE)), null);
});

test('the provider partition still binds the fallback', () => {
  // Only an Anthropic login can opt in, so the partition is tested from the
  // other side: a request on the Codex path never lands on the Anthropic paid
  // account, however spent the Codex fleet is.
  const am = spentFleet([oauth('codex', { provider: 'codex' }), oauth('paid', { allowExtraUsage: true })]);
  assert.equal(quietly(() => am.getActiveAccount(null, null, null, null, 'codex')), null);
});

// ── automatic return ─────────────────────────────────────────

test('selection returns to a normal account once its window resets', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  setQuota(am.accounts[0], { unified7dReset: Date.now() + 5_000 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);

  // The window rolls over: _clearExpiredQuotas drops the spent reading.
  setQuota(am.accounts[0], { unified7dReset: Date.now() - 1 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

test('the episode ends when the paid account itself has headroom again, with no request in between', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
  assert.equal(am.getStatus().currentAccounts.anthropic, 'paid');
  // Its own window resets. Nothing asks for Opus again; status alone must
  // stop calling it "billing".
  setQuota(am.accounts[1], { unified7d: 0.1 });
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
    assert.equal(am.onExtraUsage(1), false);
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter(l => l.includes('leaving extra usage')).length, 1);
  // And the next request neither re-announces nor re-ramps: it is a plain pick.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

test('the episode ends when another account has headroom again, with no request in between', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
  setQuota(am.accounts[0], { unified7d: 0.1 });
  assert.equal(quietly(() => am.getStatus()).accounts[1].onExtraUsage, false);
  // The cursor did not stay parked on the paid account either.
  assert.equal(am.getStatus().currentAccounts.anthropic, 'a');
});

test('an episode follows its account, not its index, when another account is removed', () => {
  const am = spentFleet([oauth('gone'), oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.getStatus().accounts[2].onExtraUsage, true);
  quietly(() => am.removeAccount(0));
  const status = am.getStatus();
  assert.deepEqual(status.accounts.map(a => [a.name, a.onExtraUsage]), [['a', false], ['paid', true]]);
  assert.equal(am.onExtraUsage(1), true);
  assert.equal(am.onExtraUsage(0), false);
});

test('removing the paid account itself ends its episode', () => {
  const am = spentFleet([oauth('paid', { allowExtraUsage: true }), oauth('a')]);
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.onExtraUsage(0), true);
  quietly(() => am.removeAccount(0));
  assert.equal(am.onExtraUsage(0), false);
  // onExtraUsage moves nothing (the TUI calls it per row on every paint); the
  // status read is what sweeps the orphaned episode away.
  assert.equal(am.getStatus().accounts[0].onExtraUsage, false);
  assert.equal(am._extraUsage.size, 0);
});

test('the switch onto and off extra usage is logged once each, not per request', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    for (let i = 0; i < 5; i++) am.getActiveAccount(null, OPUS);
    setQuota(am.accounts[0], { unified7d: 0.1 });
    for (let i = 0; i < 3; i++) am.getActiveAccount(null, OPUS);
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter(l => l.includes('on extra usage')).length, 1);
  assert.equal(lines.filter(l => l.includes('leaving extra usage')).length, 1);
});

// ── pickAlternate (the failover hops) ────────────────────────

test('pickAlternate reaches the fallback when the fleet is spent, moving nothing', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  am.currentIndex = 0;
  const alt = am.pickAlternate(new Set([0]), OPUS);
  assert.equal(alt?.name, 'paid');
  // A detour, not a decision about where the fleet rests (#286).
  assert.equal(am.currentIndex, 0);
  assert.equal(am.accounts[1].rampStartedAt, null);
});

test('a paid hop is logged once per episode and shows in status, still moving nothing', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  am.currentIndex = 0;
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    for (let i = 0; i < 4; i++) assert.equal(am.pickAlternate(new Set([0]), OPUS)?.name, 'paid');
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter(l => l.includes('Failover hop onto "paid" on extra usage')).length, 1);
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
  assert.equal(am.currentIndex, 0);
  assert.equal(am.accounts[1].rampStartedAt, null);

  // The fleet then really moves there: announced already, so no second enter
  // line, but the ramp the hop deliberately skipped starts now.
  const more = [];
  console.log = (...args) => more.push(args.join(' '));
  try {
    assert.equal(am.getActiveAccount(null, OPUS).name, 'paid');
  } finally {
    console.log = log;
  }
  assert.equal(more.filter(l => l.includes('extra usage')).length, 0);
  assert.notEqual(am.accounts[1].rampStartedAt, null);
});

// Availability is model-scoped, so the episode is too. With every Fable
// bucket spent and Opus fine, alternating requests used to end and restart
// the episode on every request: a log pair and a ramp restart each time.
test('alternating Fable/Opus: one enter log, no leave, no ramp restart', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  for (const acc of am.accounts) setQuota(acc, { unified7d: 0.3, unified7dFable: 1.0 });
  am._nextProbeAt = Date.now() + 60 * 60_000;
  am.currentIndex = 0;
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let rampAfterFirst;
  try {
    for (let i = 0; i < 6; i++) {
      assert.equal(am.getActiveAccount(null, FABLE).name, 'paid');
      if (i === 0) { rampAfterFirst = am.accounts[1].rampStartedAt = 1; }
      assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
      assert.equal(am.getStatus().accounts[1].onExtraUsage, true);
    }
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter(l => l.includes('on extra usage')).length, 1);
  assert.equal(lines.filter(l => l.includes('leaving extra usage')).length, 0);
  assert.equal(am.accounts[1].rampStartedAt, rampAfterFirst);
});

test('pickAlternate does not start billing to skip a wait on a healthy account', () => {
  // `a` is under threshold and merely paused by a per-minute 429 — it is still
  // available, so the hop must not land on the paid account.
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.5 });
  setQuota(am.accounts[1], { unified7d: 0.99 });
  assert.equal(am.pickAlternate(new Set([0]), OPUS), null);
});

// ── status and config ────────────────────────────────────────

test('the flag and the serving state are visible in status output', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  const [a, paid] = am.getStatus().accounts;
  assert.equal(a.allowExtraUsage, false);
  assert.equal(paid.allowExtraUsage, true);
  assert.equal(paid.onExtraUsage, true);
  const paint = new Proxy({}, { get: () => v => String(v) });
  assert.match(unavailableLine(paid, paint), /serving on extra usage/);
  assert.doesNotMatch(unavailableLine(a, paint), /extra usage/);
});

test('only a literal true opts in', () => {
  const am = new AccountManager([oauth('a', { allowExtraUsage: 'yes' }), oauth('b', { allowExtraUsage: true })], 0.98);
  assert.equal(am.accounts[0].allowExtraUsage, false);
  assert.equal(am.accounts[1].allowExtraUsage, true);
});

test('the opt-in is honoured on Anthropic OAuth accounts only, and says so once', () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  let am;
  try {
    am = new AccountManager([
      { name: 'key', type: 'apikey', apiKey: 'k', allowExtraUsage: true },
      oauth('backend', { upstream: 'https://api.example.com/anthropic', allowExtraUsage: true }),
      oauth('codex', { provider: 'codex', allowExtraUsage: true }),
      oauth('paid', { allowExtraUsage: true }),
    ], 0.98);
  } finally {
    console.warn = original;
  }
  assert.deepEqual(am.accounts.map(a => a.allowExtraUsage), [false, false, false, true]);
  const ignored = warned.filter(l => l.includes('allowExtraUsage is ignored'));
  assert.deepEqual(ignored.map(l => /Account "([^"]+)"/.exec(l)?.[1]), ['key', 'backend', 'codex']);
  // The one account that can bill was not warned about.
  assert.equal(ignored.some(l => l.includes('"paid"')), false);
});

test('a reload cannot opt in an account the fallback cannot bill', async () => {
  const config = [oauth('codex', { provider: 'codex' }), oauth('paid')];
  const am = new AccountManager(config.map(c => ({ ...c })), 0.98);
  const disk = [oauth('codex', { provider: 'codex', allowExtraUsage: true }), oauth('paid', { allowExtraUsage: true })];
  await quietly(() => syncAccountsFromDisk({ accounts: disk }, { accounts: config }, am));
  assert.deepEqual(am.accounts.map(a => a.allowExtraUsage), [false, true]);
});

test('a config reload applies the opt-in live, both ways', async () => {
  const config = [oauth('a'), oauth('paid')];
  const am = spentFleet(config.map(c => ({ ...c })));
  assert.equal(am.getActiveAccount(null, OPUS), null);

  const disk = [oauth('a'), oauth('paid', { allowExtraUsage: true })];
  await quietly(() => syncAccountsFromDisk({ accounts: disk }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, true);
  assert.equal(config[1].allowExtraUsage, true);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');

  // Turning it off must stop the spending now, not at the next restart.
  await quietly(() => syncAccountsFromDisk({ accounts: [oauth('a'), oauth('paid')] }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, false);
  assert.equal('allowExtraUsage' in config[1], false);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
});

// ── through the server ───────────────────────────────────────

// The recommended ordering end to end: the due probe lands on the spent normal
// account, upstream rejects it on quota, and the retry reaches the paid account
// instead of answering the client with a 429.
async function throughProxy(respondToA) {
  const { createProxyServer } = await import('../src/server.js');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const who = String(req.headers.authorization || '').replace('Bearer t-', '');
    seen.push(who);
    req.resume();
    if (who === 'a') return respondToA(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[]}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, priority: 1 })], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 1.0 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const log = console.log;
  console.log = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    return { status: res.status, seen };
  } finally {
    console.log = log;
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections?.();
  }
}

test('server: a quota-rejected probe is retried on the extra-usage account', async () => {
  const { status, seen } = await throughProxy(res => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '3600',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}');
  });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['a', 'paid']);
});

test('server: a rate-limited probe hops to the extra-usage account', async () => {
  const { status, seen } = await throughProxy(res => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '30',
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
  });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['a', 'paid']);
});

// ── the cursor under session distribution ────────────────────

// Live repro: under distribution the session walks never move the shared
// cursor, so once the fallback parked it on the paid account nothing moved it
// off — traffic went back to a normal account while status kept naming the
// paid one as current, which reads as still billing.
function liveRepro(distributeSessions) {
  const am = new AccountManager([
    oauth('L', { allowExtraUsage: true, priority: 0 }),
    oauth('R', { priority: 2 }),
  ], 0.98, { distributeSessions });
  const [L, R] = am.accounts;
  setQuota(L, { unified7d: 1.0, unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now(), spend: { enabled: true } });
  setQuota(R, { unified7d: 1.0 });
  am._nextProbeAt = Date.now() + 60 * 60_000;
  return { am, L, R };
}

for (const mode of [true, 'adaptive']) {
  test(`distributeSessions ${JSON.stringify(mode)}: the cursor leaves the paid account once a normal one can serve`, () => {
    const { am, L, R } = liveRepro(mode);
    quietly(() => {
      assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'L');
      am.recordSession('sess-1', L.index, OPUS);
      assert.equal(am.getStatus().currentAccounts.anthropic, 'L');

      // The operator raises the threshold: R has headroom, L is still refused
      // upstream. Every session moves to R — including the one pinned to L,
      // since a pin is honoured only while its account is eligible.
      am.switchThreshold = 1.05;
      assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'R');
      am.recordSession('sess-1', R.index, OPUS);
      assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-2').name, 'R');
    });
    const status = am.getStatus();
    assert.equal(status.currentAccounts.anthropic, 'R');
    assert.equal(status.currentAccount, 'R');
    assert.equal(status.accounts[0].onExtraUsage, false);
  });
}

test('a draining session is not held on the paid account either', () => {
  const { am, L } = liveRepro(true);
  quietly(() => {
    assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'L');
    am.recordSession('sess-1', L.index, OPUS);
    am.setDistributeSessions(false);
    assert.equal(am._isDrainingSession('sess-1'), true);
    am.switchThreshold = 1.05;
    assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'R');
  });
  assert.equal(am.getStatus().currentAccounts.anthropic, 'R');
});

test('the cursor stays on the paid account while nothing else can serve', () => {
  const { am } = liveRepro('adaptive');
  quietly(() => {
    for (let i = 0; i < 3; i++) assert.equal(am.getActiveAccount(null, OPUS, null, `s${i}`).name, 'L');
  });
  assert.equal(am.getStatus().currentAccounts.anthropic, 'L');
});

// ── dashboards ───────────────────────────────────────────────

test('the status header names the opt-in even while it is unused', async () => {
  const { renderStatus } = await import('../src/status-renderer.js');
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  const text = renderStatus(am.getStatus(), { color: false });
  const lines = text.split('\n');
  assert.ok(lines.some(l => l.includes('paid') && l.includes('extra usage allowed')), text);
  assert.ok(!lines.some(l => /\ba\b \(oauth.*extra usage/.test(l)), text);
});

test('dashboard badges: allowed, then billing', async () => {
  const { accountBadges } = await import('../src/dashboard.js');
  const texts = acct => accountBadges(acct, 'x', null).filter(b => b.cls.startsWith('extra-usage'));
  assert.deepEqual(texts({ name: 'p' }), []);
  assert.deepEqual(texts({ name: 'p', allowExtraUsage: true }), [{ cls: 'extra-usage', text: 'extra usage allowed' }]);
  assert.deepEqual(texts({ name: 'p', allowExtraUsage: true, onExtraUsage: true }),
    [{ cls: 'extra-usage billing', text: 'on extra usage — billing' }]);
});

test('TUI row tag: xu while allowed, xu! while billing, same in attach mode', async () => {
  const { extraUsageTag } = await import('../src/tui.js');
  const { RemoteAccountManager } = await import('../src/tui-remote.js');
  assert.equal(extraUsageTag(false, false), '');
  assert.equal(extraUsageTag(true, false), 'xu');
  assert.equal(extraUsageTag(true, true), 'xu!');

  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.onExtraUsage(1), true);
  const remote = new RemoteAccountManager();
  remote.applyStatus(JSON.parse(JSON.stringify(am.getStatus())));
  assert.equal(remote.accounts[1].allowExtraUsage, true);
  assert.equal(remote.onExtraUsage(1), true);
  assert.equal(remote.onExtraUsage(0), false);
  // A non-boolean from the other end never reads as billing.
  remote.applyStatus({ accounts: [{ name: 'x', onExtraUsage: 'yes', allowExtraUsage: 1 }] });
  assert.equal(remote.onExtraUsage(0), false);
  assert.equal(remote.accounts[0].allowExtraUsage, false);
});

// The row is budgeted to the terminal cell (#228, #234); the tag is one more
// column that budget has to know about.
test('the extra-usage tag is drawn and never pushes a TUI row past the edge', async () => {
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const am = spentFleet([
    oauth('plain@example.com'),
    oauth('allowed@example.com', { allowExtraUsage: true }),
    oauth('billing@example.com', { allowExtraUsage: true, priority: -1 }),
  ]);
  for (const a of am.accounts) {
    setQuota(a, { unified5h: 0.4, unified5hReset: Date.now() + 3600_000, unified7dReset: Date.now() + 86400_000,
      unified7dFable: 0.2, unified7dFableReset: Date.now() + 86400_000, spend: { enabled: true, usedMinor: 5 } });
  }
  quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(am.onExtraUsage(2), true);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  try {
    for (const w of [60, 70, 80, 100, 140]) {
      Object.defineProperty(process.stdout, 'columns', { value: w, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
      const drawn = [];
      const real = tui._renderAcct.bind(tui);
      tui._renderAcct = (...args) => { const out = real(...args); drawn.push(strip(out)); return out; };
      tui._paint = () => {};
      tui.running = true;
      tui.render(true);
      tui._renderAcct = real;
      assert.ok(Math.max(...drawn.map(r => r.length)) <= w, `W=${w}`);
      assert.ok(drawn.some(r => /xu!\s*$/.test(r)), `W=${w}: billing tag missing`);
      assert.ok(drawn.some(r => /\bxu\s*$/.test(r)), `W=${w}: allowed tag missing`);
    }
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
});
