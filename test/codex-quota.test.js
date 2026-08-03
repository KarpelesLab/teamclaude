import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexQuota, isCodexQuotaExhausted, codexResetAfterSeconds } from '../src/codex/quota.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { Warmer } from '../src/warmer.js';

// Captured verbatim from a live ChatGPT Codex response (plan: plus). The
// account reports its 7-day limit in the PRIMARY slot and leaves secondary
// inactive — which is why buckets are classified by window duration rather
// than by slot name.
const LIVE_HEADERS = {
  'x-codex-active-limit': 'premium',
  'x-codex-plan-type': 'plus',
  'x-codex-primary-used-percent': '0',
  'x-codex-secondary-used-percent': '0',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-over-secondary-limit-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-primary-reset-after-seconds': '604709',
  'x-codex-secondary-reset-after-seconds': '0',
  'x-codex-primary-reset-at': '1786201952',
  'x-codex-secondary-reset-at': '',
  'x-codex-credits-has-credits': 'False',
  'x-codex-credits-balance': '0',
  'x-codex-credits-unlimited': 'False',
};

const NOW = 1_785_597_000_000;

test('the live header set parses into the weekly bucket', () => {
  const q = parseCodexQuota(LIVE_HEADERS, NOW);
  assert.equal(q.unified7d, 0);
  assert.equal(q.unified7dReset, 1786201952 * 1000);
  assert.equal(q.planType, 'plus');
  // Secondary has a zero-length window, so it is not a real bucket.
  assert.equal(q.unified5h, undefined);
  assert.equal(q.unified5hReset, undefined);
});

test('an inactive bucket is ignored rather than read as 0% used', () => {
  // A zero window with 0% used would otherwise look like a limit with full
  // headroom, making an account seem more available than it is.
  const q = parseCodexQuota({
    'x-codex-secondary-window-minutes': '0',
    'x-codex-secondary-used-percent': '0',
  }, NOW);
  assert.deepEqual(q, {});
});

test('a short window is classified as the session bucket', () => {
  const q = parseCodexQuota({
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-reset-at': '1786201952',
  }, NOW);
  assert.equal(q.unified5h, 0.42);
  assert.equal(q.unified5hReset, 1786201952 * 1000);
  assert.equal(q.unified7d, undefined);
});

test('buckets are classified by duration, not by slot name', () => {
  // Secondary carries the weekly here and primary the session — the reverse of
  // the observed plan. Both must still land in the right place.
  const q = parseCodexQuota({
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-used-percent': '10',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '80',
  }, NOW);
  assert.equal(q.unified5h, 0.1);
  assert.equal(q.unified7d, 0.8);
});

test('percentages convert to fractions and overage is preserved', () => {
  const q = parseCodexQuota({
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-used-percent': '137.5',
  }, NOW);
  // Past 1 means overage; _isNearQuota reads anything past the threshold the
  // same way, so clamping would only lose information.
  assert.equal(q.unified7d, 1.375);
});

test('reset falls back to the relative seconds when reset-at is absent', () => {
  const q = parseCodexQuota({
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-used-percent': '5',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-primary-reset-at': '',
  }, NOW);
  assert.equal(q.unified7dReset, NOW + 3600_000);
});

test('two windows of the same class keep the more exhausted one', () => {
  const q = parseCodexQuota({
    'x-codex-primary-window-minutes': '60',
    'x-codex-primary-used-percent': '20',
    'x-codex-secondary-window-minutes': '300',
    'x-codex-secondary-used-percent': '90',
  }, NOW);
  // The 90% bucket is the one that will actually stop the account.
  assert.equal(q.unified5h, 0.9);
});

test('parseCodexQuota is safe on missing and malformed input', () => {
  assert.deepEqual(parseCodexQuota(null), {});
  assert.deepEqual(parseCodexQuota({}), {});
  assert.deepEqual(parseCodexQuota({
    'x-codex-primary-window-minutes': 'not-a-number',
    'x-codex-primary-used-percent': '50',
  }, NOW), {});
});

