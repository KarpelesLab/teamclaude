import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

const OPUS = 'claude-opus-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 3600_000, ...extra });

function fleet({ allowed = true, weekly = 1, apiPriority = 100, ...accountOptions } = {}) {
  const am = new AccountManager([
    oauth('subscription', { priority: 0, allowExtraUsage: allowed, ...accountOptions }),
    { name: 'api', type: 'apikey', apiKey: 'api-key', priority: apiPriority },
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 1;
  return am;
}

for (const [label, config, enabled, warned] of [
  ['missing permission', oauth('account', { preferExtraUsage: true }), false, true],
  ['permission off', oauth('account', { allowExtraUsage: false, preferExtraUsage: true }), false, true],
  ['API key', { name: 'account', type: 'apikey', apiKey: 'key', allowExtraUsage: true, preferExtraUsage: true }, false, true],
  ['third-party backend', oauth('account', { upstream: 'https://api.example.com', allowExtraUsage: true, preferExtraUsage: true }), false, true],
  ['Codex account', oauth('account', { provider: 'codex', allowExtraUsage: true, preferExtraUsage: true }), false, true],
  ['valid preference', oauth('account', { allowExtraUsage: true, preferExtraUsage: true }), true, false],
  ['truthy preference', oauth('account', { allowExtraUsage: true, preferExtraUsage: 'true' }), false, false],
  ['no preference', oauth('account', { allowExtraUsage: true }), false, false],
]) {
  test(`extra-usage preference warning: ${label}`, t => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    const am = new AccountManager([config], 0.98);
    am.getStatus();
    am.getStatus();
    assert.deepEqual({ enabled: am.accounts[0].preferExtraUsage,
      warnings: warnings.filter(line => line.includes('preferExtraUsage')) },
    { enabled, warnings: warned
      ? ['[TeamClaude] Account "account": preferExtraUsage is ignored: set allowExtraUsage: true on an Anthropic OAuth account'] : [] });
  });
}

for (const [label, options, expected, billing] of [
  ['explicit preference uses remaining included quota before API', { preferExtraUsage: true, weekly: 0.98 }, 'subscription', false],
  ['explicit preference uses credits before API', { preferExtraUsage: true }, 'subscription', true],
  ['a truthy preference does not opt in', { preferExtraUsage: 'true' }, 'api', false],
  ['preference without credit permission', { allowed: false, preferExtraUsage: true }, 'api', false],
  ['explicit API priority ahead of remaining included quota', { preferExtraUsage: true, weekly: 0.98, apiPriority: -1 }, 'api', false],
  ['explicit API priority ahead of credits', { preferExtraUsage: true, apiPriority: -1 }, 'api', false],
]) {
  test(`extra-usage priority: ${label}`, () => {
    const am = fleet(options);
    const picked = am.getActiveAccount(null, OPUS);
    const status = am.getStatus();
    assert.deepEqual({ selected: picked?.name, current: status.currentAccount, billing: status.accounts[0].onExtraUsage },
      { selected: expected, current: expected, billing });
  });
}

for (const [label, change] of [
  ['cordoned', a => { a.cordoned = true; }],
  ['disabled', a => { a.disabled = true; }],
  ['usage cap', a => { a.maxUsage = 1; }],
  ['spend cap', a => { a.maxSpend = 1; a.quota.spend.usedMinor = 100; }],
  ['upstream credits disabled', a => { a.quota.spend.enabled = false; }],
  ['billing cooldown', a => { a.billingRejectedUntil = Date.now() + 60_000; }],
  ['entitlement cooldown', a => { a.entitlementDeniedUntil = Date.now() + 60_000; }],
  ['rate limit', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; }],
]) {
  test(`extra usage before API respects ${label}`, () => {
    const am = fleet({ preferExtraUsage: true });
    change(am.accounts[0]);
    assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
  });
}

for (const weekly of [0.2, 0.99]) {
  test(`unflagged included quota at ${weekly * 100}% preserves the normal spending order`, () => {
    const am = fleet({ preferExtraUsage: true });
    am.addAccount(oauth('included', { priority: 10 }));
    am.accounts[2].quota.unified7d = weekly;
    assert.equal(am.getActiveAccount(null, OPUS)?.name, weekly < 0.98 ? 'included' : 'api');
  });
}

