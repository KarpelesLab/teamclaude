import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBand, pressureOf, pressureRank, assertNever } from '../src/band-decision.js';

const H = 3600_000;
const NOW = 1_800_000_000_000;

// One account as the band sees it. `hours` is how far out its governing window
// resets; `used` is the fraction of that window already spent.
function acct(index, used, hours, priority = 0) {
  return { index, priority, utilization: used, resetAt: hours == null ? null : NOW + hours * H };
}

function snap(accounts, { tolerance = 1.5, enabled = true } = {}) {
  return { now: NOW, enabled, tolerance, accounts };
}

function near(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12,
    `${what}: ${actual} is not ${expected}`);
}

// The three-account fixture the band tests share, and its pressures:
//   acct(0, 0.0, 10) → 2.778e-5, the maximum
//   acct(1, 0.5,  6) → 2.315e-5, 1.2x behind it
//   acct(2, 0.9, 10) → 2.778e-6, 10x behind it
const TOP_PRESSURE = 1 / (10 * 3600);
const THREE = () => [acct(0, 0, 10), acct(1, 0.5, 6), acct(2, 0.9, 10)];

test('pressure is headroom per second in the governing window', () => {
  assert.deepEqual(pressureOf(acct(0, 0.25, 5), NOW), { kind: 'known', value: 0.75 / (5 * 3600) });
});

test('pressure prefers ample quota over a soon reset — the drained-account guard', () => {
  // Reset time alone picks the account resetting in 2h. Headroom in the
  // numerator picks the one holding 19x the quota that expires in 10h.
  const drained = pressureOf(acct(0, 0.95, 2), NOW);
  const ample = pressureOf(acct(1, 0.05, 10), NOW);
  assert.equal(drained.kind, 'known');
  assert.equal(ample.kind, 'known');
  assert.ok(ample.value > drained.value,
    `ample ${ample.value} should out-pressure drained ${drained.value}`);
});

test('an unreported utilization or window is absent, and says which', () => {
  assert.deepEqual(pressureOf(acct(0, null, 10), NOW), { kind: 'absent', reason: 'no-utilization' });
  assert.deepEqual(pressureOf(acct(0, 0.5, null), NOW),
    { kind: 'absent', reason: 'no-reset', lowerBound: 0.5 / (7 * 24 * 3600) });
});

test('a known utilization with no clock carries the least it can be worth', () => {
  const bound = u => pressureOf(acct(0, u, null), NOW).lowerBound;
  near(bound(0.05), 0.95 / (7 * 24 * 3600), 'ample-but-clockless bound');
  near(bound(0.95), 0.05 / (7 * 24 * 3600), 'spent-but-clockless bound');
  assert.ok(bound(0.05) > bound(0.95), 'the bound must order by headroom');
  assert.equal(bound(1.4), 0);
  for (const p of [pressureOf(acct(0, null, 10), NOW), pressureOf(acct(0, NaN, null), NOW)]) {
    assert.equal(p.lowerBound, undefined, JSON.stringify(p));
  }
});

test('a malformed utilization is absent, never clamped into a perfect score', () => {
  assert.deepEqual(pressureOf(acct(0, NaN, 10), NOW), { kind: 'absent', reason: 'utilization-not-finite' });
  assert.deepEqual(pressureOf(acct(0, Infinity, 10), NOW), { kind: 'absent', reason: 'utilization-not-finite' });
});

test('a window whose reset has passed is a known pressure of zero, not an absence', () => {
  // Only an absence earns a top-band place, so the two must not collapse.
  assert.deepEqual(pressureOf(acct(0, 0.2, -1), NOW), { kind: 'known', value: 0 });
  assert.deepEqual(pressureOf(acct(0, 0.2, 0), NOW), { kind: 'known', value: 0 });
});

test('utilization above 1 is real overage and clamps to zero headroom', () => {
  assert.deepEqual(pressureOf(acct(0, 1.4, 10), NOW), { kind: 'known', value: 0 });
});

test('pressureRank sorts higher pressure first, and discovery at the very front', () => {
  assert.ok(pressureRank({ kind: 'known', value: 9 }) < pressureRank({ kind: 'known', value: 1 }));
  for (const reason of ['no-utilization', 'utilization-not-finite', 'expiry-routing-off']) {
    assert.equal(pressureRank({ kind: 'absent', reason }), -Infinity, reason);
  }
  assert.ok(pressureRank(pressureOf(acct(0, null, null), NOW))
    < pressureRank({ kind: 'known', value: Number.MAX_VALUE }));
});

