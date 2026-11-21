// Banked Claude usage-limit resets: read the grants, spend a chosen one by
// hand, or spend one at the pool-dry refusal when the operator has armed
// `autoRedeemResets` — the same switch, moment and per-account exemption as
// the Codex reset credits.
//
// The Codex counterpart is codex-reset-credits.js. Anthropic's version differs
// in ways that matter for a call that cannot be undone:
//
//  - The grants live in the usage payload's `cedar_ember` block, which is only
//    filled in for a caller that asks with `?cedar_ember=1` and identifies as
//    Claude Code; anything else reads `eligible: false, ineligible_reason:
//    "surface"`, a statement about the caller and not the account.
//  - Status-only reads add `&skip_spend=1`, as Claude Code does. Manual claims
//    try a fresh read, but may use a held, unblocked grant from a reading no
//    more than 15 minutes old if that read fails. Upstream validates the claim;
//    a successful fresh read that removes or blocks a grant is authoritative.
//  - Spending names any usable grant; auto-redeem picks the cheapest kind that
//    clears every exhausted limit, then the soonest expiry and `next_grant_id`.
//    "Exhausted" is what upstream reports at its own limit, together with the
//    limits behind the readings on which the proxy parks the account at its
//    weekly switch threshold (#685), which a busy fleet reaches before
//    upstream's limit.
//    The endpoint is organization-scoped
//    (POST /api/organizations/<orgUuid>/reset_rate_limits), and the body is
//    `{ program: "cedar_ember", grant_id, request_id }`.
//  - The verdict is in the body's `result`: `reset` (spent, windows cleared),
//    `already_used` (this request id already went through), `not_limited`,
//    `cooldown`, `ineligible`, `unavailable` (nothing spent). A non-2xx or a
//    lost connection is no verdict at all, over a POST that may have spent the
//    grant — so the request id is kept and replayed, and the fleet holds off.
//
// Shapes read from Claude Code 2.1.290's own client and confirmed against a
// live redemption on 2026-10-10 (`result: "reset"`, `cleared: [five_hour,
// seven_day, seven_day_overage_included]`, `resets_left: 0`).

import { randomUUID } from 'node:crypto';

import { USAGE_URL, OAUTH_USAGE_BETA, USAGE_USER_AGENT, normalizeUsagePayload, isFableReset } from './oauth.js';
import { providerOf, DEFAULT_PROVIDER } from './provider.js';
import { modelFamily } from './model.js';
import { safeLine } from './safe-text.js';
import { rememberResetReading, resetRetryAt } from './reset-readings.js';
import { proxyFetch } from './upstream-fetch.js';

export const CLAUDE_RESET_PROGRAM = 'cedar_ember';
const RESET_HOST = 'https://api.anthropic.com';
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;

// After a spend that worked: long enough that one dry pool costs one reset,
// short enough that a pool dry again tomorrow is asked again.
const SUCCESS_HOLD_MS = 60 * 60 * 1000;
// After a verdict we never read: the grant may be spent, so nothing else is.
const UNKNOWN_HOLD_MS = 30 * 60 * 1000;
// After upstream said "nothing to do here" for this account.
const DECLINED_COOLDOWN_MS = 30 * 60 * 1000;
// After an account turned out to hold nothing usable.
const NOTHING_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const CLAUDE_REDEEM_BUDGET_MS = 15_000;
const BUDGET_LAPSED = Symbol('redeem budget lapsed');

// The upstream limit behind each quota reading, in the names a grant's `clears`
// uses, where a live redemption has shown it: #677 measured a grant that
// clears `seven_day_overage_included` taking the Fable weekly from 100% to 0
// while `seven_day` was not cleared. A reading with no entry here (the Sonnet
// weekly, a learned scoped bucket) has no established name, so no grant can be
// shown to clear it and none is spent for it.
/** @type {Record<string, string>} */
const LIMIT_FOR_BUCKET = { unified5h: 'five_hour', unified7d: 'seven_day', unified7dFable: 'seven_day_overage_included' };

/** @param {Record<string, any>} account */
function headers(account) {
  return {
    Authorization: `Bearer ${account.credential}`,
    'anthropic-beta': OAUTH_USAGE_BETA,
    'User-Agent': USAGE_USER_AGENT,
    Accept: 'application/json',
  };
}

/** @param {unknown} v */
const isoMs = v => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** @param {unknown} v */
const names = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64) : []);

