import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureEarlyConsole } from '../src/early-log.js';

// Startup output used to land on the normal screen before the TUI took the
// alternate one: hidden while the dashboard ran, missing from the activity log,
// and back after `q` looking freshly logged (#413). It is held, then replayed
// once the TUI owns the console — or written to stderr if the process exits
// before a TUI ever starts, so a startup error is not lost with it.

function fakeConsole() {
  const out = [];
  return { out, log: (...a) => out.push(['log', a.join(' ')]), error: (...a) => out.push(['error', a.join(' ')]), warn: (...a) => out.push(['warn', a.join(' ')]) };
}

test('output is held, in order, and the console is restored on release', () => {
  const target = fakeConsole();
  const original = { log: target.log, error: target.error, warn: target.warn };
  const exits = [];
  const early = captureEarlyConsole({ target, stderr: { write() {} }, onExit: fn => exits.push(fn), offExit: fn => exits.splice(exits.indexOf(fn), 1) });

  target.log('[TeamClaude] Starting on account "a"');
  target.error('[TeamClaude] Refreshing token', 'for "a"');
  target.warn('careful');
  assert.deepEqual(target.out, [], 'nothing reaches the screen while held');

  assert.deepEqual(early.release(), ['[TeamClaude] Starting on account "a"', '[TeamClaude] Refreshing token for "a"', 'careful']);
  assert.equal(target.log, original.log);
  assert.equal(target.error, original.error);
  assert.equal(target.warn, original.warn);
  assert.equal(exits.length, 0, 'the exit flush is disarmed once the lines were handed over');
  assert.deepEqual(early.release(), [], 'a second release hands over nothing twice');
});

test('a process that exits before the TUI starts gets its held lines on stderr', () => {
  const target = fakeConsole();
  const written = [];
  const exits = [];
  captureEarlyConsole({ target, stderr: { write: s => written.push(s) }, onExit: fn => exits.push(fn), offExit() {} });

  target.error('[TeamClaude] Port 3456 is already in use');
  assert.equal(exits.length, 1);
  exits[0]();
  assert.deepEqual(written, ['[TeamClaude] Port 3456 is already in use\n']);
  exits[0]();
  assert.equal(written.length, 1, 'flushed once');
});
