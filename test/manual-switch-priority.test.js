import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const MODEL = 'claude-opus-5-5';

function manager(options = {}) {
  return new AccountManager([
    { name: 'automatic', type: 'apikey', apiKey: 'key-a', priority: 0 },
    { name: 'manual', type: 'oauth', accessToken: 'token-m', refreshToken: 'refresh-m', expiresAt: Date.now() + 3600_000, priority: 10, allowExtraUsage: true },
  ], 0.98, options);
}

test('manual selection takes precedence over an available higher-priority account', () => {
  const am = manager();
  assert.equal(am.setCurrentAccount(1), true);
  for (let turn = 0; turn < 3; turn++) {
    assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
    assert.equal(am.previewRouteIndex(MODEL), 1);
    assert.deepEqual(am.eligibility(1), { eligible: true });
  }
});

test('automatic placement still yields to higher priority', () => {
  const am = manager();
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

for (const blocked of ['disabled', 'error', 'five-hour quota', 'weekly quota']) {
  test(`manual selection does not bypass ${blocked}`, () => {
    const am = manager();
    am.setCurrentAccount(1);
    if (blocked === 'disabled') am.accounts[1].disabled = true;
    else if (blocked === 'error') am.accounts[1].status = 'error';
    else am.accounts[1].quota[blocked === 'five-hour quota' ? 'unified5h' : 'unified7d'] = 1;
    assert.equal(am.eligibility(1).eligible, false);
    assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
  });
}

test('request exclusions rotate away and release the manual priority preference', () => {
  const am = manager();
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(new Set([1]), MODEL).name, 'automatic');
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

test('model-route diversion preserves the manual choice for models it can serve', () => {
  const am = manager({ routes: [
    { name: 'fable', match: ['claude-fable*'], accounts: ['automatic'] },
    { name: 'other', match: ['*'], accounts: ['automatic', 'manual'] },
  ] });
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5-1').name, 'automatic');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('an explicit route pin remains more specific than the manual default', () => {
  const am = manager({ routes: [{ name: 'all', match: ['*'], accounts: ['automatic', 'manual'] }] });
  am.setCurrentAccount(1);
  assert.equal(am.setRoutePin('all', 0).ok, true);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
  am.clearRoutePin('all');
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('removing an earlier account keeps the manual preference on its account', () => {
  const am = manager();
  am.addAccount({ name: 'another', type: 'apikey', apiKey: 'key-b', priority: 0 });
  am.setCurrentAccount(1);
  am.removeAccount(0);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('removing the selected account does not transfer the preference to its replacement', () => {
  const am = manager();
  am.addAccount({ name: 'replacement', type: 'apikey', apiKey: 'key-b', priority: 10 });
  am.setCurrentAccount(1);
  am.removeAccount(1);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

test('a borrowed provider selection does not erase another provider\'s manual choice', () => {
  const am = manager();
  am.addAccount({ name: 'codex', type: 'codex', accessToken: 'token-c', refreshToken: 'refresh-c', expiresAt: Date.now() + 3600_000, priority: -1 });
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').name, 'codex');
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('a walk that lands on the manual account again keeps the choice', () => {
  const am = manager();
  am.setCurrentAccount(1);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('learning quota does not undo a healthy manual priority preference', () => {
  const am = manager();
  am.setCurrentAccount(1);
  am.accounts[1].requalify = true;
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('a shared API key chosen for one provider does not override another provider priority', () => {
  const am = new AccountManager([
    { name: 'shared', type: 'apikey', apiKey: 'key-s', priority: 10 },
    { name: 'codex', type: 'codex', accessToken: 'token-c', expiresAt: Date.now() + 3600_000, priority: 0 },
  ]);
  am.setCurrentAccount(0);
  assert.equal(am.previewRouteIndex('gpt-6-astra', 'codex'), 1);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').name, 'codex');
});

test('the embedded TUI switch survives the next request and routing preview', () => {
  const am = manager();
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  tui._key('s');
  tui._key('down');
  assert.equal(tui.selIdx, 1);
  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
  assert.equal(am.previewRouteIndex(MODEL), 1);
});

// The session-reset switch - move to an account whose weekly resets sooner when a
// five-hour window rolls - is one of the automatic rankings a manual choice
// outranks (docs/usage.md). It runs on a request, and with expiry routing off on
// every poll too: the TUI repaint, GET /teamclaude/quota, the get_quota tool. It
// used to move the cursor off the operator's pick, and _setCurrent dropped the
// choice with it.
function sessionResetFleet(opts = {}) {
  const hour = 3600_000;
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + hour },
    { name: 'b', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + hour },
  ], 0.98, opts);
  const [a, b] = am.accounts;
  // `a`'s five-hour window has just rolled, and its weekly resets sooner than `b`'s.
  Object.assign(a.quota, { unified5h: 0.5, unified5hReset: Date.now() - 1000, unified7d: 0.5, unified7dReset: Date.now() + 6 * hour, sessionWindowStated: true });
  Object.assign(b.quota, { unified5h: 0.2, unified5hReset: Date.now() + 4 * hour, unified7d: 0.1, unified7dReset: Date.now() + 58 * hour });
  return am;
}

test('a poll-driven session-reset switch keeps the manual choice', () => {
  const am = sessionResetFleet();
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(am.setCurrentAccount(1), true);
    am.refreshExpiredQuotas();
    assert.equal(am.currentIndex, 1, 'the operator picked b, and b is still available');
    assert.equal(am.providerCursors.get('anthropic'), 1, 'and so does its provider cursor, which _currentIndexForProvider reads for status, the TUI, previewRouteIndex, releasePins and _unstrandCursor');
    assert.equal(am.getActiveAccount(null, MODEL).name, 'b', 'and the choice still holds for the next request');
  } finally {
    console.log = log;
  }
});

test('the same poll still switches an automatic placement to the sooner-resetting account', () => {
  const am = sessionResetFleet();
  const log = console.log;
  console.log = () => {};
  try {
    am._setCurrent(am.accounts[1]);
    am.refreshExpiredQuotas();
    assert.equal(am.currentIndex, 0);
  } finally {
    console.log = log;
  }
});

// On the request path the same switch runs at the head of selection, and with
// expiry routing on that is the only place it runs: a poll spends no reset event
// then. A request after the roll keeps the manual choice either way.
for (const expiry of [false, true]) {
  test(`[expiry routing ${expiry ? 'on' : 'off'}] a request after a session reset keeps the manual choice`, () => {
    const am = sessionResetFleet(expiry ? { expiryRouting: { enabled: true } } : {});
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(am.setCurrentAccount(1), true);
      assert.equal(am.getActiveAccount(new Set(), MODEL).name, 'b', 'the operator picked b, and b is still available');
      assert.equal(am._isManualChoice(am.accounts[1]), true, 'and the choice is still recorded');
    } finally {
      console.log = log;
    }
  });
}

// A poll sees every provider's resets. A manual choice holds the switch for its
// own provider only: another provider's reset still moves that provider's own
// cursor - the one its next walk borrows - and the shared cursor stays on the
// choice.
test('a poll keeps a Claude manual choice and still moves the Codex cursor on a Codex reset', () => {
  const hour = 3600_000;
  const day = 24 * hour;
  const now = Date.now();
  const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + hour, ...extra });
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    oauth('claude-a2', { accountUuid: 'u2' }),
    oauth('codex-c1', { provider: 'codex', accountId: 'i1' }),
    oauth('codex-c2', { provider: 'codex', accountId: 'i2' }),
  ], 0.98);
  const by = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  const set = (name, q) => Object.assign(by[name].quota, q);
  set('claude-a1', { unified7d: 0.3, unified7dReset: now + 5 * day, unified5h: 0.1, unified5hReset: now + hour });
  set('claude-a2', { unified7d: 0.1, unified7dReset: now + 6 * day, unified5h: 0.1, unified5hReset: now + hour });
  set('codex-c1', { unified7d: 0.3, unified7dReset: now + 6 * day, unified5h: 0.1, unified5hReset: now + hour });
  set('codex-c2', { unified7d: 0.3, unified7dReset: now + 1 * day, unified5h: 0.1, unified5hReset: now + hour });
  const log = console.log;
  console.log = () => {};
  try {
    am._setCurrent(by['codex-c1']);
    assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex').name, 'codex-c1');
    assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
    set('codex-c2', { unified5h: 0.5, unified5hReset: now - 1000 }); // codex-c2's five-hour window rolls
    am.refreshExpiredQuotas(); // a TUI repaint, GET /teamclaude/quota, get_quota
    assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the shared cursor stays on the choice');
    assert.equal(am._isManualChoice(by['claude-a1']), true, 'and the choice is still recorded');
    assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex').name, 'codex-c2', 'Codex moved to the sooner-resetting account');
    assert.equal(am.getActiveAccount(null, MODEL).name, 'claude-a1');
  } finally {
    console.log = log;
  }
});

// Claude a1/a2 and Codex c1/c2 on one proxy, for the switch's cross-provider
// runs. `days` gives each account's weekly reset in days (null: never
// reported), `extra` per-account config such as a priority.
function twoProviderFleet(days, extra = {}) {
  const hour = 3600_000;
  const now = Date.now();
  const oauth = (name, fields) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + hour, ...fields, ...extra[name] });
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    oauth('claude-a2', { accountUuid: 'u2' }),
    oauth('codex-c1', { provider: 'codex', accountId: 'i1' }),
    oauth('codex-c2', { provider: 'codex', accountId: 'i2' }),
  ], 0.98);
  const by = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  for (const [name, d] of Object.entries(days)) {
    Object.assign(by[name].quota, { unified7d: 0.3, unified7dReset: d == null ? null : now + d * 24 * hour, unified5h: 0.1, unified5hReset: now + hour });
  }
  return {
    am, by,
    // `name`'s five-hour window rolls.
    roll: name => Object.assign(by[name].quota, { unified5h: 0.5, unified5hReset: now - 1000 }),
    // Where the next Codex request lands.
    nextCodex: () => am.getActiveAccount(null, 'gpt-5', null, null, 'codex').name,
  };
}

// The Codex candidate has to beat the Codex incumbent - the account the Codex
// cursor rests on - never the Claude choice, which belongs to a different
// fleet. Both orderings: a Claude choice resetting later than the Codex
// incumbent must not let a poll move Codex onto a later-resetting account, and
// one resetting sooner must not block a move onto a sooner one.
for (const [choiceDays, incumbentDays, expected] of [[5, 1, 'codex-c1'], [1, 5, 'codex-c2']]) {
  test(`a Codex reset is weighed against the Codex cursor, not a Claude choice resetting in ${choiceDays}d (Codex cursor ${incumbentDays}d, candidate 2d)`, t => {
    t.mock.method(console, 'log', () => {});
    const { am, by, roll, nextCodex } = twoProviderFleet({ 'claude-a1': choiceDays, 'claude-a2': 6, 'codex-c1': incumbentDays, 'codex-c2': 2 });
    am._setCurrent(by['codex-c1']);
    assert.equal(nextCodex(), 'codex-c1');
    assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
    roll('codex-c2');
    am.refreshExpiredQuotas();
    assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the shared cursor stays on the choice');
    assert.equal(nextCodex(), expected);
  });
}

// The priority check too: c2 shares the Codex cursor's tier, so moving onto it
// demotes nothing, however the Claude choice is ranked.
test('a move within the Codex cursor tier is not blocked by a Claude choice of higher priority', t => {
  t.mock.method(console, 'log', () => {});
  const { am, by, roll, nextCodex } = twoProviderFleet(
    { 'claude-a1': 6, 'claude-a2': 6, 'codex-c1': 5, 'codex-c2': 2 },
    { 'claude-a1': { priority: 0 }, 'codex-c1': { priority: 5 }, 'codex-c2': { priority: 5 } });
  am._setCurrent(by['codex-c1']);
  assert.equal(nextCodex(), 'codex-c1');
  assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
  roll('codex-c2');
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the shared cursor stays on the choice');
  assert.equal(nextCodex(), 'codex-c2', 'Codex moved to the sooner-resetting account in its own tier');
});

// Each provider's run sees only its own candidates: a Claude roll in the same
// poll is the choice's to ignore, and must not reach the Codex run, where it
// would move the Claude cursor that status and the TUI read.
test('one poll that rolls a Claude and a Codex account moves the Codex cursor only', t => {
  t.mock.method(console, 'log', () => {});
  const { am, by, roll, nextCodex } = twoProviderFleet({ 'claude-a1': 6, 'claude-a2': 2, 'codex-c1': 5, 'codex-c2': 3 });
  am._setCurrent(by['codex-c1']);
  assert.equal(nextCodex(), 'codex-c1');
  assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
  roll('claude-a2');
  roll('codex-c2');
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the shared cursor stays on the choice');
  assert.equal(am.accounts[am.currentIndexFor('anthropic')].name, 'claude-a1', 'and so does the Claude cursor');
  assert.equal(am.accounts[am.currentIndexFor('codex')].name, 'codex-c2', 'Codex moved to the sooner-resetting account');
  assert.equal(nextCodex(), 'codex-c2');
  assert.equal(am.getActiveAccount(null, MODEL).name, 'claude-a1');
});

// With no Codex cursor yet there is no incumbent to weigh a Codex roll
// against, so the poll leaves it to the next Codex walk, which picks on merit -
// the account resetting soonest - and not the rolled one. Both index orders,
// so the walk cannot be passing on position alone.
for (const [rolled, merit] of [['codex-c2', 'codex-c1'], ['codex-c1', 'codex-c2']]) {
  test(`with no Codex cursor yet a poll leaves a Codex roll to the walk (${rolled} rolls)`, t => {
    t.mock.method(console, 'log', () => {});
    const { am, by, roll, nextCodex } = twoProviderFleet({ 'claude-a1': 5, 'claude-a2': 6, [merit]: 1, [rolled]: 2 });
    assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
    assert.equal(am.providerCursors.get('codex'), undefined, 'no Codex request yet');
    roll(rolled);
    am.refreshExpiredQuotas();
    assert.equal(am.providerCursors.get('codex'), undefined, 'the poll set no Codex cursor');
    assert.equal(nextCodex(), merit);
  });
}

// The choice's own weekly reset is a Claude clock: unknown, it is still being
// probed, and that leaves the choice alone - it says nothing about Codex.
test('a Claude choice whose weekly reset is unknown does not hold a Codex move', t => {
  t.mock.method(console, 'log', () => {});
  const { am, by, roll, nextCodex } = twoProviderFleet({ 'claude-a1': null, 'claude-a2': 6, 'codex-c1': 5, 'codex-c2': 2 });
  am._setCurrent(by['codex-c1']);
  assert.equal(nextCodex(), 'codex-c1');
  assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
  roll('codex-c2');
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the shared cursor stays on the choice');
  assert.equal(nextCodex(), 'codex-c2', 'Codex moved to the sooner-resetting account');
});

// A request reaches the Codex run too: an API key tagged for Codex passes a
// Claude request's provider partition, and its roll comes along. Moving the
// Codex cursor serves every Codex request behind this one, so the Claude
// request's model must not narrow it: here a Claude route admits no Codex
// account but the key, and drawn over that, the Codex band would hold the key
// alone; drawn over the Codex fleet it holds codex-c3, so the key does not take
// the Codex cursor.
test('a Claude request that brings a Codex roll leaves the Codex cursor to the Codex fleet', t => {
  t.mock.method(console, 'log', () => {});
  const hour = 3600_000;
  const now = Date.now();
  const oauth = (name, fields) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + hour, ...fields });
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    oauth('codex-c1', { provider: 'codex', accountId: 'i1' }),
    oauth('codex-c3', { provider: 'codex', accountId: 'i3' }),
    { name: 'codex-key', type: 'apikey', apiKey: 'k', provider: 'codex' },
  ], 0.98, { expiryRouting: { enabled: true }, routes: [{ name: 'opus', match: ['claude-opus*'], accounts: ['claude-a1', 'codex-key'] }] });
  const by = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  const set = (name, used, days) => Object.assign(by[name].quota, { unified7d: used, unified7dReset: now + days * 24 * hour, unified5h: 0.1, unified5hReset: now + hour });
  set('claude-a1', 0.3, 5);
  set('codex-c1', 0.3, 5);
  set('codex-c3', 0, 1); // the Codex fleet's most pressing account
  set('codex-key', 0.3, 2);
  am._setCurrent(by['codex-c1']);
  assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex').name, 'codex-c1');
  assert.equal(am.setCurrentAccount(by['claude-a1'].index), true);
  Object.assign(by['codex-key'].quota, { unified5h: 0.5, unified5hReset: now - 1000, sessionWindowStated: true }); // the key's five-hour window rolls
  am.sweepExpiredQuotas(); // a status read: the window clears and the reset waits for a request
  assert.equal(by['codex-key'].sessionResetPending, true);
  assert.equal(am.getActiveAccount(new Set(), MODEL).name, 'claude-a1');
  assert.equal(by['codex-key'].sessionResetPending, false, 'the Claude request spent the key\'s reset');
  assert.equal(am.accounts[am.providerCursors.get('codex')].name, 'codex-c1');
});
