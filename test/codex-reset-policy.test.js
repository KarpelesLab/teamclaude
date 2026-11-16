import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REDEEM_POLICY,
  autoRedeemArmed,
  autoRedeemStanding,
  byExhaustion,
  creditValueWeeks,
  dailyCapVerdict,
  daysToReset,
  minDaysReason,
  recentRedemptions,
  redeemPolicyFrom,
  redeemedLast24h,
  resetCohort,
  shareCapVerdict,
} from '../src/codex-reset-policy.js';

// The spending strategy for Codex reset credits, as pure functions: what a
// credit is worth, which accounts come back together, and the three caps.
// Nothing here has a side effect, so every table is walked without a request.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

/** A Codex account whose weekly reset is `days` away. */
function codex(name, days, { quota = {}, ...extra } = {}) {
  return {
    name, index: 0, provider: 'codex', type: 'oauth', accountId: 'acct-' + name,
    quota: { unified7d: 1, unified5h: 0.1, unified7dReset: days == null ? null : NOW + days * DAY, ...quota },
    ...extra,
  };
}

// ── the knobs ───────────────────────────────────────────────────────────────

test('an absent config reads as every knob off, which is the default policy', () => {
  assert.deepEqual(redeemPolicyFrom(undefined), DEFAULT_REDEEM_POLICY);
  assert.deepEqual(redeemPolicyFrom({}), DEFAULT_REDEEM_POLICY);
  assert.deepEqual(redeemPolicyFrom({ autoRedeemResets: true }), DEFAULT_REDEEM_POLICY);
});

test('each knob is normalised to its own range, and a bad value is off rather than fatal', () => {
  assert.deepEqual(redeemPolicyFrom({ autoRedeemMinDaysToReset: 2.5, autoRedeemMaxShare: 0.5, autoRedeemMaxPerDay: 3 }),
    { minDaysToReset: 2.5, maxShare: 0.5, maxPerDay: 3 });
  // Off values, spelled every way a hand edit might.
  assert.deepEqual(redeemPolicyFrom({ autoRedeemMinDaysToReset: -1, autoRedeemMaxShare: 1, autoRedeemMaxPerDay: 0 }), DEFAULT_REDEEM_POLICY);
  assert.deepEqual(redeemPolicyFrom({ autoRedeemMinDaysToReset: 'two', autoRedeemMaxShare: 'half', autoRedeemMaxPerDay: 'many' }), DEFAULT_REDEEM_POLICY);
  // A share outside (0, 1) is not a share: 0 would mean "nobody", which is
  // what the fleet switch is for, and 1.5 means nothing.
  assert.equal(redeemPolicyFrom({ autoRedeemMaxShare: 0 }).maxShare, 1);
  assert.equal(redeemPolicyFrom({ autoRedeemMaxShare: 1.5 }).maxShare, 1);
  // A per-day cap is a count.
  assert.equal(redeemPolicyFrom({ autoRedeemMaxPerDay: 1.5 }).maxPerDay, 0);
  assert.equal(redeemPolicyFrom({ autoRedeemMaxPerDay: '2' }).maxPerDay, 2);
  // Values that would coerce to a number without being one.
  assert.deepEqual(redeemPolicyFrom({ autoRedeemMinDaysToReset: true, autoRedeemMaxShare: [0.5], autoRedeemMaxPerDay: true }), DEFAULT_REDEEM_POLICY);
  assert.deepEqual(redeemPolicyFrom({ autoRedeemMinDaysToReset: null, autoRedeemMaxShare: '', autoRedeemMaxPerDay: [3] }), DEFAULT_REDEEM_POLICY);
});

