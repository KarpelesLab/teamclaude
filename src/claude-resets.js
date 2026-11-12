// Banked Claude usage-limit resets: reading the grant a spent account holds, and
// spending one at the pool-dry refusal when the operator has armed
// `autoRedeemResets` — the same switch, the same moment and the same
// per-account exemption as the Codex reset credits.
//
// The Codex counterpart is codex-reset-credits.js. Anthropic's version differs
// in ways that matter for a call that cannot be undone:
//
//  - The grants live in the usage payload's `cedar_ember` block, which is only
//    filled in for a caller that asks with `?cedar_ember=1` and identifies as
//    Claude Code; anything else reads `eligible: false, ineligible_reason:
//    "surface"`, a statement about the caller and not the account.
//  - Spending names a grant, and only the payload's `next_grant_id` may be
//    spent; the endpoint is organization-scoped
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

import { updateState } from './config.js';
import { USAGE_URL, OAUTH_USAGE_BETA, USAGE_USER_AGENT, normalizeUsagePayload } from './oauth.js';
import { providerOf, DEFAULT_PROVIDER } from './provider.js';
import { safeLine } from './safe-text.js';
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
      resetsLeft: Number.isInteger(left) && left > 0 ? left : 0,
      clears: names(g.clears),
      usableNow: g.usable_now === true,
      paused: g.paused === true,
      endsAt: isoMs(g.ends_at),
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
    grants,
  };
}

/** @typedef {NonNullable<ReturnType<typeof parseResetStatus>>} ResetStatus */

/**
 * The grant a claim would spend: only `next_grant_id`, and only while it can be
 * used. Null when there is none.
 *
 * @param {ResetStatus|null} status
 * @param {number} [now]
 */
export function claimableGrant(status, now = Date.now()) {
  if (!status?.eligible || !status.nextGrantId) return null;
  const g = status.grants.find((/** @type {{ id: string }} */ x) => x.id === status.nextGrantId);
  if (!g || g.resetsLeft < 1 || !g.usableNow || g.paused) return null;
  if (g.endsAt != null && g.endsAt <= now) return null;
  return g;
}

/**
 * Read one account's reset status (and, from the same payload, its usage — so
 * the caller can re-apply quota after a reset without a second request).
 *
 * @param {Record<string, any>} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function fetchClaudeResetStatus(account, { fetchImpl = proxyFetch, timeoutMs = 10_000 } = {}) {
  if (!account?.credential) return { error: 'no credential' };
  try {
    const res = await fetchImpl(USAGE_URL, { headers: headers(account), signal: AbortSignal.timeout(timeoutMs), routing: account.routing ?? null });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    return { reset: parseResetStatus(data?.cedar_ember), usage: normalizeUsagePayload(data) };
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
 * @param {Record<string, any>} account
 * @param {number} now
 */
export function blockedUntil(account, now = Date.now()) {
  const q = account?.quota || {};
  let until = 0;
  for (const [use, reset] of [['unified5h', 'unified5hReset'], ['unified7d', 'unified7dReset'], ['unified7dFable', 'unified7dFableReset'], ['unified7dSonnet', 'unified7dSonnetReset']]) {
    if (q[use] != null && q[use] >= 0.98 && q[reset] > now) until = Math.max(until, q[reset]);
  }
  return until;
}

/** @typedef {{ redeemed: boolean, reason: string, account?: string, result?: string|null, resetsLeft?: number|null, cleared?: string[] }} ClaudeRedeemResult */
/** @typedef {{ outcome: 'redeemed'|'declined'|'pre_claim_failed'|'unknown', reason: string, result?: string|null, resetsLeft?: number|null, cleared?: string[], mayHaveRedeemed?: boolean, pending?: boolean }} ClaudeManualRedeemResult */
/** @typedef {{ accountUuid: string|null, orgUuid: string, grantId: string, requestId: string, createdAt: number }} PendingClaudeReset */

