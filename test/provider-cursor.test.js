import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { isSubscriptionAccount, providerOf } from '../src/provider.js';

// Two rules, and they pull in opposite directions:
//
//  1. A SUBSCRIPTION is tied to the app whose plan it is. A Claude Max token is
//     issued to Claude and a ChatGPT token to Codex; neither plan may be spent
//     by the other's client, ever.
//  2. currentIndex is one slot shared by every provider. A request only another
//     provider can serve must NOT drag it across, or a Codex request moves the
//     cursor onto a Codex account and the next Anthropic request moves it back —
//     flapping the current-account marker and re-arming storm control each time.

const HOUR = 3600_000;
const claude = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const codex = (name) => ({ ...claude(name), provider: 'codex', accountId: `acct-${name}` });
const apikey = (name, over = {}) => ({ name, type: 'apikey', apiKey: `k-${name}`, ...over });

// ── the partition ────────────────────────────────────────────

test('a Codex request never lands on a Claude subscription', () => {
  const am = new AccountManager([claude('a'), codex('c')], 0.98);
  for (let i = 0; i < 10; i++) {
    const picked = am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');
    assert.equal(providerOf(picked), 'codex', `picked ${picked?.name}`);
  }
});

test('a Claude request never lands on a Codex subscription', () => {
  const am = new AccountManager([codex('c'), claude('a')], 0.98);
  am.currentIndex = 0;
  for (let i = 0; i < 10; i++) {
    const picked = am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic');
    assert.equal(providerOf(picked), 'anthropic', `picked ${picked?.name}`);
  }
});

test('a Codex fleet with no Codex account serves nothing rather than crossing over', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  assert.equal(am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex'), null);
});

// An API key is metered capacity, not a seat — nothing about it says which app
// may spend it, so it stays eligible for any caller.
test('an API-key account may serve any caller', () => {
  const am = new AccountManager([apikey('shared')], 0.98);
  assert.ok(am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic'));
  assert.ok(am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex'));
});

test('isSubscriptionAccount separates a seat from metered capacity', () => {
  assert.equal(isSubscriptionAccount({ type: 'oauth' }), true);
  assert.equal(isSubscriptionAccount({ type: 'apikey' }), false);
  assert.equal(isSubscriptionAccount(null), false);
});

// ── the cursor ───────────────────────────────────────────────

test('a Codex request does not move the Anthropic cursor', () => {
  const am = new AccountManager([claude('a'), claude('b'), codex('c')], 0.98);
  am.currentIndex = 0;

  am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

  assert.equal(am.currentIndex, 0, 'the Codex request dragged the shared cursor across');
  assert.equal(providerOf(am.accounts[am.currentIndex]), 'anthropic');
});

test('alternating providers does not thrash the cursor', () => {
  const am = new AccountManager([claude('a'), codex('c')], 0.98);
  am.currentIndex = 0;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic');
    seen.add(am.currentIndex);
    am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');
    seen.add(am.currentIndex);
  }
  assert.deepEqual([...seen], [0], `currentIndex visited ${[...seen]}`);
});

test('each provider keeps its own cursor across calls', () => {
  const am = new AccountManager([claude('a'), codex('c1'), codex('c2')], 0.98);
  am.currentIndex = 0;
  const first = am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');
  const again = am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');
  assert.equal(again.name, first.name, 'Codex should stay on its own account, not restart the walk');
  assert.equal(am.currentIndex, 0, 'and still without touching the Anthropic cursor');
});

// A single-provider fleet — every config predating the provider seam — must
// behave exactly as it did.
test('a single-provider fleet still moves its cursor normally', () => {
  const am = new AccountManager([claude('a'), claude('b')], 0.98);
  am.currentIndex = 0;
  am.accounts[0].quota.unified5h = 0.99;      // over threshold: must rotate
  am.accounts[0].quota.unified5hReset = Date.now() + HOUR;
  const picked = am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic');
  assert.equal(picked.name, 'b');
  assert.equal(am.currentIndex, 1, 'a same-provider rotation must still move the cursor');
});
