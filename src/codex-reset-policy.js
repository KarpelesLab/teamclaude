// The spending strategy for Codex rate-limit reset credits.
//
// A Codex reset credit does two things at once: it clears the account's spent
// weekly window, and it RESTARTS the 7-day timer from the moment of redemption
// (an Anthropic reset leaves the timer where it was). Two consequences, both
// observed on a live fleet, shape everything in this file:
//
//  - A credit is worth the time it buys, and that is not a week. An account
//    whose natural reset is T days away gets T days of fresh window and then
//    the reset it would have had anyway, so the credit bought T/7 of a week.
//    Spent the day before the natural reset, it bought almost nothing.
//  - Redeeming several accounts at once moves all their timers to the same
//    moment. A pool whose resets were spread across the week — the thing that
//    keeps one account available while another is out — collapses into a
//    sawtooth: a full pool, then a dry fleet, together, every seven days.
//
// Three operator knobs answer those, all off unless set (see redeemPolicyFrom):
// a floor on how many days a credit must buy, a cap on how large a share of
// one reset cohort may be redeemed, and a cap on redemptions per day.
//
// Pure on purpose, like shouldRedeemReset in codex-reset-credits.js: every
// function here answers from values the caller already holds, so the whole
// decision table is exercised without a request and the redeemer that calls
// them is the only place with a side effect. This module imports nothing from
// codex-reset-credits.js, which imports it — the dependency runs one way.

import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * @typedef {{minDaysToReset: number, maxShare: number, maxPerDay: number}} RedeemPolicy
 */

/**
 * One past redemption the redeemer remembers, for the cohort and per-day caps.
 * `cohort` is the cohort the account was in BEFORE the credit moved its reset.
 *
 * @typedef {{account: object, name: string, cohort: number|null, at: number, manual: boolean}} RedeemRecord
 */

/** Every knob at its "off" value — exactly today's behaviour. */
export const DEFAULT_REDEEM_POLICY = Object.freeze({ minDaysToReset: 0, maxShare: 1, maxPerDay: 0 });

/**
 * The policy as the config states it, each knob normalised to its own range
 * and falling back to "off" for anything that is not a usable number. A typo
 * in a hand-edited config therefore relaxes nothing it did not mean to —
 * every fallback is the conservative one only in the sense of being what the
 * fleet did before the key existed.
 *
 *  - `autoRedeemMinDaysToReset`: days, >= 0; 0 is off.
 *  - `autoRedeemMaxShare`: a fraction, 0 < share < 1 caps; 1 (or anything
 *    outside the range) is off.
 *  - `autoRedeemMaxPerDay`: a whole number >= 0; 0 is off.
 *
 * @param {Record<string, any>|null|undefined} config
 * @returns {RedeemPolicy}
 */
export function redeemPolicyFrom(config) {
  const minDays = Number(config?.autoRedeemMinDaysToReset);
  const share = Number(config?.autoRedeemMaxShare);
  const perDay = Number(config?.autoRedeemMaxPerDay);
  return {
    minDaysToReset: Number.isFinite(minDays) && minDays > 0 ? minDays : 0,
    maxShare: Number.isFinite(share) && share > 0 && share < 1 ? share : 1,
    maxPerDay: Number.isInteger(perDay) && perDay > 0 ? perDay : 0,
  };
}

/**
 * Days until this account's natural weekly reset, or null when the account has
 * not stated one. Negative is never returned: a reset already behind us reads
 * as 0, the same as a credit that buys nothing.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {number} [now]
 * @returns {number|null}
 */
export function daysToReset(account, now = Date.now()) {
  const resetAt = account?.quota?.unified7dReset;
  if (!Number.isFinite(resetAt)) return null;
  return Math.max(0, (resetAt - now) / DAY_MS);
}

/**
 * What a credit spent on this account right now is worth, as a fraction of a
 * week: the days until its natural reset over seven. Null when the reset is
 * unknown, which is not 0 — an unvalued credit is a different thing from a
 * worthless one, and the policy treats the two differently.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {number} [now]
 * @returns {number|null}
 */
export function creditValueWeeks(account, now = Date.now()) {
  const days = daysToReset(account, now);
  return days == null ? null : Math.min(1, days / 7);
}