test('a knob set to a value it cannot read is named in a warning, with what was read', async () => {
  const { redeemPolicyWarnings } = await import('../src/codex-reset-policy.js');
  assert.deepEqual(redeemPolicyWarnings({ autoRedeemMinDaysToReset: '3d', autoRedeemMaxShare: 50, autoRedeemMaxPerDay: 2.5 }), [
    '[TeamClaude] autoRedeemMinDaysToReset is "3d", which is not a number of days above 0, so the minimum-days floor is off',
    '[TeamClaude] autoRedeemMaxShare is 50, which is not a fraction strictly between 0 and 1, so the cohort share cap is off',
    '[TeamClaude] autoRedeemMaxPerDay is 2.5, which is not a whole number above 0, so the per-day cap is off',
  ]);
  assert.match(redeemPolicyWarnings({ autoRedeemMaxShare: '50%' })[0], /autoRedeemMaxShare is "50%", /);
  assert.match(redeemPolicyWarnings({ autoRedeemMaxShare: 0 })[0], /autoRedeemMaxShare is 0, /);
  assert.match(redeemPolicyWarnings({ autoRedeemMinDaysToReset: -1 })[0], /autoRedeemMinDaysToReset is -1, /);
  assert.match(redeemPolicyWarnings({ autoRedeemMaxPerDay: true })[0], /autoRedeemMaxPerDay is true, /);
  // Nothing to say about a key that is absent, null, off as written, or usable.
  for (const config of [
    undefined, {},
    { autoRedeemMinDaysToReset: null, autoRedeemMaxShare: null, autoRedeemMaxPerDay: null },
    { autoRedeemMinDaysToReset: 0, autoRedeemMaxShare: 1, autoRedeemMaxPerDay: 0 },
    { autoRedeemMinDaysToReset: '0', autoRedeemMaxShare: '1', autoRedeemMaxPerDay: '0' },
    { autoRedeemMinDaysToReset: 2, autoRedeemMaxShare: 0.5, autoRedeemMaxPerDay: 3 },
    { autoRedeemMinDaysToReset: 6.9 },
  ]) assert.deepEqual(redeemPolicyWarnings(config), [], JSON.stringify(config));
});

test('a floor of 7 days or more is kept as written, and said to stop every automatic redemption', async () => {
  const { redeemPolicyWarnings } = await import('../src/codex-reset-policy.js');
  for (const days of [7, 10]) {
    assert.equal(redeemPolicyFrom({ autoRedeemMinDaysToReset: days }).minDaysToReset, days);
    assert.deepEqual(redeemPolicyWarnings({ autoRedeemMinDaysToReset: days }), [
      `[TeamClaude] autoRedeemMinDaysToReset is ${days}, but an account whose 7-day weekly window has run out is always less than 7 days from its reset, so no Codex credit on such a window is redeemed automatically (the usage parser also reads a window of up to 7.7 days as weekly)`,
    ]);
  }
});

// ── the value of a credit ───────────────────────────────────────────────────

test('a credit is worth the days to the natural reset over seven', () => {
  assert.equal(daysToReset(codex('a', 3.5), NOW), 3.5);
  assert.equal(creditValueWeeks(codex('a', 3.5), NOW), 0.5);
  assert.equal(creditValueWeeks(codex('a', 7), NOW), 1);
  // Never more than a week, never negative.
  assert.equal(creditValueWeeks(codex('a', 9), NOW), 1);
  assert.equal(creditValueWeeks(codex('a', -1), NOW), 0);
});

test('a credit on an account with no stated reset has no value — which is not zero', () => {
  assert.equal(daysToReset(codex('a', null), NOW), null);
  assert.equal(creditValueWeeks(codex('a', null), NOW), null);
  assert.equal(creditValueWeeks({ quota: {} }, NOW), null);
  assert.equal(creditValueWeeks(null, NOW), null);
});

// ── the minimum-days floor ──────────────────────────────────────────────────

test('with the floor off nothing is ever stopped, whatever the reset says', () => {
  assert.equal(minDaysReason(codex('a', 0.1), 0, NOW), null);
  assert.equal(minDaysReason(codex('a', null), 0, NOW), null);
});

test('the floor stops an account whose reset is too close, and says what the credit would have bought', () => {
  const reason = minDaysReason(codex('a', 1.4), 2, NOW);
  assert.match(reason, /1\.4d away/);
  assert.match(reason, /under the 2d minimum/);
  assert.match(reason, /0\.20 of a week/);
  assert.equal(minDaysReason(codex('a', 2), 2, NOW), null, 'exactly at the floor clears it');
  assert.equal(minDaysReason(codex('a', 5), 2, NOW), null);
});

