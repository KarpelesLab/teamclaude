import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { gatingUtilization } from '../src/model.js';
import { renderStatus } from '../src/status-renderer.js';
import { TUI } from '../src/tui.js';

// The weekly gate: which bucket decides whether an account may serve a family
// model. Family spend meters TWICE, once in the family bucket and once in the
// shared one, so reading the family bucket alone let an account already over its
// shared cap keep taking family traffic — and every such request pushed the
// shared bucket further past it. Issue #175 measured the coupling at
// [+1.14e-4, +5.21e-4] per request against Fable-only traffic.
//
// The rule is a MAXIMUM over the two reported buckets, with null meaning
// unreported and never zero.

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const SONNET = 'claude-sonnet-4-6';
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const acct = (quota) => ({ name: 'a', type: 'apikey', apiKey: 'k', quota });

function managerWith(quota) {
  const am = new AccountManager([acct({})], 0.98);
  am.accounts[0].quota = { ...am.accounts[0].quota, ...quota };
  am.accounts[0].probing = false;
  return am;
}

// ---------------------------------------------------------------------------
// The matrix from issue #175, one test per row.
// ---------------------------------------------------------------------------

test('shared over cap, family under: the account is barred from the family model', () => {
  const am = managerWith({ unified7d: 1.0, unified7dFable: 0.2 });
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 1.0,
    'the gate read the family bucket alone and missed the spent shared bucket');
  assert.equal(am._isNearQuota(am.accounts[0], FABLE), true);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false,
    'an account past its shared weekly cap kept serving family traffic');
});

test('family over cap, shared under: gating stays model-scoped', () => {
  const am = managerWith({ unified7d: 0.2, unified7dFable: 1.0 });
  // The family bucket still bars its own family...
  assert.equal(am._isNearQuota(am.accounts[0], FABLE), true);
  // ...and must not bar anything else. This is the property the maximum could
  // have broken by leaking the family figure into other models' decisions.
  assert.equal(am._governingWeekly(am.accounts[0], OPUS), 0.2);
  assert.equal(am._isNearQuota(am.accounts[0], OPUS), false,
    'a spent Fable bucket barred Opus, which is the bug this rule must not create');
});

test('both under cap: the account serves both', () => {
  const am = managerWith({ unified7d: 0.3, unified7dFable: 0.2 });
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 0.3,
    'the maximum of the two reported buckets is the shared one here');
  assert.equal(am._isNearQuota(am.accounts[0], FABLE), false);
  assert.equal(am._isNearQuota(am.accounts[0], OPUS), false);
});

test('family reported, shared unreported: the family figure stands alone', () => {
  const am = managerWith({ unified7dFable: 0.5 });
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 0.5,
    'an absent shared bucket must not be floored to 0 and must not erase the family figure');
});

test('both unreported: the answer is null, not zero', () => {
  const am = managerWith({});
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), null,
    'unreported became a number, which reads as "empty" rather than "unknown"');
  assert.equal(am._isNearQuota(am.accounts[0], FABLE), false,
    'the gate decided on a dimension nothing reported');
});

test('governing bucket already IS the shared one: behaviour is unchanged', () => {
  // max(x, x) is x. Asserted rather than assumed, because the maximum is the
  // whole change and this is the case where it must do nothing.
  const am = managerWith({ unified7d: 0.7 });
  assert.equal(am._governingWeekly(am.accounts[0], OPUS), 0.7);
  assert.equal(am._governingWeekly(am.accounts[0], null), 0.7);
  const spent = managerWith({ unified7d: 0.99 });
  assert.equal(spent._isNearQuota(spent.accounts[0], OPUS), true);
});

test('shared reported at zero is a value, not an absence', () => {
  // The distinction the null rule protects: 0 is a measurement.
  const am = managerWith({ unified7d: 0, unified7dFable: 0.4 });
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 0.4);
  const empty = managerWith({ unified7dFable: 0.4 });
  assert.equal(empty._governingWeekly(empty.accounts[0], FABLE), 0.4,
    'a reported 0 and an absent bucket must reach the same answer here, by different routes');
});

test('gatingUtilization keeps null as unreported for every combination', () => {
  // The one rule a maximum most easily breaks, over the whole cross product.
  for (const shared of [null, 0, 0.5, 1]) {
    for (const fam of [null, 0, 0.5, 1]) {
      const q = {};
      if (shared != null) q.unified7d = shared;
      if (fam != null) q.unified7dFable = fam;
      const got = gatingUtilization(q, 'unified7dFable');
      const expected = shared == null && fam == null ? null
        : shared == null ? fam
          : fam == null ? shared : Math.max(fam, shared);
      assert.equal(got, expected, `shared=${shared} family=${fam}`);
      if (shared == null && fam == null) assert.equal(got, null, 'absent became a number');
    }
  }
});

