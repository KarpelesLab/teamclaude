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

test('status exposes the current account independently for every provider', () => {
  const am = new AccountManager([claude('a1'), claude('a2'), codex('c1'), codex('c2')], 0.98);
  am.setCurrentAccount(1);
  am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

  const status = am.getStatus();
  assert.deepEqual(status.currentAccounts, { anthropic: 'a2', codex: 'c1' });
  assert.deepEqual(status.defaultTargets, { anthropic: 'a2', codex: 'c1' });
  assert.deepEqual(
    status.accounts.map(a => ({ name: a.name, provider: a.provider })),
    [
      { name: 'a1', provider: 'anthropic' },
      { name: 'a2', provider: 'anthropic' },
      { name: 'c1', provider: 'codex' },
      { name: 'c2', provider: 'codex' },
    ],
  );
});

// ── removal ──────────────────────────────────────────────────
//
// removeAccount renumbers every account above the one it takes, and a provider
// cursor names its account by that number. Claude and Codex accounts are
// interleaved here, the order a fleet built up over time has. Each Codex account
// is given the days until its weekly window resets, and a Codex walk that picks
// on merit takes the soonest. Nothing here waits on the clock.

const DAY = 24 * HOUR;
const weekly = (account, days) => Object.assign(account.quota, { unified7d: 0.1, unified7dReset: Date.now() + days * DAY });
function mixed(names, days) {
  const am = new AccountManager(names.map(n => (n.startsWith('c') ? codex(n) : claude(n))), 0.98);
  for (const a of am.accounts) if (providerOf(a) === 'codex') weekly(a, days[a.name]);
  am.currentIndex = 0;
  return am;
}
const named = (am, name) => am.accounts.findIndex(a => a.name === name);
const codexRequest = (am) => am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

// The Codex cursor put where traffic puts it: with the accounts that rank above
// `name` out of rotation a Codex request walks to it, and once they are back the
// cursor stays on it. Nothing preempts an account on a sooner reset alone unless
// preferSoonestWeeklyReset is on, so the accounts ranked above it stay unused.
function codexCursorOn(am, name, ahead) {
  for (const n of ahead) am.accounts[named(am, n)].disabled = true;
  codexRequest(am);
  for (const n of ahead) am.accounts[named(am, n)].disabled = false;
  assert.equal(codexRequest(am)?.name, name, `precondition: the Codex cursor rests on ${name}`);
}

test('removing an account below another provider\'s cursor leaves that provider on its account', () => {
  const am = mixed(['a1', 'c1', 'a2', 'c2', 'c3'], { c1: 1, c2: 2, c3: 3 });
  codexCursorOn(am, 'c2', ['c1']);

  // a2 sits directly below c2, so everything from c2 up moves down one.
  am.removeAccount(named(am, 'a2'));
  const status = am.getStatus();
  const served = codexRequest(am);

  // c3 is what the old number names now; c1 is what a walk that forgot the
  // cursor would pick.
  assert.equal(served?.name, 'c2', 'a removal moved the Codex traffic off its account');
  assert.deepEqual(status.currentAccounts, { anthropic: 'a1', codex: 'c2' }, 'status named another account as Codex\'s current one');
  assert.equal(am.currentIndex, 0, 'the Claude cursor moved');
});

test('removing the account another provider\'s cursor rests on re-picks on merit, not a neighbor', () => {
  const am = mixed(['a1', 'c1', 'c2', 'c3', 'c4', 'c5'], { c1: 3, c2: 4, c3: 2, c4: 5, c5: 1 });
  codexCursorOn(am, 'c3', ['c5']);

  // c4 slides into c3's place, c2 sits just below it and c1 is the
  // lowest-numbered Codex account; c5 resets soonest.
  am.removeAccount(named(am, 'c3'));
  const served = codexRequest(am);

  assert.equal(served?.name, 'c5', 'the Codex traffic did not re-pick on merit');
});

// On the base a cursor on the last account was left one past the end, where it
// named nothing until the next account was added, and then named that one.
test('removing the last account drops a cursor on it, so the next account added does not inherit it', () => {
  const am = mixed(['a1', 'c1', 'c2', 'c3'], { c1: 3, c2: 2, c3: 1 });
  codexCursorOn(am, 'c3', []);

  am.removeAccount(named(am, 'c3'));
  weekly(am.accounts[am.addAccount(codex('c9'))], 9);
  const status = am.getStatus();
  const served = codexRequest(am);

  // c2 resets soonest of what is left; c9 is new and resets last.
  assert.equal(served?.name, 'c2', 'the added account inherited the removed account\'s cursor');
  assert.equal(status.currentAccounts.codex, 'c2', 'status named the added account as Codex\'s current one');
});

// One provider always owns the slot, and status names the slot for it. On the
// base status asked the cursor first, which a removal below it left naming the
// account above; the route preview went by the same answer.
test('status names the current account after a removal below it, in a single-provider fleet too', () => {
  const am = new AccountManager([claude('a'), claude('b'), claude('c')], 0.98);
  am.currentIndex = 1;
  am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic');

  am.removeAccount(0);

  const status = am.getStatus();
  assert.equal(status.currentAccount, 'b');
  assert.deepEqual(status.currentAccounts, { anthropic: 'b' }, 'currentAccounts disagrees with currentAccount');
  assert.deepEqual(status.currentIndexes, { anthropic: 0 });
  assert.equal(am.accounts[am.previewRouteIndex('claude-opus-5')]?.name, 'b', 'the route preview names another account');
});