export class ClaudeResetRedeemer {
  /**
   * @param {any} accountManager
   * @param {{ config?: Record<string, any>|null, statusFn?: Function, claimFn?: Function, now?: () => number, log?: Function, timeoutMs?: number, pending?: Record<string, any>|null, updateStateFn?: Function }} [opts]
   */
  constructor(accountManager, { config = null, statusFn = fetchClaudeResetStatus, claimFn = claimClaudeReset, now = Date.now, log = console.log, timeoutMs = CLAUDE_REDEEM_BUDGET_MS, pending = null, updateStateFn = updateState } = {}) {
    this.am = accountManager;
    this.config = config;
    this.statusFn = statusFn;
    this.claimFn = claimFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.updateState = /** @type {typeof updateState} */ (updateStateFn);
    /** @type {WeakMap<object, { cooldownUntil: number, requestId: string|null, grantId: string|null }>} */
    this.state = new WeakMap();
    /** @type {Map<string, PendingClaudeReset|Record<string, any>>} */
    this.pending = new Map(Object.entries(pending && typeof pending === 'object' && !Array.isArray(pending) ? pending : {}));
    /** @type {Promise<ClaudeRedeemResult>|null} */
    this.inFlight = null;
    /** @type {Promise<ClaudeManualRedeemResult & { account?: string }>|null} */
    this.manualInFlight = null;
  }

  exportPending() {
    return Object.fromEntries(this.pending);
  }

  /** @param {Record<string, any>} account */
  _pendingKey(account) {
    return typeof account?.id === 'string' && account.id.length > 0 ? account.id : null;
  }

  // A reload can remove an account and renumber every later index. Resolve the
  // live row by stable entry id before touching account-manager state.
  /** @param {Record<string, any>} account */
  _liveAccount(account) {
    const live = (this.am.accounts || []).find((/** @type {Record<string, any>} */ a) => a.id === account?.id);
    return live && live.orgUuid === account.orgUuid && live.accountUuid === account.accountUuid ? live : null;
  }

  /** @param {string} accountId @param {string} requestId @param {Record<string, any>} record */
  async _discardPendingBeforeClaim(accountId, requestId, record) {
    this.pending.delete(accountId);
    try {
      await this.updateState(saved => {
        const pending = { ...(saved.claudeResetPending || {}) };
        if (pending[accountId]?.requestId === requestId) delete pending[accountId];
        saved.claudeResetPending = pending;
      });
      return true;
    } catch {
      this.pending.set(accountId, record);
      return false;
    }
  }

  /**
   * The fleet hold: armed by a reset that landed or may have, it stops the next
   * refusal — and the rest of this one's walk — spending a sibling's reset on
   * top of it. Kept on the accounts' saved quota (`claudeResetHoldUntil`), so a
   * restart minutes after a claim that may have landed does not spend another;
   * the latest any account carries holds them all.
   */
  get fleetHoldUntil() {
    let until = 0;
    for (const account of this.am.accounts || []) {
      const held = account.quota?.claudeResetHoldUntil;
      if (Number.isFinite(held)) until = Math.max(until, held);
    }
    for (const record of this.pending.values()) {
      if (Number.isFinite(record?.createdAt)) until = Math.max(until, record.createdAt + UNKNOWN_HOLD_MS);
    }
    return until;
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} until
   */
  _holdFleet(account, until) {
    const held = account.quota.claudeResetHoldUntil;
    account.quota.claudeResetHoldUntil = Number.isFinite(held) ? Math.max(held, until) : until;
  }