test('a known-but-clockless account does NOT outrank a measured one it is worse than', () => {
  // Ranking `no-reset` as discovery would put an account known to be 95% spent
  // ahead of one holding 95% of its window with an hour left, and `-Infinity`
  // wins outright, so no later tiebreak recovers it.
  const spentNoClock = pressureOf(acct(0, 0.95, null), NOW);
  const ampleExpiring = pressureOf(acct(1, 0.05, 1), NOW);
  assert.ok(pressureRank(ampleExpiring) < pressureRank(spentNoClock),
    'an account measured as worth spending must beat one merely missing a clock');
});

test('a clockless account still outranks a measured one it is better than', () => {
  // The other direction, so the bound is an ordering rather than a demotion:
  // holding almost the whole window beats a measured trickle, even scored
  // against the most pessimistic horizon a weekly window can have.
  const ampleNoClock = pressureOf(acct(0, 0.05, null), NOW);
  const spentFarOut = pressureOf(acct(1, 0.95, 24 * 7), NOW);
  assert.ok(pressureRank(ampleNoClock) < pressureRank(spentFarOut));
});

test('the band keeps accounts within the tolerance ratio of the best pressure', () => {
  const d = decideBand(snap(THREE(), { tolerance: 1.5 }));
  assert.equal(d.kind, 'banded');
  // a is the maximum; b is 1.2x behind it (inside 1.5); c is 10x behind.
  assert.deepEqual(d.keep, [0, 1]);
  assert.equal(d.floor, TOP_PRESSURE / 1.5);
});

test('a wider tolerance admits the account a narrow one bands out', () => {
  const wide = decideBand(snap(THREE(), { tolerance: 12 }));
  assert.deepEqual(wide.keep, [0, 1, 2]);
  const narrow = decideBand(snap(THREE(), { tolerance: 1 }));
  assert.deepEqual(narrow.keep, [0]);
});

test('an account with no comparable pressure stays in the band', () => {
  const d = decideBand(snap([acct(0, 0, 10), acct(1, 0.9, 10), acct(2, null, null)], { tolerance: 1 }));
  assert.equal(d.kind, 'banded');
  assert.deepEqual(d.keep, [0, 2]);
});

test('a known-but-clockless account is admitted too, though it no longer ranks top', () => {
  // Admission does not turn on the ranking: using the account is still how its
  // window gets reported.
  const d = decideBand(snap([acct(0, 0, 10), acct(1, 0.95, null)], { tolerance: 1 }));
  assert.equal(d.kind, 'banded');
  assert.deepEqual(d.keep, [0, 1]);
  // An absent account never sets the floor either, whichever reason it carries.
  assert.equal(d.floor, TOP_PRESSURE);
});

test('the band never empties a non-empty tier, whatever the tolerance says', () => {
  for (const tolerance of [1, 0.5, 0, -3, NaN, Infinity]) {
    const d = decideBand(snap([acct(0, 0, 10), acct(1, 0.9, 10)], { tolerance }));
    assert.equal(d.kind, 'banded', `tolerance ${tolerance}`);
    assert.ok(d.keep.includes(0), `tolerance ${tolerance} banded out the maximum`);
  }
});

test('only the top priority tier is banded; lower tiers pass through behind it', () => {
  // A high-pressure fallback must not band out the tier the operator preferred,
  // and the survivors must come first — callers take the first acceptable one.
  const d = decideBand(snap([
    acct(0, 0, 10, 0),      // top tier, the maximum
    acct(1, 0.9, 10, 0),    // top tier, banded out at 1.5
    acct(2, 0, 1, 1),       // lower tier, enormous pressure, kept regardless
  ], { tolerance: 1.5 }));
  assert.deepEqual(d.keep, [0, 2]);
});

test('passthrough names its reason: disabled, single candidate, nothing known', () => {
  assert.deepEqual(decideBand(snap([acct(0, 0, 10), acct(1, 0.9, 10)], { enabled: false })),
    { kind: 'passthrough', reason: 'disabled' });
  assert.deepEqual(decideBand(snap([acct(0, 0, 10)])),
    { kind: 'passthrough', reason: 'single-candidate' });
  assert.deepEqual(decideBand(snap([acct(0, null, null), acct(1, 0.5, null)])),
    { kind: 'passthrough', reason: 'no-known-pressure' });
});

test('the decision is a pure function of its snapshot', () => {
  const s = snap(THREE());
  const first = decideBand(s);
  assert.deepEqual(decideBand(s), first);
  // A separately built but identical snapshot answers identically, so nothing
  // is carried between calls and nothing is read off a clock.
  assert.deepEqual(decideBand(snap(THREE())), first);
});

test('assertNever refuses a variant nothing handles rather than falling through', () => {
  assert.throws(() => pressureRank({ kind: 'sideways' }), /pressureRank: unhandled variant/);
  assert.throws(() => assertNever({ kind: 'x' }, 'ctx'), /ctx: unhandled variant/);
});
