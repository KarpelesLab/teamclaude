import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// `expiry` is passed through exactly as given, absent included: the flag-off
// comparisons below depend on the config key genuinely not being there, and a
// default parameter would turn `undefined` back into the knob's ON value.
function mgr(names, opts = {}) {
  const { expiry, ...rest } = opts;
  return new AccountManager(names.map(n => oauth(n)), 0.98,
    'expiry' in opts ? { expiryRouting: expiry, ...rest } : rest);
}

// The knob as these tests spell it, so no call site can mean "off" by omission.
const ON = { enabled: true };
const OFF = undefined;

function near(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12,
    `${what}: ${actual} is not ${expected}`);
}

// Set a weekly bucket: `used` fraction spent, window resetting in `hours`. Both
// halves together, which is the pairing pressure depends on.
//
// `base` exists because pressure is a function of the instant it is read at, so
// a test comparing two readings must take them against ONE clock: left to
// default, a millisecond between the fixture's `Date.now()` and each
// `_expiryPressure` call shifts the value more than an exact comparison
// tolerates.
function bucket(am, index, key, used, hours, base = Date.now()) {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = base + hours * H;
  am.accounts[index].probing = false;
}

// ---------------------------------------------------------------------------
// Pressure itself
// ---------------------------------------------------------------------------

test('pressure divides the governing bucket by its OWN clock, never another bucket\'s', () => {
  const am = mgr(['a'], { expiry: ON });
  const q = am.accounts[0].quota;
  // A Fable utilization with no Fable window, beside a shared window that is
  // reported. Borrowing that horizon would rank this account on quota it does
  // not have, and steer Fable traffic into the most Fable-spent account there is.
  q.unified7dFable = 0.1;
  q.unified7d = 0.5;
  q.unified7dReset = Date.now() + 10 * H;
  assert.equal(am._expiryPressure(am.accounts[0], FABLE), null);
  // The shared bucket, which does report both halves, is measurable as usual.
  assert.ok(am._expiryPressure(am.accounts[0], OPUS) > 0);
});

test('a request is scored on the weekly bucket of ITS family', () => {
  const am = mgr(['a'], { expiry: ON });
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.9, 10, now);
  bucket(am, 0, 'unified7dFable', 0.1, 10, now);
  const opus = am._expiryPressure(am.accounts[0], OPUS, now);
  const fable = am._expiryPressure(am.accounts[0], FABLE, now);
  near(opus, 0.1 / (10 * 3600), 'opus pressure');
  near(fable, 0.9 / (10 * 3600), 'fable pressure');
});

test('a family with no bucket of its own falls back to the shared weekly', () => {
  const am = mgr(['a'], { expiry: ON });
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.25, 4, now);
  assert.equal(am._expiryPressure(am.accounts[0], FABLE, now),
    am._expiryPressure(am.accounts[0], OPUS, now));
});

// ---------------------------------------------------------------------------
// Ordering, and the drained-account guard
// ---------------------------------------------------------------------------

// a resets soonest but is nearly spent; b holds the quota actually worth
// spending; c is neither. Reset time alone picks a; pressure picks b.
function drainFleet(opts) {
  const am = mgr(['a', 'b', 'c'], opts);
  bucket(am, 0, 'unified7d', 0.95, 2);
  bucket(am, 1, 'unified7d', 0.05, 10);
  bucket(am, 2, 'unified7d', 0.50, 50);
  return am;
}

test('rotation spends the account holding expiring quota, not the one resetting soonest', () => {
  assert.equal(drainFleet({ expiry: ON }).selectActiveAccount().name, 'b');
});

test('with the knob off the same fleet still rotates on the reset timestamp alone', () => {
  assert.equal(drainFleet({ expiry: OFF }).selectActiveAccount().name, 'a');
});