/** @param {unknown} value */
function percentUsed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, n]) => key.length <= 64 && Number.isInteger(n) && n >= 0 && n <= 100));
}

/**
 * @param {{ clears?: unknown, type?: unknown }} grant
 * @returns {'fable'|'weekly'|'session'}
 */
export function claudeGrantKind(grant) {
  if (isFableReset(grant?.clears)) return 'fable';
  return grant?.type === 'session' ? 'session' : 'weekly';
}

/**
 * The `cedar_ember` block as the redeemer reasons about it, or null when the
 * payload says nothing usable. Unlike oauth.js's `bankedResets`, this keeps the
 * grant ids: it exists to spend one.
 *
 * @param {any} block
 */
export function parseResetStatus(block) {
  if (!block || typeof block !== 'object' || typeof block.eligible !== 'boolean') return null;
  const grants = (Array.isArray(block.grants) ? block.grants : []).flatMap((/** @type {any} */ g) => {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GRANT_ID.test(g.id)) return [];
    const left = Number(g.resets_left);
    return [{
      id: g.id,
      label: typeof g.label === 'string' ? safeLine(g.label, 64) : null,
      resetsLeft: Number.isInteger(left) && left > 0 ? left : 0,
      resetsTotal: Number.isInteger(g.resets_total) && g.resets_total >= 0 ? g.resets_total : null,
      clears: names(g.clears),
      usableNow: g.usable_now === true,
      paused: g.paused === true,
      startsAt: isoMs(g.starts_at),
      endsAt: isoMs(g.ends_at),
      type: ['session', 'weekly', 'full'].includes(g.type) ? g.type : null,
      givesBackWeekly: g.gives_back_weekly === true,
      useRequiresLimit: typeof g.use_requires_limit === 'boolean' ? g.use_requires_limit : null,
      percentUsed: percentUsed(g.percent_used),
      blocking: names(g.blocking),
      unavailableReason: typeof g.unavailable_reason === 'string' ? safeLine(g.unavailable_reason, 32) : null,
    }];
  });
  const next = typeof block.next_grant_id === 'string' && grants.some((/** @type {{ id: string }} */ g) => g.id === block.next_grant_id) ? block.next_grant_id : null;
  return {
    eligible: block.eligible,
    ineligibleReason: typeof block.ineligible_reason === 'string' ? safeLine(block.ineligible_reason, 32) : null,
    atLimit: block.at_limit === true,
    exhausted: names(block.exhausted),
    nextGrantId: next,
    cooldownUntil: isoMs(block.cooldown_until),
    weeklyResetsAt: isoMs(block.weekly_resets_at),
    grants,
  };
}

/** @typedef {NonNullable<ReturnType<typeof parseResetStatus>>} ResetStatus */
/** @typedef {ResetStatus['grants'][number]} ResetGrant */

/**
 * @param {ResetGrant} grant
 * @param {number} now
 */
function usableGrant(grant, now) {
  return grant.resetsLeft >= 1 && grant.usableNow && !grant.paused
    && (grant.endsAt == null || grant.endsAt > now);
}

/**
 * The cheapest usable grant that clears every exhausted limit. Keep broader
 * resets for walls that need them; within a kind, spend the soonest expiry
 * (no expiry last), then prefer upstream's `next_grant_id`.
 *
 * @param {ResetStatus|null} status
 * @param {number} [now]
 */
export function chooseAutoGrant(status, now = Date.now()) {
  if (!status?.eligible) return null;
  const cost = { fable: 0, session: 1, weekly: 2 };
  return status.grants
    .filter((/** @type {ResetGrant} */ grant) => usableGrant(grant, now) && status.exhausted.every((/** @type {string} */ limit) => grant.clears.includes(limit)))
    .sort((/** @type {ResetGrant} */ a, /** @type {ResetGrant} */ b) => cost[claudeGrantKind(a)] - cost[claudeGrantKind(b)]
      || (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity)
      || Number(b.id === status.nextGrantId) - Number(a.id === status.nextGrantId))[0] ?? null;
}