for (const [weekly, includedWeekly] of [[0.98, 0.2], [1, 0.2], [1, 0.99]]) {
  test(`a manual subscription switch follows the included-quota policy (${weekly}, ${includedWeekly})`, () => {
    const am = fleet({ preferExtraUsage: true, weekly: 0.2 });
    am.addAccount(oauth('included', { priority: 10 }));
    am.accounts[2].quota.unified7d = includedWeekly;
    am.setCurrentAccount(0);
    const initial = am.getActiveAccount(null, OPUS)?.name;
    am.accounts[0].quota.unified7d = weekly;
    const eligibility = am.eligibility(0);
    const preview = am.previewRouteIndex(OPUS);
    const selected = [am.getActiveAccount(null, OPUS)?.name, am.getActiveAccount(null, OPUS)?.name];
    assert.deepEqual({ initial, eligibility, preview, selected, billing: am.getStatus().accounts.map(a => a.onExtraUsage) },
      { initial: 'subscription', eligibility: { eligible: false, reason: 'at or above the switch threshold' },
        preview: includedWeekly < 0.98 ? 2 : 1, selected: Array(2).fill(includedWeekly < 0.98 ? 'included' : 'api'), billing: [false, false, false] });
  });
}

for (const [label, threshold, weekly, switchThreshold] of [
  ['global', 0.98, 0.99],
  ['per-bucket', { unified7d: 0.85 }, 0.9],
  ['per-account', 0.98, 0.9, { unified7d: 0.85 }],
]) {
  for (const [flags, options, expected, eligible] of [
    ['neither flag', {}, 'api', false],
    ['allow only', { allowExtraUsage: true }, 'api', false],
    ['both flags', { allowExtraUsage: true, preferExtraUsage: true }, 'included', true],
  ]) {
    test(`${label} threshold preserves per-account opt-in (${flags})`, () => {
      const am = new AccountManager([
        oauth('paid', { allowExtraUsage: true, preferExtraUsage: true }),
        { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 },
        oauth('included', { ...options, switchThreshold }),
      ], threshold);
      am.accounts[0].quota.unified7d = 1;
      am.accounts[2].quota.unified7d = weekly;
      am._nextProbeAt = Date.now() + 60_000;
      am.currentIndex = 1;
      const eligibility = am.eligibility(2);
      const preview = am.previewRouteIndex(OPUS);
      const automatic = am.getActiveAccount(null, OPUS)?.name;
      am.setDistributeSessions(true);
      am.recordSession('conversation', 2, OPUS);
      const conversation = [];
      for (let turn = 0; turn < 2; turn++) {
        const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
        conversation.push(picked?.name);
        if (picked) am.recordSession('conversation', picked.index, OPUS);
      }
      am.setCurrentAccount(2);
      const manual = am.getActiveAccount(null, OPUS)?.name;
      assert.deepEqual({ eligibility, preview, automatic, conversation, manual, billing: am.getStatus().accounts.map(a => a.onExtraUsage) },
        { eligibility: eligible ? { eligible: true } : { eligible: false, reason: 'at or above the switch threshold' },
          preview: eligible ? 2 : 1, automatic: expected, conversation: [expected, expected], manual: expected, billing: [false, false, false] });
    });
  }
}

test('fallback switch eligibility respects the target account priority', () => {
  const am = fleet({ preferExtraUsage: true, priority: 200 });
  am.addAccount(oauth('preferred', { allowExtraUsage: true, preferExtraUsage: true, priority: 0 }));
  am.accounts[2].quota.unified7d = 1;
  am.setCurrentAccount(0);
  const eligibility = am.eligibility(0);
  const preview = am.previewRouteIndex(OPUS);
  const selected = am.getActiveAccount(null, OPUS)?.name;
  assert.deepEqual({ eligibility, preview, selected },
    { eligibility: { eligible: false, reason: 'at or above the switch threshold' }, preview: 2, selected: 'preferred' });
});

