import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, accountUuid, orgUuid) {
  return {
    name,
    type: 'oauth',
    accountUuid,
    orgUuid,
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: Date.now() + 3600_000,
  };
}

test('session affinity survives export and restore with accounts reordered', () => {
  const a = oauth('a@example.com', 'person-a', 'org-a');
  const b = oauth('b@example.com', 'person-b', 'org-b');
  const first = new AccountManager([a, b], 0.98, { distributeSessions: true });
  first.recordSession('session-a', 0);
  first.recordSession('session-b', 1);

  const saved = first.exportSessionState();
  const restored = new AccountManager([b, a], 0.98, { distributeSessions: true });
  restored.restoreSessionState(saved);

  assert.equal(restored.getActiveAccount(null, null, null, 'session-a').name, 'a@example.com');
  assert.equal(restored.getActiveAccount(null, null, null, 'session-b').name, 'b@example.com');
});

test('exported session state contains no account credentials', () => {
  const am = new AccountManager([
    oauth('a@example.com', 'person-a', 'org-a'),
  ], 0.98, { distributeSessions: true });
  am.recordSession('session-a', 0);

  const json = JSON.stringify(am.exportSessionState());
  assert.ok(!json.includes('access-a@example.com'));
  assert.ok(!json.includes('refresh-a@example.com'));
  assert.ok(!json.includes('accessToken'));
  assert.ok(!json.includes('refreshToken'));
  assert.ok(!json.includes('credential'));
});

test('restore ignores affinity for an account no longer configured', () => {
  const a = oauth('a@example.com', 'person-a', 'org-a');
  const b = oauth('b@example.com', 'person-b', 'org-b');
  const first = new AccountManager([a, b], 0.98, { distributeSessions: true });
  first.recordSession('gone', 1);

  const restored = new AccountManager([a], 0.98, { distributeSessions: true });
  restored.restoreSessionState(first.exportSessionState());

  assert.equal(restored.sessionStats().known, 0);
});

test('removing an account keeps surviving runtime session pins aligned', () => {
  const am = new AccountManager([
    oauth('a@example.com', 'person-a', 'org-a'),
    oauth('b@example.com', 'person-b', 'org-b'),
    oauth('c@example.com', 'person-c', 'org-c'),
  ], 0.98, { distributeSessions: true });
  am.recordSession('on-b', 1);
  am.recordSession('on-c', 2);

  am.removeAccount(1);

  assert.equal(am.sessionTracker.pinnedAccount('on-b'), null);
  assert.equal(am.sessionTracker.pinnedAccount('on-c'), 1);
  assert.equal(am.getActiveAccount(null, null, null, 'on-c').name, 'c@example.com');
});