/**
 * Read one account's reset status and quota, without spend. Claude Code uses
 * `skip_spend=1` for these reads. Its payload may omit any spend/extra-usage
 * fields, so never apply its spend portion, even when it returns a partial one.
 * The full quota probe remains the authority on paid-overage readings.
 *
 * @param {Record<string, any>} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function fetchClaudeResetStatus(account, { fetchImpl = proxyFetch, timeoutMs = 10_000 } = {}) {
  if (!account?.credential) return { error: 'no credential' };
  try {
    const res = await fetchImpl(`${USAGE_URL}&skip_spend=1`, { headers: headers(account), signal: AbortSignal.timeout(timeoutMs), routing: account.routing ?? null });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, retryAt: resetRetryAt(res) };
    const data = await res.json();
    return { reset: parseResetStatus(data?.cedar_ember), usage: { ...normalizeUsagePayload(data), spend: null } };
  } catch (/** @type {any} */ err) {
    return { error: safeLine(err?.message || String(err), 120), status: null };
  }
}

/**
 * Spend one grant. The single irreversible call in this file. `requestId` must
 * be replayed after an unread answer, never re-minted.
 *
 * @param {Record<string, any>} account
 * @param {{ grantId: string, requestId: string }} claim
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function claimClaudeReset(account, { grantId, requestId }, { fetchImpl = proxyFetch, timeoutMs = 20_000 } = {}) {
  if (!account?.credential || !account?.orgUuid) return { error: 'missing Claude account identity' };
  if (!GRANT_ID.test(grantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return { error: 'malformed grant or request id' };
  try {
    const res = await fetchImpl(`${RESET_HOST}/api/organizations/${encodeURIComponent(account.orgUuid)}/reset_rate_limits`, {
      method: 'POST',
      headers: { ...headers(account), 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: CLAUDE_RESET_PROGRAM, grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(timeoutMs),
      routing: account.routing ?? null,
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    const result = typeof data?.result === 'string' ? safeLine(data.result, 32) : null;
    const left = Number(data?.resets_left);
    return {
      result,
      reason: typeof data?.reason === 'string' ? safeLine(data.reason, 32) : null,
      resetsLeft: Number.isInteger(left) ? left : null,
      cleared: names(data?.cleared),
      cooldownUntil: isoMs(data?.cooldown_until),
      weeklyResetsAt: isoMs(data?.weekly_resets_at),
    };
  } catch (/** @type {any} */ err) {
    return { error: safeLine(err?.message || String(err), 120), status: null };
  }
}

/**
 * When this account would come back on its own: the latest reset among the
 * windows it has spent. The pool-dry walk spends on the account that would wait
 * longest, since a reset there buys the most.
 *
 * A window counts as spent at `spentAt(bucket)`: upstream's own limit unless
 * the caller says otherwise, and never where the caller answers Infinity. The
 * walk passes the thresholds selection holds the refused request's model to,
 * since a fleet parks at those and not at 1, and leaves out the windows that
 * do not bar that model.
 *
 * @param {Record<string, any>} account
 * @param {number} now
 * @param {(bucket: string) => number} [spentAt]
 */
export function blockedUntil(account, now = Date.now(), spentAt = () => 1) {
  const q = account?.quota || {};
  let until = 0;
  for (const [use, reset] of [['unified5h', 'unified5hReset'], ['unified7d', 'unified7dReset'], ['unified7dFable', 'unified7dFableReset'], ['unified7dSonnet', 'unified7dSonnetReset']]) {
    if (q[use] != null && q[use] >= spentAt(use) && q[reset] > now) until = Math.max(until, q[reset]);
  }
  return until;
}

/** @typedef {{ redeemed: boolean, reason: string, uncertain?: boolean, available?: boolean, account?: string, result?: string|null, resetsLeft?: number|null, cleared?: string[] }} ClaudeRedeemResult */