test('the floor\'s reason never rounds the days up to the minimum they are under', () => {
  // Rounded to the nearest tenth, 1.96 days read "2d away, under the 2d minimum".
  assert.match(minDaysReason(codex('a', 1.96), 2, NOW), /^natural weekly reset is 1\.9d away, under the 2d minimum /);
  assert.match(minDaysReason(codex('a', 2.96), 3, NOW), /^natural weekly reset is 2\.9d away, under the 3d minimum /);
  assert.match(minDaysReason(codex('a', 1.04), 2, NOW), /^natural weekly reset is 1d away, under the 2d minimum /);
  // A minimum is stated as set: 2.04 rounded is 2, which 2.03 days would floor to.
  assert.match(minDaysReason(codex('a', 2.03), 2.04, NOW), /^natural weekly reset is 2d away, under the 2\.04d minimum /);
});

test('a standing states the weeks and the days from one reading, each to the step below', () => {
  const at = ms => autoRedeemStanding({
    account: codex('a', null, { quota: { unified7dReset: NOW + ms } }), autoRedeemResets: true,
    policy: DEFAULT_REDEEM_POLICY, members: [], ledger: [], now: NOW,
  });
  // Weeks to the nearest hundredth beside days to the tenth below read 6.199
  // days as "0.89 of a week (6.1d)", and 0.89 of a week is 6.23 days.
  const v = at(6.199 * DAY);
  assert.deepEqual([v.creditValueWeeks, v.daysToReset], [0.88, 6.1]);
  // An exact step is not read one low: 1.96 days is 0.28 of a week, which a
  // division in days floors to 0.27.
  assert.deepEqual([at(1.96 * DAY).creditValueWeeks, at(1.96 * DAY).daysToReset], [0.28, 1.9]);
  // A credit is never worth more than a week, however far a reset reads.
  assert.deepEqual([at(7.5 * DAY).creditValueWeeks, at(7.5 * DAY).daysToReset], [1, 7.5]);
  // Across the week, each figure is the step at or just below the reading.
  const WEEK = 7 * DAY;
  for (let ms = 0; ms <= WEEK; ms += 37 * 60 * 1000) {
    const s = at(ms);
    const hundredths = Math.round(s.creditValueWeeks * 100);
    const tenths = Math.round(s.daysToReset * 10);
    assert.ok(hundredths * WEEK / 100 <= ms && (ms < (hundredths + 1) * WEEK / 100 || hundredths === 100), `weeks at ${ms}ms`);
    assert.ok(tenths * DAY / 10 <= ms && ms < (tenths + 1) * DAY / 10, `days at ${ms}ms`);
  }
});

test('a reset already behind us reads as 0 weeks and 0 days, never less', () => {
  // Nothing sweeps a passed reset until the account is next read.
  const past = codex('a', null, { quota: { unified7dReset: NOW - 60 * 60 * 1000 } });
  const s = autoRedeemStanding({ account: past, autoRedeemResets: true, policy: DEFAULT_REDEEM_POLICY, members: [], ledger: [], now: NOW });
  assert.deepEqual([s.creditValueWeeks, s.daysToReset], [0, 0]);
  assert.match(minDaysReason(past, 2, NOW), /^natural weekly reset is 0d away, under the 2d minimum \(the credit would buy 0\.00 of a week\)$/);
});

test('with the floor on, an account whose reset is unknown cannot be shown to clear it', () => {
  assert.match(minDaysReason(codex('a', null), 2, NOW), /reset time is unknown/);
});

// ── cohorts ─────────────────────────────────────────────────────────────────

