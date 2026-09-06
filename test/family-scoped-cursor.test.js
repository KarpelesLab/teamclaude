import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Availability is scoped per model: an account whose Fable weekly bucket is
// spent still serves every other family. A request that finds the current
// account unable to serve ITS family must therefore divert that family alone,
// not move the fleet — the account was chosen (often by hand, for a weekly
// window about to lapse) precisely to be spent by the families it can serve.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';
const H = 3600_000;

// a: weekly lapses soon, Fable bucket spent, everything else fine.
// b: fresh, weekly resets much later.
function fleet(extra = [], opts = {}) {
  const am = new AccountManager([oauth('a', opts.a), oauth('b', opts.b), ...extra], 0.98, opts.manager);
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
  // The diversion paces the burst onto b once; a repeat does not re-arm it.
  assert.notEqual(am.accounts[1].rampStartedAt, null);
  am.accounts[1].rampStartedAt = null;
  am.getActiveAccount(null, FABLE);
  assert.equal(am.accounts[1].rampStartedAt, null);
});

test('advisor requests keep their own cursor, so interleaving with plain requests does not thrash', () => {
  const am = fleet();
  am.getActiveAccount(null, OPUS);
  const lines = captureLog(() => {
    for (let i = 0; i < 3; i++) {
      // An Opus request whose advisor needs Fable: a cannot serve the pair.
      assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
      assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
    }
  });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.equal(am.accounts[am.currentIndex].name, 'a');
});

test('a current account barred outright is abandoned, diversion cursor or not', () => {
  const am = fleet();
  am.getActiveAccount(null, OPUS);
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  am.setDisabled(0, true);
  // Fable-only traffic: the sticky diversion must not keep a disabled account current.
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  assert.equal(am.accounts[am.currentIndex].name, 'b', 'the fleet moved off the disabled account');
  assert.equal(am.getStatus().currentAccount, 'b');
});

test('the preview names the account a diverted family will actually land on', () => {
  // c is barred at first (5h spent), then frees up with a sooner Fable reset
  // than b. Selection keeps Fable on b; the preview must say the same.
  const am = fleet([oauth('c')]);
  const now = Date.now();
  Object.assign(am.accounts[2].quota, {
    unified5h: 0.99, unified5hReset: now + 4 * H,
    unified7d: 0.1, unified7dReset: now + 2 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 2 * H,
  });
  am.getActiveAccount(null, OPUS);
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  am.accounts[2].quota.unified5h = 0.1;
  const chosen = am.getActiveAccount(null, FABLE);
  assert.equal(chosen.name, 'b');
  assert.equal(am.previewRouteIndex(FABLE), chosen.index);
});

test('a diverted family yields to a higher-priority account that becomes available', () => {
  const am = fleet([oauth('c', { priority: 0 })], { a: { priority: 1 }, b: { priority: 1 } });
  const now = Date.now();
  Object.assign(am.accounts[2].quota, {
    unified5h: 0.99, unified5hReset: now + 4 * H,
    unified7d: 0.1, unified7dReset: now + 50 * H,
    unified7dFable: 0.1, unified7dFableReset: now + 50 * H,
  });
  am.getActiveAccount(null, OPUS);
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
  am.accounts[2].quota.unified5h = 0.1;
  assert.equal(am.getActiveAccount(null, FABLE).name, 'c');
});

test('a route exclusion is model-scoped too: a manual switch to a routed account holds', () => {
  const routes = [
    { name: 'backend', match: ['k3*'], accounts: ['backend'] },
    { name: 'claude', match: ['*'], accounts: ['a', 'b'] },
  ];
  const am = fleet([apikey('backend', { priority: 100 })], { manager: { routes } });
  am.currentIndex = 2; // POST /teamclaude/switch to the backend account
  assert.equal(am.getActiveAccount(null, 'k3-large').name, 'backend');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a', 'Opus is routed away');
  assert.equal(am.getActiveAccount(null, 'k3-large').name, 'backend');
  assert.equal(am.getStatus().currentAccount, 'backend', 'the operator\'s switch was not undone');
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