export class ClaudeResetRedeemer {
  /**
   * @param {any} accountManager
   * @param {{ config?: Record<string, any>|null, statusFn?: Function, claimFn?: Function, now?: () => number, log?: Function, timeoutMs?: number }} [opts]
   */
  constructor(accountManager, { config = null, statusFn = fetchClaudeResetStatus, claimFn = claimClaudeReset, now = Date.now, log = console.log, timeoutMs = CLAUDE_REDEEM_BUDGET_MS } = {}) {
    this.am = accountManager;
    this.config = config;
    this.statusFn = statusFn;
    this.claimFn = claimFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    // `declined` holds the passes that depend on the refused request's model,
    // by _modelKey: when the account may be asked again for such a request.
    /** @type {WeakMap<object, { cooldownUntil: number, declined: Map<string, number>, requestIds: Map<string, string> }>} */
    this.state = new WeakMap();
    /** @type {Promise<ClaudeRedeemResult>|null} */
    this.inFlight = null;
    /** @type {string|null} the model the attempt in flight was made for */
    this.inFlightModel = null;
    /** @type {string|null} */
    this.inFlightKey = null;
    // The account an attempt's answer is about, when it is about one (a reset
    // that landed, or `available`); see maybeRedeemForPool.
    /** @type {WeakMap<object, Record<string, any>>} */
    this.answeredFor = new WeakMap();
    // reset-actions holds this across the fresh read and the manual claim.
    this.manualInFlight = false;
    /** @type {number|null} */
    this.fleetHoldStartedAt = null;
    // The latest fleet hold this process armed (see fleetHoldUntil).
    this.heldUntil = 0;
  }

  /**
   * The fleet hold: armed by a reset that landed or may have, it stops the next
   * refusal — and the rest of this one's walk — spending a sibling's reset on
   * top of it. Kept on the accounts' saved quota (`claudeResetHoldUntil`), so a
   * restart minutes after a claim that may have landed does not spend another;
   * the latest any account carries holds them all. The latest this process
   * armed counts as well, because an account removed while its claim was in
   * flight takes its saved hold out of the fleet.
   */
  get fleetHoldUntil() {
    let until = this.heldUntil;
    for (const account of this.am.accounts || []) {
      const held = account.quota?.claudeResetHoldUntil;
      if (Number.isFinite(held)) until = Math.max(until, held);
    }
    return until;
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} until
   */
  _holdFleet(account, until) {
    account.quota ??= {};
    const held = account.quota.claudeResetHoldUntil;
    if (!Number.isFinite(held) || until >= held) this.fleetHoldStartedAt = this.now();
    account.quota.claudeResetHoldUntil = Number.isFinite(held) ? Math.max(held, until) : until;
    this.heldUntil = Math.max(this.heldUntil, until);
  }

  /** Every status read, including auto-redeem and post-claim quota reapply.
   * @param {Record<string, any>} account
   * @param {{ timeoutMs?: number }} [opts]
   */
  async readStatus(account, opts = {}) {
    let read;
    try { read = await this.statusFn(account, opts); } catch (/** @type {any} */ error) {
      read = { error: error?.message || String(error) };
    }
    rememberResetReading(account, 'claude', read, this.now());
    return read;
  }

  /** @param {object} account */
  _stateFor(account) {
    let s = this.state.get(account);
    if (!s) { s = { cooldownUntil: 0, declined: new Map(), requestIds: new Map() }; this.state.set(account, s); }
    return s;
  }

  /**
   * What the parked verdict reads off a refused request's model: the weekly
   * bucket that governs it (a route may name its own), and its family only
   * where that bucket is the shared weekly and some account has learned a
   * scoped bucket for the family, the one way a family gates beside it.
   * Whether an account is parked for one such request says nothing about a
   * request with another key, so the passes that turn on it are kept by this
   * key, and an attempt in flight is matched on it as a refusal joins and
   * again once the attempt has run. Bounded, unlike the model name a client
   * sends.
   *
   * @param {string|null} model
   */
  _modelKey(model) {
    const bucket = this.am._weeklyBucketFor?.(model) ?? '';
    const family = modelFamily(model);
    const scoped = bucket === 'unified7d' && family !== 'other'
      && (this.am.accounts || []).some((/** @type {Record<string, any>} */ a) => a.quota?.scopedWeekly?.[family]);
    return scoped ? `${bucket}:${family}` : bucket;
  }

