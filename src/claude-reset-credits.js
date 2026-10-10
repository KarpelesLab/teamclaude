// Claude banked usage-limit resets.
//
// Anthropic occasionally grants a Claude subscription a banked "usage-limit
// reset" (the `cedar_ember` program, shown as "Resets" on claude.ai): spending
// one refills the account's spent limits ahead of their own reset. Claude Code
// offers it only behind an explicit "Use your reset?" prompt, so a pooled
// account that runs dry sits out the rest of its week with a reset in hand —
// the same gap codex-reset-credits.js closes for Codex, closed the same way.
//
// The isolation is the mirror image of that file's: an Anthropic OAuth
// subscription token is sent to api.anthropic.com and nowhere else, and nothing
// here touches an API key, a third-party backend's key or a Codex token.
//
// The routes are not part of the public API. Everything below is the wire
// format Claude Code itself speaks, and four facts about it shape the code.
//
// First, the status is the usage endpoint the quota probe already reads, asked
// with `cedar_ember=1&skip_spend=1`. The probe keeps only a COUNT of banked
// resets (bankedResets in oauth.js); the grant ids that spend one are read here,
// per attempt, and never stored — not on the quota, not in persisted state, not
// in the status payload.
//
// Second, only the grant the status names as `next_grant_id` is ever claimed,
// and only once that grant's own flags say it can be. Upstream decides the
// order; a client that picks its own grant is guessing.
//
// Third, the claim is answered 200 whether or not it spent anything, with the
// verdict in `result`. Classifying on the status code would read "you are not
// at a limit" as a reset that worked, and a reset that worked is not
// recoverable.
//
// Fourth, a claim whose answer never arrived may have spent a reset. Its
// account may then be refilled where rotation cannot see it, so until a status
// or a replay settles that claim no other account's reset is claimed, and the
// hold survives a restart. The replay reuses the claim's `request_id`, but it
// comes at least half an hour later and Claude Code keeps a key for ten
// minutes, so upstream may no longer tie the two: what keeps the replay from
// spending a second reset is the fresh status in front of it — the grant still
// named next with as many resets left — and the weekly still reading spent.

import { randomUUID } from 'node:crypto';

import { CREDIT_EXPIRY_WINDOW_MS, weeklyExhausted } from './codex-reset-credits.js';
import { fetchUsage, normalizeUsagePayload, oauthUsageHeaders } from './oauth.js';
import { isSubscriptionAccount, providerOf } from './provider.js';
import { safeLine } from './safe-text.js';
import { proxyFetch } from './upstream-fetch.js';

// Provider-neutral: both read the account's parsed quota, not a wire format.
export { weeklyExhausted };

const ANTHROPIC_API = 'https://api.anthropic.com';

/** The anytime status read Claude Code makes: the usage payload plus the `cedar_ember` block. */
export const CLAUDE_RESET_STATUS_URL = `${ANTHROPIC_API}/api/oauth/usage?cedar_ember=1&skip_spend=1`;

/**
 * Where a reset is claimed: org-scoped, so the account's organization id from
 * its profile. Encoded, so a stored id cannot steer the POST off this path.
 *
 * @param {string} orgUuid
 */
export function claudeResetClaimUrl(orgUuid) {
  return `${ANTHROPIC_API}/api/organizations/${encodeURIComponent(orgUuid)}/reset_rate_limits`;
}

const PROGRAM = 'cedar_ember';

// The shapes Claude Code validates before it will act on either. A grant id
// that fails is dropped with its grant, and a request id that fails is never sent.
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The limit types a grant may clear or the status may list as exhausted; any
// other entry is dropped, as Claude Code drops it.
const LIMIT_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet']);