// ---------------------------------------------------------------------------
// Sonnet. `unified7dSonnet` is only populated by the opt-in usage prober, so
// every pre-existing fixture leaves it null and nothing executed that arm.
// ---------------------------------------------------------------------------

test('Sonnet is gated by the shared bucket exactly as Fable is', () => {
  const am = managerWith({ unified7d: 1.0, unified7dSonnet: 0.2 });
  assert.equal(am._governingWeekly(am.accounts[0], SONNET), 1.0);
  assert.equal(am._isAvailable(am.accounts[0], SONNET), false,
    'an account past its shared weekly cap kept serving Sonnet');
});

test('a spent Sonnet bucket bars only Sonnet', () => {
  const am = managerWith({ unified7d: 0.2, unified7dSonnet: 1.0, unified7dFable: 0.1 });
  assert.equal(am._isNearQuota(am.accounts[0], SONNET), true);
  assert.equal(am._isNearQuota(am.accounts[0], FABLE), false, 'Sonnet\'s bucket barred Fable');
  assert.equal(am._isNearQuota(am.accounts[0], OPUS), false, 'Sonnet\'s bucket barred Opus');
});

// ---------------------------------------------------------------------------
// The consumers that inherit the fix, and the ones that deliberately do not.
// ---------------------------------------------------------------------------

test('the probe ranker sees the shared bucket too', () => {
  // `_selectProbe` ranks on `_maxUtilization`, so without this it could aim a
  // probe at an account that cannot serve the model it is probing for.
  const am = managerWith({ unified7d: 1.0, unified7dFable: 0.2 });
  assert.equal(am._maxUtilization(am.accounts[0], FABLE), 1.0,
    'the probe ranker read the family bucket alone');
});

test('_modelWeeklyExhausted stays family-only and does NOT take the maximum', () => {
  // A different question: "can this account serve this family at all", not "is
  // it near any cap". Folding the shared bucket in would skip accounts for
  // probes they could have served, hardening the stale cached utilization a
  // probe exists to correct.
  const am = managerWith({ unified7d: 1.0, unified7dFable: 0.2 });
  assert.equal(am._modelWeeklyExhausted(am.accounts[0], FABLE), false,
    'the advisor family gate started consulting the shared bucket');
  const spentFamily = managerWith({ unified7d: 0.2, unified7dFable: 1.0 });
  assert.equal(spentFamily._modelWeeklyExhausted(spentFamily.accounts[0], FABLE), true);
});

test('the reset still names the governing window, not the bucket that won the max', () => {
  // The value and the reset may now describe different buckets. That is safe
  // because no caller pairs them: both readers of the reset
  // (`_pickBestAvailable`, `_pickLeastLoaded`) use it as a ranking tiebreak
  // among accounts that already passed `_isAvailable`, and neither divides a
  // headroom by it. Pinned here so a later "make them consistent" edit has to
  // argue with a test rather than quietly pair one bucket's level with another
  // bucket's clock.
  const now = Date.now();
  const am = managerWith({
    unified7d: 1.0, unified7dReset: now + 100_000,
    unified7dFable: 0.2, unified7dFableReset: now + 900_000,
  });
  assert.equal(am._governingWeekly(am.accounts[0], FABLE), 1.0, 'the value is the maximum');
  assert.equal(am._governingWeeklyReset(am.accounts[0], FABLE), now + 900_000,
    'the reset must stay with the governing window');
});

// ---------------------------------------------------------------------------
// The displays. The gate and every rendering of it answer one question, so they
// are pinned against the gate rather than each against a bucket. Issue #175
// names the status Models row specifically: #172 fixed its blocklist half and
// left the shared-weekly half reading the family bucket alone.
// ---------------------------------------------------------------------------

// Drives the REAL renderer against the REAL payload and compares its output to
// `_isAvailable`. Recomputing the rule here instead — asserting
// `gatingUtilization(...) >= switchThreshold` — would be a THIRD derivation of
// the one question, and would pass with the renderer reverted.
function modelsRowFor(am, name) {
  const out = renderStatus(am.getStatus(), { color: false, now: Date.now() });
  const lines = out.split('\n');
  // The account HEADER, not the first line containing the name: a bare
  // `includes(name)` also matches the "TeamClaude status" banner.
  const at = lines.findIndex(l => l.startsWith(`> ${name} (`));
  assert.ok(at >= 0, `account ${name} has no header line in the rendered output`);
  const row = lines.slice(at, at + 12).find(l => l.includes('Models'));
  assert.ok(row, `no Models row rendered for ${name}; the test would assert nothing`);
  return row;
}

