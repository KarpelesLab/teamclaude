import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowWatcher, ROLLOVER_MIN_JUMP_MS } from '../src/window-watcher.js';

const WEEK = 7 * 24 * 3600_000;
const T0 = 1_800_000_000_000;

const SHARED = 'unified7d';
const FABLE = 'unified7dFable';

// The reset map a watcher is handed: { requestBucket: { window, reset } }.
function at(bucket, window, reset) {
  return { [bucket]: { window, reset } };
}

test('a first sight is not a rollover — it only establishes the baseline', () => {
  const w = new WindowWatcher();
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0)), false);
  // Now that a baseline exists, the same reset re-reported is still not one.
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0)), false);
});

test('a week-long jump forward in the governing reset is a rollover', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), true);
});

test('a sub-hour disagreement between the two reset writers is not a rollover', () => {
  // A response header carries whole seconds, the usage endpoint a fractional
  // ISO timestamp, so one instant arrives as two values up to a second apart.
  // Any strictly-forward test reads that as a roll and re-routes for nothing.
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + 999)), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + ROLLOVER_MIN_JUMP_MS)), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + ROLLOVER_MIN_JUMP_MS + 1)), true);
});

test('a reset moving BACKWARD is not a rollover', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 - WEEK)), false);
});

test('a baseline is compared only against the same account', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  // Account 1 has never been seen on this bucket: first sight, not a jump,
  // however far its reset sits from account 0's.
  assert.equal(w.rolledOver(1, SHARED, at(SHARED, SHARED, T0 + WEEK)), false);
});

test('two buckets sharing one window are tracked, and preempted, apart', () => {
  // An account that has never served Fable reports no Fable utilization, so its
  // Fable bucket resolves to the shared window. Keyed by the window the two
  // would share an entry, and the second bucket's roll would never be seen.
  const w = new WindowWatcher();
  const before = { ...at(SHARED, SHARED, T0), ...at(FABLE, SHARED, T0) };
  const after = { ...at(SHARED, SHARED, T0 + WEEK), ...at(FABLE, SHARED, T0 + WEEK) };
  w.seed(0, before);
  assert.equal(w.rolledOver(0, SHARED, after), true);
  assert.equal(w.rolledOver(0, FABLE, after), true);
  assert.equal(w.owedOn(SHARED, 0), true);
  assert.equal(w.owedOn(FABLE, 0), true);
});

test("a bucket's window flips to the shared one and back without swallowing the roll", () => {
  // _clearExpiredQuotas nulls a family utilization and its reset together at the
  // reset instant, so the bucket collapses onto the shared window and then
  // returns to its own. A single slot loses the pre-roll reset to the first flip.
  const w = new WindowWatcher();
  w.seed(0, at(FABLE, FABLE, T0));
  // Flip 1: the family bucket is cleared, so this bucket now reads the shared
  // window. A different window is a first sight, not a jump.
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, SHARED, T0 + 3 * WEEK)), false);
  // Flip 2: upstream reports the new family window. The Fable slot still holds
  // its own pre-roll value, so the week-long jump is visible.
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, FABLE, T0 + WEEK)), true);
});

test('an owed event is re-reported on every pass until something moves', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), true);
  // Detection never advances the baseline past a pending event, so a pass that
  // could not act on it costs the event nothing.
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), true);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), true);
});

test('a rollover settles exactly once, on the request that moved off it', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK));
  w.noteServed(1, [SHARED]);
  assert.equal(w.settleServed(), 1);
  // Banked: the post-roll reset is the new baseline, so nothing is owed and the
  // same event cannot be counted or acted on a second time.
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 0), false);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), false);
});

test('a retry that fails back onto the rolled account leaves the event owed', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK));
  // Re-routed to 1, refused, served by 0 after all: nothing moved.
  w.noteServed(1, [SHARED]);
  w.noteServed(0, [SHARED]);
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 0), true);
  assert.equal(w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK)), true);
});

test('a bucket this request did not spend settles nothing', () => {
  const w = new WindowWatcher();
  w.seed(0, { ...at(SHARED, SHARED, T0), ...at(FABLE, FABLE, T0) });
  w.rolledOver(0, FABLE, at(FABLE, FABLE, T0 + WEEK));
  // Opus traffic moving off account 0 says nothing about where Fable went.
  w.noteServed(1, [SHARED]);
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(FABLE, 0), true);
});

test('a service record is consumed by its settle and cannot settle a later event', () => {
  // `settleServed` clears `served` because a service record answers "where did
  // this bucket's traffic go" for ONE settlement. Kept, it answers for the next
  // one too, and banks an event that nothing moved.
  //
  // Reachable because the two calls are not paired: `confirmRouted` runs only on
  // the success path while `endSession` runs in a `finally`, so a request that
  // errors reaches a settlement carrying an earlier request's answer.
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  w.seed(2, at(SHARED, SHARED, T0));
  // Event on account 0, moved to account 1 and banked.
  w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK));
  w.noteServed(1, [SHARED]);
  assert.equal(w.settleServed(), 1);
  // A later event on a DIFFERENT account, with nothing served since. Nothing
  // moved, so nothing may be banked.
  w.rolledOver(2, SHARED, at(SHARED, SHARED, T0 + WEEK));
  assert.equal(w.settleServed(), 0);
  assert.equal(w.owedOn(SHARED, 2), true);
});

test('an owed event survives its bucket changing window underneath it', () => {
  // The reason the owed check comes FIRST rather than being a shortcut for the
  // same answer. Re-deriving from the baseline reads the window the bucket
  // resolves to right now, and a window it has never resolved to here is a first
  // sight: the owed event would silently stop being reported and the pin would
  // settle onto the account that just gained a week.
  const w = new WindowWatcher();
  w.seed(0, at(FABLE, FABLE, T0));
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, FABLE, T0 + WEEK)), true);
  // The family utilization is cleared, so the bucket collapses onto the shared
  // window, which it has never resolved to on this account.
  assert.equal(w.rolledOver(0, FABLE, at(FABLE, SHARED, T0 + 3 * WEEK)), true);
  assert.equal(w.owedOn(FABLE, 0), true);
});

test('commitOn notes and settles in one step, for a choice with no quiet point', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK));
  assert.equal(w.commitOn(1, [SHARED]), 1);
  assert.equal(w.commitOn(1, [SHARED]), 0);
});

test('two accounts can owe on one bucket at once, each settled by its own traffic', () => {
  const w = new WindowWatcher();
  w.seed(0, at(SHARED, SHARED, T0));
  w.seed(1, at(SHARED, SHARED, T0));
  w.rolledOver(0, SHARED, at(SHARED, SHARED, T0 + WEEK));
  w.rolledOver(1, SHARED, at(SHARED, SHARED, T0 + WEEK));
  // Served by 1, so only account 0's event moved.
  assert.equal(w.commitOn(1, [SHARED]), 1);
  assert.equal(w.owedOn(SHARED, 0), false);
  assert.equal(w.owedOn(SHARED, 1), true);
});

test('remap follows the account list through a removal and drops what went away', () => {
  const w = new WindowWatcher();
  w.seed(2, at(SHARED, SHARED, T0));
  w.rolledOver(2, SHARED, at(SHARED, SHARED, T0 + WEEK));
  // Account 1 is removed: everything above it moves down one slot.
  assert.equal(w.remap(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx)), true);
  assert.equal(w.owedOn(SHARED, 1), true);
  assert.equal(w.owedOn(SHARED, 2), false);
  // Now remove the account the event belongs to: nothing is left to track.
  assert.equal(w.remap(idx => (idx === 1 ? null : idx)), false);
});
