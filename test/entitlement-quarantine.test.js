import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name) {
  return {
    name,
    type: 'oauth',
    accessToken: `token-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: Date.now() + 3600_000,
  };
}

test('an entitlement denial makes an account unavailable until its cooldown expires', () => {
  const am = new AccountManager([oauth('a'), oauth('b')]);

  const deniedUntil = am.markEntitlementDenied(0, { seconds: 60 });

  assert.ok(deniedUntil > Date.now());
  assert.equal(am.getActiveAccount().name, 'b');
  assert.equal(
    am.getStatus().accounts[0].entitlementDeniedUntil,
    new Date(deniedUntil).toISOString(),
  );

  am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.accounts[0].entitlementDeniedUntil, null);
});

test('repeated entitlement denials extend a cooldown but never shorten it', () => {
  const am = new AccountManager([oauth('a')]);
  const first = am.markEntitlementDenied(0, { seconds: 60 });
  const second = am.markEntitlementDenied(0, { seconds: 1 });

  assert.equal(second, first);
  assert.equal(am.accounts[0].entitlementDeniedUntil, first);
});

test('an entitlement cooldown is not persisted as quota state', () => {
  const am = new AccountManager([oauth('a')]);
  am.markEntitlementDenied(0, { seconds: 60 });

  assert.equal(JSON.stringify(am.exportQuotaState()).includes('entitlement'), false);
});

const START = Date.parse('2026-07-03T12:00:00Z');
const MIN = 60_000;

// A denial is re-checked after every cooldown so an organization that turns
// OAuth back on is noticed without a restart. One that does not would cost a
// 403 every five minutes for good, so the wait lengthens while the denials
// keep coming, the way an API key's 401 hold does (#473).
test('consecutive entitlement denials lengthen the cooldown up to an hour', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a')]);
  for (const [n, wait] of [[1, 5], [2, 15], [3, 60], [4, 60]]) {
    assert.equal(am.markEntitlementDenied(0), Date.now() + wait * MIN);
    assert.equal(am.accounts[0].entitlementDenial.count, n);
    t.mock.timers.tick(wait * MIN);
    assert.equal(am.isEntitlementDenied(0), false);
  }
});

// Requests already in flight when the first 403 landed come back with their
// own, during the cooldown or after it, in the same millisecond or later. They
// are the same news, not further denials, and must not hold the account again.
test('a denial for a request sent before the last one was counted does not count again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a')]);
  const epoch = am.accounts[0].entitlementEpoch;
  const until = am.markEntitlementDenied(0);

  assert.equal(am.markEntitlementDenied(0, { epoch }), until);
  assert.equal(am.accounts[0].entitlementDenial.count, 1);

  t.mock.timers.tick(5 * MIN);
  am.markEntitlementDenied(0, { epoch });
  assert.equal(am.accounts[0].entitlementDenial.count, 1);
  assert.equal(am.isEntitlementDenied(0), false);
});

// A pinned request bypasses the cooldown, so a new one can be refused while
// it is live. That is a fresh denial, sent after the last one.
test('a denial for a request sent during a live cooldown counts as the next one', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a')]);
  am.markEntitlementDenied(0);

  assert.equal(am.markEntitlementDenied(0, { epoch: am.accounts[0].entitlementEpoch }), Date.now() + 15 * MIN);
  assert.equal(am.accounts[0].entitlementDenial.count, 2);
});

// Re-admission is not recovery: after the cooldown the account looked healthy
// in status until the next request was refused again. The denial stays visible
// until a request sent after it is served.
test('an entitlement denial stays in status past its cooldown until a later request is served', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([oauth('a')]);
  const before = am.accounts[0].entitlementEpoch;
  am.markEntitlementDenied(0, { detail: 'OAuth authentication is currently not allowed for this organization.' });
  t.mock.timers.tick(5 * MIN);

  assert.equal(am.getActiveAccount().name, 'a');
  assert.deepEqual(am.getStatus().accounts[0].entitlementDenial, {
    detail: 'OAuth authentication is currently not allowed for this organization.',
    since: START,
    count: 1,
  });

  am.clearEntitlementDenied(am.accounts[0], before);
  assert.equal(am.getStatus().accounts[0].entitlementDenial.count, 1, 'a request sent before the denial proves nothing');

  // An account object no longer at its index (removed meanwhile) clears nothing.
  am.clearEntitlementDenied({ ...am.accounts[0] }, am.accounts[0].entitlementEpoch);
  assert.equal(am.getStatus().accounts[0].entitlementDenial.count, 1, 'a stale account object clears nothing');

  am.clearEntitlementDenied(am.accounts[0], am.accounts[0].entitlementEpoch);
  assert.equal(am.getStatus().accounts[0].entitlementDenial, null);

  // A 403 still in flight from before the denial lands after the recovery.
  am.markEntitlementDenied(0, { epoch: before });
  assert.equal(am.getStatus().accounts[0].entitlementDenial, null);
  assert.equal(am.isEntitlementDenied(0), false);

  assert.equal(am.markEntitlementDenied(0), Date.now() + 5 * MIN);
});

test('a zero-second entitlement cooldown leaves the account available', () => {
  const am = new AccountManager([oauth('a')]);

  assert.equal(am.markEntitlementDenied(0, { seconds: 0 }), null);
  assert.equal(am.getActiveAccount().name, 'a');
});

// The TUI status column reads `active` off the account's own status, but the
// entitlement cooldown and the usage caps live beside it, so a barred account
// looked exactly like a healthy one (#468). The column now names the bar.
test('the TUI status column shows an entitlement cooldown and a usage cap', async () => {
  const { TUI } = await import('../src/tui.js');
  const { RemoteAccountManager } = await import('../src/tui-remote.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const am = new AccountManager([
    { name: 'denied', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'capped', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, maxUsage: 0.5 },
    { name: 'fine', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.markEntitlementDenied(0, { seconds: 240 });
  am.accounts[1].quota.unified7d = 0.6;
  am.accounts[1].quota.unified7dReset = Date.now() + 3600_000;
  const row = (mgr, i) => {
    const tui = new TUI({
      accountManager: mgr, config: { proxy: { port: 1 }, accounts: [], routes: [] },
      saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, remote: mgr !== am,
    });
    tui.render = () => {}; tui.mode = 'normal'; tui.selIdx = -1;
    return strip(tui._renderAcct(i, 8, true, mgr.getRoutes(), [], { fable: null, sonnet: null }));
  };
  assert.match(row(am, 0), /denied 4m/);
  assert.match(row(am, 1), /capped/);
  assert.match(row(am, 2), /active/);
  assert.doesNotMatch(row(am, 0), /active/);

  // Attach mode reads the same off the status payload, where the deadline is an
  // ISO string rather than a timestamp.
  const remote = new RemoteAccountManager();
  remote.applyStatus(am.getStatus());
  assert.match(row(remote, 0), /denied 4m/);
  assert.match(row(remote, 1), /capped/);
  assert.match(row(remote, 2), /active/);

  // Past the cooldown the account is re-admitted but not yet proven: it still
  // reads as denied, not active, until a request is served.
  am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
  assert.match(row(am, 0), /denied/);
  assert.doesNotMatch(row(am, 0), /active/);
  const later = new RemoteAccountManager();
  later.applyStatus(am.getStatus());
  assert.match(row(later, 0), /denied/);
  assert.doesNotMatch(row(later, 0), /active/);

  // The count rides along, and a state that needs something else wins.
  am.markEntitlementDenied(0);
  am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
  assert.match(row(am, 0), /denied \u00d72/);
  am.accounts[0].maxUsage = 0.5;
  am.accounts[0].quota.unified7d = 0.6;
  am.accounts[0].quota.unified7dReset = Date.now() + 3600_000;
  assert.match(row(am, 0), /capped/);
  am.accounts[0].maxUsage = null;
  am.accounts[0].status = 'error';
  assert.match(row(am, 0), /error/);
  const failed = new RemoteAccountManager();
  failed.applyStatus(am.getStatus());
  assert.match(row(failed, 0), /error/);

  // The column is ten wide, and a count off the attach payload is not trusted.
  am.accounts[0].status = 'active';
  am.accounts[0].entitlementDenial.count = 100;
  assert.match(row(am, 0), /denied 99\+/);
  for (const count of ['2\n', { valueOf: 1, toString: 1 }]) {
    const odd = new RemoteAccountManager();
    odd.applyStatus(am.getStatus());
    odd.accounts[0].entitlementDenial.count = count;
    const line = row(odd, 0);
    assert.match(line, /denied/);
    assert.doesNotMatch(line, /\n/);
  }
});
