import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { DEFAULT_PROVIDER } from '../src/provider.js';

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
  return new AccountManager(names.map(n => (typeof n === 'string' ? oauth(n) : n)), 0.98,
    'expiry' in opts ? { expiryRouting: expiry, ...rest } : rest);
}

// The knob as these tests spell it, so no call site can mean "off" by omission.
const ON = { enabled: true };
const OFF = undefined;

// A request's exclusion set, empty. With the knob on the refresh spends a session
// reset only for a caller carrying one; without it the call reads as a poll.
const asRequest = () => new Set();

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

test('a LEARNED family bucket is read, not the shared weekly it hides behind', () => {
  // Upstream meters some families with a weekly bucket the family table has
  // never heard of, reported scoped to the family and learned at runtime
  // (#231). The gate takes the tighter of that and the shared weekly; pressure
  // must read the same one, or an account with 10% of its Opus quota left is
  // credited with the shared window's 90% headroom and ranks first.
  const am = mgr(['a', 'b'], { expiry: ON });
  const now = Date.now();
  bucket(am, 0, 'unified7d', 0.10, 48, now);
  bucket(am, 1, 'unified7d', 0.50, 48, now);
  am.accounts[0].quota.scopedWeekly = { opus: { utilization: 0.90, resetAt: now + 48 * H } };

  assert.equal(am._governingWeekly(am.accounts[0], OPUS), 0.90);
  near(am._expiryPressure(am.accounts[0], OPUS, now), 0.10 / (48 * 3600), 'scoped headroom');
  assert.ok(am._expiryPressure(am.accounts[0], OPUS, now) < am._expiryPressure(am.accounts[1], OPUS, now),
    'the scoped-spent account must not outrank the one with real headroom');
  assert.deepEqual(am._topPressureBand(am.accounts, OPUS).map(a => a.name), ['b']);

  // A family the scoped map says nothing about still reads the shared weekly.
  near(am._expiryPressure(am.accounts[0], FABLE, now), 0.90 / (48 * 3600), 'unscoped family');
});

test('the gate and the ranking read the same number, however the bucket resolves', () => {
  // The scoped reading answers for the REQUEST's bucket, not for whichever
  // window that bucket fell back to: following the collapse into scopedWeekly
  // would disagree with the gate in exactly the cases it does not consult.
  // Both halves are checked, not just the number — the ratio is only a rate
  // when one window supplies both of its terms.
  const now = Date.now();
  const SC = now + 12 * H;
  const SH = now + 40 * H;
  const FB = now + 30 * H;
  const scoped = { opus: { utilization: 0.90, resetAt: SC } };
  const fableScoped = { fable: { utilization: 0.95, resetAt: now + 5 * H } };
  const cases = [
    ['scoped binds', OPUS, SC,
      q => Object.assign(q, { unified7d: 0.10, unified7dReset: SH, scopedWeekly: scoped })],
    ['shared binds', OPUS, SH,
      q => Object.assign(q, { unified7d: 0.95, unified7dReset: SH, scopedWeekly: scoped })],
    ['no scoped map', OPUS, SH,
      q => Object.assign(q, { unified7d: 0.40, unified7dReset: SH, scopedWeekly: {} })],
    ['malformed entry', OPUS, SH,
      q => Object.assign(q, { unified7d: 0.40, unified7dReset: SH, scopedWeekly: { opus: 7 } })],
    ['family bucket absent', FABLE, SH,
      q => Object.assign(q, { unified7d: 0.10, unified7dReset: SH, scopedWeekly: fableScoped })],
    ['family bucket present', FABLE, FB,
      q => Object.assign(q, { unified7d: 0.10, unified7dReset: SH, unified7dFable: 0.55, unified7dFableReset: FB, scopedWeekly: fableScoped })],
  ];
  for (const [label, model, expectedReset, fill] of cases) {
    const am = mgr(['a'], { expiry: ON });
    fill(am.accounts[0].quota);
    const win = am._governingWindow(am.accounts[0], model);
    assert.equal(win.utilization, am._governingWeekly(am.accounts[0], model), `${label}: utilization`);
    assert.equal(win.resetAt, expectedReset, `${label}: resetAt came from another window`);
  }
  // And with a route override, whether or not the override bucket is reported.
  for (const reported of [false, true]) {
    const am = mgr(['a'], { expiry: ON });
    am.setRoutes([{ name: 'r', match: ['claude-opus-*'], bucket: 'unified7dCustom' }]);
    Object.assign(am.accounts[0].quota, { unified7d: 0.10, unified7dReset: SH, scopedWeekly: scoped });
    if (reported) {
      am.accounts[0].quota.unified7dCustom = 0.70;
      am.accounts[0].quota.unified7dCustomReset = now + 60 * H;
    }
    const win = am._governingWindow(am.accounts[0], OPUS);
    assert.equal(win.utilization, am._governingWeekly(am.accounts[0], OPUS), `route override, reported=${reported}`);
    assert.equal(win.resetAt, reported ? now + 60 * H : SH, `route override reset, reported=${reported}`);
  }
});