test('an account whose window nobody has reported ranks in the top band', () => {
  // Its reset is the furthest out in the fleet, so the reset tiebreak ranks it
  // last. Unknown pressure ranks it first: using it is how the quota is learned.
  const build = expiry => {
    const am = mgr(['a', 'b'], { expiry });
    am.accounts[0].quota.unified7dReset = Date.now() + 100 * H; // no utilization
    am.accounts[0].probing = false;
    bucket(am, 1, 'unified7d', 0.05, 10);
    return am;
  };
  assert.equal(build(ON).selectActiveAccount().name, 'a');
  assert.equal(build(OFF).selectActiveAccount().name, 'b');
});

test('a KNOWN-SPENT account with no clock does not outrank measured expiring quota', () => {
  // The one state where "nothing is known" is false: the family utilization is
  // reported and its window is not. Both real quota writers set the two under
  // independent conditionals, so a report carrying one without the other lands
  // here. Ranked as pure discovery it would put the account 95% through its
  // Fable quota ahead of one holding 95% of it with an hour to go.
  const build = expiry => {
    const am = mgr(['spent-unpaired', 'ample-expiring'], { expiry, distributeSessions: true });
    const q = am.accounts[0].quota;
    q.unified7dFable = 0.95;          // known, and nearly gone
    q.unified7dFableReset = null;     // but no clock
    q.unified7d = 0.10;
    q.unified7dReset = Date.now() + 200 * H;
    am.accounts[0].probing = false;
    bucket(am, 1, 'unified7dFable', 0.05, 1);
    bucket(am, 1, 'unified7d', 0.10, 200);
    return am;
  };
  for (const expiry of [ON, OFF]) {
    const am = build(expiry);
    assert.equal(am._pickBestAvailable(null, FABLE).name, 'ample-expiring',
      `_pickBestAvailable with expiry ${expiry ? 'on' : 'off'}`);
    assert.equal(am._pickLeastLoaded(null, FABLE).name, 'ample-expiring',
      `_pickLeastLoaded with expiry ${expiry ? 'on' : 'off'}`);
  }
  // Still admitted, and still published as unknown on the wire: being used is
  // how the missing window gets reported.
  assert.deepEqual(build(ON)._bandedCandidates(null, FABLE).map(a => a.name),
    ['spent-unpaired', 'ample-expiring']);
  assert.equal(build(ON)._expiryPressure(build(ON).accounts[0], FABLE), null);
});

test('a clockless account still outranks measured quota it genuinely beats', () => {
  // The other direction, so the bound orders rather than demotes: an account
  // holding almost its whole window beats a measured trickle even when scored
  // against the most pessimistic horizon a weekly window can have.
  const am = mgr(['ample-noclock', 'spent-farout'], { expiry: ON });
  const q = am.accounts[0].quota;
  q.unified7dFable = 0.05;
  q.unified7dFableReset = null;
  q.unified7d = 0.10;
  q.unified7dReset = Date.now() + 200 * H;
  am.accounts[0].probing = false;
  bucket(am, 1, 'unified7dFable', 0.95, 24 * 7);
  bucket(am, 1, 'unified7d', 0.10, 200);
  assert.equal(am._pickBestAvailable(null, FABLE).name, 'ample-noclock');
});

test('the band narrows and widens with the tolerance ratio', () => {
  const bandNames = tolerance => {
    const am = drainFleet({ expiry: { enabled: true, tolerance } });
    return am._bandedCandidates().map(a => a.name);
  };
  // b is the maximum; a is 3.8x behind it and c is 9.5x behind.
  assert.deepEqual(bandNames(1), ['b']);
  assert.deepEqual(bandNames(1.5), ['b']);
  assert.deepEqual(bandNames(4), ['a', 'b']);
  assert.deepEqual(bandNames(10), ['a', 'b', 'c']);
});

test('the band is inert with the knob off — every eligible account survives it', () => {
  const am = drainFleet({ expiry: OFF });
  assert.deepEqual(am._bandedCandidates().map(a => a.name), ['a', 'b', 'c']);
  // And the ranking term is absent for all of them, which is the whole off
  // switch: it cannot discriminate rather than being branched around.
  assert.deepEqual(am._rankedPressures(am.accounts, null, Date.now()), [-Infinity, -Infinity, -Infinity]);
});

