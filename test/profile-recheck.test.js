import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober, PROFILE_RECHECK_MS } from '../src/prober.js';
import { renderStatus } from '../src/status-renderer.js';

// The probe read the OAuth profile only until the tier was known, so a Max or
// Pro plan that lapsed later went unnoticed. It is now read again on a slow
// cadence, and a plan that disappears is reported in status.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 3600_000, ...extra };
}

const MAX = { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_20x', hasClaudeMax: true, hasClaudePro: false };
const PRO = { organizationType: 'claude_pro', rateLimitTier: 'default_claude_pro', hasClaudeMax: false, hasClaudePro: true };
const FREE = { organizationType: 'claude_free', rateLimitTier: 'default_claude_ai', hasClaudeMax: false, hasClaudePro: false };
const usage = async () => ({ fiveHour: { utilization: 0.1, resetAt: 1000 } });
const START = Date.parse('2026-01-01T00:00:00Z');

test('the probe reads a known plan again once per profile interval', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  let reads = 0;
  const prober = new Prober(am, { intervalMs: 0, probeFn: usage, profileFn: async () => { reads++; return MAX; }, log: () => {} });
  await prober.probeAll();
  assert.equal(reads, 1, 'read on the first cycle');
  t.mock.timers.setTime(START + PROFILE_RECHECK_MS - 1);
  await prober.probeAll();
  assert.equal(reads, 1, 'not again inside the interval');
  t.mock.timers.setTime(START + PROFILE_RECHECK_MS);
  await prober.probeAll();
  assert.equal(reads, 2, 'again once it has passed');
});

test('accounts that share a name keep their own profile schedule', async () => {
  const am = new AccountManager([oauth('same', MAX), oauth('same', { ...MAX, accessToken: 't-other' })], 0.98);
  const seen = [];
  const prober = new Prober(am, { intervalMs: 0, probeFn: usage, profileFn: async (token) => { seen.push(token); return MAX; }, log: () => {} });
  await prober.probeAll();
  assert.deepEqual(seen.sort(), ['t-other', 't-same']);
});

test('a plan that turns free is reported with when it was seen, and the account stays in rotation', async () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  const prober = new Prober(am, { intervalMs: 0, probeFn: usage, profileFn: async () => FREE, log: () => {} });
  const before = Date.now();
  await prober.probeAll();
  const row = am.getStatus().accounts[0];
  assert.equal(row.subscriptionLost.plan, 'Max');
  assert.ok(row.subscriptionLost.since >= before);
  assert.equal(row.status, 'active');
  assert.equal(row.unavailable, null);
  assert.equal(am.accounts[0].hasClaudeMax, false, 'the profile fields still take the new values');
  assert.equal(am.accounts[0].rateLimitTier, 'default_claude_ai');
});

test('the loss is found even when the usage read is refused', async () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  const prober = new Prober(am, { intervalMs: 0, probeFn: async () => ({ error: 'HTTP 403', status: 403 }), profileFn: async () => FREE, log: () => {} });
  await prober.probeAll();
  assert.equal(am.getStatus().accounts[0].subscriptionLost?.plan, 'Max');
});

test('the first time the loss was seen is kept, also when a reload puts the signed-in plan back', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  t.mock.timers.setTime(START + PROFILE_RECHECK_MS);
  am.applyProfileData(0, FREE);
  // What syncAccountsFromDisk does with the config row's profile fields.
  Object.assign(am.accounts[0], { hasClaudeMax: true, hasClaudePro: false });
  t.mock.timers.setTime(START + 2 * PROFILE_RECHECK_MS);
  am.applyProfileData(0, FREE);
  assert.deepEqual(am.getStatus().accounts[0].subscriptionLost, { plan: 'Max', since: START });
});

test('the loss is restored after a restart from the saved quota state', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  const lost = am.accounts[0].subscriptionLost;
  assert.equal(lost?.plan, 'Max');
  // The config row still carries what login saw.
  const restarted = new AccountManager([oauth('a', MAX)], 0.98);
  restarted.restoreQuotaState(JSON.parse(JSON.stringify(am.exportQuotaState())));
  assert.deepEqual(restarted.getStatus().accounts[0].subscriptionLost, lost);
});

