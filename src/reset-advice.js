// When to spend a banked Claude reset, and on which account: read-only advice
// for whoever spends by hand (the resets routes, a dashboard). It never spends;
// the automatic redeemer keeps its own trigger (a request refused by a dry pool).
//
// A reset is worth what it gives back: the time until the account's own weekly
// reset, scaled by its plan weight. While the pool still serves, waiting costs
// nothing, so the advice is to wait — unless a grant would lapse first.
import { chooseAutoGrant, claudeGrantKind } from './claude-resets.js';

/** How far ahead of a forecast dry spell the advice turns to "spend". */
export const ADVICE_LEAD_MS = 30 * 60_000;
/** An account back on its own sooner than this is not worth a reset. */
export const ADVICE_MIN_GAIN_MS = 30 * 60_000;
/** A grant lapsing within this is spent now where it still buys time. */
export const ADVICE_EXPIRY_MS = 24 * 3600_000;

/**
 * @typedef {Object} AdviceAccount
 * @property {string} name
 * @property {boolean} serving  Rotation can use it now.
 * @property {boolean} spendable  A claim is allowed at all: OAuth Claude, not disabled or cordoned, with an org.
 * @property {number|null} weight  Plan weight (quota-summary.js quotaTier), null when unknown.
 * @property {number|null} weeklyResetAt  From the quota headers.
 * @property {import('./claude-resets.js').ResetStatus|null} reset  The last reset reading.
 */

/**
 * @typedef {Object} AdviceCandidate
 * @property {string} account
 * @property {string} grantId
 * @property {'weekly'|'fable'|'session'} kind
 * @property {number|null} endsAt  When the grant lapses.
 * @property {number} backAt  When the account is back on its own.
 * @property {number} gainMs
 */

/**
 * @typedef {Object} ResetAdvice
 * @property {'spend'|'wait'} action
 * @property {'dry'|'soon-dry'|'expiring'|'headroom'|'no-candidate'} why
 * @property {number|null} dryAt  When no account serves: now, the forecast, or null.
 * @property {number|null} [recheckAt]  When a "wait" would turn into "spend" on the forecast.
 * @property {AdviceCandidate|null} [candidate]  On "wait": the reset a dry spell would take.
 * @property {string} [account]
 * @property {string} [grantId]
 * @property {'weekly'|'fable'|'session'} [kind]
 * @property {number|null} [endsAt]
 * @property {number} [backAt]
 * @property {number} [gainMs]
 */

/**
 * @param {{ accounts: AdviceAccount[], forecast: { allOutAt: number } | null, now?: number }} args
 * @returns {ResetAdvice}
 */
export function adviseResets({ accounts, forecast, now = Date.now() }) {
  /** @type {(AdviceCandidate & { weight: number|null })[]} */
  const candidates = [];
  for (const a of accounts) {
    const status = a.reset;
    if (a.serving || !a.spendable || !status?.eligible) continue;
    if (status.cooldownUntil != null && status.cooldownUntil > now) continue;
    // A reset only brings an account back when a weekly limit is what keeps
    // it out; a five-hour wall lifts on its own within hours.
    if (!status.exhausted.some(limit => limit.startsWith('seven_day'))) continue;
    const grant = chooseAutoGrant(status, now);
    if (!grant) continue;
    const backAt = status.weeklyResetsAt ?? a.weeklyResetAt;
    if (backAt == null || backAt - now < ADVICE_MIN_GAIN_MS) continue;
    candidates.push({ account: a.name, grantId: grant.id, kind: claudeGrantKind(grant), endsAt: grant.endsAt, backAt, gainMs: backAt - now, weight: a.weight });
  }
  const weighted = candidates.every(c => c.weight != null && c.weight > 0);
  /** @param {AdviceCandidate & { weight: number|null }} c */
  const value = c => c.gainMs * (weighted ? /** @type {number} */ (c.weight) : 1);
  candidates.sort((x, y) => value(y) - value(x) || (x.endsAt ?? Infinity) - (y.endsAt ?? Infinity));
  const pick = (/** @type {(AdviceCandidate & { weight: number|null }) | undefined} */ c) => {
    if (!c) return null;
    return { account: c.account, grantId: c.grantId, kind: c.kind, endsAt: c.endsAt, backAt: c.backAt, gainMs: c.gainMs };
  };

  const serving = accounts.some(a => a.serving);
  const dryAt = !serving ? now : Number.isFinite(forecast?.allOutAt) ? /** @type {number} */ (forecast?.allOutAt) : null;
  const best = pick(candidates[0]);
  if (dryAt != null && dryAt - now <= ADVICE_LEAD_MS) {
    return best ? { action: 'spend', why: serving ? 'soon-dry' : 'dry', dryAt, ...best } : { action: 'wait', why: 'no-candidate', dryAt };
  }
  const lapsing = pick(candidates.find(c => c.endsAt != null && c.endsAt - now <= ADVICE_EXPIRY_MS && c.endsAt < c.backAt));
  if (lapsing) return { action: 'spend', why: 'expiring', dryAt, ...lapsing };
  return best
    ? { action: 'wait', why: 'headroom', dryAt, recheckAt: dryAt == null ? null : dryAt - ADVICE_LEAD_MS, candidate: best }
    : { action: 'wait', why: 'no-candidate', dryAt };
}