test('an operator\'s priority order still wins outright over pressure', () => {
  const am = new AccountManager([
    oauth('cheap', { priority: 1 }),
    oauth('preferred', { priority: 0 }),
  ], 0.98, { expiryRouting: { enabled: true } });
  bucket(am, 0, 'unified7d', 0.01, 1);   // enormous pressure, wrong tier
  bucket(am, 1, 'unified7d', 0.90, 100); // feeble pressure, the preferred tier
  assert.equal(am.selectActiveAccount().name, 'preferred');
  // The lower tier is still reachable — it is passed through, never banded out.
  assert.deepEqual(am._bandedCandidates().map(a => a.name), ['preferred', 'cheap']);
});

// ---------------------------------------------------------------------------
// Band filtering in the three selection paths
// ---------------------------------------------------------------------------

test('path 1 (rotation): the band narrows what _selectNext may rotate onto', () => {
  const build = expiry => {
    const am = mgr(['cur', 'a', 'b'], { expiry });
    am.accounts[0].disabled = true; // force the walk past the current account
    bucket(am, 1, 'unified7d', 0.95, 2);
    bucket(am, 2, 'unified7d', 0.05, 10);
    return am;
  };
  assert.equal(build(ON).getActiveAccount(null, OPUS).name, 'b');
  assert.equal(build(OFF).getActiveAccount(null, OPUS).name, 'a');
});

test('path 1 scores each family on its own bucket, so two models split the fleet', () => {
  // a holds its Fable quota and has spent its shared weekly; b is the mirror.
  // A fresh manager per model, because the first request makes its answer the
  // sticky current account and the second would then never reach the band.
  const build = () => {
    const am = mgr(['cur', 'a', 'b'], { expiry: ON });
    am.accounts[0].disabled = true; // force the walk past the current account
    bucket(am, 1, 'unified7d', 0.9, 10);
    bucket(am, 1, 'unified7dFable', 0.1, 10);
    bucket(am, 2, 'unified7d', 0.1, 10);
    bucket(am, 2, 'unified7dFable', 0.9, 10);
    return am;
  };
  assert.equal(build().getActiveAccount(null, OPUS).name, 'b');
  assert.equal(build().getActiveAccount(null, FABLE).name, 'a');
});

