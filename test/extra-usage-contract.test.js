import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus } from '../src/status-renderer.js';

const OPUS = 'claude-opus-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, expiresAt: Date.now() + 3600_000, ...extra });
const api = (name, priority = 100) => ({ name, type: 'apikey', apiKey: `key-${name}`, priority });

function fleet({ allowed = true, weekly = 1, apiPriority = 100 } = {}) {
  const am = new AccountManager([
    oauth('subscription', { allowExtraUsage: allowed }),
    api('api', apiPriority),
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true } });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 1;
  return am;
}

for (const [label, options, expected] of [
  ['included quota below threshold', { weekly: 0.2 }, 'subscription'],
  ['remaining included quota above threshold', { weekly: 0.98 }, 'api'],
  ['subscription credits', { weekly: 1 }, 'api'],
  ['included quota above threshold without permission', { allowed: false, weekly: 0.98 }, 'api'],
  ['explicit API priority ahead of included quota', { weekly: 0.2, apiPriority: -1 }, 'api'],
]) {
  test(`extra-usage permission preserves normal rotation: ${label}`, () => {
    const am = fleet(options);
    const picked = am.getActiveAccount(null, OPUS);
    const status = am.getStatus();
    assert.deepEqual({ selected: picked?.name, current: status.currentAccount, billing: status.accounts[0].onExtraUsage },
      { selected: expected, current: expected, billing: false });
  });
}

for (const weekly of [0.98, 1]) {
  for (const other of [oauth('other', { allowExtraUsage: true }), api('other')]) {
    test(`a manual switch does not bypass ${other.type} capacity at ${weekly * 100}% subscription usage`, () => {
      const am = new AccountManager([oauth('subscription', { allowExtraUsage: true }), other], 0.98);
      am._nextProbeAt = Date.now() + 60_000;
      am.setCurrentAccount(0);
      const initial = am.getActiveAccount(null, OPUS)?.name;
      Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true } });
      const eligibility = am.eligibility(0);
      const selected = [am.getActiveAccount(null, OPUS)?.name, am.getActiveAccount(null, OPUS)?.name];
      assert.deepEqual({ initial, eligibility, selected, billing: am.getStatus().accounts[0].onExtraUsage },
        { initial: 'subscription', eligibility: { eligible: false, reason: 'at or above the switch threshold' },
          selected: ['other', 'other'], billing: false });
    });
  }
}

test('automatic rotation back to an account does not restore an earlier manual choice', () => {
  const am = new AccountManager([
    oauth('a', { allowExtraUsage: true }), oauth('b', { allowExtraUsage: true }),
  ], 0.98);
  am._nextProbeAt = Date.now() + 60_000;
  am.setCurrentAccount(0);
  am.accounts[0].disabled = true;
  const selected = [am.getActiveAccount(null, OPUS)?.name];
  am.accounts[0].disabled = false;
  am.accounts[1].quota.unified7d = 1;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[1].quota.unified7d = 0;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  assert.deepEqual({ selected, billing: am.getStatus().accounts.map(a => a.onExtraUsage) },
    { selected: ['b', 'a', 'b'], billing: [false, false] });
});

test('failover keeps available API capacity ahead of subscription credits', () => {
  const am = fleet();
  const alternate = am.pickAlternate(new Set(), OPUS);
  assert.deepEqual({ account: alternate?.name, cursor: am.currentIndex, paid: am.getStatus().accounts[0].onExtraUsage },
    { account: 'api', cursor: 1, paid: false });
});

test('an explicit API switch stays effective when subscription credits are available', () => {
  const am = fleet();
  am.setCurrentAccount(0);
  const switched = am.setCurrentAccount(1);
  const eligibility = am.eligibility(1);
  const selected = [am.getActiveAccount(null, OPUS)?.name, am.getActiveAccount(null, OPUS)?.name];
  const status = am.getStatus();
  assert.deepEqual({ switched, eligibility, selected, current: status.currentAccount, paid: status.accounts[0].onExtraUsage },
    { switched: true, eligibility: { eligible: true }, selected: ['api', 'api'], current: 'api', paid: false });
});

