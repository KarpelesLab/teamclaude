import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// getStatus copied each account's quota verbatim and nothing on the read path
// swept expired windows, so an idle server reported a window whose reset had
// passed at its old percentage with a timestamp in the past — to `status
// --json`, to anything scripted against /teamclaude/status, and to the attached
// TUI, whose own refresh is a no-op because it trusts the server to do this
// (#237).

const HOUR = 3600_000;
const acct = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR });

function withExpiredSession() {
  const am = new AccountManager([acct('a'), acct('b')], 0.98);
  const q = am.accounts[0].quota;
  q.unified5h = 0.97;
  q.unified5hReset = Date.now() - HOUR;      // already rolled
  return am;
}

test('getStatus does not report a window whose reset has passed', () => {
  const am = withExpiredSession();
  const status = am.getStatus();
  const a = status.accounts.find(x => x.name === 'a');
  assert.notEqual(a.quota.unified5h, 0.97, 'the expired window was reported at its old percentage');
  assert.ok(a.quota.unified5hReset == null || a.quota.unified5hReset > Date.now(),
    'a reset timestamp in the past was reported as current');
});

test('a live window is left alone', () => {
  const am = new AccountManager([acct('a')], 0.98);
  const q = am.accounts[0].quota;
  q.unified5h = 0.42;
  q.unified5hReset = Date.now() + HOUR;
  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.unified5h, 0.42);
});

// The part that makes this safe: reading status must not rotate the fleet.
// refreshExpiredQuotas() also runs _switchOnSessionReset, so wiring that into
// getStatus would let a polling dashboard drive routing.
test('reading status never moves the current account', () => {
  const am = withExpiredSession();
  // Give the current account a later weekly reset than the other, which is the
  // shape _switchOnSessionReset acts on.
  am.accounts[0].quota.unified7dReset = Date.now() + 6 * 24 * HOUR;
  am.accounts[1].quota.unified7dReset = Date.now() + HOUR;
  am.accounts[1].quota.unified7d = 0.1;
  const before = am.currentIndex;

  for (let i = 0; i < 5; i++) am.getStatus();

  assert.equal(am.currentIndex, before, 'a status read rotated the fleet');
});

test('sweepExpiredQuotas clears without switching; refreshExpiredQuotas may switch', () => {
  const am = withExpiredSession();
  am.sweepExpiredQuotas();
  assert.notEqual(am.accounts[0].quota.unified5h, 0.97);
  // The mutating form still exists for the request path.
  assert.equal(typeof am.refreshExpiredQuotas, 'function');
});
