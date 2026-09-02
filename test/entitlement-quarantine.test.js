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