for (const [mode, setting] of [['even', true], ['adaptive', 'adaptive'], ['load', 'load']]) {
  for (const weekly of [0.98, 1]) {
    test(`${mode} distribution leaves an allow-only subscription at ${weekly * 100}% usage`, () => {
      const am = fleet({ weekly });
      am.setDistributeSessions(setting);
      am.recordSession('conversation', 0, OPUS);
      const selected = [];
      for (let turn = 0; turn < 2; turn++) {
        const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
        selected.push(picked?.name ?? null);
        if (picked) am.recordSession('conversation', picked.index, OPUS);
      }
      assert.deepEqual({ selected, pinned: am.sessionTracker.pinnedAccount('conversation', 'unified7d'),
        billing: am.getStatus().accounts[0].onExtraUsage },
      { selected: ['api', 'api'], pinned: 1, billing: false });
    });
  }

  test(`${mode} distribution preserves API affinity when subscription credits are available`, () => {
    const am = fleet();
    am.setDistributeSessions(setting);
    am.recordSession('conversation', 1, OPUS);
    const selected = [];
    for (let turn = 0; turn < 2; turn++) {
      const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
      selected.push(picked?.name ?? null);
      if (picked) am.recordSession('conversation', picked.index, OPUS);
    }
    assert.deepEqual({ selected, pinned: am.sessionTracker.pinnedAccount('conversation', 'unified7d'), paid: am.getStatus().accounts[0].onExtraUsage },
      { selected: ['api', 'api'], pinned: 1, paid: false });
  });

  test(`${mode} distribution places new sessions on API accounts when subscription credits are available`, () => {
    const am = fleet();
    am.addAccount(api('api-2'));
    am.setDistributeSessions(setting);
    const selected = [];
    for (const sessionId of ['first', 'second']) {
      const picked = am.getActiveAccount(null, OPUS, null, sessionId);
      selected.push(picked?.name ?? null);
      if (picked) am.recordSession(sessionId, picked.index, OPUS);
    }
    assert.deepEqual({ selected, paid: am.getStatus().accounts[0].onExtraUsage },
      { selected: ['api', 'api-2'], paid: false });
  });
}

test('a transient throttle does not restart an exhausted-fleet billing episode', () => {
  const am = new AccountManager([oauth('subscription', { allowExtraUsage: true })], 0.98);
  am.accounts[0].quota.unified7d = 1;
  am._nextProbeAt = Date.now() + 60_000;
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let selected;
  let during;
  try {
    am.getActiveAccount(null, OPUS);
    am.accounts[0].rampStartedAt = 1;
    am.accounts[0].status = 'throttled';
    am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
    const status = am.getStatus().accounts[0];
    during = { unavailable: status.unavailable, billing: status.onExtraUsage };
    am.accounts[0].rateLimitedUntil = Date.now() - 1;
    selected = am.getActiveAccount(null, OPUS)?.name;
  } finally {
    console.log = log;
  }
  assert.deepEqual({ during, selected, ramp: am.accounts[0].rampStartedAt,
    enters: lines.filter(line => line.includes('on extra usage')).length,
    leaves: lines.filter(line => line.includes('leaving extra usage')).length },
  { during: { unavailable: 'throttled', billing: true }, selected: 'subscription', ramp: 1, enters: 1, leaves: 0 });
});

test('status ends a manually selected billing episode when its quota recovers', () => {
  const am = new AccountManager([oauth('subscription', { allowExtraUsage: true })], 0.98);
  am._nextProbeAt = Date.now() + 60_000;
  am.setCurrentAccount(0);
  Object.assign(am.accounts[0].quota, { unified7d: 1, spend: { enabled: true, usedMinor: 0 } });
  am.getActiveAccount(null, OPUS);
  const before = am.getStatus().accounts[0];
  Object.assign(am.accounts[0].quota, { unified7d: 0.2, spend: { enabled: true, usedMinor: 100 } });
  const after = am.getStatus().accounts[0];
  assert.deepEqual({ before: { unavailable: before.unavailable, billing: before.onExtraUsage },
    after: { unavailable: after.unavailable, billing: after.onExtraUsage } },
  { before: { unavailable: 'quota', billing: true }, after: { unavailable: null, billing: false } });
});

for (const [label, restrict, reason, text] of [
  ['disabled', a => { a.disabled = true; }, 'disabled', /Blocked\s+disabled by operator/],
  ['usage cap', a => { a.maxUsage = 1; }, 'capped', /Blocked\s+account usage cap reached/],
  ['spend cap', a => { a.maxSpend = 1; a.quota.spend.usedMinor = 100; }, 'spend-capped', /Blocked\s+extra-usage spend cap reached/],
  ['throttle', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; }, 'throttled', /Blocked\s+upstream 429 hold/],
]) {
  test(`status preserves the ${label} explanation during an existing billing episode`, () => {
    const am = new AccountManager([oauth('subscription', { allowExtraUsage: true })], 0.98);
    Object.assign(am.accounts[0].quota, { unified7d: 1, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
    am._nextProbeAt = Date.now() + 60_000;
    am.getActiveAccount(null, OPUS);
    restrict(am.accounts[0]);
    const status = am.getStatus();
    assert.deepEqual({ reason: status.accounts[0].unavailable, billing: status.accounts[0].onExtraUsage },
      { reason, billing: true });
    assert.match(renderStatus(status, { color: false }), text);
  });
}

test('an ineligible route pin does not override an eligible manual choice', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), { ...api('pinned'), disabled: true }], 0.98);
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
  am.setRoutePin('opus', 2);
  am.setCurrentAccount(1);
  const eligibility = am.eligibility(1);
  const preview = am.previewRouteIndex(OPUS);
  const selected = am.getActiveAccount(null, OPUS)?.name;
  assert.deepEqual({ eligibility, preview, selected },
    { eligibility: { eligible: true }, preview: 1, selected: 'b' });
});

test('route preview keeps available API capacity ahead of allow-only subscription credits', () => {
  const am = fleet();
  am.setCurrentAccount(0);
  assert.equal(am.previewRouteIndex(OPUS), 1);
});
