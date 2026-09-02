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
  // Expected values written out by hand from the quota shape, not read back out
  // of the helpers under test: asserting `_governingWeekly(a) ===
  // _governingWindow(a).utilization` compares one function with itself and
  // cannot fail. Every number below is independently
  // constructed, and the WRITER (_setCurrent, through the watcher's own state)
  // is checked alongside the readers.
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

    // The WRITER: making the account current must leave the watcher holding
    // exactly this window at exactly this reset, under this name.
    am._setCurrent(a);
    assert.equal(am._currentRef.windows.get(c.window), c.resetAt,
      `${c.label}: writer stored the wrong reset under ${c.window}`);
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

test('an equal-pressure tie breaks on the governing window\'s clock, not another', () => {
  // Identical scoped windows on both accounts, so the pressures are computed
  // from identical inputs and the tie is exact rather than nearly so — the next
  // sort key is what decides the pick. The SHARED weekly disagrees and points
  // the other way, and it is a clock neither the gate nor the ratio consulted.
  const now = Date.now();
  const fleet = expiry => {
    const am = mgr(['a', 'b'], { expiry });
    for (const i of [0, 1]) {
      Object.assign(am.accounts[i].quota, {
        unified5h: 0.1,
        unified7d: 0.10,
        scopedWeekly: { opus: { utilization: 0.80, resetAt: now + 20 * H } },
      });
      am.accounts[i].probing = false;
    }
    am.accounts[0].quota.unified7dReset = now + 100 * H;
    am.accounts[1].quota.unified7dReset = now + 5 * H;
    return am;
  };

  const on = fleet(ON);
  assert.equal(on._expiryPressure(on.accounts[0], OPUS, now),
    on._expiryPressure(on.accounts[1], OPUS, now), 'the fixture must tie exactly');
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
