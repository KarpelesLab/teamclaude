import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

// Node puts a TTY stdout in blocking mode, so a paint is a synchronous write(2)
// that returns only when the terminal has drained the pty. Measured live on
// 2026-09-15: the proxy's main thread sat in write() under
// StreamBase::WriteString for 5-29s at a time whenever the terminal emulator
// paused, and every request in flight sat with it — no bytes relayed, no
// completion, no log line, because the thing that would show it was the thing
// blocked. The TUI now flips stdout non-blocking and drops a frame when the
// terminal is behind, rather than waiting for it.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

/** A stand-in for process.stdout that records writes and blocking flips, and
 *  lets the test say whether the terminal is behind. */
function fakeStdout() {
  const listeners = {};
  const persistent = {};
  return {
    writes: [], blocking: [], writableNeedDrain: false, columns: 100, rows: 30,
    _handle: { setBlocking(b) { this_.blocking.push(b); } },
    write(s) { this.writes.push(s); return !this.writableNeedDrain; },
    once(ev, fn) { (listeners[ev] ||= []).push(fn); },
    // A `once` listener is spent by an emit; an `on` listener is not. The TUI
    // uses `once` for drain and `on` for error, and only stop() clears the latter.
    on(ev, fn) { (persistent[ev] ||= []).push(fn); },
    removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
      persistent[ev] = (persistent[ev] || []).filter(f => f !== fn);
    },
    emit(ev, arg) {
      const fns = listeners[ev] || [];
      listeners[ev] = [];
      for (const f of fns) f(arg);
      for (const f of persistent[ev] || []) f(arg);
    },
    listeners: (ev) => [...(listeners[ev] || []), ...(persistent[ev] || [])],
  };
}
// `this_` lets the handle reach the outer object without a class.
let this_;

function withStdout(fake, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdout', { value: fake, configurable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'stdout', real); }
}

function makeTUI() {
  const am = new AccountManager([oauth('a')], 0.98);
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
}

test('a frame is dropped while the terminal is behind, and the current one painted on drain', () => {
  const out = fakeStdout(); this_ = out;
  withStdout(out, () => {
    const tui = makeTUI();
    tui.running = true;
    let frames = 0;
    tui._render = function () { this._paint(`frame-${++frames}`, false); };

    tui.render({ force: true });
    assert.deepEqual(out.writes, ['frame-1']);

    out.writableNeedDrain = true;              // terminal stopped draining
    tui.render({ force: true });
    tui.render({ force: true });
    assert.deepEqual(out.writes, ['frame-1'], 'nothing is queued behind a stuck terminal');
    assert.equal(out.listeners('drain').length, 1, 'one drain listener, however many frames were dropped');

    out.writableNeedDrain = false;             // terminal caught up
    out.emit('drain');
    // frame-2 and frame-3 were dropped; what is painted is whatever is CURRENT.
    assert.deepEqual(out.writes, ['frame-1', 'frame-4']);
    assert.equal(out.listeners('drain').length, 0);
  });
});

test('stdout is flipped non-blocking at start and blocking again before the exit sequence', () => {
  const out = fakeStdout(); this_ = out;
  const stdin = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, removeListener() {}, pause() {} };
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  try {
    withStdout(out, () => {
      const tui = makeTUI();
      tui.render = () => {};
      tui._scheduleTick = () => {};
      tui.start();
      assert.deepEqual(out.blocking, [false]);
      tui.stop();
      assert.deepEqual(out.blocking, [false, true]);
      // The restore sequence is the LAST write, after the flip back to blocking.
      assert.match(out.writes.at(-1), /\?25h.*\?1049l/);
    });
  } finally {
    Object.defineProperty(process, 'stdin', realIn);
  }
});

test('a stdout without a settable handle is left alone', () => {
  const out = fakeStdout(); this_ = out;
  delete out._handle;
  withStdout(out, () => {
    const tui = makeTUI();
    assert.doesNotThrow(() => tui._setStdoutBlocking(false));
  });
});

// Flipping stdout non-blocking moved its write failures onto the async path,
// where they arrive as an 'error' event. Nothing listened, so Node promoted
// them to uncaughtException and the crash handler exited the process: the
// proxy died whenever a terminal went away, twice within a day, each time
// orphaning the sidecar on its port. The display is now allowed to fail alone.

function withStdio(out, fn) {
  const stdin = { setRawMode() {}, resume() {}, setEncoding() {}, on() {}, removeListener() {}, pause() {} };
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  try { return withStdout(out, fn); } finally { Object.defineProperty(process, 'stdin', realIn); }
}

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

test('a stdout error stops the painting, not the process', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = makeTUI();
    tui.render = () => {};
    tui._scheduleTick = () => {};
    tui.start();
    assert.equal(out.listeners('error').length, 1, 'an async write failure has somewhere to go');

    // Precisely what Node would otherwise promote to an uncaughtException.
    out.emit('error', epipe());

    const before = out.writes.length;
    tui._paint('the terminal is gone', true);
    assert.equal(out.writes.length, before, 'no further write is attempted');
  });
});

test('a dead terminal cannot throw out of stop()', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = makeTUI();
    tui.render = () => {};
    tui._scheduleTick = () => {};
    tui.start();
    out.write = () => { throw epipe(); };   // blocking again: the failure throws here
    assert.doesNotThrow(() => tui.stop());
    assert.equal(out.listeners('error').length, 0, 'the listener is released with the terminal');
  });
});

test('a stalled terminal that never drains does not strand the next paint', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = makeTUI();
    tui.render = () => {};
    tui._scheduleTick = () => {};
    tui.start();
    out.writableNeedDrain = true;           // a frame is parked waiting for drain
    tui._paint('parked', true);
    out.emit('error', epipe());             // the drain will now never come
    const before = out.writes.length;
    out.writableNeedDrain = false;
    tui._paint('later', true);
    assert.equal(out.writes.length, before, 'the broken stream is checked before the drain handshake');
  });
});