// The claim's `result` values. Anything else reads as `unavailable`, which is
// the conservative reading: "we cannot tell whether that was spent".
const CLAIM_RESULTS = new Set(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']);

// Claude Code's own ceiling on one claim request, used when a caller names none.
const CLAIM_TIMEOUT_MS = 25_000;

// A claim cut off mid-flight may have spent a reset and holds the whole fleet;
// one never started has spent nothing. So the status reads stop short of this
// much of the budget, and the claim is not started with less.
const CLAIM_FLOOR_MS = 10_000;

// How long one status read is trusted. Claude Code re-reads before a claim once
// its reading is older than this, so a grant upstream has moved past is never
// the one claimed.
const STATUS_TTL_MS = 20_000;

// After an attempt that spent nothing, how long before this account may try
// again; an attempt whose verdict we never read holds the whole fleet as long.
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

// After a reset that landed, on the account and the fleet alike. Long on
// purpose: a weekly window that still reads spent afterwards — a re-read that
// failed or had not caught up — must not be answered with a second reset.
const SUCCESS_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// How long a reading showing a sibling at its limit counts as recent: Claude
// Code reuses an answered wall status as long. Shorter than every pool hold, so
// a reading taken before a reset that may have landed is stale once the hold
// lapses.
const LIMIT_READING_TTL_MS = 10 * 60 * 1000;

// Why rotation bars a sibling, sorted by what the bar rests on. These last
// past any reading: an operator's decision, a login needing re-login, a route.
const DURABLE_BARS = new Set(['disabled', 'spend-capped', 'capped', 'error', 'exhausted', 'route']);
// These rest on a reading or a hold, which may be stale; anything else is a
// hold of minutes, which a reset elsewhere is never spent to outlast.
const LIMIT_BARS = new Set(['quota', 'throttled', 'upstream-rejected']);

// The limits a status can list that bar every model's requests.
const SHARED_LIMITS = new Set(['five_hour', 'seven_day']);

// What a refresh that outlived the attempt's budget resolves with; see the
// Codex redeemer, which races its refresh the same way.
const BUDGET_LAPSED = Symbol('redeem budget lapsed');

/** One budget for the whole attempt: Claude Code's own claim timeout is 25 s, and the Claude client waits minutes for a response head. */
export const CLAUDE_REDEEM_BUDGET_MS = 30_000;

/** @typedef {{id: string, resetsLeft: number, usableNow: boolean, paused: boolean, useRequiresLimit: boolean, clears: string[], endsAt: number|null}} CedarGrant */

/** @typedef {{eligible: boolean, ineligibleReason: string|null, grants: CedarGrant[], nextGrantId: string|null, exhausted: string[], cooldownUntil: number|null, weeklyResetsAt: number|null}} CedarBlock */

/** @typedef {{result: string, reason: string|null, resetsLeft: number|null, cleared: string[]}} ClaimVerdict */

/** @typedef {{error: string, status: number|null, unsent?: boolean}} ClaimFailure */

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function limitTypes(raw) {
  return Array.isArray(raw) ? raw.filter(type => typeof type === 'string' && LIMIT_TYPES.has(type)) : [];
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function instant(raw) {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One grant, or null when it is one Claude Code would drop. Every flag falls
 * back to the default that spends nothing: a grant is not usable, not unpaused
 * and not free of the limit requirement unless the payload says so in a boolean.
 *
 * @param {any} raw
 * @returns {CedarGrant|null}
 */
function cedarGrant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !GRANT_ID.test(raw.id)) return null;
  if (!Number.isInteger(raw.resets_left) || raw.resets_left < 0) return null;
  return {
    id: raw.id,
    resetsLeft: raw.resets_left,
    usableNow: raw.usable_now === true,
    paused: raw.paused === true,
    useRequiresLimit: raw.use_requires_limit !== false,
    clears: limitTypes(raw.clears),
    endsAt: instant(raw.ends_at),
  };
}

/**
 * The `cedar_ember` block, validated the way Claude Code validates it, or null
 * when it lacks the one field everything else depends on.
 *
 * A block that does not list `exhausted` lists nothing as spent, as Claude Code
 * reads it (`exhausted ?? []`).
 *
 * @param {any} raw  the usage payload's `cedar_ember` object
 * @returns {CedarBlock|null}
 */
export function parseCedarEmber(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.eligible !== 'boolean') return null;
  /** @type {CedarGrant[]} */
  const grants = Array.isArray(raw.grants) ? raw.grants.flatMap((/** @type {any} */ g) => cedarGrant(g) ?? []) : [];
  const next = raw.next_grant_id;
  return {
    eligible: raw.eligible,
    ineligibleReason: typeof raw.ineligible_reason === 'string' ? safeLine(raw.ineligible_reason, 64) : null,
    grants,
    // Only a grant that survived validation can be next: a handle to a grant we
    // dropped is a handle to something we know nothing about.
    nextGrantId: typeof next === 'string' && grants.some(g => g.id === next) ? next : null,
    exhausted: limitTypes(raw.exhausted),
    cooldownUntil: instant(raw.cooldown_until),
    weeklyResetsAt: instant(raw.weekly_resets_at),
  };
}

/**
 * @param {any} res
 * @returns {Promise<unknown>}
 */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The account's banked-reset status, read fresh. A payload with no block is a
 * read with nothing in it; a failed read is an error, never "no reset".
 *
 * The payload is also a usage reading, returned as the probe maps it: the grant
 * ids reduced to its count, and no spend block, which `skip_spend=1` asked
 * upstream to leave out, so a partial one here says nothing about the wallet.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 * @returns {Promise<{block: CedarBlock|null, usage: Record<string, any>} | {error: string, status: number|null}>}
 */