/**
 * Why the minimum-days rule stops this account, or null when it does not.
 *
 * With the floor off (0) nothing is ever stopped here, so a fleet that never
 * set the key keeps spending exactly as before. With it on, an account whose
 * reset is unknown is stopped too: the rule exists to keep a credit from being
 * spent for a fraction of a week, and a credit that cannot be valued cannot be
 * shown to clear the floor.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {number} minDaysToReset
 * @param {number} [now]
 * @returns {string|null}
 */
export function minDaysReason(account, minDaysToReset, now = Date.now()) {
  if (!(minDaysToReset > 0)) return null;
  const days = daysToReset(account, now);
  if (days == null) return `weekly reset time is unknown, so the credit cannot be valued against the ${formatDays(minDaysToReset)} minimum`;
  if (days >= minDaysToReset) return null;
  const value = Math.min(1, days / 7);
  return `natural weekly reset is ${formatDays(days)} away, under the ${formatDays(minDaysToReset)} minimum (the credit would buy ${value.toFixed(2)} of a week)`;
}

/**
 * The reset cohort this account belongs to: the 24-hour bucket its natural
 * weekly reset falls in. Accounts in one cohort come back together, so they
 * are the ones a share cap keeps apart. Null when the reset is unknown.
 *
 * @param {Record<string, any>|null|undefined} account
 * @returns {number|null}
 */
export function resetCohort(account) {
  const resetAt = account?.quota?.unified7dReset;
  return Number.isFinite(resetAt) ? Math.floor(resetAt / DAY_MS) : null;
}

/**
 * Whether this account is one the auto-redeem policy may ever spend on: a
 * Codex account on an armed fleet that has not opted out. The cohort is
 * counted over these, not over every Codex row — an account that can never
 * redeem is not one the cap needs to hold back.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {boolean} autoRedeemResets
 */
export function autoRedeemArmed(account, autoRedeemResets) {
  return !!account && autoRedeemResets === true && providerOf(account) === 'codex' && account.autoRedeemReset !== false;
}

/**
 * The records still inside the window the caps reason over. A cohort is a
 * fact about one week — after that every member has reset on its own and the
 * phase the redemption moved is gone — so nothing older is counted anywhere.
 *
 * @param {RedeemRecord[]} ledger
 * @param {number} now
 */
export function recentRedemptions(ledger, now) {
  return (ledger || []).filter(r => r && now - r.at < WEEK_MS);
}

/** @param {RedeemRecord[]} ledger @param {number} now */
export function redeemedLast24h(ledger, now) {
  return recentRedemptions(ledger, now).filter(r => now - r.at < DAY_MS).length;
}

/**
 * Whether the per-day cap allows one more automatic redemption.
 *
 * @param {RedeemRecord[]} ledger
 * @param {number} maxPerDay
 * @param {number} now
 * @returns {{ok: boolean, reason: string|null, redeemedLast24h: number}}
 */
export function dailyCapVerdict(ledger, maxPerDay, now) {
  const used = redeemedLast24h(ledger, now);
  if (!(maxPerDay > 0) || used < maxPerDay) return { ok: true, reason: null, redeemedLast24h: used };
  return { ok: false, reason: `the daily cap of ${maxPerDay} auto-redemption${maxPerDay === 1 ? '' : 's'} is reached (${used} in the last 24h)`, redeemedLast24h: used };
}

/**
 * The share cap, for one account against its cohort.
 *
 * The cohort is sized as it WAS before anything was redeemed: its current
 * members plus every account a redemption already moved out of it this week.
 * Sized on the current members alone, each redemption would shrink the cohort
 * and let the next one through — on a cohort of four at a half share, 2 of 4,
 * then 2 of 3, then 1 of 2, then 1 of 1, which is the whole cohort and the
 * sawtooth the cap exists to prevent.
 *
 * `allowed` is the share of that size rounded UP, so a cap never reads as
 * "nobody" on a small cohort: a half share of one account is one account.
 *
 * @param {Object} args
 * @param {Record<string, any>} args.account
 * @param {Record<string, any>[]} args.members  every account the policy may spend on (see autoRedeemArmed), this one included
 * @param {RedeemRecord[]} args.ledger
 * @param {number} args.maxShare
 * @param {number} args.now
 * @returns {{ok: boolean, reason: string|null, cohort: number|null, size: number, allowed: number, used: number}}
 */