for (const [mode, setting] of [['even', true], ['adaptive', 'adaptive'], ['load', 'load']]) {
  test(`${mode} distribution preserves interleaved affinity within the preferred included tier`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const am = fleet({ preferExtraUsage: true });
    am.addAccount(oauth('included-1', { allowExtraUsage: true, preferExtraUsage: true }));
    am.addAccount(oauth('included-2', { allowExtraUsage: true, preferExtraUsage: true }));
    for (const account of am.accounts.slice(2)) account.quota.unified7d = 0.99;
    am.setDistributeSessions(setting);
    const selected = [];
    for (const sessionId of ['first', 'second', 'first', 'second']) {
      const picked = am.getActiveAccount(null, OPUS, null, sessionId);
      selected.push(picked?.name);
      am.recordSession(sessionId, picked.index, OPUS);
      if (selected.length === 2) t.mock.timers.tick(am.ramp.windowMs + 1);
    }
    assert.deepEqual({ selected, eligibility: [am.eligibility(0), am.eligibility(2)],
      ramps: am.accounts.slice(2).map(a => am._rampCap(a)),
      billing: am.getStatus().accounts.map(a => a.onExtraUsage),
      announcements: lines.filter(line => line.includes('Routing to')).length },
    { selected: ['included-1', 'included-2', 'included-1', 'included-2'],
      eligibility: [{ eligible: false, reason: 'at or above the switch threshold' }, { eligible: true }],
      ramps: [Infinity, Infinity], billing: [false, false, false, false], announcements: 2 });
  });

  for (const [weekly, includedWeekly] of [[0.98, 0.2], [1, 0.2], [1, 0.99]]) {
    test(`${mode} affinity follows the included-quota policy (${weekly}, ${includedWeekly})`, () => {
      const am = fleet({ preferExtraUsage: true, weekly });
      am.addAccount(oauth('included', { priority: 10 }));
      am.accounts[2].quota.unified7d = includedWeekly;
      am.setDistributeSessions(setting);
      am.recordSession('conversation', 0, OPUS);
      const selected = [];
      for (let turn = 0; turn < 2; turn++) {
        const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
        selected.push(picked?.name ?? null);
        if (picked) am.recordSession('conversation', picked.index, OPUS);
      }
      assert.deepEqual({ selected, pinned: am.sessionTracker.pinnedAccount('conversation', 'unified7d'),
        billing: am.getStatus().accounts.map(a => a.onExtraUsage) },
      { selected: Array(2).fill(includedWeekly < 0.98 ? 'included' : 'api'), pinned: includedWeekly < 0.98 ? 2 : 1, billing: [false, false, false] });
    });
  }

  test(`${mode} distribution preserves API affinity with the preference enabled`, () => {
    const am = fleet({ preferExtraUsage: true });
    am.setDistributeSessions(setting);
    am.recordSession('conversation', 1, OPUS);
    const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
    assert.deepEqual({ selected: picked?.name, pinned: am.sessionTracker.pinnedAccount('conversation', 'unified7d'), paid: am.getStatus().accounts[0].onExtraUsage },
      { selected: 'api', pinned: 1, paid: false });
  });

  for (const weekly of [0.98, 1]) {
    test(`${mode} distribution preserves interleaved subscription affinity at ${weekly * 100}% usage`, t => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const lines = [];
      t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
      const am = fleet({ preferExtraUsage: true, weekly });
      am.addAccount(oauth('subscription-2', { allowExtraUsage: true, preferExtraUsage: true }));
      Object.assign(am.accounts[2].quota, { unified7d: weekly, spend: { enabled: true } });
      am.setDistributeSessions(setting);
      am.recordSession('api-conversation', 1, OPUS);
      const selected = [];
      for (const sessionId of ['first', 'second', 'api-conversation', 'first', 'second']) {
        const picked = am.getActiveAccount(null, OPUS, null, sessionId);
        selected.push(picked?.name ?? null);
        if (picked) am.recordSession(sessionId, picked.index, OPUS);
        if (selected.length === 2) t.mock.timers.tick(am.ramp.windowMs + 1);
      }
      const status = am.getStatus();
      assert.deepEqual({ selected, ramps: [am._rampCap(am.accounts[0]), am._rampCap(am.accounts[2])],
        billing: [status.accounts[0].onExtraUsage, status.accounts[2].onExtraUsage],
        announcements: lines.filter(line => line.includes('Routing to')).length },
      { selected: ['subscription', 'subscription-2', 'api', 'subscription', 'subscription-2'],
        ramps: [Infinity, Infinity], billing: [weekly === 1, weekly === 1], announcements: 2 });
    });
  }
}

