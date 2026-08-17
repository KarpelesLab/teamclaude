import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// The TUI used to repaint the whole screen every 500ms for as long as the proxy
// ran. The spinner it was animating is drawn only next to in-flight requests, so
// while idle each tick redrew a frame indistinguishable from the last — enough
// wake-ups to keep a laptop from sleeping (issue #134).
//
// Two properties keep that from coming back: the tick slows down when there is
// nothing to animate, and an unchanged frame is not written to the terminal at
// all.

function makeTUI() {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes: () => [],
    sessionStats: () => ({ active: 0, total: 0 }),
    getStatus: () => ({ accounts: [] }),
    refreshExpiredQuotas: () => {},
  };
  const config = { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [] };
  return new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
}

test('the tick is slow while idle and fast only while something is animating', () => {
  const tui = makeTUI();
  assert.equal(tui.active.size, 0);
  const idle = tui._tickDelay();

  tui.active.set('r1', { started: Date.now() });
  const busy = tui._tickDelay();

  assert.ok(busy < idle, `animating tick (${busy}ms) must be faster than idle (${idle}ms)`);
  // The point of the issue: idling must not mean waking twice a second.
  assert.ok(idle >= 5000, `idle tick is ${idle}ms — too chatty to let a laptop sleep`);

  tui.active.delete('r1');
  assert.equal(tui._tickDelay(), idle, 'falls back to the idle cadence once nothing is in flight');
});

// Run exactly one real tick, driving the scheduler's own callback rather than a
// hand-rolled copy of its body.
function runOneTick(tui) {
  let captured = null;
  tui._setTimeout = (fn) => { captured = fn; return { unref() {} }; };
  tui._scheduleTick();
  assert.ok(captured, '_scheduleTick armed no timer');
  // Stop it re-arming forever when we invoke it.
  const rearm = tui._scheduleTick;
  tui._scheduleTick = () => {};
  try { captured(); } finally { tui._scheduleTick = rearm; }
}

test('the spinner frame only advances when the spinner is on screen', () => {
  const tui = makeTUI();
  tui.running = true;
  tui.render = () => {};

  const before = tui.frame;
  runOneTick(tui);
  assert.equal(tui.frame, before, 'an idle tick must not change what would be drawn');

  tui.active.set('r1', { started: Date.now() });
  runOneTick(tui);
  assert.notEqual(tui.frame, before, 'the spinner still animates while a request is in flight');
});

// An unchanged screen must not be rewritten: that write is the wake-up.
test('an identical frame is not written to the terminal twice', () => {
  const tui = makeTUI();
  tui.running = true;

  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    tui._paint('SAME', false);
    tui._paint('SAME', false);
    tui._paint('SAME', false);
    assert.equal(writes.length, 1, 'repeated identical frames collapse to one write');

    tui._paint('DIFFERENT', false);
    assert.equal(writes.length, 2, 'a changed frame is written');

    // force is how a resize gets through: the terminal reflowed, so the cached
    // frame says nothing about what is actually on screen.
    tui._paint('DIFFERENT', true);
    assert.equal(writes.length, 3, 'a forced repaint is written even when unchanged');
  } finally {
    process.stdout.write = orig;
  }
});

// The terminal is shared state. If something else scribbles on it, an unchanged
// frame would otherwise leave the screen corrupted indefinitely.
test('an unchanged frame is still repainted eventually', () => {
  const tui = makeTUI();
  tui.running = true;

  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    tui._paint('SAME', false);
    assert.equal(writes.length, 1);
    tui._paint('SAME', false);
    assert.equal(writes.length, 1);

    // Pretend the last paint was long enough ago to be considered stale.
    tui._lastPaintAt = Date.now() - 120_000;
    tui._paint('SAME', false);
    assert.equal(writes.length, 2, 'a stale screen is refreshed even when the frame matches');
  } finally {
    process.stdout.write = orig;
  }
});

// A request arriving mid-idle-tick must start animating immediately rather than
// waiting out the remainder of the slow tick.
test('a request arriving while idle re-arms the tick at once', () => {
  const tui = makeTUI();
  tui.running = true;
  tui.render = () => {};

  let scheduled = 0;
  tui._scheduleTick = () => { scheduled++; };

  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages' });
  assert.equal(scheduled, 1, 'going from idle to animating re-arms the tick');

  // A second concurrent request is already animating — no need to re-arm again.
  tui.onRequestStart('r2', { method: 'POST', path: '/v1/messages' });
  assert.equal(scheduled, 1);
});