test('accounts whose resets fall on the same UTC calendar day share a cohort', () => {
  const a = codex('a', 2);
  const b = { ...a, quota: { ...a.quota, unified7dReset: a.quota.unified7dReset + 6 * 60 * 60 * 1000 } };
  const c = codex('c', 3);
  assert.equal(resetCohort(a), resetCohort(b));
  assert.notEqual(resetCohort(a), resetCohort(c));
  assert.equal(resetCohort(codex('d', null)), null);
  // A calendar day, not a 24-hour span: two resets two hours apart on either
  // side of 00:00 UTC are different cohorts. NOW is 12:00 UTC.
  const lateEvening = { ...a, quota: { ...a.quota, unified7dReset: NOW + 11 * 60 * 60 * 1000 } };
  const earlyMorning = { ...a, quota: { ...a.quota, unified7dReset: NOW + 13 * 60 * 60 * 1000 } };
  assert.notEqual(resetCohort(lateEvening), resetCohort(earlyMorning));
});

test('only an armed Codex account is counted in a cohort', () => {
  assert.equal(autoRedeemArmed(codex('a', 2), true), true);
  assert.equal(autoRedeemArmed(codex('a', 2), false), false);
  assert.equal(autoRedeemArmed(codex('a', 2, { autoRedeemReset: false }), true), false);
  assert.equal(autoRedeemArmed({ name: 'c', type: 'oauth', quota: {} }, true), false, 'an Anthropic account');
});

// ── the share cap ───────────────────────────────────────────────────────────

test('with the cap off the verdict is always yes', () => {
  const members = [codex('a', 2), codex('b', 2)];
  assert.equal(shareCapVerdict({ account: members[0], members, ledger: [], maxShare: 1, now: NOW }).ok, true);
});

test('a half share of a cohort of four allows two, most exhausted first, and the cohort does not shrink as it is spent', () => {
  const members = [codex('a', 2, { index: 0 }), codex('b', 2, { index: 1 }), codex('c', 2, { index: 2 }), codex('d', 2, { index: 3 })];
  const cohort = resetCohort(members[0]);
  const ledger = [];
  const ask = account => shareCapVerdict({ account, members, ledger, maxShare: 0.5, now: NOW });

  const first = ask(members[0]);
  assert.deepEqual({ ok: first.ok, size: first.size, allowed: first.allowed, used: first.used }, { ok: true, size: 4, allowed: 2, used: 0 });

  // `a` redeems: its reset moves a week out, so it leaves the cohort...
  ledger.push({ account: members[0], name: 'a', cohort, at: NOW, manual: false });
  members[0].quota.unified7dReset = NOW + 7 * DAY;
  const second = ask(members[1]);
  // ...but the cohort is still sized at four, and one of its two slots is spent.
  assert.deepEqual({ ok: second.ok, size: second.size, allowed: second.allowed, used: second.used }, { ok: true, size: 4, allowed: 2, used: 1 });

  ledger.push({ account: members[1], name: 'b', cohort, at: NOW + 1000, manual: false });
  members[1].quota.unified7dReset = NOW + 7 * DAY;
  const third = ask(members[2]);
  assert.equal(third.ok, false);
  assert.equal(third.used, 2);
  assert.equal(third.allowed, 2, 'sized on the current members alone this would have read ceil(0.5 * 2) = 1 of 1, and the whole cohort would go');
  assert.match(third.reason, /cohort of 4 already had 2 redeemed, the 50% share cap allows 2/);
});