test('every reader and the WRITER agree with a table nobody derived from them', () => {
  // Expected values are written out by hand from the quota shape rather than
  // read back out of the helpers under test, which would compare a function with
  // itself. The WRITER is checked alongside the readers, and it has one site: a
  // request arriving to find the cursor already on an account takes the reading.
  // So the guard drives an ordinary selection and reads what it left behind.
  const now = Date.now();
  const SHARED = now + 40 * H;
  const SCOPED = now + 12 * H;
  const FABLE_R = now + 30 * H;
  const cases = [
    {
      label: 'scoped binds — the learned window is spent past the shared one',
      quota: { unified7d: 0.10, unified7dReset: SHARED, scopedWeekly: { opus: { utilization: 0.90, resetAt: SCOPED } } },
      model: OPUS,
      window: 'scoped:opus', utilization: 0.90, resetAt: SCOPED,
    },
    {
      label: 'shared binds — the learned window has more headroom',
      quota: { unified7d: 0.95, unified7dReset: SHARED, scopedWeekly: { opus: { utilization: 0.20, resetAt: SCOPED } } },
      model: OPUS,
      window: 'unified7d', utilization: 0.95, resetAt: SHARED,
    },
    {
      label: 'no scoped map at all',
      quota: { unified7d: 0.40, unified7dReset: SHARED, scopedWeekly: {} },
      model: OPUS,
      window: 'unified7d', utilization: 0.40, resetAt: SHARED,
    },
    {
      label: 'a family with its own field is never scoped-resolved',
      quota: { unified7d: 0.10, unified7dReset: SHARED, unified7dFable: 0.55, unified7dFableReset: FABLE_R, scopedWeekly: { fable: { utilization: 0.95, resetAt: SCOPED } } },
      model: FABLE,
      window: 'unified7dFable', utilization: 0.55, resetAt: FABLE_R,
    },
    {
      label: 'a family whose field is absent collapses onto the shared window',
      quota: { unified7d: 0.10, unified7dReset: SHARED, scopedWeekly: {} },
      model: FABLE,
      window: 'unified7d', utilization: 0.10, resetAt: SHARED,
    },
  ];

  for (const c of cases) {
    const am = mgr(['a'], { expiry: ON });
    Object.assign(am.accounts[0].quota, c.quota);
    const a = am.accounts[0];

    // Readers, each against the hand-written value.
    assert.equal(am._governingWeekly(a, c.model), c.utilization, `${c.label}: gate`);
    assert.equal(am._rankedReset(a, c.model), c.resetAt, `${c.label}: tiebreak`);
    assert.equal(am._governingWindow(a, c.model).window, c.window, `${c.label}: window name`);
    const [snap] = am._bandSnapshot([a], c.model, now).accounts;
    assert.equal(snap.utilization, c.utilization, `${c.label}: band utilization`);
    assert.equal(snap.resetAt, c.resetAt, `${c.label}: band reset`);

    // The WRITER, reached the only way anything reaches it: a request arrives,
    // finds the cursor on this account, and takes its reading. That reading must
    // hold exactly this window at exactly this reset, under this name.
    assert.equal(am.currentIndex, a.index, `${c.label}: the fixture must start on a`);
    am.getActiveAccount(null, c.model);
    assert.equal(am._currentObs.idx, a.index, `${c.label}: the reading named another account`);
    assert.equal(am._currentObs.windows.get(c.window), c.resetAt,
      `${c.label}: the writer stored the wrong reset under ${c.window}`);
  }
});

