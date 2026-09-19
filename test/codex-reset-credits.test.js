import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { accountBadges } from '../src/dashboard.js';
import { renderStatus, resetCreditLine } from '../src/status-renderer.js';
import { resetCreditTag } from '../src/tui.js';

// Free Codex rate-limit reset credits: the count an account holds, and every
// surface that reports it.
//
// Reading the count out of the `/wham/usage` payload is exercised beside the
// rest of that payload, in codex-usage.test.js. This is what becomes of the
// count once it has reached an account.

const DAY = 24 * 60 * 60 * 1000;

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** A Codex account exactly as a config that never mentions the option makes one. */
function codex(name, extra = {}) {
  return oauth(name, { provider: 'codex', accountId: 'acct-' + name, ...extra });
}

// ── what the operator sees ──────────────────────────────────────────────────

// The badge count is the account's HOLDINGS (`available_count`), which says
// nothing about plan support — that is stated only by the detail rows, and
// they cost a request nobody should make to draw a badge. The two counts must
// stay distinguishable in the code; here they are simply never conflated.

test('the TUI row tags an account holding credits, and only then', () => {
  assert.equal(resetCreditTag({ resetCredits: { available: 1, applicable: 0 } }), 'RC1');
  assert.equal(resetCreditTag({ resetCredits: { available: 2, applicable: 2 } }), 'RC2');
  assert.equal(resetCreditTag({ resetCredits: { available: 0, applicable: 0 } }), '');
  assert.equal(resetCreditTag({ resetCredits: null }), '');
  assert.equal(resetCreditTag({}), '');
});

test('the status screen names the credits, and says when none would apply yet', () => {
  const paint = { dim: s => s, cyan: s => s, gray: s => s };
  assert.equal(resetCreditLine({ quota: {} }, paint), null);
  assert.equal(resetCreditLine({ quota: { resetCredits: { available: 0, applicable: 0 } } }, paint), null);

  const one = resetCreditLine({ quota: { resetCredits: { available: 1, applicable: 0 } } }, paint);
  assert.match(one, /1 free rate-limit reset credit/);
  assert.match(one, /none applicable to a window right now/);

  const two = resetCreditLine({ quota: { resetCredits: { available: 2, applicable: 1 } } }, paint);
  assert.match(two, /2 free rate-limit reset credits/);
  assert.equal(/none applicable/.test(two), false);
});

test('the status screen stays silent for an account holding nothing', () => {
  const account = { name: 'a', type: 'oauth', status: 'active', quota: { unified5h: 0.2, unified7d: 0.3 }, usage: {}, sessions: 0 };
  const out = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [account] }, { color: false });
  assert.equal(/Reset/.test(out), false);

  const holding = { ...account, quota: { ...account.quota, resetCredits: { available: 1, applicable: 0 } } };
  const shown = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [holding] }, { color: false });
  assert.match(shown, /Reset\s+1 free rate-limit reset credit/);
});

test('the dashboard card carries the same count', () => {
  const card = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 1, applicable: 0 } } }, 'a');
  assert.ok(card.some(b => b.text === '1 reset credit'));
  const plural = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 3, applicable: 1 } } }, 'a');
  assert.ok(plural.some(b => b.text === '3 reset credits'));
  const none = accountBadges({ name: 'a', provider: 'codex', quota: { resetCredits: { available: 0, applicable: 0 } } }, 'a');
  assert.equal(none.some(b => /reset credit/.test(b.text)), false);
});

// The count is the only thing an operator sees when the probe is off, and the
// probe is off by default — so it has to survive a restart.
test('the credit count survives export and restore', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, { sevenDay: { utilization: 1, resetAt: Date.now() + DAY }, resetCredits: { available: 1, applicable: 0 } });
  assert.equal(am.accounts[0].quota.resetCredits.available, 1);
  assert.equal(typeof am.accounts[0].quota.resetCredits.seenAt, 'number');

  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const restored = new AccountManager([codex('a')], 0.98);
  restored.restoreQuotaState(saved);
  assert.equal(restored.accounts[0].quota.resetCredits.available, 1);
});

// A payload that says nothing about credits must not blank what we knew: the
// count is the one field here with no other source.
test('a usage reading with no credit counters leaves the last one alone', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, { resetCredits: { available: 1, applicable: 1 } });
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + DAY } });
  assert.equal(am.accounts[0].quota.resetCredits.available, 1);
});
