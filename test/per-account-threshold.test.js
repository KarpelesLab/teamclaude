import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, DEFAULT_SWITCH_THRESHOLD } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// Fleet threshold fixed at 0.98 unless a test says otherwise; the second
// account carries whatever per-account switchThreshold the test is about.
function fleet(switchThreshold, fleetThreshold = 0.98) {
  return new AccountManager([oauth('a'), oauth('b', { switchThreshold })], fleetThreshold);
}

// ── thresholdFor(bucket, account) resolution order ────────────────────────

test('a bare per-account number overrides every bucket', () => {
  const am = fleet(0.5);
  const b = am.accounts[1];
  for (const bucket of ['unified5h', 'unified7d', 'unified7dFable', 'unified7dSonnet', 'tokens', 'requests']) {
    assert.equal(am.thresholdFor(bucket, b), 0.5, bucket);
  }
  // The other account carries no override and reads the fleet value.
  assert.equal(am.thresholdFor('unified7d', am.accounts[0]), 0.98);
});

test('a table without `default` only overrides the buckets it lists — the rest inherit the fleet value', () => {
  const am = fleet({ unified7dFable: 0.8 });
  const b = am.accounts[1];
  assert.equal(am.thresholdFor('unified7dFable', b), 0.8);
  // Not listed, and no account-level `default`: falls all the way through to
  // the fleet setting rather than being left uncovered.
  assert.equal(am.thresholdFor('unified5h', b), 0.98);
  assert.equal(am.thresholdFor('unified7d', b), 0.98);
});

test("an account `default` covers the buckets its own table does not list", () => {
  const am = fleet({ default: 0.5, unified7dFable: 0.8 });
  const b = am.accounts[1];
  assert.equal(am.thresholdFor('unified5h', b), 0.5);
  assert.equal(am.thresholdFor('unified7d', b), 0.5);
  assert.equal(am.thresholdFor('unified7dFable', b), 0.8);
});

test('a fleet-wide table still resolves normally for an account with no override', () => {
  const am = fleet(null, { default: 0.98, unified7d: 0.9 });
  const a = am.accounts[0];
  assert.equal(am.thresholdFor('unified7d', a), 0.9);
  assert.equal(am.thresholdFor('unified5h', a), 0.98);
});

test('an account bare number wins outright over a fleet-wide table', () => {
  const am = fleet(0.5, { default: 0.98, unified7d: 0.9 });
  const b = am.accounts[1];
  assert.equal(am.thresholdFor('unified7d', b), 0.5);
  assert.equal(am.thresholdFor('unified5h', b), 0.5);
});

test('effectiveThresholdFor mirrors effectiveThreshold but per account', () => {
  const am = fleet(0.6);
  assert.equal(am.effectiveThresholdFor(am.accounts[1]), 0.6);
  assert.equal(am.effectiveThresholdFor(am.accounts[0]), am.effectiveThreshold);
});

// ── invalid values fall back, exactly like the fleet's own tolerant rule ──
//
// switchThreshold has never had a hard config-load-time validator (only the
// `teamclaude threshold` CLI refuses a bad number, and that refusal never
// reaches the config file — see thresholdRatio in index.js). A malformed
// fleet value already falls back to DEFAULT_SWITCH_THRESHOLD rather than
// crashing or gating on NaN; the per-account override is held to the exact
// same rule via resolveSwitchThreshold's typeof/Number.isFinite guard.

test('a non-numeric per-account override is ignored, falling back to the fleet value', () => {
  const am = fleet('not-a-number');
  assert.equal(am.thresholdFor('unified7d', am.accounts[1]), 0.98);
});

test('NaN/Infinity in a per-account table are ignored bucket by bucket', () => {
  const am = fleet({ unified7d: NaN, unified5h: Infinity, unified7dFable: 0.8 });
  const b = am.accounts[1];
  assert.equal(am.thresholdFor('unified7d', b), 0.98);   // NaN rejected → fleet
  assert.equal(am.thresholdFor('unified5h', b), 0.98);   // Infinity rejected → fleet
  assert.equal(am.thresholdFor('unified7dFable', b), 0.8); // the one valid entry still applies
});