test('removing an account above another provider\'s cursor leaves that provider on its account', () => {
  const am = mixed(['a1', 'c1', 'c2', 'a2'], { c1: 1, c2: 2 });
  codexCursorOn(am, 'c2', ['c1']);

  am.removeAccount(named(am, 'a2'));
  const status = am.getStatus();
  const served = codexRequest(am);

  assert.equal(served?.name, 'c2', 'a removal above the Codex cursor moved the Codex traffic');
  assert.equal(status.currentAccounts.codex, 'c2', 'status named another account as Codex\'s current one');
});

// The account holding the shared slot goes, and the account that slides into
// the slot is another provider's. That provider now owns the slot and walks from
// it, not from its cursor, so status has to name the slot for it as well. The
// orders differ in where the slot lands against the cursor.
for (const [label, names, days, cursor, ahead] of [
  ['the slot lands below the cursor', ['a1', 'c1', 'c2', 'a2'], { c1: 1, c2: 2 }, 'c2', ['c1']],
  ['another Codex account sits above the cursor', ['a1', 'c1', 'c2', 'c3'], { c1: 1, c2: 2, c3: 3 }, 'c2', ['c1']],
  ['the cursor is on the last account', ['a1', 'c1', 'c2'], { c1: 1, c2: 2 }, 'c2', ['c1']],
  ['the slot lands on the cursor', ['a1', 'c2', 'c1'], { c1: 1, c2: 2 }, 'c2', ['c1']],
  ['the removed account was last, so the slot clamps onto the one below', ['c1', 'c2', 'a1'], { c1: 2, c2: 1 }, 'c1', ['c2']],
]) {
  test(`removing the account that holds the shared slot: status names where the inheriting provider goes (${label})`, () => {
    const am = mixed(names, days);
    am.currentIndex = named(am, 'a1');
    codexCursorOn(am, cursor, ahead);

    am.removeAccount(named(am, 'a1'));
    assert.equal(providerOf(am.accounts[am.currentIndex]), 'codex', 'precondition: a Codex account inherited the slot');
    const status = am.getStatus();
    const served = codexRequest(am);

    assert.equal(status.currentAccounts.codex, served?.name, 'status named another account than the one Codex is served by');
  });
}

// The same removal, then the slot goes back to a Claude account before Codex's
// next request: Codex borrows the slot again and re-seeds from its own cursor,
// which the renumbering kept on its account.
test('a provider handed the slot by a removal and then relieved of it returns to its own account', () => {
  const am = mixed(['a1', 'c1', 'c2', 'a2'], { c1: 1, c2: 2 });
  codexCursorOn(am, 'c2', ['c1']);

  am.removeAccount(named(am, 'a1')); // c1 slides into the slot a1 held
  am.setCurrentAccount(named(am, 'a2'));
  const status = am.getStatus();
  const served = codexRequest(am);

  assert.equal(served?.name, 'c2', 'Codex did not return to its own account');
  assert.equal(status.currentAccounts.codex, 'c2', 'status named another account as Codex\'s current one');
});

// A shared API key reads as the default provider, so a Codex request borrows
// the slot even while the key holds it, and starts from Codex's own cursor.
test('a shared key holding the slot is not reported as Codex\'s current account', () => {
  const am = new AccountManager([apikey('kn'), codex('c1'), codex('c2')], 0.98);
  weekly(am.accounts[1], 1);
  weekly(am.accounts[2], 2);
  am.currentIndex = 0;
  codexCursorOn(am, 'c2', ['kn', 'c1']);

  const status = am.getStatus();
  const served = codexRequest(am);

  assert.equal(served?.name, 'c2');
  assert.equal(status.currentAccounts.codex, 'c2', 'status named the shared key as Codex\'s current account');
});

// No removal at all: a Codex walk can park the slot on a shared key, which reads
// as the default provider. Claude then owns the slot, and its next walk starts
// from the key rather than from the account its cursor names.
test('a Codex walk that parks the slot on a shared key makes the key Claude\'s current account', () => {
  const am = new AccountManager([codex('c1'), apikey('kn'), claude('a1')], 0.98);
  const claudeRequest = () => am.getActiveAccount(null, 'claude-opus-5', null, null, 'anthropic');
  am.currentIndex = 0;
  am.accounts[named(am, 'kn')].disabled = true;
  assert.equal(claudeRequest()?.name, 'a1', 'precondition: Claude rests on a1');
  am.accounts[named(am, 'kn')].disabled = false;
  am.accounts[named(am, 'c1')].disabled = true;
  assert.equal(codexRequest(am)?.name, 'kn', 'precondition: the Codex walk moves the slot onto the key');
  am.accounts[named(am, 'c1')].disabled = false;

  const status = am.getStatus();
  const served = claudeRequest();

  assert.equal(status.currentAccounts.anthropic, served?.name, 'status named another account than the one Claude is served by');
  assert.equal(status.currentAccounts.anthropic, status.currentAccount, 'currentAccounts disagrees with currentAccount for the slot\'s owner');
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