test('preferred affinity yields when another subscription recovers', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const am = fleet({ preferExtraUsage: true });
  am.addAccount(oauth('recovered', { allowExtraUsage: true, preferExtraUsage: true }));
  am.accounts[2].quota.unified7d = 1;
  am.setDistributeSessions(true);
  const first = am.getActiveAccount(null, OPUS, null, 'conversation');
  am.recordSession('conversation', first.index, OPUS);
  t.mock.timers.tick(am.ramp.windowMs + 1);
  am.accounts[2].quota.unified7d = 0.2;
  const selected = [];
  for (let turn = 0; turn < 2; turn++) selected.push(am.getActiveAccount(null, OPUS, null, 'conversation')?.name);
  const status = am.getStatus();
  assert.deepEqual({ selected, billing: status.accounts.map(a => a.onExtraUsage),
    ramp: am._rampCap(am.accounts[0]),
    enters: lines.filter(line => line.includes('on extra usage')).length,
    leaves: lines.filter(line => line.includes('leaving extra usage')).length },
  { selected: ['recovered', 'recovered'], billing: [false, false, false], ramp: Infinity, enters: 1, leaves: 1 });

  t.mock.timers.tick(am.sessionTracker.knownTtlMs + 1);
  assert.deepEqual(am.getStatus().accounts.map(a => a.onExtraUsage), [false, false, false]);
});

test('preferred billing affinity checks the advisor route before priority preemption', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const am = fleet({ preferExtraUsage: true, weekly: 0.2, apiPriority: -1 });
  const advisor = 'claude-fable-5';
  am.setRoutes([{ name: 'fable', match: ['claude-fable-*'], accounts: ['subscription'] }]);
  am.setDistributeSessions(true);
  const first = am.getActiveAccount(null, OPUS, advisor, 'conversation');
  am.recordSession('conversation', first.index, OPUS);
  am.accounts[0].quota.unified7d = 1;
  const selected = [];
  for (let turn = 0; turn < 2; turn++) {
    selected.push(am.getActiveAccount(null, OPUS, advisor, 'conversation')?.name);
    if (turn === 0) t.mock.timers.tick(am.ramp.windowMs + 1);
  }
  const status = am.getStatus();
  assert.deepEqual({ selected, billing: status.accounts.map(a => a.onExtraUsage),
    ramp: am._rampCap(am.accounts[0]),
    enters: lines.filter(line => line.includes('on extra usage')).length,
    leaves: lines.filter(line => line.includes('leaving extra usage')).length },
  { selected: ['subscription', 'subscription'], billing: [true, false], ramp: Infinity, enters: 1, leaves: 0 });

  t.mock.timers.tick(am.sessionTracker.knownTtlMs + 1);
  assert.deepEqual(am.getStatus().accounts.map(a => a.onExtraUsage), [false, false]);
});

test('advisor restrictions do not preserve billing after the account recovers included quota', () => {
  const am = fleet({ preferExtraUsage: true, weekly: 0.2 });
  const advisor = 'claude-fable-5';
  am.setRoutes([{ name: 'fable', match: ['claude-fable-*'], accounts: ['subscription'] }]);
  am.setDistributeSessions(true);
  const first = am.getActiveAccount(null, OPUS, advisor, 'conversation');
  am.recordSession('conversation', first.index, OPUS);
  Object.assign(am.accounts[0].quota, { unified7d: 1, unified7dFable: 1 });
  am.getActiveAccount(null, OPUS, advisor, 'conversation');
  const before = am.getStatus().accounts[0];
  Object.assign(am.accounts[0].quota, { unified7d: 0.2, spend: { enabled: true, usedMinor: 100 } });
  const after = am.getStatus().accounts[0];
  assert.deepEqual({ before: before.onExtraUsage, after: { unavailable: after.unavailable, billing: after.onExtraUsage } },
    { before: true, after: { unavailable: null, billing: false } });
});

