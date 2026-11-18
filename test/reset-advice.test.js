import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviseResets, ADVICE_LEAD_MS, ADVICE_MIN_GAIN_MS, ADVICE_EXPIRY_MS } from '../src/reset-advice.js';

// When to spend a banked Claude reset, and on which account. A reset is spent
// for the pool, not for an account: while some account still serves, waiting
// costs nothing; once the pool is dry (or about to be), the reset that buys the
// most is the one on the account that would otherwise stay out longest.

const NOW = Date.parse('2026-11-20T16:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const grant = (extra = {}) => ({ id: 'g-weekly', label: 'Weekly reset', resetsLeft: 1, resetsTotal: 1, clears: ['five_hour', 'seven_day'],
  usableNow: true, paused: false, startsAt: null, endsAt: NOW + 20 * DAY, type: 'full', givesBackWeekly: true,
  useRequiresLimit: null, percentUsed: null, blocking: [], unavailableReason: null, ...extra });
const fable = (extra = {}) => grant({ id: 'g-fable', label: 'Fable reset', clears: ['seven_day_overage_included'], type: null, ...extra });
const status = (extra = {}) => ({ eligible: true, ineligibleReason: null, atLimit: true, exhausted: ['seven_day'],
  nextGrantId: null, cooldownUntil: null, weeklyResetsAt: null, grants: [grant()], ...extra });
const acct = (name, extra = {}) => ({ name, serving: false, spendable: true, weight: 20, weeklyResetAt: NOW + 3 * DAY, reset: status(), ...extra });

test('while an account serves and no dry spell is near, the advice is to wait', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [acct('a', { serving: true, reset: null }), acct('b')] });
  assert.equal(advice.action, 'wait');
  assert.equal(advice.why, 'headroom');
  assert.equal(advice.candidate.account, 'b', 'it still names the account it would pick');
});

test('a dry pool spends the reset that keeps an account back longest', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [
    acct('soon', { weeklyResetAt: NOW + 2 * HOUR }),
    acct('late', { weeklyResetAt: NOW + 4 * DAY }),
    acct('mid', { weeklyResetAt: NOW + DAY }),
  ] });
  assert.deepEqual(
    { action: advice.action, why: advice.why, account: advice.account, grantId: advice.grantId, kind: advice.kind, gainMs: advice.gainMs },
    { action: 'spend', why: 'dry', account: 'late', grantId: 'g-weekly', kind: 'weekly', gainMs: 4 * DAY });
});

test('the plan weight scales what a reset gives back, when every candidate has one', () => {
  const accounts = [acct('team', { weight: 1, weeklyResetAt: NOW + 5 * DAY }), acct('max', { weight: 20, weeklyResetAt: NOW + 2 * DAY })];
  assert.equal(adviseResets({ now: NOW, forecast: null, accounts }).account, 'max');
  // One unknown weight: compare time alone rather than guess.
  accounts[1].weight = null;
  assert.equal(adviseResets({ now: NOW, forecast: null, accounts }).account, 'team');
});

test('a forecast dry spell within the lead time spends now; further out it waits and says when to look again', () => {
  const accounts = [acct('serving', { serving: true, reset: null }), acct('out')];
  const near = adviseResets({ now: NOW, forecast: { allOutAt: NOW + ADVICE_LEAD_MS, firstBackAt: NOW + 2 * HOUR }, accounts });
  assert.equal(near.action, 'spend');
  assert.equal(near.why, 'soon-dry');
  assert.equal(near.dryAt, NOW + ADVICE_LEAD_MS);
  const far = adviseResets({ now: NOW, forecast: { allOutAt: NOW + 6 * HOUR, firstBackAt: NOW + 7 * HOUR }, accounts });
  assert.equal(far.action, 'wait');
  assert.equal(far.recheckAt, NOW + 6 * HOUR - ADVICE_LEAD_MS);
});

