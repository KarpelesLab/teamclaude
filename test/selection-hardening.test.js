import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Make an account genuinely unavailable via near-quota with a FUTURE reset, so
// selection has to fall through to the probe/soonest-reset fallback paths.
function nearQuotaFutureReset(am, i) {
  am.accounts[i].quota.unified7d = 0.999;
  am.accounts[i].quota.unified7dReset = Date.now() + 3600_000;
}

// F1: the "all unavailable → soonest reset" fallback in _selectNext must not
// resurrect a DISABLED account. The disabled check in _isAvailable short-circuits
// before the expired-hold clear, so a disabled account with a past hold slips
// into the fallback and (pre-fix) got force-reactivated.
test('the soonest-reset fallback never resurrects a disabled account', () => {
  const am = new AccountManager([oauth('disabled'), oauth('busy')], 0.98);
  am.markRateLimited(0, 1);
  am.accounts[0].rateLimitedUntil = Date.now() - 5000; // hold already expired…
  am.accounts[0].disabled = true;                      // …but operator-disabled
  nearQuotaFutureReset(am, 1);                          // the other account is genuinely busy

  const acct = am.getActiveAccount();
  assert.notEqual(acct?.name, 'disabled');             // never selected
  assert.equal(am.accounts[0].disabled, true);         // still disabled
  assert.equal(am.accounts[0].status, 'throttled');    // NOT flipped to active
  assert.notEqual(am.accounts[0].rateLimitedUntil, null); // hold NOT cleared
});

// F1 (sibling): the same must hold for an errored (dead-token) account.
test('the soonest-reset fallback never resurrects an errored account', () => {
  const am = new AccountManager([oauth('broken'), oauth('busy')], 0.98);
  am.markRateLimited(0, 1);
  am.accounts[0].rateLimitedUntil = Date.now() - 5000;
  am.accounts[0].status = 'error'; // token needs re-login
  nearQuotaFutureReset(am, 1);

  const acct = am.getActiveAccount();
  assert.notEqual(acct?.name, 'broken');
  assert.equal(am.accounts[0].status, 'error'); // not silently reactivated
});

// F2: a request for an OWNED model must never fall back / probe onto a non-owner
// account (which would just reject the unknown model id). When the owner is
// unavailable, the correct result is "nothing" (→ synthetic 429), not a Claude
// account.
test('an owned-model request never falls back to a non-owner account', () => {
  const am = new AccountManager([
    oauth('claude'),
    oauth('deepseek', { models: ['deepseek-chat'], priority: 100 }),
  ], 0.98);
  am.markRateLimited(1, 3600);        // the sole owner is throttled (future hold)
  nearQuotaFutureReset(am, 0);        // the Claude account is busy too

  const acct = am.getActiveAccount(null, 'deepseek-chat');
  assert.notEqual(acct?.name, 'claude'); // the deepseek model must not hit Claude
});

// Positive control: with no owner declared, the probe/fallback still works
// normally (ownership routing is inert unless someone declares a models list).
test('ownership guard is inert when no account claims the model', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  nearQuotaFutureReset(am, 0);
  nearQuotaFutureReset(am, 1);
  // Every account near quota → a probe is allowed; some account is returned.
  const acct = am.getActiveAccount(null, 'claude-sonnet-4-6');
  assert.ok(acct, 'a probe target should still be selectable');
});

// F1 (cooldowns): nor an account sitting out an entitlement or routing cooldown.
// unavailableReason reports either before the lines that clear a lapsed 429
// hold, so a hold that has ended stays on the account and the soonest-reset
// fallback read it as reset - sending the request to an account upstream had
// just refused, or whose proxy could not be reached, while the probe skips both.
// Concurrent requests on one account reach this state: one is answered 429,
// another 403 or fails to reach the proxy.
for (const [what, arm, extra] of [
  ['an entitlement', (am) => am.markEntitlementDenied(0, { seconds: 60 }), {}],
  ['a routing', (am) => am.markRoutingFailed(0, 60), { routing: 'socks5://127.0.0.1:1' }],
]) {
  test(`the soonest-reset fallback never resurrects an account in ${what} cooldown`, () => {
    const am = new AccountManager([oauth('cooling', extra), oauth('busy')], 0.98);
    am.markRateLimited(0, 1);
    am.accounts[0].rateLimitedUntil = Date.now() - 5000; // hold already expired…
    assert.ok(arm(am) > Date.now(), 'precondition: the cooldown is armed');  // …but cooling down
    nearQuotaFutureReset(am, 1);

    const acct = am.getActiveAccount();
    assert.notEqual(acct?.name, 'cooling');
    assert.equal(am.accounts[0].status, 'throttled');       // NOT flipped to active
    assert.notEqual(am.accounts[0].rateLimitedUntil, null); // hold NOT cleared
  });

  // Control: the fallback still does its job once the cooldown is over. An
  // exhausted account is one nothing but this fallback brings back, and it
  // flips the status to active on the way - so the pick is the fallback's.
  test(`the soonest-reset fallback revives an account whose ${what.replace(/^an? /, '')} cooldown has ended`, () => {
    const am = new AccountManager([oauth('cooling', extra), oauth('busy')], 0.98);
    am.markRateLimited(0, 1);
    am.accounts[0].rateLimitedUntil = Date.now() - 5000;
    am.accounts[0].status = 'exhausted';
    arm(am);
    am.accounts[0].entitlementDeniedUntil &&= Date.now() - 1;
    am.accounts[0].routingFailedUntil &&= Date.now() - 1;
    nearQuotaFutureReset(am, 1);

    assert.equal(am.getActiveAccount()?.name, 'cooling');
    assert.equal(am.accounts[0].status, 'active');
  });
}
