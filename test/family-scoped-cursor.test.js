import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Availability is scoped per model: an account whose Fable weekly bucket is
// spent still serves every other family. A request that finds the current
// account unable to serve ITS family must therefore divert that family alone,
// not move the fleet — the account was chosen (often by hand, for a weekly
// window about to lapse) precisely to be spent by the families it can serve.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';
const H = 3600_000;

// a: weekly lapses soon, Fable bucket spent, everything else fine.
// b: fresh, weekly resets much later.
function fleet() {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const now = Date.now();
  Object.assign(am.accounts[0].quota, {
    unified5h: 0.4, unified5hReset: now + 4 * H,
    unified7d: 0.6, unified7dReset: now + 4 * H,
    unified7dFable: 0.99, unified7dFableReset: now + 4 * H,
  });
  Object.assign(am.accounts[1].quota, {
    unified5h: 0.05, unified5hReset: now + 4 * H,
    unified7d: 0.1, unified7dReset: now + 100 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 100 * H,
  });
  return am;
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

test('a Fable-only exclusion diverts Fable and leaves the current account for everything else', () => {
  const am = fleet();
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b', 'a cannot serve Fable; Fable diverts');
  // The observed defect: the Fable diversion had moved the global cursor, so
  // this returned b although a was fully eligible for Opus.
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  assert.equal(am.accounts[am.currentIndex].name, 'a', 'the current account did not move');
  assert.equal(am.getStatus().currentAccount, 'a');
});

test('the diverted family stays put, and returns once the current account can serve it again', () => {
  const am = fleet();
  am.getActiveAccount(null, OPUS);
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  // a's Fable bucket refreshes: Fable comes back to the current account.
  am.accounts[0].quota.unified7dFable = 0.1;
  assert.equal(am.getActiveAccount(null, FABLE).name, 'a');
});

test('a diversion is logged as one, once, and never as a global switch', () => {
  const am = fleet();
  am.getActiveAccount(null, OPUS);
  const lines = captureLog(() => {
    am.getActiveAccount(null, FABLE);
    am.getActiveAccount(null, FABLE);
  });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Divert/);
  assert.doesNotMatch(lines[0], /Switched to account/);
});

test('an exclusion that is not family-scoped still rotates the fleet', () => {
  const am = fleet();
  am.getActiveAccount(null, OPUS);
  // a's 5-hour window is spent: a can serve nothing, so this is the ordinary
  // rotation and the current account must move.
  am.accounts[0].quota.unified5h = 0.99;
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  assert.equal(am.accounts[am.currentIndex].name, 'b');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});