test('equally spent windows are governed by the one that resets sooner', () => {
  // Two candidate windows equally spent: the number cannot choose and the clock
  // must. Taking the longer one prices the account on quota it will lose before
  // it can spend.
  const now = Date.now();
  const cases = [
    ['scoped resets sooner', now + 10 * H, now + 100 * H, 'scoped:opus', now + 10 * H],
    ['shared resets sooner', now + 100 * H, now + 10 * H, 'unified7d', now + 10 * H],
  ];
  for (const [label, scopedAt, sharedAt, window, resetAt] of cases) {
    const am = mgr(['a'], { expiry: ON });
    Object.assign(am.accounts[0].quota, {
      unified7d: 0.50, unified7dReset: sharedAt,
      scopedWeekly: { opus: { utilization: 0.50, resetAt: scopedAt } },
    });
    const win = am._governingWindow(am.accounts[0], OPUS);
    assert.equal(win.window, window, `${label}: window`);
    assert.equal(win.resetAt, resetAt, `${label}: reset`);
    // The gate reads the same utilization either way — the tie is real.
    assert.equal(am._governingWeekly(am.accounts[0], OPUS), 0.50, `${label}: gate`);
  }
});

test('an equal-pressure tie breaks on the governing window\'s clock, not another', t => {
  // Half the headroom over half the horizon prices identically, so the tie is
  // exact and the next key decides: the governing window's clock, not the shared.
  const now = Date.now();
  // The pickers read their own `Date.now()`, and pressure is a function of the
  // instant it is read at: one millisecond past the fixture's `now` ends the tie
  // and the ranking answers on raw pressure before the tiebreak is consulted.
  // Frozen here so the tie is still a tie when the pickers below read it.
  t.mock.timers.enable({ apis: ['Date'], now });
  const fleet = expiry => {
    const am = mgr(['a', 'b'], { expiry });
    for (const i of [0, 1]) {
      Object.assign(am.accounts[i].quota, { unified5h: 0.1, unified7d: 0.10 });
      am.accounts[i].probing = false;
    }
    am.accounts[0].quota.scopedWeekly = { opus: { utilization: 0.75, resetAt: now + 10 * H } };
    am.accounts[1].quota.scopedWeekly = { opus: { utilization: 0.50, resetAt: now + 20 * H } };
    am.accounts[0].quota.unified7dReset = now + 100 * H;
    am.accounts[1].quota.unified7dReset = now + 5 * H;
    return am;
  };

  const on = fleet(ON);
  assert.equal(on._expiryPressure(on.accounts[0], OPUS, now),
    on._expiryPressure(on.accounts[1], OPUS, now), 'the fixture must tie exactly');
  assert.notEqual(on._rankedReset(on.accounts[0], OPUS), on._rankedReset(on.accounts[1], OPUS),
    'the governing clocks must differ, or candidate order decides');
  assert.equal(on._pickBestAvailable(null, OPUS).name, 'a');
  assert.equal(on._pickLeastLoaded(null, OPUS).name, 'a');

  // With the knob off the older tiebreak is untouched, shared clock and all:
  // the off switch is that this feature's terms go inert.
  const off = fleet(OFF);
  assert.equal(off._pickBestAvailable(null, OPUS).name, 'b');
  assert.equal(off._pickLeastLoaded(null, OPUS).name, 'b');
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
  on.refreshExpiredQuotas(null, asRequest());
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
  // Asked of a TWIN, because this reads the band on a fleet whose cursor the
  // check below is about to move.
  assert.deepEqual(build()._bandedCandidates().map(a => a.name), ['cur', 'b']);
  const am = build();
  // Driven through the refresh, the one place the switch runs, and carrying a
  // request: with the knob on a poll leaves the switch to the next request.
  am.refreshExpiredQuotas(null, asRequest());
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
  // Driven through the refresh itself, as above: the switch has no other caller.
  am.refreshExpiredQuotas(null, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'cur');
});

