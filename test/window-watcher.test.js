import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowWatcher, ROLLOVER_MIN_JUMP_MS } from '../src/window-watcher.js';

const WEEK = 7 * 24 * 3600_000;
const T0 = 1_800_000_000_000;

// Named windows, which is the watcher's whole vocabulary: the shared weekly, a
// family's own field, and one upstream learned for a family that has none.
const SHARED = 'unified7d';
const FABLE = 'unified7dFable';
const SCOPED_OPUS = 'scoped:opus';

// The map a watcher is handed: { windowName: reset }.
function at(window, reset) {
  return { [window]: reset };
}

test('a first sight is not a rollover — it only establishes the baseline', () => {
  const w = new WindowWatcher();
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0)), false);
  // Now that a baseline exists, the same reset re-reported is still not one.
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0)), false);
});

test('a week-long jump forward in the governing reset is a rollover', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
});

test('a sub-hour disagreement between the two reset writers is not a rollover', () => {
  // A response header carries whole seconds, the usage endpoint a fractional
  // ISO timestamp, so one instant arrives as two values up to a second apart.
  // Any strictly-forward test reads that as a roll and re-routes for nothing.
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + 999)), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + ROLLOVER_MIN_JUMP_MS)), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + ROLLOVER_MIN_JUMP_MS + 1)), true);
});

test('a reset moving BACKWARD is not a rollover', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 - WEEK)), false);
});

test('a baseline is compared only against the same account', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  // Account 1 has never been seen on this window: first sight, not a jump,
  // however far its reset sits from account 0's.
  assert.equal(w.rolledOver(1, SHARED, at(SHARED, T0 + WEEK)), false);
});

test('two DIFFERENT windows on one account are tracked, and owed, apart', () => {
  // The shared weekly and a learned scoped bucket are different windows on the
  // same account, and the request families they govern are different traffic.
  // Keyed by the request bucket both would land on `unified7d`, and an event
  // owed on one would be re-reported to — and consumed by — the other.
  const w = new WindowWatcher();
  w.seed(0, { ...at(SHARED, T0), ...at(SCOPED_OPUS, T0) });
  assert.equal(w.rolledOver(0, SCOPED_OPUS, at(SCOPED_OPUS, T0 + WEEK)), true);
  assert.equal(w.owedOn(SCOPED_OPUS, 0), true);
  // The shared window did not move, and owes nothing.
  assert.equal(w.owedOn(SHARED, 0), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0)), false);
});

test('a window that goes absent and returns is a first sight, not a jump', () => {
  // _clearExpiredQuotas nulls a family's utilization and reset together, and a
  // scoped entry is deleted outright once its reset passes. A tenure beginning
  // in that gap must not leave the old value behind to be read as a roll when
  // upstream reports the window again.
  const w = new WindowWatcher();
  w.seed(0, at(FABLE, T0));
  // A tenure begins while the window is absent: establish is authoritative and
  // drops what it does not mention.
  w.establish(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, T0 + 3 * WEEK)), false);
  // And now that it has a baseline again, a real roll is visible.
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, T0 + 4 * WEEK)), true);
});

test('establish leaves other accounts alone', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.seed(1, at(SHARED, T0));
  w.establish(0, at(FABLE, T0));
  // Account 1's baseline is untouched, so its own roll is still detectable.
  assert.equal(w.rolledOver(1, SHARED, at(SHARED, T0 + WEEK)), true);
});

test('an owed event is re-reported on every pass until something moves', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
  // Detection never advances the baseline past a pending event, so a pass that
  // could not act on it costs the event nothing.
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
});

test('an owed event survives a tenure beginning on the same account', () => {
  // establish replaces baselines, and a rollover already detected must not be
  // erased by one: the owed check comes before any baseline is read.
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
  w.establish(0, at(SHARED, T0 + WEEK));
  assert.equal(w.owedOn(SHARED, 0), true);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK)), true);
});

test('a rollover settles exactly once, on the request that moved off it', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 1);
  w.noteServed(1, [SHARED], 1);
  assert.equal(w.settleServed(), 1);
  // Banked: the post-roll reset is the new baseline, so nothing is owed and the
  // same event cannot be counted or acted on a second time.
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 0), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 2), false);
});