export async function fetchClaudeResetStatus(account, { fetchImpl = proxyFetch, timeoutMs = CLAUDE_REDEEM_BUDGET_MS, url = CLAUDE_RESET_STATUS_URL } = {}) {
  if (!account?.credential) return { error: 'missing Claude credential', status: null };
  try {
    const res = await fetchImpl(url, {
      // The probe's headers exactly: the block is gated on the User-Agent.
      headers: oauthUsageHeaders(account.credential),
      routing: account.routing ?? null,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = /** @type {any} */ (await readJson(res));
    if (!data || typeof data !== 'object') return { error: 'unreadable usage status', status: null };
    return { block: parseCedarEmber(data.cedar_ember), usage: { ...normalizeUsagePayload(data), spend: null } };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * Claim one reset. The single irreversible call in this file.
 *
 * `requestId` is the idempotency key. A caller replaying a claim whose answer
 * never arrived sends that claim's key rather than minting one; upstream ties
 * the two only while it still holds the key (Claude Code keeps one ten minutes).
 *
 * A claim that cannot be well-formed is not sent at all and says so (`unsent`),
 * so it can never be mistaken for one that may have spent something.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ grantId: string, requestId: string }} attempt
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<ClaimVerdict | ClaimFailure>}
 */
export async function claimClaudeReset(account, { grantId, requestId }, { fetchImpl = proxyFetch, timeoutMs = CLAIM_TIMEOUT_MS } = {}) {
  if (!account?.credential) return { error: 'missing Claude credential', status: null, unsent: true };
  if (!account.orgUuid) return { error: 'no organization id to claim against', status: null, unsent: true };
  if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) return { error: 'malformed grant id', status: null, unsent: true };
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return { error: 'malformed request id', status: null, unsent: true };
  try {
    const res = await fetchImpl(claudeResetClaimUrl(account.orgUuid), {
      method: 'POST',
      headers: { ...oauthUsageHeaders(account.credential), 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: PROGRAM, grant_id: grantId, request_id: requestId }),
      routing: account.routing ?? null,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The verdict is in the body; a non-2xx means only that none was reached.
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = /** @type {any} */ (await readJson(res));
    if (!data || typeof data !== 'object') return { error: 'unreadable claim answer', status: null };
    return {
      result: CLAIM_RESULTS.has(data.result) ? data.result : 'unavailable',
      reason: typeof data.reason === 'string' ? safeLine(data.reason, 64) : null,
      resetsLeft: Number.isInteger(data.resets_left) && data.resets_left >= 0 ? data.resets_left : null,
      cleared: limitTypes(data.cleared),
    };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * What a claim's answer means for what we hold.
 *
 *  - `spent`: a reset landed, this claim's or — on a replay — the earlier one's.
 *  - `declined`: upstream answered and nothing was spent by us.
 *  - `refused`: upstream turned the request away before acting on it (429, an
 *    auth failure), or it was never sent. Nothing was spent.
 *  - `unknown`: it may have been spent. A dropped connection, a timeout, a 5xx,
 *    an unreadable body or `unavailable` are all a verdict we never read.
 *
 * `replay` is whether this claim retries an unconfirmed one on the same grant,
 * which is what turns `already_used` into the grant spent — most likely by
 * that claim — and `cooldown` into that claim perhaps still going through.
 *
 * @param {ClaimVerdict|ClaimFailure|null|undefined} answer
 * @param {boolean} replay
 * @returns {'spent'|'declined'|'refused'|'unknown'}
 */
export function claimOutcome(answer, replay) {
  if (!answer) return 'unknown';
  if ('error' in answer) {
    if (answer.unsent) return 'refused';
    return answer.status === 429 || answer.status === 401 || answer.status === 403 ? 'refused' : 'unknown';
  }
  switch (answer.result) {
    case 'reset': return 'spent';
    case 'already_used': return replay ? 'spent' : 'declined';
    case 'cooldown': return replay ? 'unknown' : 'declined';
    case 'not_limited':
    case 'ineligible': return 'declined';
    default: return 'unknown';
  }
}

/**
 * An Anthropic OAuth subscription login on Anthropic's own endpoint: the only
 * credential the status read and the claim are ever sent with.
 *
 * @param {Record<string, any>} account
 */
function isClaudeSubscription(account) {
  return providerOf(account) === 'anthropic' && isSubscriptionAccount(account) && !!account.credential && !account.upstream;
}

/**
 * The checks that need no network, shared by the policy and by the redeemer
 * deciding whether to read the status at all.
 *
 * `autoRedeemResets` is the FLEET switch, the same one that arms the Codex
 * redeemer, and it defaults to false here too; an account's own
 * `autoRedeemReset` can only veto.
 *
 * @param {{account: Record<string, any>, autoRedeemResets?: boolean, now?: number}} args
 * @returns {{ok: boolean, reason: string}}
 */
export function redeemPreconditions({ account, autoRedeemResets = false, now = Date.now() }) {
  if (!account) return { ok: false, reason: 'no account' };
  if (!isClaudeSubscription(account)) return { ok: false, reason: 'not a Claude subscription account' };
  if (autoRedeemResets !== true) return { ok: false, reason: 'auto-redeem is switched off' };
  if (account.autoRedeemReset === false) return { ok: false, reason: 'auto-redeem is switched off for this account' };
  // A local switchThreshold or maxUsage below 1 takes an account out of
  // rotation early, but upstream would answer that account `not_limited` — or,
  // with a grant that needs no limit, spend a reset on headroom it still had.
  if (!weeklyExhausted(account, now)) return { ok: false, reason: 'weekly window is not exhausted' };
  if (!account.orgUuid) return { ok: false, reason: 'no organization id to claim a reset against' };
  return { ok: true, reason: 'weekly window is exhausted' };
}

/**
 * The one grant this status lets us claim, or why there is none. Claude Code's
 * gates, applied to the weekly limit: a 5-hour wall is never what a reset is
 * spent on.
 *
 * @param {CedarBlock|null|undefined} block
 * @param {number} [now]
 * @returns {{grant: CedarGrant|null, reason: string}}
 */
export function redeemableGrant(block, now = Date.now()) {
  if (!block) return { grant: null, reason: 'the usage status has no block of banked resets' };
  if (!block.eligible) return { grant: null, reason: `not eligible for resets (${block.ineligibleReason ?? 'no reason given'})` };
  // Another reset was just started on the account, by us or by someone else.
  if (block.cooldownUntil != null && block.cooldownUntil > now) return { grant: null, reason: 'upstream reports a reset cooldown' };
  // At a wall Claude Code offers nothing for a limit the status does not list:
  // "this limit may have lifted already".
  if (!block.exhausted.includes('seven_day')) {
    return { grant: null, reason: 'upstream does not list the weekly limit as exhausted' };
  }
  const grant = block.nextGrantId ? block.grants.find(g => g.id === block.nextGrantId) ?? null : null;
  if (!grant) return { grant: null, reason: 'no next grant to claim' };
  if (!grant.usableNow) return { grant: null, reason: 'its next reset is not usable yet' };
  if (grant.paused) return { grant: null, reason: 'its next reset is paused' };
  if (grant.resetsLeft < 1) return { grant: null, reason: 'its next grant has none left' };
  if (grant.endsAt != null && grant.endsAt <= now) return { grant: null, reason: 'its next reset has expired' };
  if (!grant.clears.includes('seven_day')) return { grant: null, reason: 'its next reset does not clear the weekly limit' };
  // Claude Code's "early use" gate: a grant upstream would let us spend with no
  // limit hit, while the status lists none of the limits it clears as spent.
  if (!grant.useRequiresLimit && !grant.clears.some(type => block.exhausted.includes(type))) {
    return { grant: null, reason: 'upstream lists no limit this reset clears as spent' };
  }
  return { grant, reason: 'its next reset can be claimed' };
}

/**
 * Soonest-ending first; a grant with no end sorts last, and two of those
 * compare equal rather than as NaN.
 *
 * @param {number|null} a
 * @param {number|null} b
 */
function byEnd(a, b) {
  const left = a ?? Infinity;
  const right = b ?? Infinity;
  return left === right ? 0 : left - right;
}

/**
 * The accounts worth asking, best first, out of a set whose status is in hand:
 * those offering nothing drop out, and the rest are ordered by the grant each
 * would spend, so the reset that would lapse first is the one used.
 *
 * @param {Array<{account: Record<string, any>, block: CedarBlock|null}>} [candidates]
 * @param {number} [now]
 * @returns {Array<{account: Record<string, any>, grant: CedarGrant}>}
 */
export function orderRedeemCandidates(candidates = [], now = Date.now()) {
  return candidates
    .flatMap(candidate => {
      const { grant } = redeemableGrant(candidate.block, now);
      return grant ? [{ account: candidate.account, grant }] : [];
    })
    .sort((a, b) => byEnd(a.grant.endsAt, b.grant.endsAt));
}

/**
 * Whether to claim this account's next reset. Pure, like its Codex twin: every
 * input is a value already gathered, so the whole decision is testable without
 * a request.
 *
 * Beyond the preconditions and the grant's own gates, a claim needs one of two
 * justifications: every other Claude account is out for this request too, or
 * the grant is about to lapse unspent.
 *
 * @param {Object} args
 * @param {Record<string, any>} args.account
 * @param {boolean} [args.autoRedeemResets]  the fleet switch — see redeemPreconditions
 * @param {Array<{name?: string, available: boolean}>} [args.pool]  the OTHER Anthropic accounts, availability resolved for the refused request's model
 * @param {CedarBlock|null} [args.block]  this account's fresh status
 * @param {number} [args.now]
 * @returns {{redeem: boolean, reason: string, grantId: string|null}}
 */
export function shouldRedeemReset({ account, autoRedeemResets = false, pool = [], block = null, now = Date.now() }) {
  const pre = redeemPreconditions({ account, autoRedeemResets, now });
  if (!pre.ok) return { redeem: false, reason: pre.reason, grantId: null };

  const { grant, reason } = redeemableGrant(block, now);
  if (!grant) return { redeem: false, reason, grantId: null };

  if (pool.every(other => !other.available)) {
    return { redeem: true, reason: 'every other Claude account is unavailable', grantId: grant.id };
  }

  if (grant.endsAt != null && grant.endsAt - now <= CREDIT_EXPIRY_WINDOW_MS) {
    const days = Math.max(0, Math.round((grant.endsAt - now) / (24 * 60 * 60 * 1000)));
    return { redeem: true, reason: `reset expires in ~${days}d and this weekly is spent`, grantId: grant.id };
  }

  return { redeem: false, reason: 'another Claude account can still serve', grantId: null };
}

/** @typedef {{redeemed: boolean, reason: string, result?: string}} RedeemResult */

/**
 * A claim whose verdict never arrived: its key, for the replay, and what its
 * grant held and when it was first sent, for telling that it has settled.
 *
 * @typedef {{grantId: string, requestId: string, resetsLeft: number, at: number}} UnsettledClaim
 */

/**
 * Per-account transient state. `read` is the last status and when it was taken;
 * `unsettled` is a claim whose verdict never arrived. Neither leaves this object.
 *
 * @typedef {{cooldownUntil: number, read: {block: CedarBlock|null, at: number}|null, unsettled: UnsettledClaim|null}} RedeemState
 */

/**
 * @param {Record<string, any>} account
 * @param {{timeoutMs: number}} opts
 */
function rereadUsage(account, { timeoutMs }) {
  return fetchUsage(account.credential, account.routing ?? null, { timeoutMs });
}

/**
 * Turns the policy into the one action it authorises, with the Codex redeemer's
 * shape: concurrent pool-dry refusals join one attempt, a fleet hold armed by a
 * reset that landed — or may have — is read before anything else, and ONE
 * deadline covers the refresh, the read, the claim and the re-read, with each
 * call given only what is left of it.
 */
export class ClaudeResetRedeemer {
  /**
   * @param {any} accountManager
   * @param {{config?: Record<string, any>|null, statusFn?: Function, claimFn?: Function, usageFn?: Function, now?: () => number, log?: Function, timeoutMs?: number, claimFloorMs?: number, statusTtlMs?: number}} [opts]
   */
  constructor(accountManager, {
    // The SHARED config object, read per refusal, so the fleet switch binds on
    // the next refused request rather than at the next restart.
    config = null,
    statusFn = fetchClaudeResetStatus,
    claimFn = claimClaudeReset,
    usageFn = rereadUsage,
    now = Date.now,
    log = console.log,
    timeoutMs = CLAUDE_REDEEM_BUDGET_MS,
    claimFloorMs = CLAIM_FLOOR_MS,
    statusTtlMs = STATUS_TTL_MS,
  } = {}) {
    this.am = accountManager;
    this.config = config;
    this.statusFn = statusFn;
    this.claimFn = claimFn;
    this.usageFn = usageFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.claimFloorMs = claimFloorMs;
    this.statusTtlMs = statusTtlMs;
    // Keyed by the account object: indices are renumbered and names repeat,
    // while a grant id or an unsettled key belongs to exactly one login.
    /** @type {WeakMap<object, RedeemState>} */
    this.state = new WeakMap();
    /** @type {Promise<RedeemResult>|null} */
    this.inFlight = null;
  }

  /**
   * The pool hold: armed by a reset that landed, may have, or is under way, it
   * stops the next refusal — and the rest of this one's walk — spending a
   * sibling's reset on top of it. Kept on the accounts' saved quota, so it
   * survives a restart; the latest any account carries holds them all.
   */
  get fleetCooldownUntil() {
    let until = 0;
    for (const account of this.am.accounts) {
      const held = account.quota?.claudeResetHoldUntil;
      if (Number.isFinite(held)) until = Math.max(until, held);
    }
    return until;
  }

  /**
   * @param {object} account
   * @returns {RedeemState}
   */
  _stateFor(account) {
    let state = this.state.get(account);
    if (!state) {
      state = { cooldownUntil: 0, read: null, unsettled: null };
      this.state.set(account, state);
    }
    return state;
  }

  /**
   * Claim a reset for ONE of `accounts` — the Claude logins the refused request
   * could have used — if the policy allows it. `model` is the refused
   * request's, so "every other account is out" is asked about that model.
   *
   * @param {Record<string, any>[]} accounts
   * @param {{model?: string|null}} [opts]
   * @returns {Promise<RedeemResult>}
   */
  async maybeRedeemForPool(accounts, { model = null } = {}) {
    if (!accounts?.length) return { redeemed: false, reason: 'no candidate accounts' };
    if (this.inFlight) return this.inFlight;
    const attempt = this._attempt(accounts, model).finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * @param {Record<string, any>[]} accounts
   * @param {string|null} model
   * @returns {Promise<RedeemResult>}
   */
  async _attempt(accounts, model) {
    const now = this.now();
    if (now < this.fleetCooldownUntil) {
      return { redeemed: false, reason: 'the pool is cooling down after a recent reset attempt' };
    }
    const deadline = now + this.timeoutMs;
    this._expireUnsettled(now);

    /** @type {Array<{account: Record<string, any>, block: CedarBlock|null}>} */
    const holders = [];
    // The statuses this walk read: upstream's own word on what each account
    // has spent, ahead of anything stored for it locally.
    /** @type {Map<object, CedarBlock>} */
    const reads = new Map();
    let reason = 'no Claude account holds a reset worth spending';
    for (const account of accounts) {
      const ready = await this._ready(account, this._stateFor(account), now, deadline);
      if (ready.read) reads.set(account, ready.read);
      if (ready.block) holders.push({ account, block: ready.block });
      else reason = ready.reason ?? reason;
      // A status showing an earlier unconfirmed claim settled speaks for the fleet.
      if (this.now() < this.fleetCooldownUntil) return { redeemed: false, reason };
    }

    let order = orderRedeemCandidates(holders, now);
    // A claim still in doubt may have refilled its account where rotation cannot
    // see it, so until it settles the only claim made anywhere is its replay.
    const pending = this._unsettledClaims();
    if (pending.size && order.length) {
      const replays = order.filter(({ account, grant }) => pending.get(account) === grant.id);
      if (!replays.length) {
        for (const held of pending.keys()) this._holdFleet(held, now + RETRY_COOLDOWN_MS);
        return { redeemed: false, reason: 'an unconfirmed reset in the pool may still have gone through' };
      }
      order = replays;
    }

    const blocks = new Map(holders.map(holder => [holder.account, holder.block]));
    for (const { account } of order) {
      const result = await this._decide(account, this._stateFor(account), blocks.get(account) ?? null, model, reads, now, deadline);
      if (result.redeemed) return result;
      reason = result.reason;
      // Nothing after this could start a claim: a fleet hold, or too little budget.
      if (this.now() < this.fleetCooldownUntil || this._timeLeft(deadline) < this.claimFloorMs) break;
    }
    return { redeemed: false, reason };
  }

  /**
   * A claim never confirmed holds the fleet no longer than one that landed.
   * Past that its key is dropped too: a replay that old could be answered for
   * the first claim and read as a reset landing now.
   *
   * @param {number} now
   */
  _expireUnsettled(now) {
    for (const account of this.am.accounts) {
      const state = this.state.get(account);
      if (!state?.unsettled || now - state.unsettled.at < SUCCESS_COOLDOWN_MS) continue;
      state.unsettled = null;
      this.log(`[TeamClaude] An unconfirmed Claude usage-limit reset on "${safeLine(account.name, 64)}" was never settled — no longer holding the pool for it`);
    }
  }

  /**
   * Every account holding an unconfirmed claim, with the grant it was on.
   *
   * @returns {Map<object, string>}
   */
  _unsettledClaims() {
    /** @type {Map<object, string>} */
    const pending = new Map();
    for (const account of this.am.accounts) {
      const unsettled = this.state.get(account)?.unsettled;
      if (unsettled) pending.set(account, unsettled.grantId);
    }
    return pending;
  }

  /**
   * The no-network checks and a fresh status, for one account. Answers with a
   * block that offers a grant, or with why this account is not a candidate,
   * and either way with the status this walk read for it, if any.
   *
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<{block?: CedarBlock, reason?: string, read?: CedarBlock|null}>}
   */
  async _ready(account, state, now, deadline) {
    const autoRedeemResets = this.config?.autoRedeemResets === true;
    const pre = redeemPreconditions({ account, autoRedeemResets, now });
    if (!pre.ok) return { reason: pre.reason };
    if (now < state.cooldownUntil) return { reason: 'cooling down after a recent attempt' };

    // The count the usage probe last saw. Zero is a real zero and costs no
    // request; an absent reading decides nothing — the probe may be off. An
    // account holding an unconfirmed claim is read anyway: only its status
    // can settle that claim.
    if (account.quota?.resetCredits?.available === 0 && !state.unsettled) return { reason: 'holds no reset credits' };

    const read = await this._status(account, state, now, deadline);
    if (read.error !== undefined) {
      state.cooldownUntil = now + RETRY_COOLDOWN_MS;
      return { reason: `could not read the reset status (${read.error})` };
    }
    const block = read.block ?? null;
    const name = safeLine(account.name, 64);
    const cooldownUntil = block?.cooldownUntil ?? null;
    const cooling = cooldownUntil != null && cooldownUntil > now;

    // Claude Code's settlement rule: once a status, eligible or not, stops
    // naming the grant we claimed blind as next, with no cooldown running, that
    // claim was spent or withdrawn. A grant holding several resets stays next
    // after one is spent, so its count dropping since the claim says the same.
    // Either way the next claim waits until the quota has caught up.
    const unsettled = state.unsettled;
    if (unsettled && block && !cooling) {
      const claimed = block.grants.find(g => g.id === unsettled.grantId);
      if (block.nextGrantId !== unsettled.grantId || (claimed && claimed.resetsLeft < unsettled.resetsLeft)) {
        state.unsettled = null;
        state.cooldownUntil = now + RETRY_COOLDOWN_MS;
        this._holdFleet(account, now + RETRY_COOLDOWN_MS);
        this.log(`[TeamClaude] An unconfirmed Claude usage-limit reset on "${name}" is no longer pending — it may have gone through, so the pool holds off`);
        return { reason: 'an earlier unconfirmed reset may have gone through', read: block };
      }
    }

    // A reset under way on this account — ours from before a restart, a
    // person's, another instance's — puts it on its way back into service.
    if (cooling) {
      this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      this.log(`[TeamClaude] A Claude usage-limit reset is under way on "${name}" — it is on its way back, so the pool holds off`);
    }

    const offer = redeemableGrant(block, now);
    if (!offer.grant || !block) {
      // The account's own state, which will say the same in a minute: without a
      // cooldown a dry pool would re-read it every time the cache lapsed. Never
      // past the end of a cooldown upstream reports, though.
      state.cooldownUntil = cooling ? Math.min(now + RETRY_COOLDOWN_MS, cooldownUntil) : now + RETRY_COOLDOWN_MS;
      return { reason: offer.reason, read: block };
    }
    return { block, read: block };
  }

  /**
   * Whether `other`, a sibling of the account being decided, is out for the
   * refused request on evidence a reset may be spent on. Rotation's verdict
   * stands when it is durable; one resting on a reading or a hold stands only
   * while a recent reading backs it, since holds outlive what armed them and
   * nothing here sees a week given back by a reset spent elsewhere. Anything
   * short of that reads as able to serve: in doubt, nothing is spent.
   *
   * @param {Record<string, any>} other
   * @param {string|null} model
   * @param {Map<object, CedarBlock>} reads  the statuses this walk read
   * @param {number} now
   */
  _siblingOut(other, model, reads, now) {
    const bar = this.am.unavailableReason(other, model);
    if (bar === null) return false;
    if (DURABLE_BARS.has(bar)) return true;
    const read = reads.get(other);
    if (read?.exhausted.some(type => SHARED_LIMITS.has(type))) return true;
    // Only a status in the program vouches for an empty list: an ineligible
    // one may leave it out for want of anything to say.
    if (read?.eligible && !read.exhausted.length) return false;
    if (!LIMIT_BARS.has(bar)) return false;
    const seenAt = this.am.limitSeenAt(other, model);
    return seenAt != null && now - seenAt < LIMIT_READING_TTL_MS;
  }

  /**
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {CedarBlock|null} block
   * @param {string|null} model
   * @param {Map<object, CedarBlock>} reads  the statuses this walk read
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<RedeemResult>}
   */
  async _decide(account, state, block, model, reads, now, deadline) {
    const autoRedeemResets = this.config?.autoRedeemResets === true;
    // Rotation's own answer, for the refused request's model, so the two cannot
    // disagree — and an account a first reset returned to service makes every
    // sibling's answer "another account can still serve". Overruled only the
    // safe way: toward "can serve".
    const pool = this.am.accounts
      .filter((/** @type {Record<string, any>} */ other) => other !== account && providerOf(other) === 'anthropic')
      .map((/** @type {Record<string, any>} */ other) => ({
        name: other.name,
        available: !this._siblingOut(other, model, reads, now),
      }));

    const verdict = shouldRedeemReset({ account, autoRedeemResets, pool, block, now });
    const grant = block?.grants.find(g => g.id === verdict.grantId);
    // A policy "no" turns on pool state that can change within the minute, so
    // it arms no cooldown; the status cache bounds what asking again costs.
    if (!verdict.redeem || !grant) return { redeemed: false, reason: verdict.reason };
    return this._claim(account, state, grant, verdict.reason, now, deadline);
  }

  /**
   * @param {number} deadline
   * @returns {number}
   */
  _timeLeft(deadline) {
    return deadline - this.now();
  }

  /**
   * Hold every account off until `until`, for as long as a reset that landed,
   * may have, or is under way on `account` needs to show up in the quota. The
   * hold is written to that account's saved quota, so a restart keeps it.
   *
   * @param {Record<string, any>} account
   * @param {number} until
   */
  _holdFleet(account, until) {
    const held = account.quota.claudeResetHoldUntil;
    account.quota.claudeResetHoldUntil = Number.isFinite(held) ? Math.max(held, until) : until;
  }

  /**
   * Refresh the account's token, never waiting longer than the attempt has
   * left; a refresh that lands late carries on in the background, but this
   * attempt does not proceed on it.
   *
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _freshToken(account, deadline) {
    const left = this._timeLeft(deadline);
    if (left <= 0) return { ok: false, error: 'ran out of the redeem budget before refreshing the token' };
    /** @type {any} */
    let timer = null;
    /** @type {Promise<any>} */
    const lapsed = new Promise(resolve => { timer = setTimeout(() => resolve(BUDGET_LAPSED), left); });
    try {
      const refreshed = (async () => this.am.ensureTokenFresh(account.index))()
        .then(() => null, (/** @type {any} */ err) => err ?? new Error('token refresh failed'));
      const outcome = await Promise.race([refreshed, lapsed]);
      if (outcome === BUDGET_LAPSED) return { ok: false, error: 'ran out of the redeem budget refreshing the token' };
      if (outcome) return { ok: false, error: `token refresh failed (${safeLine(outcome.message || String(outcome), 80)})` };
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The status, from cache while it is fresh enough to claim on. A fresh read
   * is applied to the account's quota as the probe's would be.
   *
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<{block?: CedarBlock|null, error?: string}>}
   */
  async _status(account, state, now, deadline) {
    if (state.read && now - state.read.at < this.statusTtlMs) return { block: state.read.block };
    const fresh = await this._freshToken(account, deadline);
    if (!fresh.ok) return { error: fresh.error ?? 'token refresh failed' };
    const timeoutMs = this._timeLeft(deadline) - this.claimFloorMs;
    if (timeoutMs <= 0) return { error: 'ran out of the redeem budget before reading the reset status' };
    const result = await this.statusFn(account, { timeoutMs });
    if (!result || result.error) return { error: result?.error || 'no answer' };
    // An account whose week came back — a claim of ours that landed unseen, a
    // reset spent in claude.ai — reads available from here on.
    if (result.usage) this.am.applyUsageData(account.index, result.usage);
    /** @type {CedarBlock|null} */
    const block = result.block ?? null;
    // Upstream's "cannot say right now", which Claude Code treats as a failed read.
    if (block && !block.eligible && block.ineligibleReason === 'unavailable') return { error: 'upstream could not report its resets' };
    state.read = { block, at: now };
    return { block };
  }

  /**
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {CedarGrant} grant
   * @param {string} why  the policy's justification, for the log
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<RedeemResult>}
   */
  async _claim(account, state, grant, why, now, deadline) {
    const name = safeLine(account.name, 64);
    const fresh = await this._freshToken(account, deadline);
    const timeoutMs = fresh.ok ? this._timeLeft(deadline) : 0;
    if (timeoutMs < this.claimFloorMs) {
      // Nothing was sent, so no key is minted and only this account waits.
      const reason = fresh.error || 'too little of the redeem budget left to claim';
      state.cooldownUntil = now + RETRY_COOLDOWN_MS;
      this.log(`[TeamClaude] Claude usage-limit reset on "${name}" stopped before claiming — ${reason}`);
      return { redeemed: false, reason };
    }

    // The switches once more, at the last moment: one turned off while the
    // token was refreshed binds this claim, and a replay as much as a first try.
    const pre = redeemPreconditions({ account, autoRedeemResets: this.config?.autoRedeemResets === true, now: this.now() });
    if (!pre.ok) {
      this.log(`[TeamClaude] Claude usage-limit reset on "${name}" stopped before claiming — ${pre.reason}`);
      return { redeemed: false, reason: pre.reason };
    }

    // A claim whose verdict never arrived is retried with its own key, never a
    // fresh one. Upstream may have let that key go by now, so the guard against
    // a double spend is the status this claim was decided on: same grant still
    // next, as many resets left, the weekly still spent.
    const replay = state.unsettled?.grantId === grant.id;
    const requestId = state.unsettled && replay ? state.unsettled.requestId : randomUUID();
    this.log(`[TeamClaude] Claiming a Claude usage-limit reset on "${name}" — ${why}`);

    /** @type {ClaimVerdict|ClaimFailure|null} */
    let answer;
    try {
      answer = await this.claimFn(account, { grantId: grant.id, requestId }, { timeoutMs });
    } catch (/** @type {any} */ err) {
      answer = { error: err?.message || String(err), status: null };
    }
    // Whatever upstream decided, the status we hold describes a moment before it.
    state.read = null;
    const outcome = claimOutcome(answer, replay);
    const said = !answer ? 'no answer' : 'error' in answer ? safeLine(answer.error, 120) : answer.result;

    if (outcome === 'spent') {
      state.unsettled = null;
      state.cooldownUntil = now + SUCCESS_COOLDOWN_MS;
      // The fleet too: what else stops a sibling's reset being spent next is
      // this account reading available again — the re-read below, which may fail.
      this._holdFleet(account, now + SUCCESS_COOLDOWN_MS);
      this.log(`[TeamClaude] Claimed a Claude usage-limit reset on "${name}" (${said}${replay ? ', the earlier claim landing' : ''})`);
      await this._refresh(account, name, deadline);
      return { redeemed: true, reason: why, result: said };
    }

    state.cooldownUntil = now + RETRY_COOLDOWN_MS;
    if (outcome === 'unknown') {
      // It may well have been spent. Keep the record — on a replay, the first
      // claim's as it was — and hold the fleet: the walk would otherwise
      // answer an uncertain reset with a second.
      if (!replay) state.unsettled = { grantId: grant.id, requestId, resetsLeft: grant.resetsLeft, at: now };
      this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      this.log(`[TeamClaude] Claude usage-limit reset on "${name}" is unconfirmed — ${said}; it may still have been spent, so the pool holds off`);
      await this._reread(account, name, deadline);
      return { redeemed: false, reason: `claim outcome unknown (${said})` };
    }

    if (outcome === 'refused') {
      // An unsettled claim stays unsettled: this answer says nothing about it,
      // so on a replay the pool holds exactly as it did after the first try.
      if (replay) this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      const status = answer && 'error' in answer ? answer.status : null;
      const scope = status === 401 || status === 403 ? '; the login\'s token scope may not allow claiming resets' : '';
      this.log(`[TeamClaude] Claude usage-limit reset on "${name}" was refused — ${said}${scope}; nothing was spent${replay ? ', but the earlier claim is still unconfirmed' : ''}`);
      return { redeemed: false, reason: `claim refused (${said})` };
    }

    state.unsettled = null;
    if (said === 'not_limited') {
      // Upstream's word that the account is not at a limit, which the reading
      // that made the pool look dry had missed: lift its wall, re-read it, and
      // spend no sibling's reset on that reading.
      this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      this.log(`[TeamClaude] Claude usage-limit reset declined on "${name}" — upstream says it is not at a limit, nothing spent; back in rotation, and the pool holds off`);
      await this._refresh(account, name, deadline);
      return { redeemed: false, reason: 'upstream declined (not_limited)' };
    }
    if (replay) {
      // `ineligible` to a replay, which Claude Code reads as "your earlier try
      // may have gone through".
      this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      this.log(`[TeamClaude] Claude usage-limit reset declined on "${name}" — upstream said "${said}" to the replay; the earlier claim may have gone through, so the pool holds off`);
      await this._reread(account, name, deadline);
      return { redeemed: false, reason: `upstream declined (${said}); the earlier claim may have gone through` };
    }
    if (said === 'already_used' || said === 'cooldown') {
      // Someone else has just spent or started this account's reset, so it is
      // on its way back: re-read it, and spend no sibling's reset meanwhile.
      this._holdFleet(account, now + RETRY_COOLDOWN_MS);
      this.log(`[TeamClaude] Claude usage-limit reset declined on "${name}" — upstream said "${said}", nothing spent by us; a reset there was just spent or started, so the pool holds off`);
      await this._reread(account, name, deadline);
      return { redeemed: false, reason: `upstream declined (${said})` };
    }
    this.log(`[TeamClaude] Claude usage-limit reset declined on "${name}" — upstream said "${said}", nothing spent`);
    return { redeemed: false, reason: `upstream declined (${said})` };
  }

  /**
   * Put the account back in service once its limits are known to be clear:
   * drop the hold and the upstream rejection it was barred by, then re-read
   * its quota.
   *
   * @param {Record<string, any>} account
   * @param {string} name
   * @param {number} deadline
   */
  async _refresh(account, name, deadline) {
    this.am.clearRateLimited(account.index);
    this.am.clearUpstreamRejected(account.index);
    await this._reread(account, name, deadline);
  }

  /**
   * Re-read the account's quota within what is left of the budget. A failed or
   * skipped re-read fabricates nothing; the account is re-learned from traffic
   * like any other whose quota we cannot see.
   *
   * @param {Record<string, any>} account
   * @param {string} name
   * @param {number} deadline
   */
  async _reread(account, name, deadline) {
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) {
      this.log(`[TeamClaude] Out of time to re-read Claude quota for "${name}" — it will be re-learned from traffic`);
      return;
    }
    const usage = await (async () => this.usageFn(account, { timeoutMs }))().catch(() => null);
    if (!usage || usage.error) {
      this.log(`[TeamClaude] Could not re-read Claude quota for "${name}" — it will be re-learned from traffic`);
      return;
    }
    this.am.applyUsageData(account.index, usage);
  }
}