test('path 3: the reset switch is drawn over what the request can be sent to', () => {
  // A Codex account cannot serve an Anthropic request, so it may neither be
  // switched to nor stop a switch. Here its pressure takes the top band alone.
  const build = (expiry, withCodex) => {
    const fleet = [oauth('cur'), oauth('reset')];
    if (withCodex) fleet.push(oauth('codex', { provider: 'codex' }));
    const am = mgr(fleet, { expiry });
    bucket(am, 0, 'unified7d', 0.50, 50);
    bucket(am, 1, 'unified7d', 0.10, 10);
    if (withCodex) bucket(am, 2, 'unified7d', 0.00, 1);
    // Only the challenger's 5h window has expired, so it alone triggers the switch.
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000;
    return am;
  };
  // Asked of a TWIN, because these read the band on a fleet whose cursor the
  // checks below are about to move.
  const twin = build(ON, true);
  assert.deepEqual(twin._bandedCandidates(null, OPUS).map(a => a.name), ['codex'],
    'the fixture must give the Codex account the band on its own');
  assert.deepEqual(
    twin._bandedCandidates(twin._excludeOtherProviders(null, DEFAULT_PROVIDER), OPUS).map(a => a.name),
    ['reset'], 'the fixture must give the band to the challenger once the request excludes Codex');

  // Through getActiveAccount, where the request's provider partition is built.
  const on = build(ON, true);
  on.getActiveAccount(null, OPUS);
  assert.equal(on.accounts[on.currentIndex].name, 'reset',
    'an account the request cannot be sent to vetoed the switch');

  // Two controls: the same fleet without the foreign account, and with the knob
  // off. Both switch, so neither alone accounts for the divergence.
  const without = build(ON, false);
  without.getActiveAccount(null, OPUS);
  assert.equal(without.accounts[without.currentIndex].name, 'reset');

  const off = build(OFF, true);
  off.getActiveAccount(null, OPUS);
  assert.equal(off.accounts[off.currentIndex].name, 'reset');
});

test('path 3: the reset switch skips an excluded account that also reset', () => {
  // The exclusion has to reach the eligible loop, not only the band guard that
  // vetoes its pick: an account on another provider that also reset is a candidate.
  const am = mgr([oauth('cur'), oauth('reset'), oauth('codex', { provider: 'codex' })], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 10);
  bucket(am, 2, 'unified7d', 0.00, 1);
  // Both challengers reset, so the foreign account is a candidate to walk past.
  for (const i of [1, 2]) {
    am.accounts[i].quota.unified5h = 0.5;
    am.accounts[i].quota.unified5hReset = Date.now() - 1000;
  }
  am.refreshExpiredQuotas(OPUS, am._excludeOtherProviders(null, DEFAULT_PROVIDER));
  // Names the account rather than only ruling out the foreign one: "not codex"
  // would pass on a cursor that never moved.
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the switch let an account the request cannot be sent to decide where it goes');
});