  /**
   * Refresh the account's token, never waiting longer for it than the attempt
   * has left. `ensureTokenFresh` takes no timeout and joins any refresh
   * already running, so awaited plainly it is unbounded, and a refusal waiting
   * on this attempt (another key's, or the same) would be held as long; it is
   * raced instead, as the Codex redeemer's `_freshToken` does. A refresh that
   * lands late carries on in the background, and this attempt does not act on
   * it.
   *
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @returns {Promise<string|null>} why the attempt cannot go on, or null
   */
  async _freshToken(account, deadline) {
    const left = deadline - this.now();
    if (left <= 0) return 'ran out of the redeem budget';
    /** @type {any} */
    let timer = null;
    const lapsed = new Promise(resolve => { timer = setTimeout(() => resolve(BUDGET_LAPSED), left); });
    try {
      // Wrapped so a synchronous throw arrives as a rejection, and settled both
      // ways so losing the race cannot leave one unhandled.
      const refreshed = (async () => this.am.ensureTokenFresh(account.index))()
        .then(() => null, (/** @type {any} */ err) => err ?? new Error('token refresh failed'));
      const outcome = await Promise.race([refreshed, lapsed]);
      if (outcome === BUDGET_LAPSED) return 'ran out of the redeem budget refreshing the token';
      if (outcome) return `token refresh failed (${safeLine(outcome.message || String(outcome), 80)})`;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {Record<string, any>} account */
  _isClaude(account) {
    return !!account && providerOf(account) === DEFAULT_PROVIDER && !account.upstream && account.type === 'oauth';
  }

  /**
   * The pool-dry entry point: every Claude account this request could use is
   * out, so maybe spend ONE reset on one of `accounts`. Armed by the same fleet
   * switch as the Codex redeemer (`autoRedeemResets`), read off the shared
   * config per refusal so a toggle applies at once.
   *
   * `model` is the refused request's: it decides which weekly bucket governs,
   * and so whether the switch threshold is what parked an account.
   *
   * @param {Record<string, any>[]} accounts
   * @param {{ model?: string|null }} [opts]
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async maybeRedeemForPool(accounts, { model = null } = {}) {
    if (this.config?.autoRedeemResets !== true) return { redeemed: false, reason: 'auto-redeem is switched off' };
    if (!accounts?.length) return { redeemed: false, reason: 'no candidate accounts' };
    if (this.manualInFlight) return { redeemed: false, reason: 'a manual reset is in progress' };
    if (this.inFlight) {
      // Concurrent refusals with the same key are one decision about the
      // fleet, so they share one attempt. This refusal's key has to match the
      // one the attempt started with, and the two have to match again once it
      // has run: its reads can teach the fleet the scoped bucket that sets two
      // models apart, and one that runs out or is dropped while it walks can
      // make alike two keys its passes kept apart. Only a bucket learned while
      // the attempt runs and gone again before it ends (run out and swept, or
      // dropped by a later read) is missed. A refusal with another key waits
      // for it instead: that attempt judged other readings, and its passes say
      // nothing about this one. Attempts still never overlap, so one dry pool
      // costs one reset; a reset that landed answers this refusal too. An
      // answer about one account (a reset that landed, or `available`) serves
      // only a refusal that was offered that account, though: the offer
      // follows the request's route and the key does not. Any other refusal
      // makes its own attempt.
      const joined = this.inFlightModel; // the attempt clears it as it ends
      const keyedAlike = this.inFlightKey === this._modelKey(model);
      const earlier = await this.inFlight;
      const sameKey = keyedAlike && this._modelKey(joined) === this._modelKey(model);
      const about = this.answeredFor.get(earlier);
      const offered = about != null && accounts.includes(about);
      if (sameKey ? (!about || offered) : (earlier.redeemed && offered)) return earlier;
      return this.maybeRedeemForPool(accounts, { model });
    }
    const key = this._modelKey(model);
    const attempt = this._attempt(accounts, model).finally(() => { this.inFlight = null; this.inFlightModel = null; this.inFlightKey = null; });
    this.inFlight = attempt;
    this.inFlightModel = model;
    this.inFlightKey = key;
    return attempt;
  }

  /**
   * @param {Record<string, any>[]} accounts
   * @param {string|null} model
   */
  async _attempt(accounts, model) {
    const now = this.now();
    if (now < this.fleetHoldUntil) return { redeemed: false, reason: 'holding off after a recent Claude reset attempt' };
    // An account another attempt has just re-read (one this refusal waited on)
    // may serve this request now: the pool is not dry, so nothing is spent and
    // the server selects again.
    const serving = accounts.find(a => this.am.unavailableReason?.(a, model) === null);
    if (serving) {
      const r = { redeemed: false, available: true, account: safeLine(serving.name, 64), reason: 'an account can serve the request after all' };
      this.answeredFor.set(r, serving);
      return r;
    }
    const deadline = now + this.timeoutMs;
    const key = this._modelKey(model);
    // Ranked on the readings that bar this account for the refused model, each
    // against the threshold selection holds it to (the account's own, the
    // bucket's or the fleet's): the 5-hour window against its own, the shared
    // weekly and the model's family bucket against the governing bucket's, as
    // _nearQuotaBucket compares them. Another family's window does not bar the
    // model, so it does not count. A fleet parked below upstream's limit is
    // then ranked on its readings rather than left in config order. With no
    // model, every window counts against its own bucket's threshold.
    const governing = model ? this.am._weeklyBucketFor?.(model) ?? 'unified7d' : null;
    const until = (/** @type {Record<string, any>} */ a) => blockedUntil(a, now, bucket => {
      const at = (/** @type {string} */ b) => this.am.thresholdFor?.(b, a) ?? 1;
      if (bucket === 'unified5h' || !governing) return at(bucket);
      return bucket === 'unified7d' || bucket === governing ? at(governing) : Infinity;
    });
    const candidates = accounts
      // Not a cordoned account: a reset there would buy new work it takes none of.
      // Nor a long-lived one (long-lived.js): its token cannot read reset status
      // or claim, and a scope denial on the claim would read as "may have been
      // spent" and hold the resets of every other account.
      .filter(a => this._isClaude(a) && a.orgUuid && !a.disabled && !a.cordoned && a.autoRedeemReset !== false && a.longLived !== true)
      .filter(a => a.quota?.resetCredits?.available !== 0)
      .filter(a => now >= this._stateFor(a).cooldownUntil && now >= (this._stateFor(a).declined.get(key) ?? 0))
      .sort((a, b) => until(b) - until(a));
    let reason = 'no Claude account holds a usable reset';
    for (const account of candidates) {
      if (this.now() >= deadline) { reason = 'ran out of the redeem budget'; break; }
      const r = await this._redeem(account, deadline, model);
      if (r.redeemed || r.available) { this.answeredFor.set(r, account); return r; }
      reason = r.reason;
      if (this.now() < this.fleetHoldUntil) break;
    }
    return { redeemed: false, reason };
  }

  /**
   * Pass over an account that holds a usable reset, and say so. The cooldown
   * set here is also what rate-limits the line: the walk skips the account
   * until it ends, so a dry pool being polled logs one line per account per
   * cooldown, not one per refusal. A pass that turns on the refused request's
   * model is kept under its `key` (_modelKey), and skips the account only for
   * requests with the same one.
   *
   * @param {Record<string, any>} account
   * @param {number} until  when this account may be asked again
   * @param {string} reason
   * @param {string|null} [key]
   * @returns {ClaudeRedeemResult}
   */
  _decline(account, until, reason, key = null) {
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    if (key == null) state.cooldownUntil = until;
    else state.declined.set(key, until);
    this.log(`[TeamClaude] Account "${name}": banked reset not redeemed: ${safeLine(reason, 160)}`);
    return { redeemed: false, account: name, reason };
  }

  /**
   * The upstream limits a reset must clear on an account the proxy itself holds
   * out of rotation at its weekly switch threshold, though upstream does not
   * report it at a weekly limit. The manager decides whether it is parked and by
   * which readings, with the thresholds that apply to this account and model. Null
   * when it is not parked on a weekly reading (below its threshold, parked by
   * the 5-hour window alone, or barred for another reason); `unknown` names a
   * parking reading no grant can be shown to clear.
   *
   * @param {Record<string, any>} account
   * @param {string|null} model
   * @returns {{ limits: string[], unknown: string|null }|null}
   */
  _parkedLimits(account, model) {
    /** @type {string[]|null|undefined} */
    const buckets = this.am.weeklyParkedBuckets?.(account, model);
    if (!buckets?.length) return null;
    return {
      limits: buckets.flatMap(b => LIMIT_FOR_BUCKET[b] ?? []),
      unknown: buckets.find(b => !LIMIT_FOR_BUCKET[b]) ?? null,
    };
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @param {string|null} [model]
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async _redeem(account, deadline, model = null) {
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    const now = this.now();
    const refused = await this._freshToken(account, deadline);
    if (refused) return { redeemed: false, account: name, reason: refused };
    const left = () => Math.max(1, deadline - this.now());
    const read = await this.readStatus(account, { timeoutMs: left() });
    if (read?.error) {
      state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `could not read reset status (${read.error})` };
    }
    // The status read carries the account's quota as of now, so the manager
    // judges on that and not on a reading that may have gone stale.
    if (read.usage && !read.usage.error) this.am.applyUsageData?.(account.index, read.usage);
    // The passes below that turn on the model are kept for this key alone. It
    // is taken after the read, which can teach the fleet a scoped bucket that
    // gives the model a key of its own.
    const key = this._modelKey(model);
    // Stale enough that it can serve this request after all: the pool is not
    // dry, so the walk ends without spending and the server selects again.
    if (this.am.unavailableReason?.(account, model) === null) {
      return { redeemed: false, available: true, account: name, reason: 'its fresh quota reading can serve the request' };
    }
    const status = read.reset;
    if (!status || !status.eligible) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `not eligible for resets${status?.ineligibleReason ? ` (${status.ineligibleReason})` : ''}` };
    }
    if (!status.grants.some((/** @type {ResetGrant} */ g) => usableGrant(g, now))) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: 'holds no usable reset' };
    }
    // What the proxy itself holds the account out on for this model, at its
    // weekly switch threshold. A reset that leaves one of those standing does
    // not return the account to service whatever upstream reports, so they
    // are part of the wall on every path, an upstream weekly wall included.
    const parked = this._parkedLimits(account, model);
    if (parked?.unknown) return this._decline(account, now + DECLINED_COOLDOWN_MS, `no reset is known to clear its ${parked.unknown} reading`, key);
    // What a grant has to clear, and the grants that may be spent on it.
    /** @type {ResetStatus} */
    let wall = status;
    const atLimit = status.atLimit && status.exhausted.length > 0;
    // A grant is scarce and a 5-hour wall lifts on its own within hours: spend
    // one only where a weekly limit (the all-models week or a family's,
    // `seven_day*`) is what turns the account away: upstream's, or the
    // proxy's own threshold on a weekly reading.
    if (!atLimit || !status.exhausted.some((/** @type {string} */ limit) => limit.startsWith('seven_day'))) {
      // Upstream reports no weekly wall: no wall at all, or the 5-hour one
      // alone. Selection stops using an account at its switch threshold, so a
      // busy fleet never reaches one: every account parks a little short, and
      // the pool is dry with resets banked (#685). Upstream accepts a claim
      // there, so an account parked by a WEEKLY threshold counts as walled by
      // the limits behind that reading, beside any upstream reports.
      if (!parked) {
        return this._decline(account, now + DECLINED_COOLDOWN_MS, atLimit
          ? 'no weekly limit is exhausted'
          : 'not at a usage limit, nor held out of rotation by its weekly switch threshold', key);
      }
      // Short of any upstream limit, a grant that says it needs one reached
      // would answer `not_limited`.
      const grants = atLimit ? status.grants : status.grants.filter((/** @type {ResetGrant} */ g) => g.useRequiresLimit !== true);
      if (!grants.some((/** @type {ResetGrant} */ g) => usableGrant(g, now))) {
        return this._decline(account, now + DECLINED_COOLDOWN_MS, 'its reset can only be used at the upstream limit');
      }
      wall = { ...status, grants, exhausted: [...new Set([...parked.limits, ...status.exhausted])] };
    } else if (parked) {
      // At upstream's own weekly wall, a park the proxy holds as well (the
      // shared weekly behind a Fable wall) has to be cleared with it.
      wall = { ...status, exhausted: [...new Set([...parked.limits, ...status.exhausted])] };
    }
    // Spent on an account it would not return to service, a reset buys this
    // request nothing — and the grant is gone.
    const grant = chooseAutoGrant(wall, now);
    if (!grant) {
      // No usable grant covers the whole wall. Name the limits none clears,
      // or the whole wall when separate grants only cover parts of it.
      const uncovered = wall.exhausted.filter((/** @type {string} */ limit) => !wall.grants.some((/** @type {ResetGrant} */ g) => usableGrant(g, now) && g.clears.includes(limit)));
      return this._decline(account, now + DECLINED_COOLDOWN_MS, `its reset does not clear ${(uncovered.length ? uncovered : wall.exhausted).join(', ')}`,
        wall === status ? null : key);
    }
    // Upstream already says a claim now would answer `cooldown`: save the POST.
    if (status.cooldownUntil != null && status.cooldownUntil > now) {
      return this._decline(account, status.cooldownUntil, 'upstream reports a reset cooldown');
    }
    // Removed while it was read: no request can be served from it any more.
    if (!this.am.accounts?.includes(account)) return { redeemed: false, account: name, reason: 'account is no longer listed' };
    return this.redeemGrant(account, grant.id, { deadline, kind: claudeGrantKind(grant) });
  }

  /**
   * Shared claim execution. Manual callers validate fresh details, or recent
   * cached details if the fresh Claude read failed, in reset-actions first;
   * auto callers keep all policy checks in _redeem.
   * Unread claims keep a separate replay key for each chosen grant.
   *
   * @param {Record<string, any>} account
   * @param {string} grantId
   * @param {{ manual?: boolean, deadline?: number, kind?: ReturnType<typeof claudeGrantKind> }} [opts]
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async redeemGrant(account, grantId, { manual = false, deadline = this.now() + this.timeoutMs, kind } = {}) {
    if (manual && this.inFlight) return { redeemed: false, reason: 'an automatic reset is in progress' };
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    const now = this.now();
    const requestId = state.requestIds.get(grantId) || randomUUID();
    state.requestIds.set(grantId, requestId);
    const action = manual ? 'Manual Claude reset' : 'Claude reset';
    this.log(manual
      ? `[TeamClaude] Manually redeeming a banked Claude reset on "${name}"`
      : `[TeamClaude] Redeeming a banked Claude ${kind === 'fable' ? 'Fable' : kind ?? 'usage-limit'} reset on "${name}" — no Claude account can serve the request`);
    let r;
    try {
      r = await this.claimFn(account, { grantId, requestId }, { timeoutMs: Math.max(1, deadline - this.now()) });
    } catch (/** @type {any} */ err) {
      r = { error: safeLine(err?.message || String(err), 120) };
    }

    if (r?.error) {
      // No verdict, over a POST that may have spent the grant: keep the key for
      // a replay, and stop anything else spending in the meantime.
      state.cooldownUntil = now + UNKNOWN_HOLD_MS;
      this._holdFleet(account, now + UNKNOWN_HOLD_MS);
      this.log(`[TeamClaude] ${action} on "${name}" got no verdict (${r.error}); it may have been spent, so the fleet holds off`);
      return { redeemed: false, uncertain: true, account: name, reason: `reset request failed (${r.error}); it may still have gone through` };
    }
    state.requestIds.delete(grantId);
    if (r?.result === 'reset' || r?.result === 'already_used') {
      state.cooldownUntil = now + SUCCESS_HOLD_MS;
      this._holdFleet(account, now + SUCCESS_HOLD_MS);
      this.log(`[TeamClaude] ${manual ? 'Manually redeemed' : 'Redeemed'} a Claude usage-limit reset on "${name}" — cleared ${(r.cleared || []).join(', ') || 'its limits'}, ${r.resetsLeft ?? '?'} left`);
      try { await this._reapply(account, deadline); } catch {
        this.log(`[TeamClaude] Could not re-read Claude quota for "${name}" after the reset — it will be re-learned from traffic`);
      }
      return { redeemed: true, account: name, reason: manual ? 'manual redeem' : 'no Claude account could serve the request', result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared };
    }
    state.cooldownUntil = r?.result === 'cooldown' && r.cooldownUntil ? r.cooldownUntil : now + DECLINED_COOLDOWN_MS;
    this.log(`[TeamClaude] ${action} on "${name}" declined upstream (${r?.result || 'no result'}${r?.reason ? `: ${r.reason}` : ''}); nothing was spent`);
    return { redeemed: false, account: name, reason: `upstream declined (${r?.result || 'no result'}${r?.reason ? `: ${r.reason}` : ''})`, result: r?.result };
  }

  /**
   * Put the account back in service: drop any hold and any stored upstream
   * `rejected` verdict (a quota re-read does not touch it, so the account would
   * otherwise read `upstream-rejected` until it went stale), then re-read its
   * quota. Never fabricates a reading; if the read fails, traffic re-learns it.
   *
   * @param {Record<string, any>} account
   * @param {number} deadline
   */
  async _reapply(account, deadline) {
    try { this.am.clearRateLimited(account.index); } catch { /* not held */ }
    try { this.am.clearUpstreamRejected(account.index); } catch { /* not rejected */ }
    const read = await this.readStatus(account, { timeoutMs: Math.max(1, deadline - this.now()) });
    if (read?.usage && !read.usage.error) this.am.applyUsageData(account.index, read.usage);
  }
}
