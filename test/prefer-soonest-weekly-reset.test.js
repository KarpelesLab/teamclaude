import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const H = 3600_000;

// Three equal-priority accounts, the first (current) resetting furthest out.
function fleet(prefer, extra = {}) {
  const am = new AccountManager([oauth('late'), oauth('soon'), oauth('mid')], 0.98,
    { preferSoonestWeeklyReset: prefer, ...extra });
  const now = Date.now();
  Object.assign(am.accounts[0].quota, { unified7d: 0.1, unified7dReset: now + 150 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.5, unified7dReset: now + 10 * H });
  Object.assign(am.accounts[2].quota, { unified7d: 0.2, unified7dReset: now + 60 * H });
  return am;
}

test('off: stays on the current account while it has quota', () => {
  const am = fleet(false);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'late');
});

test('on: moves to the account whose weekly resets soonest', () => {
  const am = fleet(true);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'soon');
  // ...and stays there.
  assert.equal(am.getActiveAccount(null, OPUS).name, 'soon');
});

test('on: once the soonest is spent, falls to the next-soonest', () => {
  const am = fleet(true);
  am.accounts[1].quota.unified7d = 0.99;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'mid');
});

test('on: a 5h-limited soonest account is skipped, then reclaimed', () => {
  const am = fleet(true);
  Object.assign(am.accounts[1].quota, { unified5h: 0.99, unified5hReset: Date.now() + H });
  assert.equal(am.getActiveAccount(null, OPUS).name, 'mid');
  am.accounts[1].quota.unified5h = 0.1;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'soon');
});

test('on: priority still wins over reset time', () => {
  const am = fleet(true);
  am.accounts[1].priority = 5;
  am.accounts[2].priority = 5;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'late');
});

test('on: an account with an unknown reset does not preempt', () => {
  const am = fleet(true);
  am.accounts[1].quota.unified7dReset = null;
  am.accounts[2].quota.unified7dReset = null;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'late');
});

test('on: eligibility reports the sooner-reset preemptor', () => {
  const am = fleet(true);
  const e = am.eligibility(0);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /"soon".*resets sooner/);
});

test('setter toggles live', () => {
  const am = fleet(false);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'late');
  am.setPreferSoonestWeeklyReset(true);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'soon');
});