test('the share is rounded up, so a small cohort is never "nobody"', () => {
  const members = [codex('a', 2)];
  const v = shareCapVerdict({ account: members[0], members, ledger: [], maxShare: 0.25, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.allowed, 1);
  const three = [codex('a', 2), codex('b', 2), codex('c', 2)];
  assert.equal(shareCapVerdict({ account: three[0], members: three, ledger: [], maxShare: 0.5, now: NOW }).allowed, 2);
});

test('a share that is not exact in binary does not round a whole number up to the next one', () => {
  // 0.28 * 25 is 7.000000000000001 in floating point; the cap allows 7, not 8.
  const pool = Array.from({ length: 25 }, (_, i) => codex('m' + i, 2, { index: i }));
  assert.equal(shareCapVerdict({ account: pool[0], members: pool, ledger: [], maxShare: 0.28, now: NOW }).allowed, 7);
  const cohort = resetCohort(pool[0]);
  const ledger = pool.slice(0, 7).map(account => ({ account, name: account.name, cohort, at: NOW, manual: false }));
  assert.equal(shareCapVerdict({ account: pool[7], members: pool, ledger, maxShare: 0.28, now: NOW }).ok, false);
});

test('a manual redemption takes a slot of its cohort, and keeps the cohort at its size', () => {
  const members = [codex('a', 2, { index: 0 }), codex('b', 2, { index: 1 })];
  const cohort = resetCohort(members[0]);
  const ledger = [{ account: members[0], name: 'a', cohort, at: NOW, manual: true }];
  members[0].quota.unified7dReset = NOW + 7 * DAY;
  const v = shareCapVerdict({ account: members[1], members, ledger, maxShare: 0.5, now: NOW });
  assert.deepEqual({ ok: v.ok, size: v.size, allowed: v.allowed, used: v.used }, { ok: false, size: 2, allowed: 1, used: 1 });
});

test('a redemption up to a week old still holds its cohort\'s slot', () => {
  // a was redeemed five days ago, out of the cohort b still resets in: a
  // day from now. Its timer then restarted, so it resets in two. The phase
  // it moved stays moved until the members reset on their own.
  const a = codex('a', 2);
  const b = codex('b', 1);
  const ledger = [{ account: a, name: 'a', cohort: resetCohort(b), at: NOW - 5 * DAY, manual: false }];
  const v = shareCapVerdict({ account: b, members: [a, b], ledger, maxShare: 0.5, now: NOW });
  assert.deepEqual({ ok: v.ok, size: v.size, allowed: v.allowed, used: v.used }, { ok: false, size: 2, allowed: 1, used: 1 });
  assert.equal(recentRedemptions(ledger, NOW + 2 * DAY - 1).length, 1, 'just under a week old');
  assert.equal(recentRedemptions(ledger, NOW + 2 * DAY).length, 0, 'a week old');
});

test('a redemption from another cohort, or from more than a week ago, is not charged to this one', () => {
  const members = [codex('a', 2), codex('b', 5)];
  const ledger = [
    { account: members[1], name: 'b', cohort: resetCohort(members[1]), at: NOW, manual: false },
    { account: {}, name: 'old', cohort: resetCohort(members[0]), at: NOW - 8 * DAY, manual: false },
  ];
  const v = shareCapVerdict({ account: members[0], members, ledger, maxShare: 0.5, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.used, 0);
  assert.equal(v.size, 1);
});

test('the account asked about is in its own cohort even when the members leave it out', () => {
  // The status payload asks about a disabled or cordoned account too, which
  // the redeemer's members do not list: alone on its day it is a cohort of
  // one, not of none.
  const a = codex('a', 2);
  const v = shareCapVerdict({ account: a, members: [codex('b', 5)], ledger: [], maxShare: 0.5, now: NOW });
  assert.deepEqual({ ok: v.ok, size: v.size, allowed: v.allowed, used: v.used }, { ok: true, size: 1, allowed: 1, used: 0 });
});

test('an account with no stated reset belongs to no cohort and is not capped by one', () => {
  const members = [codex('a', null)];
  assert.equal(shareCapVerdict({ account: members[0], members, ledger: [], maxShare: 0.5, now: NOW }).ok, true);
});

// ── the per-day cap ─────────────────────────────────────────────────────────

test('the per-day cap counts a rolling 24 hours and says when it is reached', () => {
  const ledger = [
    { account: {}, name: 'a', cohort: 1, at: NOW - 23 * 60 * 60 * 1000, manual: false },
    { account: {}, name: 'b', cohort: 1, at: NOW - 25 * 60 * 60 * 1000, manual: false },
  ];
  assert.equal(redeemedLast24h(ledger, NOW), 1);
  assert.equal(recentRedemptions(ledger, NOW).length, 2);
  assert.deepEqual(dailyCapVerdict(ledger, 0, NOW), { ok: true, reason: null, redeemedLast24h: 1 });
  assert.equal(dailyCapVerdict(ledger, 2, NOW).ok, true);
  const capped = dailyCapVerdict(ledger, 1, NOW);
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /daily cap of 1 auto-redemption is reached \(1 in the last 24h\)/);
});

test('the per-day cap counts automatic redemptions only', () => {
  const manual = { account: {}, name: 'a', cohort: 1, at: NOW - 60 * 60 * 1000, manual: true };
  assert.equal(redeemedLast24h([manual], NOW), 0);
  assert.equal(dailyCapVerdict([manual], 1, NOW).ok, true, 'a redemption made by hand does not hold the automatic ones back');
  const automatic = { ...manual, manual: false };
  assert.equal(dailyCapVerdict([manual, automatic], 1, NOW).ok, false);
  assert.equal(dailyCapVerdict([manual, automatic], 1, NOW).redeemedLast24h, 1);
});

// ── ordering ────────────────────────────────────────────────────────────────

test('most exhausted first: weekly, then 5-hour, then the credit worth more, then array order', () => {
  const rows = [
    codex('d', 2, { index: 3 }),
    codex('c', 5, { index: 2 }),
    codex('b', 2, { index: 1, quota: { unified5h: 0.9 } }),
    codex('a', 2, { index: 0, quota: { unified7d: 1.2 } }),
  ];
  assert.deepEqual([...rows].sort(byExhaustion).map(r => r.name), ['a', 'b', 'c', 'd']);
});

// ── standing, for the status payload ────────────────────────────────────────

test('standing names the first thing that exempts an account, and the value either way', () => {
  const policy = { minDaysToReset: 2, maxShare: 0.5, maxPerDay: 1 };
  const a = codex('a', 3.5);
  const armed = autoRedeemStanding({ account: a, autoRedeemResets: true, policy, members: [a], ledger: [], now: NOW });
  assert.deepEqual(armed, { armed: true, exemptReason: null, creditValueWeeks: 0.5, daysToReset: 3.5 });

  const off = autoRedeemStanding({ account: a, autoRedeemResets: false, policy, members: [a], ledger: [], now: NOW });
  assert.deepEqual(off, { armed: false, exemptReason: 'auto-redeem is switched off', creditValueWeeks: 0.5, daysToReset: 3.5 });

  const optOut = autoRedeemStanding({ account: { ...a, autoRedeemReset: false }, autoRedeemResets: true, policy, members: [a], ledger: [], now: NOW });
  assert.equal(optOut.exemptReason, 'auto-redeem is switched off for this account');

  const close = autoRedeemStanding({ account: codex('z', 1), autoRedeemResets: true, policy, members: [a], ledger: [], now: NOW });
  assert.match(close.exemptReason, /under the 2d minimum/);
  assert.equal(close.creditValueWeeks, 0.14);

  const full = autoRedeemStanding({ account: a, autoRedeemResets: true, policy, members: [a], ledger: [{ account: {}, name: 'x', cohort: 0, at: NOW, manual: false }], now: NOW });
  assert.match(full.exemptReason, /daily cap/);

  // The share cap, with the per-day cap off: another member of a's cohort
  // was redeemed by hand, which takes the one slot a half share of two has.
  const b = codex('b', 3.5);
  const shared = autoRedeemStanding({
    account: a, autoRedeemResets: true, policy: { ...policy, maxPerDay: 0 }, members: [a],
    ledger: [{ account: b, name: 'b', cohort: resetCohort(a), at: NOW, manual: true }], now: NOW,
  });
  assert.equal(shared.armed, false);
  assert.match(shared.exemptReason, /^its reset cohort of 2 already had 1 redeemed, the 50% share cap allows 1$/);

  const unknown = autoRedeemStanding({ account: codex('u', null), autoRedeemResets: true, policy: DEFAULT_REDEEM_POLICY, members: [], ledger: [], now: NOW });
  assert.deepEqual(unknown, { armed: true, exemptReason: null, creditValueWeeks: null, daysToReset: null });
});