export function shareCapVerdict({ account, members, ledger, maxShare, now }) {
  const cohort = resetCohort(account);
  if (!(maxShare > 0 && maxShare < 1) || cohort == null) return { ok: true, reason: null, cohort, size: 0, allowed: 0, used: 0 };
  const moved = recentRedemptions(ledger, now).filter(r => r.cohort === cohort);
  // One account counts once, whichever list it is on: a member that redeemed
  // and (somehow) still states a reset in the same bucket is not two accounts.
  const population = new Set(members.filter(m => resetCohort(m) === cohort));
  for (const r of moved) population.add(/** @type {Record<string, any>} */ (r.account));
  const size = population.size;
  const used = moved.length;
  const allowed = Math.ceil(maxShare * size);
  if (used < allowed) return { ok: true, reason: null, cohort, size, allowed, used };
  const pct = Math.round(maxShare * 100);
  return {
    ok: false,
    cohort, size, allowed, used,
    reason: `its reset cohort of ${size} already had ${used} redeemed, the ${pct}% share cap allows ${allowed}`,
  };
}

/**
 * Most exhausted first — the order a cohort's slots are handed out in, so the
 * account furthest past its window is the one the cap lets through. Ties go
 * to the one whose 5-hour window is also further gone, then to the natural
 * reset that is further away (the credit worth more), then to array order.
 *
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
export function byExhaustion(a, b) {
  const weekly = (b.quota?.unified7d ?? 0) - (a.quota?.unified7d ?? 0);
  if (weekly) return weekly;
  const hourly = (b.quota?.unified5h ?? 0) - (a.quota?.unified5h ?? 0);
  if (hourly) return hourly;
  const reset = (b.quota?.unified7dReset ?? 0) - (a.quota?.unified7dReset ?? 0);
  if (reset) return reset;
  return (a.index ?? 0) - (b.index ?? 0);
}

/**
 * The account's standing under the policy, for the status payload: whether
 * the automatic policy may spend on it at all, why not when it may not, and
 * what a credit spent on it now would buy. `armed` is about the policy and
 * the caps, not about the moment — an armed account whose weekly window is
 * still healthy is armed and simply not exhausted.
 *
 * @param {Object} args
 * @param {Record<string, any>} args.account
 * @param {boolean} args.autoRedeemResets
 * @param {RedeemPolicy} args.policy
 * @param {Record<string, any>[]} args.members  the fleet's armed Codex accounts
 * @param {RedeemRecord[]} args.ledger
 * @param {number} args.now
 * @returns {{armed: boolean, exemptReason: string|null, creditValueWeeks: number|null}}
 */
export function autoRedeemStanding({ account, autoRedeemResets, policy, members, ledger, now }) {
  const creditValue = creditValueWeeks(account, now);
  const value = creditValue == null ? null : Math.round(creditValue * 100) / 100;
  /** @param {string} reason */
  const exempt = reason => ({ armed: false, exemptReason: reason, creditValueWeeks: value });
  if (autoRedeemResets !== true) return exempt('auto-redeem is switched off');
  if (account.autoRedeemReset === false) return exempt('auto-redeem is switched off for this account');
  const floor = minDaysReason(account, policy.minDaysToReset, now);
  if (floor) return exempt(floor);
  const daily = dailyCapVerdict(ledger, policy.maxPerDay, now);
  if (!daily.ok) return exempt(/** @type {string} */ (daily.reason));
  const share = shareCapVerdict({ account, members, ledger, maxShare: policy.maxShare, now });
  if (!share.ok) return exempt(/** @type {string} */ (share.reason));
  return { armed: true, exemptReason: null, creditValueWeeks: value };
}

/** @param {number} days */
function formatDays(days) {
  const rounded = Math.round(days * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}d`;
}

/** A name fit for a log line. @param {Record<string, any>} account */
export function redeemName(account) {
  return safeLine(account?.name, 64);
}