test('the rendered Models row agrees with routing for every family', () => {
  // Shared bucket at the cap, both families far under it: the state where
  // reading a family bucket alone prints the opposite of what routing does.
  const am = managerWith({ unified7d: 0.99, unified7dFable: 0.05, unified7dSonnet: 0.05 });
  const row = modelsRowFor(am, 'a');
  for (const [model, label] of [[OPUS, 'Opus'], [SONNET, 'Sonnet'], [FABLE, 'Fable']]) {
    const routable = am._isAvailable(am.accounts[0], model);
    const cell = row.split(/\s{2,}/).find(c => c.trim().startsWith(label));
    assert.ok(cell, `no ${label} cell in: ${row}`);
    const shownAvailable = cell.includes('✓');
    assert.equal(shownAvailable, routable,
      `${label}: the row shows ${shownAvailable ? 'available' : 'unavailable'} while routing says`
      + ` ${routable ? 'available' : 'unavailable'} — ${row}`);
  }
});

test('the rendered Models row still shows a family available when only its own bucket is spent', () => {
  // The other direction, so the test above cannot be satisfied by a renderer
  // that marks everything unavailable.
  const am = managerWith({ unified7d: 0.1, unified7dFable: 0.99 });
  const row = modelsRowFor(am, 'a');
  assert.ok(row.includes('Opus ✓'), `Opus should read available: ${row}`);
  assert.ok(/Fable ✗/.test(row), `Fable should read unavailable: ${row}`);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
});

test('the recovery time beside a ✗ is the latest blocking WEEKLY bucket, not the family one', () => {
  // The weekly half of the mark comes from a maximum, so it only clears once
  // both weekly blockers have rolled. Printing the family reset beside a ✗ the
  // shared weekly produced told an operator that a week-long block clears in an
  // hour. The shared 5h bucket is not a candidate here and is a known gap; see
  // the comment on this rule in status-renderer.js.
  const now = Date.now();
  const am = managerWith({
    unified7d: 0.99, unified7dReset: now + 72 * 3600_000,
    unified7dFable: 0.99, unified7dFableReset: now + 1 * 3600_000,
  });
  const row = modelsRowFor(am, 'a');
  const fable = row.split(/\s{2,}/).find(c => c.trim().startsWith('Fable'));
  assert.match(fable, /Fable ✗/);
  assert.match(fable, /3d/, `the Fable cell named its own 1h reset while the shared bucket blocks for 3d: ${row}`);
});

test('no recovery time is shown when a blocking bucket has no reset', () => {
  // A known-but-earlier time would understate the block and an absent one is
  // unknown, so the cell says nothing rather than naming a time that is not
  // when this clears.
  const now = Date.now();
  const am = managerWith({
    unified7d: 0.99, // shared blocks, and reports no reset
    unified7dFable: 0.99, unified7dFableReset: now + 1 * 3600_000,
  });
  const row = modelsRowFor(am, 'a');
  const fable = row.split(/\s{2,}/).find(c => c.trim().startsWith('Fable'));
  assert.match(fable, /Fable ✗/);
  assert.equal(/\d+[smhd]/.test(fable), false,
    `an unknown recovery time was printed as a duration anyway: ${row}`);
});

test('the TUI blocked tag follows the gate, not the family bucket', () => {
  // Same question, third rendering (issue #85's ⊘ tag). An account under its
  // family cap but over the shared one carried no tag while routing refused it.
  const now = Date.now();
  const am = managerWith({
    unified5h: 0.1, unified5hReset: now + 3600_000,
    unified7d: 0.99, unified7dReset: now + 3600_000,
    unified7dFable: 0.05, unified7dFableReset: now + 3600_000,
  });
  const tui = Object.create(TUI.prototype);
  tui.am = am; tui.mode = 'normal'; tui.selIdx = -1;
  const row = stripAnsi(tui._renderAcct(0, 8, true, am.getRoutes(), [], { fable: null, sonnet: null }));
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
  assert.match(row, /⊘ Fable/,
    `routing refuses Fable on this account but the TUI shows no blocked tag: ${row}`);
});

test('the TUI blocked tag stays off when the account can still serve the family', () => {
  const now = Date.now();
  const am = managerWith({
    unified5h: 0.1, unified5hReset: now + 3600_000,
    unified7d: 0.1, unified7dReset: now + 3600_000,
    unified7dFable: 0.05, unified7dFableReset: now + 3600_000,
  });
  const tui = Object.create(TUI.prototype);
  tui.am = am; tui.mode = 'normal'; tui.selIdx = -1;
  const row = stripAnsi(tui._renderAcct(0, 8, true, am.getRoutes(), [], { fable: null, sonnet: null }));
  assert.equal(am._isAvailable(am.accounts[0], FABLE), true);
  assert.equal(/⊘/.test(row), false, `a servable family was tagged blocked: ${row}`);
});
