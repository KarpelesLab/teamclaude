import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fleet() {
  return new AccountManager([oauth('a'), oauth('b')], 0.98);
}

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// ── _isNearQuota names the bucket that fired ─────────────────

test('the 5-hour bucket fires first and is named, even when the weekly is known too', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  assert.equal(am._nearQuotaBucket(a), 'unified5h');
});

test('a governing weekly bucket fires and is named when the 5-hour is fresh', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.10, unified7d: 0.99 });
  assert.equal(am._nearQuotaBucket(a), 'unified7d');
  assert.equal(am._isNearQuota(a), true);
});

test('a family weekly bucket is named for the model it governs', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.10, unified7dFable: 0.99, unified7d: 0.20 });
  assert.equal(am._nearQuotaBucket(a, 'claude-fable-5-1'), 'unified7dFable');
});

test('a tokens bucket fires and is named on an API-key account', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: null, tokensLimit: 1000, tokensRemaining: 10 });
  assert.equal(am._nearQuotaBucket(a), 'tokens');
});

test('nothing over threshold returns null', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.40, unified7d: 0.52 });
  assert.equal(am._nearQuotaBucket(a), null);
  assert.equal(am._isNearQuota(a), false);
});

// ── _bucketPct reads the fired bucket, not a fixed one ───────

test('the percent shown is the fired bucket own number', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  assert.equal(am._bucketPct(a, 'unified5h'), 99);
  setQuota(a, { unified5h: 0.10, unified7d: 0.99 });
  assert.equal(am._bucketPct(a, 'unified7d'), 99);
});

// ── the log line names the bucket that fired ─────────────────

test('updateQuota logs the fired bucket with its own percent', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    am.updateQuota(0, {}, null, null);
  } finally {
    console.log = realLog;
  }
  const line = lines.find((l) => l.includes('will switch on next request'));
  assert.ok(line, 'the switch line was logged');
  assert.match(line, /at 99% unified5h usage/);
  assert.doesNotMatch(line, /52/);
});
