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

  const deniedUntil = am.markEntitlementDenied(0, 60);

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
  const first = am.markEntitlementDenied(0, 60);
  const second = am.markEntitlementDenied(0, 1);

  assert.equal(second, first);
  assert.equal(am.accounts[0].entitlementDeniedUntil, first);
});

test('an entitlement cooldown is not persisted as quota state', () => {
  const am = new AccountManager([oauth('a')]);
  am.markEntitlementDenied(0, 60);

  assert.equal(JSON.stringify(am.exportQuotaState()).includes('entitlement'), false);
});

test('a zero-second entitlement cooldown leaves the account available', () => {
  const am = new AccountManager([oauth('a')]);

  assert.equal(am.markEntitlementDenied(0, 0), null);
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
  am.markEntitlementDenied(0, 240);
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
});
