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
    // `writeError` is what the completion callback reports. Node calls it
    // before it emits 'error', which is the order stop() relies on.
    writeError: null,
    write(s, cb) {
      this.writes.push(s);
      if (typeof cb === 'function') cb(this.writeError);
      return !this.writableNeedDrain;
    },
    once(ev, fn) { (listeners[ev] ||= []).push(fn); },
    // A `once` listener is spent by an emit; an `on` listener is not. The TUI
    // uses `once` for drain and `on` for error, and stop() releases the latter
    // only once its own last write has completed cleanly.
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

function makeTUI(extra = {}) {
  const am = new AccountManager([oauth('a')], 0.98);
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    ...extra,
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
// proxy died whenever a terminal went away, skipping stop() and the state save.
// The display is now allowed to fail alone.

/** A stand-in for process.stdin that keeps its listeners, so a test can see
 *  what start() installed and stop() took away, and emit on them. */
function fakeStdin() {
  const listeners = {};
  return {
    setRawMode() {}, resume() {}, setEncoding() {}, pause() {},
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
    emit(ev, arg) { for (const f of [...(listeners[ev] || [])]) f(arg); },
    listeners: (ev) => listeners[ev] || [],
  };
}

/** Run `fn` with both ends of the terminal faked. console.error is replaced
 *  BEFORE the TUI starts, so what start() saves as the original — the one a
 *  lost terminal is reported through — is the recorder handed to `fn`. */
function withStdio(out, fn) {
  const stdin = fakeStdin();
  const errors = [];
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realLog = console.log;
  const realErr = console.error;
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  console.error = (...a) => { errors.push(a.join(' ')); };
  try { return withStdout(out, () => fn({ stdin, errors })); } finally {
    console.log = realLog;
    console.error = realErr;
    Object.defineProperty(process, 'stdin', realIn);
  }
}

/** A started TUI whose frames are a fixed string, so every write after the
 *  alt-screen entry is a paint and `composed` counts the frames built. */
function startTUI(extra = {}) {
  const tui = makeTUI(extra);
  tui.composed = 0;
  tui._render = function () { this.composed++; this._paint(`frame-${this.composed}`, true); };
  tui._scheduleTick = () => {};
  tui.start();
  return tui;
}

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

test('a stdout error is recorded once and stops the painting, not the process', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, ({ errors }) => {
    const tui = startTUI();
    assert.equal(out.listeners('error').length, 1, 'an async write failure has somewhere to go');
    assert.equal(tui._stdoutDead, false);

    // Precisely what Node would otherwise promote to an uncaughtException.
    out.emit('error', epipe());
    assert.equal(tui._stdoutDead, true);
    assert.equal(errors.length, 1, 'said through the console.error saved before start() patched it');
    assert.match(errors[0], /terminal lost \(stdout: EPIPE\)/);

    const writes = out.writes.length;
    const composed = tui.composed;
    tui.render({ force: true });
    tui._paint('the terminal is gone', true);
    assert.equal(tui.composed, composed, 'render() returns before composing a frame nobody can see');
    assert.equal(out.writes.length, writes, 'no further write is attempted');

    out.emit('error', epipe());
    assert.equal(errors.length, 1, 'a second failure says nothing new');
    assert.equal(tui.log.some(l => /terminal lost/.test(l.msg)), false, 'not into the pane nobody can see');
  });
});

test('the server keeps running headless when its terminal dies', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    let quits = 0;
    const tui = startTUI({ onQuit: () => { quits++; } });
    out.emit('error', epipe());
    assert.equal(quits, 0, 'a closed pane must not end every routed session');
    assert.equal(tui.running, true);
  });
});

test('an attach client quits when its terminal dies', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, ({ stdin }) => {
    let quits = 0;
    const tui = startTUI({ remote: true, onQuit: () => { quits++; } });
    const writes = out.writes.length;
    out.emit('error', epipe());
    assert.equal(quits, 1, 'a client with no terminal has nothing left to do');
    assert.equal(tui.running, false);
    assert.equal(stdin.listeners('data').length, 0);
    assert.equal(out.writes.length, writes, 'stop() does not send the exit sequence to a dead terminal');

    // A write that was still queued fails after the quit: recorded, not re-run.
    out.emit('error', epipe());
    assert.equal(quits, 1);
  });
});

test('a stdin error marks the terminal dead instead of ending the process', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, ({ stdin, errors }) => {
    const tui = startTUI();
    assert.equal(stdin.listeners('error').length, 1, 'installed beside the data listener');
    stdin.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
    assert.equal(tui._stdoutDead, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stdin: EIO/);
    const writes = out.writes.length;
    tui.render({ force: true });
    assert.equal(out.writes.length, writes);
  });
});

test('stop() removes the listeners once its last write has completed', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, ({ stdin }) => {
    const tui = startTUI();
    tui.stop();
    assert.equal(stdin.listeners('data').length, 0);
    assert.equal(stdin.listeners('error').length, 0);
    assert.equal(out.listeners('error').length, 0, 'the exit sequence went out cleanly: nothing is left to fail');
    assert.equal(out.listeners('resize').length, 0);
  });
});

test('starting again does not stack a second stdout guard', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = startTUI();
    out.writeError = epipe();               // the exit sequence fails: the guard stays
    tui.stop();
    out.writeError = null;
    tui.start();
    assert.equal(out.listeners('error').length, 1);
    assert.equal(tui._stdoutDead, false, 'a new start is a new terminal');
    tui.stop();
  });
});

test('a dead terminal cannot throw out of stop()', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = startTUI();
    out.write = () => { throw epipe(); };
    assert.doesNotThrow(() => tui.stop());
    assert.equal(out.listeners('error').length, 1, 'an unconfirmed write keeps the guard');
  });
});

test('a stalled terminal that never drains does not strand the next paint', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, () => {
    const tui = startTUI();
    out.writableNeedDrain = true;           // a frame is parked waiting for drain
    tui._paint('parked', true);
    out.emit('error', epipe());             // the drain will now never come
    const before = out.writes.length;
    out.writableNeedDrain = false;
    tui._paint('later', true);
    assert.equal(out.writes.length, before, 'the broken stream is checked before the drain handshake');
  });
});

// Flipping stdout back to blocking does not make writes ALREADY QUEUED
// synchronous, and a failed write is reported as an event after stop() has
// returned — while shutdown() is still stopping the prober and awaiting a state
// save. Releasing the guard inside stop() unconditionally would hand that late
// EPIPE to nobody. It is released only by a clean completion of the last write.
test('a write that fails after stop() is still absorbed', () => {
  const out = fakeStdout(); this_ = out;
  withStdio(out, ({ errors }) => {
    const tui = startTUI();
    out.writeError = epipe();               // the exit sequence itself fails
    tui.stop();
    assert.equal(out.listeners('error').length, 1, 'the failed write keeps the guard attached');
    assert.doesNotThrow(() => out.emit('error', epipe()));
    assert.equal(tui._stdoutDead, true, 'the late failure has somewhere to go, so Node never promotes it');
    assert.equal(errors.length, 1);
  });
});
