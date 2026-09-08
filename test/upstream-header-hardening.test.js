import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Rate-limit headers come from whatever `upstream` points at, and the model name
// comes from the client's request body. Neither is ours: a value that does not
// parse must not wedge a bucket, and a string must not reach a log or a status
// line carrying a terminal escape.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const codex = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });

// Capture console.log for one call.
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

// ── reset headers that do not parse ─────────────────────────

test('an unparseable 5h reset is ignored, so the bucket still clears on the reset we knew', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const past = Math.floor((Date.now() + 1000) / 1000); // a reset just ahead of us
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String(past),
  });
  assert.equal(am.accounts[0].quota.unified5hReset, past * 1000);

  // A later response from a lying upstream: `never` used to become NaN here,
  // and `now >= NaN` is never true, so the bucket could not be cleared again.
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': 'never',
  });
  assert.equal(am.accounts[0].quota.unified5hReset, past * 1000, 'the valid reset survives');
  assert.equal(am._isNearQuota(am.accounts[0]), true, 'still spent before the reset');

  am.accounts[0].quota.unified5hReset = Date.now() - 1; // the window rolls over
  assert.equal(am._isNearQuota(am.accounts[0]), false, 'and the bucket clears');
  assert.equal(am.accounts[0].quota.unified5h, null);
});

test('reset headers are stored only as positive finite numbers, never NaN', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-reset': 'never',
    'anthropic-ratelimit-unified-7d-reset': '-5',
    'anthropic-ratelimit-unified-7d_oi-reset': 'NaN',
    'anthropic-ratelimit-tokens-reset': 'tomorrow-ish',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified5hReset, null);
  assert.equal(q.unified7dReset, null);
  assert.equal(q.unified7dFableReset, null);
  assert.equal(q.resetsAt, null);

  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-reset': '1900000000',
    'anthropic-ratelimit-tokens-reset': '2030-01-01T00:00:00Z',
  });
  assert.equal(q.unified5hReset, 1900000000 * 1000);
  assert.equal(q.resetsAt, '2030-01-01T00:00:00Z');
});

// ── header-derived strings ───────────────────────────────────

test('unified-status is stripped of escapes and bounded before it is stored', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected\x1b[2J\n' + 'x'.repeat(100) });
  const status = am.accounts[0].quota.unifiedStatus;
  assert.equal(/[\x00-\x1f\x7f]/.test(status), false, 'no control characters');
  assert.ok(status.startsWith('rejected'));
  assert.ok(status.length <= 32);
});

test('a plain unified-status is stored as-is and still acted on', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(am.accounts[0].quota.unifiedStatus, 'rejected');
  assert.equal(am.unavailableReason(am.accounts[0]), 'upstream-rejected');
});

test('codex plan type and bucket names are stripped of escapes', () => {
  const am = new AccountManager([codex('c')], 0.98);
  am.updateQuota(0, {
    'x-codex-plan-type': 'pro\x1b[31m',
    'x-codex-fox-primary-used-percent': '10',
    'x-codex-fox-primary-window-minutes': '10080',
    'x-codex-fox-limit-name': 'GPT\x1b[1;1H-Spark',
  });
  const q = am.accounts[0].quota;
  assert.equal(q.planType, 'pro');
  assert.equal(q.codexModelBuckets.fox.name, 'GPT -Spark');
});

test('codex model buckets are capped: the reading refreshed longest ago makes room', () => {
  const am = new AccountManager([codex('c')], 0.98);
  const headersFor = (slug) => ({
    [`x-codex-${slug}-primary-used-percent`]: '10',
    [`x-codex-${slug}-primary-window-minutes`]: '10080',
  });
  for (let i = 0; i < 40; i++) {
    am.updateQuota(0, headersFor(`fam${i}`));
    // Distinct seenAt stamps so "longest ago" is well defined.
    for (const b of Object.values(am.accounts[0].quota.codexModelBuckets)) b.seenAt -= 1;
  }
  const slugs = Object.keys(am.accounts[0].quota.codexModelBuckets);
  assert.equal(slugs.length, 32);
  assert.equal(slugs.includes('fam0'), false, 'the oldest went first');
  assert.equal(slugs.includes('fam39'), true);

  // Refreshing a slug that is already known never evicts anything.
  am.updateQuota(0, headersFor('fam39'));
  assert.equal(Object.keys(am.accounts[0].quota.codexModelBuckets).length, 32);
});

// ── the model name in log lines ──────────────────────────────

test('a request-body model name is stripped before it reaches the advisor log line', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) {
    acc.quota.unified7dFable = 0.999;
    acc.quota.unified7dFableReset = Date.now() + 3600_000;
  }
  const hostile = 'claude-fable-5\x1b[2J\nforged line';
  const lines = captureLog(() => am.getActiveAccount(null, 'claude-opus-4-8', hostile));
  const line = lines.find(l => l.includes('advisor model'));
  assert.ok(line, 'the degrade line is logged');
  assert.equal(line.includes('\x1b'), false);
  assert.equal(line.includes('\n'), false);
  assert.ok(line.includes('claude-fable-5 forged line'));
});

test('the model name in the divert log line is stripped and bounded', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a');
  // a's Fable weekly is spent: it serves Opus but a Fable request is diverted.
  am.accounts[0].quota.unified7dFable = 0.999;
  am.accounts[0].quota.unified7dFableReset = Date.now() + 3600_000;
  const hostile = 'claude-fable-5\x1b[2J' + 'z'.repeat(200);
  const lines = captureLog(() => am.getActiveAccount(null, hostile));
  const line = lines.find(l => l.includes('Diverting'));
  assert.ok(line, 'the divert line is logged');
  assert.equal(line.includes('\x1b'), false);
  assert.ok(line.length < 200, 'the model name is bounded, not echoed whole');
});