test('a preferred conversation uses recovered legacy quota before resuming credits', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const am = fleet({ preferExtraUsage: true });
  am.addAccount(oauth('legacy', { allowExtraUsage: true }));
  am.accounts[2].quota.unified7d = 1;
  am.setDistributeSessions(true);
  const first = am.getActiveAccount(null, OPUS, null, 'first');
  am.recordSession('first', first.index, OPUS);
  t.mock.timers.tick(am.ramp.windowMs + 1);
  am.accounts[1].disabled = true;
  am.accounts[2].quota.unified7d = 0.99;
  const recovered = am.getStatus().accounts.map(a => a.onExtraUsage);
  const selected = [first?.name];
  for (const sessionId of ['second', 'first']) {
    const account = am.getActiveAccount(null, OPUS, null, sessionId);
    selected.push(account?.name);
    am.recordSession(sessionId, account.index, OPUS);
  }
  const during = am.getStatus().accounts.map(a => a.onExtraUsage);
  am.accounts[2].quota.unified7d = 1;
  am.accounts[1].disabled = false;
  selected.push(am.getActiveAccount(null, OPUS, null, 'first')?.name);
  assert.deepEqual({ recovered, selected, during, billing: am.getStatus().accounts.map(a => a.onExtraUsage),
    ramp: am._rampCap(am.accounts[0]), enters: lines.filter(line => line.includes('on extra usage')).length },
  { recovered: [false, false, false], selected: ['subscription', 'legacy', 'legacy', 'subscription'], during: [false, false, false],
    billing: [true, false, false], ramp: 1, enters: 2 });
});

test('an exclusive model route still restricts extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'], accounts: ['api'] }]);
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
});

test('an eligible route pin takes precedence over automatic extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
  am.setRoutePin('opus', 1);
  am.setDistributeSessions(true);
  am.recordSession('conversation', 0, OPUS);

  const preview = am.previewRouteIndex(OPUS);
  const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
  assert.deepEqual({ preview, selected: picked?.name, paid: am.getStatus().accounts[0].onExtraUsage },
    { preview: 1, selected: 'api', paid: false });

  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'subscription');
});

for (const weekly of [0.98, 1]) {
  for (const disabled of [false, true]) {
    test(`a route pin overrides a manual fallback only while eligible (${weekly * 100}% usage, disabled=${disabled})`, () => {
      const am = new AccountManager([
        oauth('s1', { allowExtraUsage: true, preferExtraUsage: true }),
        oauth('s2', { allowExtraUsage: true, preferExtraUsage: true }),
        { name: 'pinned', type: 'apikey', apiKey: 'api-key', priority: 100, disabled },
      ], 0.98);
      am._nextProbeAt = Date.now() + 60_000;
      for (const account of am.accounts.slice(0, 2)) Object.assign(account.quota, { unified7d: weekly, spend: { enabled: true } });
      am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
      am.setRoutePin('opus', 2);
      am.setCurrentAccount(1);
      const eligibility = am.eligibility(1);
      const preview = am.previewRouteIndex(OPUS);
      const selected = am.getActiveAccount(null, OPUS)?.name;
      assert.deepEqual({ eligibility, preview, selected },
        { eligibility: { eligible: true }, preview: disabled ? 1 : 2, selected: disabled ? 's2' : 'pinned' });
    });
  }
}

test('the provider partition still restricts extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.addAccount(oauth('codex', { provider: 'codex' }));
  assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex')?.name, 'codex');
});

test('an explicit API switch remains eligible and serves requests with the preference enabled', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setCurrentAccount(0);
  const switched = am.setCurrentAccount(1);
  const eligibility = am.eligibility(1);
  const selected = [am.getActiveAccount(null, OPUS)?.name, am.getActiveAccount(null, OPUS)?.name];
  const status = am.getStatus();
  assert.deepEqual({ switched, eligibility, selected, current: status.currentAccount, paid: status.accounts[0].onExtraUsage },
    { switched: true, eligibility: { eligible: true }, selected: ['api', 'api'], current: 'api', paid: false });
});

test('automatic cursor movements clear an earlier manual API choice', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setCurrentAccount(1);
  const selected = [am.getActiveAccount(null, OPUS)?.name];
  am.accounts[1].disabled = true;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  am.accounts[1].disabled = false;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  assert.deepEqual(selected, ['api', 'subscription', 'api', 'subscription']);
});