  /** @param {object} account */
  _stateFor(account) {
    let s = this.state.get(account);
    if (!s) { s = { cooldownUntil: 0, requestId: null, grantId: null }; this.state.set(account, s); }
    return s;
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
   * @param {Record<string, any>[]} accounts
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async maybeRedeemForPool(accounts) {
    if (this.config?.autoRedeemResets !== true) return { redeemed: false, reason: 'auto-redeem is switched off' };
    if (!accounts?.length && this.pending.size === 0) return { redeemed: false, reason: 'no candidate accounts' };
    if (this.manualInFlight) return { redeemed: false, reason: 'in_progress' };
    if (this.inFlight) return this.inFlight;
    const attempt = this._attempt(accounts).finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /** @param {Record<string, any>[]} accounts */
  async _attempt(accounts) {
    const now = this.now();
    if (this.pending.size > 0) {
      if (now < this.fleetHoldUntil) return { redeemed: false, reason: 'holding off after a recent Claude reset attempt' };
      const replay = await this._resolvePending();
      const redeemed = replay.find(r => r.outcome === 'redeemed');
      if (redeemed) return { redeemed: true, account: redeemed.account, reason: 'a pending Claude reset was confirmed', result: redeemed.result, resetsLeft: redeemed.resetsLeft, cleared: redeemed.cleared };
      if (replay.some(r => r.outcome === 'unknown')) return { redeemed: false, reason: 'a pending Claude reset still has no verdict; it may still have gone through' };
      return { redeemed: false, reason: 'pending Claude reset replay finished; no sibling was claimed' };
    }
    if (now < this.fleetHoldUntil) return { redeemed: false, reason: 'holding off after a recent Claude reset attempt' };
    const deadline = now + this.timeoutMs;
    const candidates = accounts
      .filter(a => this._isClaude(a) && a.orgUuid && !a.disabled && a.autoRedeemReset !== false)
      .filter(a => a.quota?.resetCredits?.available !== 0)
      .filter(a => now >= this._stateFor(a).cooldownUntil)
      .sort((a, b) => blockedUntil(b, now) - blockedUntil(a, now));
    let reason = 'no Claude account holds a usable reset';
    for (const account of candidates) {
      if (this.now() >= deadline) { reason = 'ran out of the redeem budget'; break; }
      const r = await this._redeem(account, deadline);
      if (r.redeemed) return r;
      reason = r.reason;
      if (this.now() < this.fleetHoldUntil) break;
    }
    return { redeemed: false, reason };
  }

  /**
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @returns {Promise<ClaudeRedeemResult>}
   */
  async _redeem(account, deadline) {
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    const now = this.now();
    try { await this.am.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
      return { redeemed: false, account: name, reason: `token refresh failed (${safeLine(err?.message || String(err), 80)})` };
    }
    const left = () => Math.max(1, deadline - this.now());
    const read = await this.statusFn(account, { timeoutMs: left() });
    if (read?.error) {
      state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `could not read reset status (${read.error})` };
    }
    const status = read.reset;
    if (!status || !status.eligible) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: `not eligible for resets${status?.ineligibleReason ? ` (${status.ineligibleReason})` : ''}` };
    }
    const grant = claimableGrant(status, now);
    if (!grant) {
      state.cooldownUntil = now + NOTHING_COOLDOWN_MS;
      return { redeemed: false, account: name, reason: 'holds no usable reset' };
    }
    {
      if (!status.atLimit || !status.exhausted.length) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: 'not at a usage limit' };
      }
      // A grant is scarce and a 5-hour wall lifts on its own within hours: spend
      // one only where a weekly limit (the all-models week or a family's,
      // `seven_day*`) is what turns the account away.
      if (!status.exhausted.some((/** @type {string} */ limit) => limit.startsWith('seven_day'))) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: 'no weekly limit is exhausted' };
      }
      // Spent on an account it would not return to service, a reset buys this
      // request nothing — and the grant is gone.
      const uncovered = status.exhausted.filter((/** @type {string} */ limit) => !grant.clears.includes(limit));
      if (uncovered.length) {
        state.cooldownUntil = now + DECLINED_COOLDOWN_MS;
        return { redeemed: false, account: name, reason: `its reset does not clear ${uncovered.join(', ')}` };
      }
    }
    // Upstream already says a claim now would answer `cooldown`: save the POST.
    if (status.cooldownUntil != null && status.cooldownUntil > now) {
      state.cooldownUntil = status.cooldownUntil;
      return { redeemed: false, account: name, reason: 'upstream reports a reset cooldown' };
    }
    this.log(`[TeamClaude] Redeeming a banked Claude usage-limit reset on "${name}" — no Claude account can serve the request`);
    const r = await this._executeClaim(account, grant, deadline);
    if (r.outcome === 'unknown') {
      this.log(`[TeamClaude] Claude reset on "${name}" got no verdict; it may have been spent, so the fleet holds off`);
      return { redeemed: false, account: name, reason: `reset request failed (${r.reason}); it may still have gone through` };
    }
    if (r.outcome === 'pre_claim_failed') return { redeemed: false, account: name, reason: r.reason };
    if (r.outcome === 'redeemed') {
      this.log(`[TeamClaude] Redeemed a Claude usage-limit reset on "${name}" — cleared ${(r.cleared || []).join(', ') || 'its limits'}, ${r.resetsLeft ?? '?'} left`);
      return { redeemed: true, account: name, reason: 'no Claude account could serve the request', result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared };
    }
    this.log(`[TeamClaude] Claude reset on "${name}" declined upstream (${r.result || 'no result'}); nothing was spent`);
    return { redeemed: false, account: name, reason: `upstream declined (${r.result || r.reason})`, result: r.result };
  }

  /**
   * Operator-initiated redemption. Unlike the pool-dry policy this accepts any
   * currently usable grant, including one with no exhausted window.
   *
   * @param {Record<string, any>} account
   * @returns {Promise<ClaudeManualRedeemResult & { account?: string }>}
   */
  redeemAccount(account) {
    const name = safeLine(account?.name, 64);
    if (this.inFlight || this.manualInFlight) {
      return Promise.resolve(/** @type {ClaudeManualRedeemResult & { account?: string }} */ ({ outcome: 'declined', account: name, reason: 'in_progress' }));
    }
    const attempt = this._redeemAccount(account).finally(() => { this.manualInFlight = null; });
    this.manualInFlight = attempt;
    return attempt;
  }

  /** @param {Record<string, any>} account @returns {Promise<ClaudeManualRedeemResult & { account?: string }>} */
  async _redeemAccount(account) {
    const name = safeLine(account?.name, 64);
    if (!this._isClaude(account) || !account.orgUuid) {
      return { outcome: 'declined', account: name, reason: 'unsupported_seat' };
    }
    if (this.pending.size > 0 && this.now() < this.fleetHoldUntil) {
      return { outcome: 'declined', account: name, reason: 'cooldown' };
    }
    const key = this._pendingKey(account);
    const replay = await this._resolvePending();
    const own = key ? replay.find(r => r.accountId === key) : null;
    const orphan = replay.find(r => r.outcome === 'unknown' && (r.reason === 'pending_orphan' || r.reason === 'pending_identity_mismatch'));
    if (orphan) {
      const { accountId: _id, ...result } = orphan;
      void _id;
      return result;
    }
    if (own?.outcome === 'redeemed' || own?.outcome === 'unknown') {
      const { accountId: _id, ...result } = own;
      void _id;
      return result;
    }
    if (replay.length > 0 || this.pending.size > 0) {
      return { outcome: 'declined', account: name, reason: 'pending_replay' };
    }
    if (this.now() < this.fleetHoldUntil || this.now() < this._stateFor(account).cooldownUntil) {
      return { outcome: 'declined', account: name, reason: 'cooldown' };
    }
    account = this._liveAccount(account);
    if (!account) return { outcome: 'pre_claim_failed', account: name, reason: 'account_removed' };
    const deadline = this.now() + this.timeoutMs;
    try { await this.am.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
      return { outcome: 'pre_claim_failed', account: name, reason: `token refresh failed (${safeLine(err?.message || String(err), 80)})` };
    }
    account = this._liveAccount(account);
    if (!account) return { outcome: 'pre_claim_failed', account: name, reason: 'account_removed' };
    let read;
    try { read = await this.statusFn(account, { timeoutMs: Math.max(1, deadline - this.now()) }); } catch (/** @type {any} */ err) {
      return { outcome: 'pre_claim_failed', account: name, reason: `could not read reset status (${safeLine(err?.message || String(err), 80)})` };
    }
    if (read?.error) return { outcome: 'pre_claim_failed', account: name, reason: `could not read reset status (${read.error})` };
    const status = read.reset;
    if (!status?.eligible) return { outcome: 'declined', account: name, reason: 'ineligible', result: status?.ineligibleReason ?? null };
    const grant = claimableGrant(status, this.now());
    if (!grant) return { outcome: 'declined', account: name, reason: 'no_usable_grant' };
    if (status.cooldownUntil != null && status.cooldownUntil > this.now()) {
      return { outcome: 'declined', account: name, reason: 'cooldown' };
    }
    const result = await this._executeClaim(account, grant, deadline);
    return { account: name, ...result };
  }

  /**
   * Replay every durable unresolved claim before considering new work. Pending
   * records deliberately skip the fresh-grant gate: a grant that disappeared is
   * exactly the restart-after-unknown case the original request id resolves.
   *
   * @returns {Promise<(ClaudeManualRedeemResult & { accountId: string, account: string })[]>}
   */
  async _resolvePending() {
    const entries = [...this.pending.entries()].sort(([a, av], [b, bv]) => {
      const at = Number(av?.createdAt), bt = Number(bv?.createdAt);
      return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0) || a.localeCompare(b);
    });
    /** @type {(ClaudeManualRedeemResult & { accountId: string, account: string })[]} */
    const results = [];
    for (const [accountId, record] of entries) {
      const account = (this.am.accounts || []).find((/** @type {Record<string, any>} */ a) => a.id === accountId);
      const valid = account && this._isClaude(account)
        && (typeof record?.accountUuid === 'string' || record?.accountUuid === null) && record.accountUuid === account.accountUuid
        && typeof record?.orgUuid === 'string' && record.orgUuid === account.orgUuid
        && typeof record?.grantId === 'string' && GRANT_ID.test(record.grantId)
        && typeof record?.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(record.requestId)
        && Number.isFinite(record?.createdAt);
      if (!valid) {
        results.push({ outcome: 'unknown', accountId, account: safeLine(account?.name, 64), reason: account ? 'pending_identity_mismatch' : 'pending_orphan', mayHaveRedeemed: true });
        break;
      }
      try { await this.am.ensureTokenFresh(account.index); } catch {
        results.push({ outcome: 'unknown', accountId, account: safeLine(account.name, 64), reason: 'pending_token_refresh_failed', mayHaveRedeemed: true });
        break;
      }
      const result = await this._executeClaim(account, { id: record.grantId }, this.now() + this.timeoutMs, record.requestId);
      results.push({ accountId, account: safeLine(account.name, 64), ...result });
      break;
    }
    return results;
  }

  /**
   * The one claim executor shared by automatic and manual redemption. Intent is
   * durable before the POST. Success clears pending only with its fleet hold;
   * if that write fails, the known verdict survives with pending replay intent.
   *
   * @param {Record<string, any>} account
   * @param {{ id: string }} grant
   * @param {number} deadline
   * @param {string|null} [replayRequestId]
   * @returns {Promise<ClaudeManualRedeemResult>}
   */
  async _executeClaim(account, grant, deadline, replayRequestId = null) {
    account = this._liveAccount(account);
    if (!account) return { outcome: replayRequestId ? 'unknown' : 'pre_claim_failed', reason: 'account_removed', ...(replayRequestId ? { mayHaveRedeemed: true } : {}) };
    let state = this._stateFor(account);
    const accountId = this._pendingKey(account);
    if (!accountId || typeof account.orgUuid !== 'string' || !account.orgUuid) {
      return { outcome: replayRequestId ? 'unknown' : 'pre_claim_failed', reason: 'missing_stable_account_identity', ...(replayRequestId ? { mayHaveRedeemed: true } : {}) };
    }
    try { await this.am.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
      return { outcome: replayRequestId ? 'unknown' : 'pre_claim_failed', reason: `token refresh failed (${safeLine(err?.message || String(err), 80)})`, ...(replayRequestId ? { mayHaveRedeemed: true } : {}) };
    }
    const existing = this.pending.get(accountId);
    const requestId = replayRequestId || existing?.requestId || randomUUID();
    const record = { accountUuid: typeof account.accountUuid === 'string' ? account.accountUuid : null, orgUuid: account.orgUuid, grantId: grant.id, requestId, createdAt: existing?.createdAt || this.now() };
    if (!replayRequestId) {
      this.pending.set(accountId, record);
      try {
        await this.updateState(saved => {
          saved.claudeResetPending = { ...(saved.claudeResetPending || {}), [accountId]: record };
        });
      } catch (/** @type {any} */ err) {
        if (existing) this.pending.set(accountId, existing);
        else this.pending.delete(accountId);
        return { outcome: 'pre_claim_failed', reason: `could not persist reset intent (${safeLine(err?.message || String(err), 80)})` };
      }
    }
    const current = this._liveAccount(account);
    if (!current) {
      if (replayRequestId) return { outcome: 'unknown', reason: 'account_removed', mayHaveRedeemed: true };
      if (!await this._discardPendingBeforeClaim(accountId, requestId, record)) {
        return { outcome: 'unknown', reason: 'account removed before claim and pending intent could not be cleared', mayHaveRedeemed: true };
      }
      return { outcome: 'pre_claim_failed', reason: 'account_removed' };
    }
    account = current;
    state = this._stateFor(account);
    try { await this.am.ensureTokenFresh(account.index); } catch (/** @type {any} */ err) {
      if (replayRequestId) return { outcome: 'unknown', reason: 'pending_token_refresh_failed', mayHaveRedeemed: true };
      if (!await this._discardPendingBeforeClaim(accountId, requestId, record)) {
        return { outcome: 'unknown', reason: 'token refresh failed and pending intent could not be cleared', mayHaveRedeemed: true };
      }
      return { outcome: 'pre_claim_failed', reason: `token refresh failed (${safeLine(err?.message || String(err), 80)})` };
    }
    const beforeClaim = this._liveAccount(account);
    if (!beforeClaim) {
      if (replayRequestId) return { outcome: 'unknown', reason: 'account_removed', mayHaveRedeemed: true };
      if (!await this._discardPendingBeforeClaim(accountId, requestId, record)) {
        return { outcome: 'unknown', reason: 'account removed before claim and pending intent could not be cleared', mayHaveRedeemed: true };
      }
      return { outcome: 'pre_claim_failed', reason: 'account_removed' };
    }
    account = beforeClaim;
    state = this._stateFor(account);
    state.grantId = grant.id;
    state.requestId = requestId;
    const r = await this.claimFn(account, { grantId: grant.id, requestId }, { timeoutMs: Math.max(1, deadline - this.now()) });
    const knownDecline = ['not_limited', 'cooldown', 'ineligible', 'unavailable'].includes(r?.result);
    const afterClaim = this._liveAccount(account);
    if (!knownDecline && !afterClaim) {
      return { outcome: 'unknown', reason: 'account_removed_after_claim', mayHaveRedeemed: true };
    }
    if (afterClaim) {
      account = afterClaim;
      state = this._stateFor(account);
    }
    if (r?.error || (!['reset', 'already_used'].includes(r?.result) && !knownDecline)) {
      const until = this.now() + UNKNOWN_HOLD_MS;
      state.cooldownUntil = until;
      this._holdFleet(account, until);
      await this.updateState(saved => { saved.quota = this.am.exportQuotaState(); }).catch(() => {});
      return { outcome: 'unknown', reason: safeLine(r?.error || 'unrecognized reset verdict', 120), mayHaveRedeemed: true };
    }
    if (r.result === 'reset' || r.result === 'already_used') {
      state.cooldownUntil = this.now() + SUCCESS_HOLD_MS;
      this._holdFleet(account, state.cooldownUntil);
      this.pending.delete(accountId);
      try {
        await this.updateState(saved => {
          saved.quota = this.am.exportQuotaState();
          const pending = { ...(saved.claudeResetPending || {}) };
          if (pending[accountId]?.requestId === requestId) delete pending[accountId];
          saved.claudeResetPending = pending;
        });
      } catch {
        this.pending.set(accountId, record);
        return { outcome: 'redeemed', reason: 'reset verdict received but its fleet hold could not be persisted', result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared, pending: true };
      }
      state.requestId = null;
      state.grantId = null;
      await this._reapply(account, deadline);
      return { outcome: 'redeemed', reason: r.result === 'already_used' ? 'prior redemption confirmed' : 'reset redeemed', result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared };
    }
    state.cooldownUntil = r.result === 'cooldown' && r.cooldownUntil ? r.cooldownUntil : this.now() + DECLINED_COOLDOWN_MS;
    this.pending.delete(accountId);
    try {
      await this.updateState(saved => {
        const pending = { ...(saved.claudeResetPending || {}) };
        if (pending[accountId]?.requestId === requestId) delete pending[accountId];
        saved.claudeResetPending = pending;
      });
    } catch {
      this.pending.set(accountId, record);
      return { outcome: 'unknown', reason: 'reset refusal received but pending intent could not be cleared', result: r.result, mayHaveRedeemed: true };
    }
    state.requestId = null;
    state.grantId = null;
    return { outcome: 'declined', reason: r.reason || r.result, result: r.result, resetsLeft: r.resetsLeft, cleared: r.cleared };
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
    account = this._liveAccount(account);
    if (!account) return;
    try { this.am.clearRateLimited(account.index); } catch { /* not held */ }
    try { this.am.clearUpstreamRejected(account.index); } catch { /* not rejected */ }
    const read = await this.statusFn(account, { timeoutMs: Math.max(1, deadline - this.now()) });
    account = this._liveAccount(account);
    if (!account) return;
    if (read?.usage && !read.usage.error) this.am.applyUsageData(account.index, read.usage);
  }
}