test('path 2 (new session): the band narrows where distribution may place it', () => {
  const build = expiry => {
    const am = mgr(['a', 'b'], { expiry, distributeSessions: true });
    bucket(am, 0, 'unified7d', 0.95, 2);
    bucket(am, 1, 'unified7d', 0.05, 10);
    return am;
  };
  assert.equal(build(ON).getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
  assert.equal(build(OFF).getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
});

test('path 2: inside the band, pressure breaks a load tie ahead of the reset', () => {
  // Both accounts sit inside a 1.5 tolerance and carry no sessions, so the pick
  // reaches the two terms that disagree: a resets sooner, b holds more.
  const build = expiry => {
    const am = mgr(['a', 'b'], { expiry, distributeSessions: true });
    bucket(am, 0, 'unified7d', 0.9, 2);
    bucket(am, 1, 'unified7d', 0.3, 12);
    return am;
  };
  assert.deepEqual(build(ON)._bandedCandidates().map(a => a.name), ['a', 'b']);
  assert.equal(build(ON).getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
  assert.equal(build(OFF).getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
});

test('path 2: load still spreads sessions across the accounts the band admitted', () => {
  // The band is a set, not a sort: within it the #109 protection is unchanged.
  const am = mgr(['a', 'b'], { expiry: { enabled: true, tolerance: 10 }, distributeSessions: true });
  bucket(am, 0, 'unified7d', 0.5, 10);
  bucket(am, 1, 'unified7d', 0.5, 10);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  am.recordSession('sess-1', first.index, OPUS);
  const second = am.getActiveAccount(null, OPUS, null, 'sess-2');
  assert.notEqual(second.index, first.index);
});

test('path 3 (session-quota reset): a switch onto a spent account is vetoed', () => {
  // The current account holds the quota worth spending; the challenger merely
  // resets sooner, which is the metric this feature exists to correct.
  const build = expiry => {
    const am = mgr(['cur', 'b'], { expiry });
    bucket(am, 0, 'unified7d', 0.05, 10);
    bucket(am, 1, 'unified7d', 0.95, 2);
    const q = am.accounts[1].quota;
    q.unified5h = 0.5;
    q.unified5hReset = Date.now() - 1000; // its 5h window just expired
    return am;
  };
  const off = build(OFF);
  off.refreshExpiredQuotas();
  assert.equal(off.accounts[off.currentIndex].name, 'b');

  const on = build(ON);
  on.refreshExpiredQuotas();
  assert.equal(on.accounts[on.currentIndex].name, 'cur');
});

test('path 3: a band member with strictly worse pressure is still refused', () => {
  // Widening the tolerance puts the challenger back in the band, so membership
  // is not what stops it. The rank comparison is the guard that does, and the two
  // are different properties: one says worth spending, the other says not worse.
  const build = () => {
    const am = mgr(['cur', 'b'], { expiry: { enabled: true, tolerance: 100 } });
    bucket(am, 0, 'unified7d', 0.05, 10);
    bucket(am, 1, 'unified7d', 0.95, 2);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000; // its 5h just expired
    return am;
  };
  // Membership is asked of a TWIN, never of the manager under test: reading
  // eligibility clears expired windows as a side effect, so asking here would
  // consume the very session reset the switch is triggered by, and the
  // assertion below would pass without the switch ever having been considered.
  assert.deepEqual(build()._bandedCandidates().map(a => a.name), ['cur', 'b']);
  const am = build();
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'cur');
});

test('path 3: a switch onto an account the band excluded is refused too', () => {
  // The challenger holds MORE expiring quota than the account we are on, so the
  // rank comparison has no objection. What stops it is that a same-tier peer
  // holds far more still, which banded the challenger out — selection would not
  // have chosen it either, so a reset must not install it.
  const build = () => {
    const am = mgr(['cur', 'b', 'hot'], { expiry: ON });
    bucket(am, 0, 'unified7d', 0.50, 50); // 2.78e-6
    bucket(am, 1, 'unified7d', 0.40, 40); // 4.17e-6 — better than cur
    bucket(am, 2, 'unified7d', 0.00, 10); // 2.78e-5 — the band's maximum
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000;
    return am;
  };
  assert.deepEqual(build()._bandedCandidates().map(a => a.name), ['hot']);
  const am = build();
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'cur');
});

test('path 3 still switches when the sooner-resetting account is the better one', () => {
  const am = mgr(['cur', 'b'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.9, 100);
  bucket(am, 1, 'unified7d', 0.1, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'b');
});

// ---------------------------------------------------------------------------
// The 5h bucket is a gate, not a ranking term
// ---------------------------------------------------------------------------

test('the five-hour bucket gates availability and never enters the score', () => {
  const am = mgr(['a', 'b'], { expiry: ON });
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.5, 10, now);
  bucket(am, 1, 'unified7d', 0.5, 10, now);
  const before = am._expiryPressure(am.accounts[0], OPUS, now);
  // A 5h window an hour from reset is a ~30x shorter horizon; scoring it would
  // drown the weekly comparison this ordering exists to make.
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[0].quota.unified5hReset = now + 1 * H;
  assert.equal(am._expiryPressure(am.accounts[0], OPUS, now), before);
  // Spent, it removes the account from the band entirely — as a gate.
  am.accounts[0].quota.unified5h = 0.99;
  assert.deepEqual(am._bandedCandidates().map(a => a.name), ['b']);
});