test('a retry that fails back onto the rolled account leaves the event owed', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 1);
  // Re-routed to 1, refused, served by 0 after all: nothing moved. The later
  // selection is the one that says where the traffic went.
  w.noteServed(1, [SHARED], 1);
  w.noteServed(0, [SHARED], 2);
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 0), true);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 3), true);
});

test('a terminal from before the event cannot clear it, whenever it lands', () => {
  // The invariant: clearing evidence must postdate the event it clears. An
  // attempt issued before the rollover was detected says where traffic was
  // going before anyone knew, and a later request may since have fallen back
  // onto the rolled account.
  for (const order of ['old-last', 'old-first']) {
    const w = new WindowWatcher();
    w.seed(0, at(SHARED, T0));
    // Selection 1 is issued and goes to account 1. Selection 2 detects the roll.
    w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 2);
    const oldTerminal = () => w.noteServed(1, [SHARED], 1);
    const newTerminal = () => w.noteServed(0, [SHARED], 3);
    for (const t of (order === 'old-last' ? [newTerminal, oldTerminal] : [oldTerminal, newTerminal])) t();
    assert.equal(w.settleServed(), 0, `order ${order}`);
    assert.equal(w.owedOn(SHARED, 0), true, `order ${order}`);
  }
});

test('a window this request did not spend settles nothing', () => {
  const w = new WindowWatcher();
  w.seed(0, { ...at(SHARED, T0), ...at(FABLE, T0) });
  w.rolledOver(0, FABLE, at(FABLE, T0 + WEEK), 1);
  // Opus traffic moving off account 0 says nothing about where Fable went.
  w.noteServed(1, [SHARED], 1);
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(FABLE, 0), true);
});

test('a service record is consumed by its settle and cannot settle a later event', () => {
  // `settleServed` clears `served` because a service record answers "where did
  // this window's traffic go" for ONE settlement. Kept, it answers for the next
  // one too, and banks an event that nothing moved.
  //
  // Reachable because the two calls are not paired: `confirmRouted` runs only on
  // the success path while `endSession` runs in a `finally`, so a request that
  // errors reaches a settlement carrying an earlier request's answer.
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.seed(2, at(SHARED, T0));
  // Event on account 0, moved to account 1 and banked.
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 1);
  w.noteServed(1, [SHARED], 1);
  assert.equal(w.settleServed(), 1);
  // A later event on a DIFFERENT account, with nothing served since. Nothing
  // moved, so nothing may be banked.
  w.rolledOver(2, SHARED, at(SHARED, T0 + WEEK), 2);
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 2), true);
});

test('commitOn notes and settles in one step, for a choice with no quiet point', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 1);
  assert.equal(w.commitOn(1, [SHARED], 1), 1);
  assert.equal(w.commitOn(1, [SHARED], 2), 0);
});

test('two accounts can owe on one window at once, each settled by its own traffic', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.seed(1, at(SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 1);
  w.rolledOver(1, SHARED, at(SHARED, T0 + WEEK), 1);
  // Served by 1, so only account 0's event moved.
  assert.equal(w.commitOn(1, [SHARED], 1), 1);
  assert.equal(w.owedOn(SHARED, 0), false);
  assert.equal(w.owedOn(SHARED, 1), true);
});

test('remap follows the account list through a removal and drops what went away', () => {
  const w = new WindowWatcher();
  w.seed(2, at(SHARED, T0));
  w.rolledOver(2, SHARED, at(SHARED, T0 + WEEK), 1);
  // Account 1 is removed: everything above it moves down one slot.
  assert.equal(w.remap(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx)), true);
  assert.equal(w.owedOn(SHARED, 1), true);
  assert.equal(w.owedOn(SHARED, 2), false);
  // Now remove the account the event belongs to: nothing is left to track.
  assert.equal(w.remap(idx => (idx === 1 ? null : idx)), false);
});

test('remap carries the served record\'s sequence with its account', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, T0 + WEEK), 5);
  w.noteServed(2, [SHARED], 6);
  w.remap(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx));
  // The evidence still postdates the event, so it still settles it.
  assert.equal(w.settleServed(), 1);
});