// A hand-edited array is the #425 hazard class: `typeof [] === 'object'`
// passes the naive object check, and spreading it would key a table by
// numeric string indices nothing ever asks about, silently doing nothing
// while looking configured. Per-account resolution must not repeat it.
test('a hand-edited array override is refused, not spread into numeric bucket keys', () => {
  const am = fleet([0.5]);
  const b = am.accounts[1];
  assert.equal(am.thresholdFor('unified7d', b), 0.98);
  assert.equal(am.thresholdFor('0', b), 0.98);
});

// ── rotation actually happens at the account's own level ──────────────────

test('two accounts at the same raw utilization rotate independently of their own thresholds', () => {
  const am = new AccountManager(
    [oauth('a', { switchThreshold: 1.0 }), oauth('b', { switchThreshold: 0.98 })],
    0.98,
  );
  const [a, b] = am.accounts;
  setQuota(a, { unified7d: 0.99 }); // under a's own 1.0 wall
  setQuota(b, { unified7d: 0.99 }); // over b's own 0.98 wall

  assert.equal(am.unavailableReason(a, OPUS), null);
  assert.equal(am.unavailableReason(b, OPUS), 'quota');

  am.currentIndex = 1; // start on b, which must rotate off
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('an uncapped-by-override account rotates at the fleet threshold as before', () => {
  const am = fleet(null, 0.98);
  const b = am.accounts[1];
  setQuota(b, { unified7d: 0.98 });
  assert.equal(am.unavailableReason(b, OPUS), 'quota');
});

// ── family bucket (unified7dFable) scoping ─────────────────────────────────

test("a per-account family override stops only that family, on that account's own wall", () => {
  const am = fleet({ unified7dFable: 0.8 });
  const b = am.accounts[1];
  setQuota(b, { unified7d: 0.1, unified7dFable: 0.85 }); // over b's 0.8, well under the 0.98 fleet default
  assert.equal(am.unavailableReason(b, FABLE), 'quota');
  assert.equal(am.unavailableReason(b, OPUS), null); // Opus is governed by unified7d, still on the fleet setting
});

test('a family override does not fire while the account is under it', () => {
  const am = fleet({ unified7dFable: 0.8 });
  const b = am.accounts[1];
  setQuota(b, { unified7d: 0.1, unified7dFable: 0.7 });
  assert.equal(am.unavailableReason(b, FABLE), null);
});

// ── status exposure ────────────────────────────────────────────────────────

test('getStatus exposes the raw per-account override, and null when there is none', () => {
  const am = fleet({ unified7dFable: 0.8 });
  const status = am.getStatus();
  assert.deepEqual(status.accounts[1].switchThreshold, { unified7dFable: 0.8 });
  assert.equal(status.accounts[0].switchThreshold, null);
});

// ── live reload via sync-accounts ──────────────────────────────────────────

test('a switchThreshold edit on disk applies to the running account without a restart', async () => {
  const mem = [{ name: 'a', type: 'apikey', apiKey: 'k' }, { name: 'b', type: 'apikey', apiKey: 'k2' }];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  const disk = mem.map(a => ({ ...a }));
  disk[1].switchThreshold = 0.5;

  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);

  assert.equal(am.accounts[1].switchThreshold, 0.5);
  assert.equal(am.thresholdFor('unified7d', am.accounts[1]), 0.5);

  // Dropping it on disk reverts the account to the fleet setting, mirroring
  // maxUsage's `|| null` reload behaviour.
  delete disk[1].switchThreshold;
  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.equal(am.accounts[1].switchThreshold, null);
  assert.equal(am.thresholdFor('unified7d', am.accounts[1]), 0.98);
});

test('DEFAULT_SWITCH_THRESHOLD still governs an account and fleet with nothing configured', () => {
  const am = new AccountManager([oauth('a')]);
  assert.equal(am.thresholdFor('unified7d', am.accounts[0]), DEFAULT_SWITCH_THRESHOLD);
});