test('new tokens drop a restored loss until a profile read says it again', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  const restarted = new AccountManager([oauth('a', MAX)], 0.98);
  restarted.restoreQuotaState(JSON.parse(JSON.stringify(am.exportQuotaState())));
  assert.ok(restarted.accounts[0].subscriptionLost);
  // A `teamclaude login` reaches the running proxy by a reload: the plan the
  // login saw (sync-accounts copies it from the config row), then new tokens.
  Object.assign(restarted.accounts[0], MAX);
  restarted.updateAccountTokens(0, { accessToken: 't-new', refreshToken: 'r-new', expiresAt: Date.now() + 3600_000 });
  assert.equal(restarted.getStatus().accounts[0].subscriptionLost, null);
  restarted.applyProfileData(0, FREE);
  assert.equal(restarted.getStatus().accounts[0].subscriptionLost?.plan, 'Max', 'a profile still without the plan reports it again');
});

test('a profile showing a plan again clears the report', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  assert.ok(am.accounts[0].subscriptionLost);
  am.applyProfileData(0, PRO);
  assert.equal(am.getStatus().accounts[0].subscriptionLost, null);
  assert.equal(am.accounts[0].hasClaudePro, true);
});

test('only a profile that shows a plan clears the report, not one that omits the flags', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  Object.assign(am.accounts[0], { hasClaudeMax: true }); // a reload, as above
  am.applyProfileData(0, { organizationType: 'claude_max' });
  assert.equal(am.accounts[0].subscriptionLost?.plan, 'Max');
});

test('a failed or empty profile read changes nothing', () => {
  const am = new AccountManager([oauth('a', MAX), oauth('b', MAX)], 0.98);
  am.applyProfileData(1, FREE);
  const lost = { ...am.accounts[1].subscriptionLost };
  for (const failed of [{ error: 'HTTP 503', status: 503 }, { error: 'fetch failed', status: null }, null]) {
    am.applyProfileData(0, failed);
    am.applyProfileData(1, failed);
  }
  assert.equal(am.accounts[0].subscriptionLost, null);
  assert.equal(am.accounts[0].hasClaudeMax, true);
  assert.deepEqual(am.accounts[1].subscriptionLost, lost);
});

test('a profile that omits the plan flags is not a loss', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' });
  assert.equal(am.accounts[0].rateLimitTier, 'default_claude_max_5x');
  assert.equal(am.accounts[0].hasClaudeMax, true);
  assert.equal(am.accounts[0].subscriptionLost, null);
});

test('a plan change that keeps a plan is logged, not reported as a loss', (t) => {
  const logged = [];
  t.mock.method(console, 'log', (/** @type {string} */ line) => { logged.push(line); });
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  logged.length = 0;
  am.applyProfileData(0, PRO);
  assert.equal(am.accounts[0].subscriptionLost, null);
  assert.equal(am.accounts[0].hasClaudePro, true);
  assert.deepEqual(logged, ['[TeamClaude] Account "a": plan changed from Claude Max (default_claude_max_20x) to Claude Pro (default_claude_pro)']);
});

test('an account that never showed Max or Pro is not reported', () => {
  const am = new AccountManager([oauth('a', { organizationType: 'claude_team', seatTier: 'team_standard', hasClaudeMax: false, hasClaudePro: false })], 0.98);
  am.applyProfileData(0, { organizationType: 'claude_team', seatTier: 'team_premium', hasClaudeMax: false, hasClaudePro: false });
  assert.equal(am.accounts[0].seatTier, 'team_premium');
  assert.equal(am.accounts[0].subscriptionLost, null);
});

test('status names the lost plan, since when, and what to do', () => {
  const am = new AccountManager([oauth('a', MAX)], 0.98);
  am.applyProfileData(0, FREE);
  const text = renderStatus(am.getStatus(), { color: false });
  assert.match(text, /Plan\s+its OAuth profile no longer shows the Claude Max plan \(since .+ ago\) — renew the plan or disable the account/);
});