for (const disabled of [false, true]) {
  test(`a transient throttle preserves preferred episodes (API disabled=${disabled})`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const am = fleet({ preferExtraUsage: true });
    am.addAccount(oauth('subscription-2', { allowExtraUsage: true, preferExtraUsage: true }));
    am.accounts[2].quota.unified7d = 1;
    am.setDistributeSessions(true);
    for (const sessionId of ['first', 'second']) {
      const picked = am.getActiveAccount(null, OPUS, null, sessionId);
      am.recordSession(sessionId, picked.index, OPUS);
    }
    t.mock.timers.tick(am.ramp.windowMs + 1);
    am.accounts[1].disabled = disabled;
    am.accounts[2].status = 'throttled';
    am.accounts[2].rateLimitedUntil = Date.now() + 10_000;
    am.getActiveAccount(null, OPUS, null, 'first');
    t.mock.timers.tick(10_001);
    const selected = am.getActiveAccount(null, OPUS, null, 'second')?.name;
    assert.deepEqual({ selected, ramp: am._rampCap(am.accounts[2]),
      enters: lines.filter(line => line.includes('Routing to "subscription-2"')).length,
      leaves: lines.filter(line => line.includes('leaving extra usage')).length,
      billing: am.getStatus().accounts.map(a => a.onExtraUsage) },
    { selected: 'subscription-2', ramp: Infinity, enters: 1, leaves: 0, billing: [true, false, true] });
  });
}

test('removing the preference restores single-account legacy billing episodes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const config = { accounts: [
    oauth('s1', { allowExtraUsage: true, preferExtraUsage: true }),
    oauth('s2', { allowExtraUsage: true, preferExtraUsage: true }),
    { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 },
  ] };
  const am = new AccountManager(config.accounts, 0.98);
  am._nextProbeAt = Date.now() + 60_000;
  for (const account of am.accounts.slice(0, 2)) account.quota.unified7d = 1;
  am.setDistributeSessions(true);
  for (const sessionId of ['first', 'second']) {
    const picked = am.getActiveAccount(null, OPUS, null, sessionId);
    am.recordSession(sessionId, picked.index, OPUS);
  }
  const before = am.getStatus().accounts.map(a => a.onExtraUsage);
  const disk = { accounts: config.accounts.map(a => a.type === 'oauth'
    ? { ...a, preferExtraUsage: false } : { ...a, disabled: true }) };
  await syncAccountsFromDisk(disk, config, am);
  const selected = [];
  for (const sessionId of ['first', 'second', 'first', 'second']) {
    const picked = am.getActiveAccount(null, OPUS, null, sessionId);
    selected.push(picked?.name);
    am.recordSession(sessionId, picked.index, OPUS);
  }
  t.mock.timers.tick(am.sessionTracker.knownTtlMs + 1);
  assert.deepEqual({ before, selected, billing: am.getStatus().accounts.map(a => a.onExtraUsage),
    preference: am.accounts.slice(0, 2).map(a => a.preferExtraUsage) },
  { before: [true, true, false], selected: ['s1', 's1', 's1', 's1'],
    billing: [true, false, false], preference: [false, false] });
});

test('reloading extra-usage permission and preference applies them independently', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers.authorization || req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'application/json',
      ...(req.headers.authorization ? { 'anthropic-ratelimit-unified-7d-utilization': '1' } : {}),
    });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let running;
  try {
    running = await spawnServer({ config: () => ({
      proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false,
      quotaProbeSeconds: 0,
      accounts: [oauth('subscription', { allowExtraUsage: true }), { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 }],
    }) });
    const post = async path => {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [] }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    await post('/v1/messages');
    await post('/v1/messages');
    const config = JSON.parse(await readFile(running.configPath, 'utf8'));
    delete config.accounts[0].allowExtraUsage;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    config.accounts[0].allowExtraUsage = true;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    config.accounts[0].preferExtraUsage = true;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    delete config.accounts[0].preferExtraUsage;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    assert.deepEqual(seen, ['Bearer t-subscription', 'api-key', 'api-key', 'api-key', 'Bearer t-subscription', 'api-key'], running.output());
  } finally {
    await running?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