test('path 3: the band that refuses the switch is the fleet\'s, not this attempt\'s tried set', () => {
  // `hot` never reset, so it is nothing this switch may weigh; what it does hold
  // is the fleet's band, which is why a challenger the band leaves out must not
  // become the cursor for every request behind this one. An exclusion that
  // removes a genuine candidate may change the answer, and this does not deny it.
  const build = () => {
    const am = mgr(['cur', 'hot', 'reset'], { expiry: ON });
    bucket(am, 0, 'unified7d', 0.50, 100); // 1.39e-6, the cursor
    bucket(am, 1, 'unified7d', 0.00, 1);   // 2.78e-4, the band's maximum, alone
    bucket(am, 2, 'unified7d', 0.50, 10);  // 1.39e-5, banded out by hot
    am.accounts[2].quota.unified5h = 0.9;
    am.accounts[2].quota.unified5hReset = Date.now() - 1000;
    return am;
  };
  // Asked of TWINS, because reading availability clears the expired window the
  // switch is triggered by.
  assert.deepEqual(build()._bandedCandidates(null, OPUS).map(a => a.name), ['hot'],
    'the fixture must give the band to hot on the whole fleet');
  assert.deepEqual(build()._bandedCandidates(new Set([1]), OPUS).map(a => a.name), ['reset'],
    'the fixture must hand the band to reset once hot is out, or the arm tests nothing');

  // One event, two arriving requests differing only in what they have tried: the
  // 429-hop shape, and a plain request.
  const excluded = build();
  const hop = excluded.getActiveAccount(new Set([1]), OPUS);
  const unexcluded = build();
  unexcluded.getActiveAccount(null, OPUS);
  assert.equal(excluded.accounts[excluded.currentIndex].name,
    unexcluded.accounts[unexcluded.currentIndex].name,
    'the same event left the fleet in two places depending on what the arriving request had tried');

  assert.equal(excluded.accounts[excluded.currentIndex].name, 'cur',
    'the tried account left the band, and the switch installed what the band refuses');
  // The veto costs this request nothing; only the fleet declines to move.
  assert.equal(hop.name, 'cur',
    'the vetoed switch also moved the request off the account it was entitled to');
  // `cur` and not `hot`: the event was spent at the hop, the cursor never moved,
  // and _select returns a live current before any pressure comparison.
  assert.equal(excluded.getActiveAccount(null, OPUS).name, 'cur',
    'the request behind the hop inherited a cursor the fleet band refuses');
});

test('path 3: an exclusion the fleet\'s band survives still lets the switch through', () => {
  // The control for the arm above. The switch is refused when the FLEET's band
  // refuses the challenger, never because the request excluded something: here
  // the tried account holds the band and the challenger is inside it too.
  const am = mgr(['cur', 'hot', 'reset'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 100); // 1.39e-6
  bucket(am, 1, 'unified7d', 0.45, 10);  // 1.53e-5, the band's maximum
  bucket(am, 2, 'unified7d', 0.50, 10);  // 1.39e-5, inside it
  am.accounts[2].quota.unified5h = 0.9;
  am.accounts[2].quota.unified5hReset = Date.now() - 1000;
  am.getActiveAccount(new Set([1]), OPUS);
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'a switch the fleet band admits was refused for excluding a band member');
});

test('path 3: the band that refuses the switch reads the fleet the walk serves, not the fleet the cursor account declares', () => {
  // `_excludeOtherProviders` partitions subscriptions only, so an API-key cursor
  // reads anthropic whatever fleet the walk is serving. Deriving the band's
  // partition from that account bands a Codex switch over the Anthropic fleet,
  // whose top-band account the challenger cannot beat, and the switch is vetoed
  // for a reason no Codex request has anything to do with.
  const build = () => {
    const am = mgr([{ name: 'key', type: 'apikey', apiKey: 'k-key' },
      oauth('cxreset', { provider: 'codex' }), oauth('anhot')], { expiry: ON });
    bucket(am, 0, 'unified7d', 0.50, 100); // the cursor, and an API key: reads anthropic
    bucket(am, 1, 'unified7d', 0.50, 10);  // the Codex fleet's reset candidate
    bucket(am, 2, 'unified7d', 0.00, 1);   // the Anthropic fleet's top band, alone
    am.accounts[1].quota.unified5h = 0.9;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000;
    am.currentIndex = 0;
    return am;
  };
  // Asked of TWINS, because reading availability clears the expired window the
  // switch is triggered by. The two bands differing is the whole discriminator.
  const codex = build();
  assert.deepEqual(
    codex._bandedCandidates(codex._excludeOtherProviders(null, 'codex'), OPUS).map(a => a.name),
    ['cxreset'], 'the fixture must give the Codex partition\'s band to the challenger');
  const anthropic = build();
  assert.deepEqual(
    anthropic._bandedCandidates(anthropic._excludeOtherProviders(null, DEFAULT_PROVIDER), OPUS).map(a => a.name),
    ['anhot'], 'the fixture must hand the Anthropic partition\'s band elsewhere, or the arm tests nothing');

  const am = build();
  const served = am.getActiveAccount(null, OPUS, null, null, 'codex');
  assert.equal(served.name, 'cxreset',
    'the band was drawn over the fleet the cursor account declares, and vetoed a switch the walk\'s own fleet admits');
  // The number, not an index lookup: a vetoed switch leaves no entry at all, and
  // reading `accounts[undefined]` would throw instead of failing here.
  assert.equal(am.providerCursors.get('codex'), 1,
    'the Codex fleet\'s cursor did not follow the switch its own band admitted');
});