test('isCodexQuotaExhausted only fires at a spent bucket', () => {
  assert.equal(isCodexQuotaExhausted(LIVE_HEADERS, NOW), false);
  assert.equal(isCodexQuotaExhausted({
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-used-percent': '99.9',
  }, NOW), false);
  assert.equal(isCodexQuotaExhausted({
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-used-percent': '100',
  }, NOW), true);
});

test('codexResetAfterSeconds reports the earliest future reset', () => {
  const headers = {
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-at': String(Math.floor(NOW / 1000) + 60),
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-reset-at': String(Math.floor(NOW / 1000) + 6000),
  };
  assert.equal(codexResetAfterSeconds(headers, NOW), 60);
});

test('codexResetAfterSeconds is null when nothing is known', () => {
  assert.equal(codexResetAfterSeconds({}, NOW), null);
});

// ── account manager integration ─────────────────────────────

function codexAcct(extra = {}) {
  return {
    name: 'cx', type: 'oauth', protocol: 'codex', accountId: 'a',
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra,
  };
}

test('updateQuota routes a codex account to the codex parser', () => {
  const am = new AccountManager([codexAcct()], 0.98);
  am.updateQuota(0, LIVE_HEADERS);
  assert.equal(am.accounts[0].quota.unified7d, 0);
  assert.equal(am.accounts[0].quota.unified7dReset, 1786201952 * 1000);
  assert.equal(am.accounts[0].planType, 'plus');
  assert.equal(am.accounts[0].usage.totalRequests, 1);
});

test('an anthropic account still uses the anthropic parser', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't' }], 0.98);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.5',
    'anthropic-ratelimit-unified-7d-utilization': '0.25',
  });
  assert.equal(am.accounts[0].quota.unified5h, 0.5);
  assert.equal(am.accounts[0].quota.unified7d, 0.25);
});

test('codex headers do not leak into an anthropic account', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't' }], 0.98);
  am.updateQuota(0, LIVE_HEADERS);
  assert.equal(am.accounts[0].quota.unified7d, null);
});

test('a spent codex weekly bucket makes the account unavailable', () => {
  // The point of the adapter: exhaustion is known from the previous response,
  // so the next request never lands on a spent account.
  const am = new AccountManager([codexAcct()], 0.98);
  am.updateQuota(0, {
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 600),
  });
  assert.equal(am._isAvailable(am.accounts[0]), false);
});

test('a codex account with headroom stays available', () => {
  const am = new AccountManager([codexAcct()], 0.98);
  am.updateQuota(0, LIVE_HEADERS);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('rotation prefers the codex account once the claude one is spent', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    codexAcct({ name: 'codex' }),
  ], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '1.0' });
  am.updateQuota(1, LIVE_HEADERS);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am.getActiveAccount().name, 'codex');
});

test('learning a codex weekly quota clears the probing flag', () => {
  const am = new AccountManager([codexAcct()], 0.98);
  assert.equal(am.accounts[0].probing, true);
  am.updateQuota(0, LIVE_HEADERS);
  assert.equal(am.accounts[0].probing, false);
  assert.equal(am.accounts[0].requalify, true);
});

// ── probe / warm exclusion ──────────────────────────────────

test('the prober skips codex accounts', async () => {
  // fetchUsage talks to Anthropic's usage endpoint, which rejects a ChatGPT
  // token; probing one would 401, force a refresh, 401 again and stick.
  const probed = [];
  const am = new AccountManager([
    codexAcct({ name: 'codex' }),
    { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const prober = new Prober(am, {
    probeFn: async () => { probed.push(true); return { unified: {} }; },
    log: () => {},
  });

  await prober.probeAll();
  assert.equal(probed.length, 1);
});

test('the warmer skips codex accounts', () => {
  const am = new AccountManager([codexAcct()], 0.98);
  const warmer = new Warmer(am, { spawnFn: async () => 0, log: () => {} });
  assert.equal(warmer._isWarmTarget(am.accounts[0]), false);
});

test('the warmer still targets an ordinary oauth account', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't' }], 0.98);
  const warmer = new Warmer(am, { spawnFn: async () => 0, log: () => {} });
  assert.equal(warmer._isWarmTarget(am.accounts[0]), true);
});