test('an account back on its own within the minimum gain is not worth a reset', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [acct('a', { weeklyResetAt: NOW + ADVICE_MIN_GAIN_MS - MIN })] });
  assert.equal(advice.action, 'wait');
  assert.equal(advice.why, 'no-candidate');
  assert.equal(advice.dryAt, NOW);
});

test('the grant must clear every exhausted limit; the cheapest such grant is chosen', () => {
  // Weekly exhausted: a Fable reset does not bring the account back.
  const weekly = adviseResets({ now: NOW, forecast: null, accounts: [acct('a', { reset: status({ grants: [fable()] }) })] });
  assert.equal(weekly.why, 'no-candidate');
  // Only the Fable weekly exhausted: the Fable reset is enough, and cheaper.
  const fableOnly = adviseResets({ now: NOW, forecast: null, accounts: [acct('a', {
    reset: status({ exhausted: ['seven_day_overage_included'], grants: [grant(), fable()] }) })] });
  assert.equal(fableOnly.grantId, 'g-fable');
  assert.equal(fableOnly.kind, 'fable');
});

test('no reset is advised where the claim would be refused or buy nothing', () => {
  const cases = {
    'not spendable (disabled, cordoned, no org)': acct('a', { spendable: false }),
    'never read': acct('a', { reset: null }),
    'not eligible': acct('a', { reset: status({ eligible: false }) }),
    'cooling down': acct('a', { reset: status({ cooldownUntil: NOW + HOUR }) }),
    'no weekly limit exhausted': acct('a', { reset: status({ exhausted: ['five_hour'] }) }),
    'grant not usable now': acct('a', { reset: status({ grants: [grant({ usableNow: false })] }) }),
    'grant expired': acct('a', { reset: status({ grants: [grant({ endsAt: NOW - MIN })] }) }),
    'no natural reset known': acct('a', { weeklyResetAt: null }),
  };
  for (const [label, account] of Object.entries(cases)) {
    assert.equal(adviseResets({ now: NOW, forecast: null, accounts: [account] }).why, 'no-candidate', label);
  }
});

test('the reading\'s own weekly reset time wins over the quota headers', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [
    acct('a', { weeklyResetAt: NOW + 5 * DAY, reset: status({ weeklyResetsAt: NOW + DAY }) }),
    acct('b', { weeklyResetAt: NOW + 2 * DAY }),
  ] });
  assert.equal(advice.account, 'b');
});

// A grant about to lapse is spent where it still buys time, pool or no pool:
// waiting loses it outright.
test('a grant expiring soon on an account still out past it is spent with headroom', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [
    acct('serving', { serving: true, reset: null }),
    acct('keeps', { weeklyResetAt: NOW + 4 * DAY }),
    acct('lapses', { weeklyResetAt: NOW + 3 * DAY, reset: status({ grants: [grant({ endsAt: NOW + 6 * HOUR })] }) }),
  ] });
  assert.deepEqual([advice.action, advice.why, advice.account, advice.endsAt], ['spend', 'expiring', 'lapses', NOW + 6 * HOUR]);
  // Back on its own before the grant lapses: nothing is lost by waiting.
  const later = adviseResets({ now: NOW, forecast: null, accounts: [
    acct('serving', { serving: true, reset: null }),
    acct('back', { weeklyResetAt: NOW + 2 * HOUR, reset: status({ grants: [grant({ endsAt: NOW + 6 * HOUR })] }) }),
  ] });
  assert.equal(later.action, 'wait');
  assert.equal(ADVICE_EXPIRY_MS, DAY);
});

test('equal gain prefers the grant that lapses first', () => {
  const advice = adviseResets({ now: NOW, forecast: null, accounts: [
    acct('later', { reset: status({ grants: [grant({ endsAt: NOW + 30 * DAY })] }) }),
    acct('sooner', { reset: status({ grants: [grant({ endsAt: NOW + 10 * DAY })] }) }),
  ] });
  assert.equal(advice.account, 'sooner');
});