test('path 3: a hop that refuses to move does not park the fleet on a paused account', () => {
  // A paused account is still _isAvailable: the pause is the HOP's own test, and
  // it runs after selection has moved the cursor, so a refused hop can leave the
  // fleet somewhere no request wanted. The bound this arm does not close: the
  // switch still never consults isPaused, so an account inside its own pause
  // that genuinely holds the fleet band can still be installed.
  const am = mgr(['cur', 'hot', 'reset'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 100);
  bucket(am, 1, 'unified7d', 0.00, 1);
  bucket(am, 2, 'unified7d', 0.50, 10);
  am.accounts[2].quota.unified5h = 0.9;
  am.accounts[2].quota.unified5hReset = Date.now() - 1000;
  am.pauseAccount(2, 60);
  am.getActiveAccount(new Set([1]), OPUS);
  assert.equal(am.isPaused(am.currentIndex), false,
    'a hop that refused to move parked the fleet inside a rate-limit pause');
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'the refused hop moved the cursor onto the paused account');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'cur',
    'the request behind the refused hop was routed to a paused account');
});

test('path 3: a reset stays pending until a request that can act on it', () => {
  // The reset is fleet state, not this request's, so a window that expires while
  // one request cannot use the account has to outlive that request.
  const am = mgr(['cur', 'reset'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  // Request 1 has already tried the challenger, so the switch may not install it.
  // The flag is what this asserts: the cursor stays put either way.
  am.refreshExpiredQuotas(OPUS, new Set([1]));
  assert.equal(am.accounts[1].sessionResetPending, true,
    'a request that could not use the account consumed its reset');
  assert.equal(am.accounts[am.currentIndex].name, 'cur');

  // Request 2 can be sent there, and nothing re-triggers the event.
  am.refreshExpiredQuotas(OPUS, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the reset never reached a request that could act on it');
});

test('path 3: a request that cannot use the incumbent leaves the reset for one that can', () => {
  // The same rule at the other end of the comparison: the switch measures every
  // candidate against the cursor's account, so a request barred there settles nothing.
  const am = mgr(['cur', 'reset'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  // Request 1 excludes the cursor's own account.
  am.refreshExpiredQuotas(OPUS, new Set([am.currentIndex]));
  assert.equal(am.accounts[1].sessionResetPending, true,
    'a request that could not use the incumbent consumed the reset');
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'the switch decided against an account the request cannot be sent to');

  // Request 2 can be sent to either, and nothing re-triggers the event.
  am.refreshExpiredQuotas(OPUS, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the reset did not survive to a request that could act on it');
});

test('path 3: a request whose model the account cannot serve leaves the reset pending', () => {
  // The face an exclusion set cannot express: the account is out of reach for
  // THIS model alone, though every other model still routes to it.
  const build = expiry => {
    const am = mgr(['cur', 'reset'], { expiry });
    bucket(am, 0, 'unified7d', 0.50, 50);
    bucket(am, 1, 'unified7d', 0.10, 10);
    // Spent for Fable and untouched for Opus, which is the whole fixture.
    bucket(am, 1, 'unified7dFable', 0.99, 10);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000;
    return am;
  };
  // Asked of a TWIN, because reading availability clears expired windows.
  const twin = build(ON);
  assert.equal(twin._isAvailable(twin.accounts[1], FABLE), false,
    'the fixture must bar the challenger from Fable');
  assert.equal(twin._isAvailable(twin.accounts[1], OPUS), true,
    'the fixture must leave the challenger usable for Opus');

  const am = build(ON);
  am.refreshExpiredQuotas(FABLE, asRequest());
  assert.equal(am.accounts[1].sessionResetPending, true,
    'a request the account cannot serve consumed its reset');
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'the switch installed an account this request cannot be sent to');

  // The request behind it, with nothing left to re-trigger the event.
  am.refreshExpiredQuotas(OPUS, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the reset never reached the model that could act on it');

  // The knob-off control on the same fixture: the event is spent on sight
  // whatever model the request carries.
  const off = build(OFF);
  off.refreshExpiredQuotas(FABLE, asRequest());
  assert.equal(off.accounts[1].sessionResetPending, false,
    'the knob-off path left an event the router consumes');
  assert.equal(off.accounts[off.currentIndex].name, 'reset',
    'the knob-off path skipped a switch the router performs');
});

test('path 3: a request the incumbent cannot serve leaves the reset for one it does', () => {
  // The same test at the other end. A request the cursor's account cannot serve
  // is diverted for that request alone and leaves the fleet where it is.
  const build = expiry => {
    const am = mgr(['cur', 'reset'], { expiry });
    bucket(am, 0, 'unified7d', 0.50, 50);
    bucket(am, 0, 'unified7dFable', 0.99, 1);
    bucket(am, 1, 'unified7d', 0.10, 10);
    am.accounts[1].quota.unified5h = 0.5;
    am.accounts[1].quota.unified5hReset = Date.now() - 1000;
    return am;
  };
  const twin = build(ON);
  assert.equal(twin._isAvailable(twin.accounts[0], FABLE), false,
    'the fixture must bar the incumbent from Fable');
  assert.equal(twin._isAvailable(twin.accounts[0], OPUS), true,
    'the fixture must leave the incumbent usable for Opus');

  const am = build(ON);
  am.refreshExpiredQuotas(FABLE, asRequest());
  assert.equal(am.accounts[1].sessionResetPending, true,
    'a request that could not be sent to the incumbent consumed the reset');
  assert.equal(am.accounts[am.currentIndex].name, 'cur');

  am.refreshExpiredQuotas(OPUS, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the reset did not survive to the model that could weigh it');

  // The knob-off control: the incumbent's model decides nothing either.
  const off = build(OFF);
  off.refreshExpiredQuotas(FABLE, asRequest());
  assert.equal(off.accounts[1].sessionResetPending, false,
    'the knob-off path left an event the router consumes');
  assert.equal(off.accounts[off.currentIndex].name, 'reset',
    'the knob-off path skipped a switch the router performs');
});

test('path 3: a poll clears the window and leaves the reset for a request', () => {
  // A poll routes nothing, so a reset it spends is spent nowhere. Driven through
  // getQuotaSummary, which the status-line poller hits several times a minute.
  const am = mgr(['cur', 'reset'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  am.getQuotaSummary();
  assert.equal(am.accounts[1].quota.unified5h, null,
    'the poll must still clear the expired window — that is its job');
  assert.equal(am.accounts[1].sessionResetPending, true,
    'a poll spent the reset');
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'a poll ran the switch');

  // Repeatedly, because the poller is not a one-off.
  for (let i = 0; i < 12; i++) am.getQuotaSummary();
  assert.equal(am.accounts[1].sessionResetPending, true, 'repeated polling wore the reset down');

  // And the request that can act on it still finds it.
  am.refreshExpiredQuotas(OPUS, asRequest());
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the reset the poll left pending never reached the request');
});

test('path 3: the knob-off poll spends the reset on sight', () => {
  // The control for the arm above: with the feature off a poll consumes the
  // event and runs the switch. The same fixture with the knob flipped.
  const am = mgr(['cur', 'reset'], { expiry: OFF });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.10, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;

  am.getQuotaSummary();
  assert.equal(am.accounts[1].sessionResetPending, false,
    'the knob-off poll left an event the router consumes');
  assert.equal(am.accounts[am.currentIndex].name, 'reset',
    'the knob-off poll skipped a switch the router performs');
});

test('path 3: the knob-off switch sees the whole fleet', () => {
  // The exclusion is gated at the call site for the reason the model is. Both
  // challengers rank equally off, so the tiebreak takes the Codex account.
  const am = mgr([oauth('cur'), oauth('anth'), oauth('codex', { provider: 'codex' })], { expiry: OFF });
  bucket(am, 0, 'unified7d', 0.50, 50);
  bucket(am, 1, 'unified7d', 0.50, 40);
  bucket(am, 2, 'unified7d', 0.50, 10);
  for (const i of [1, 2]) {
    am.accounts[i].quota.unified5h = 0.5;
    am.accounts[i].quota.unified5hReset = Date.now() - 1000;
  }
  // The switch's own pick, read before the walk can move the cursor again: an
  // Anthropic request cannot be sent where the knob-off switch installs.
  am.refreshExpiredQuotas(OPUS, am._excludeOtherProviders(null, DEFAULT_PROVIDER));
  assert.equal(am.accounts[am.currentIndex].name, 'codex',
    'the knob-off switch dropped a candidate the router keeps');
});

test('path 3: the knob-off switch keeps a spent account out', () => {
  // With the knob on, refreshExpiredQuotas has already filtered on this test.
  // With it off, this guard alone keeps a spent account out of the switch.
  const am = mgr(['cur', 'spent'], { expiry: OFF });
  bucket(am, 0, 'unified7d', 0.50, 50);
  // Over the threshold and resetting sooner than the incumbent, on an account
  // no request can be sent to.
  bucket(am, 1, 'unified7d', 0.99, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000; // its 5h window just expired

  assert.equal(am._isAvailable(am.accounts[1], null), false,
    'the fixture must make the challenger unavailable, or it gates nothing');
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'cur',
    'the knob-off switch installed an account whose weekly is spent');
});

test('path 3: the knob-off switch reads no account the band would have read', () => {
  // The band expression sits inside the `&&` so the knob-off path evaluates none
  // of it, and that placement is behaviour and not tidiness: banding an account
  // reads its availability, and reading availability clears a past-due throttle.
  // `thr` is never a candidate here, so nothing the knob-off path is entitled to
  // touch reaches it, and its throttle fields are what show whether the band was
  // built anyway. Quota windows cannot show it: the refresh clears every expired
  // one whatever the knob.
  const past = Date.now() - 1000;
  const am = mgr(['cur', 'chall', 'thr'], { expiry: OFF });
  bucket(am, 0, 'unified7d', 0.50, 100);
  bucket(am, 1, 'unified7d', 0.10, 10);
  bucket(am, 2, 'unified7d', 0.40, 50);
  // Only the challenger's 5h window has expired, so it alone fires the switch and
  // `thr` is nothing this path may consider.
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = past;
  am.accounts[2].status = 'throttled';
  am.accounts[2].rateLimitedUntil = past;

  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'chall',
    'the knob-off switch never fired, so the arm tests nothing about the statement it guards');
  assert.equal(am.accounts[2].status, 'throttled',
    'the knob-off switch read an account the band would have read, and cleared its throttle');
  assert.equal(am.accounts[2].rateLimitedUntil, past,
    'the knob-off switch read an account the band would have read, and dropped its rate-limit clock');
});

test('path 3 still switches when the sooner-resetting account is the better one', () => {
  const am = mgr(['cur', 'b'], { expiry: ON });
  bucket(am, 0, 'unified7d', 0.9, 100);
  bucket(am, 1, 'unified7d', 0.1, 10);
  am.accounts[1].quota.unified5h = 0.5;
  am.accounts[1].quota.unified5hReset = Date.now() - 1000;
  am.refreshExpiredQuotas(null, asRequest());
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
