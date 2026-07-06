import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired } from './oauth.js';
import { sameIdentity } from './identity.js';
import { isFableModel } from './model.js';

// Re-exported for callers that already import model helpers from here.
export { isFableModel, parseRequestModel } from './model.js';

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
];

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,            // utilization 0-1
    unified7d: null,            // utilization 0-1
    unified7dSonnet: null,      // utilization 0-1 (Sonnet-specific weekly bucket)
    unified7dFable: null,       // utilization 0-1 (Fable-specific weekly bucket)
    unified5hReset: null,       // ms timestamp
    unified7dReset: null,       // ms timestamp
    unified7dSonnetReset: null, // ms timestamp
    unified7dFableReset: null,  // ms timestamp
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, { refreshFn = refreshAccessToken, throttleProbeFloorMs } = {}) {
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      orgUuid: acct.orgUuid || null,
      orgName: acct.orgName || null,
      priority: acct.priority || 0,
      disabled: acct.disabled || false,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      // No quota is known at startup, so start probing: the first response for
      // an account reveals its weekly limit and triggers re-evaluation.
      probing: true,
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      throttledAt: null,
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    // When every account reads as over-quota we would otherwise refuse locally
    // forever (a stale cached utilization is never re-validated because no
    // request is ever sent). Instead, allow one real upstream probe at most this
    // often to refresh the cached quota. See _selectProbe.
    this.probeIntervalMs = 60_000;
    this._nextProbeAt = 0;
    // Minimum time a 429 hold is respected verbatim before a throttled account
    // becomes probe-eligible (see _isProbeable). Long enough to honor a genuine
    // retry-after, short enough that a stale hold cannot pin the fleet.
    this.throttleProbeFloorMs = throttleProbeFloorMs
      ?? (Number(process.env.TEAMCLAUDE_THROTTLE_PROBE_FLOOR_MS) || 60_000);
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount(exclude = null, model = null) {
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas();
    const current = this.accounts[this.currentIndex];
    // `model` scopes availability: an account whose Fable weekly bucket is spent
    // is still fully usable for other models, so it is only excluded when THIS
    // request targets Fable (see _isAvailable).
    // `exclude` is a per-request set of indices already tried this request (e.g.
    // an account that just threw a transport error). It is never a persistent
    // status change — the account stays healthy for the next request.
    // We just learned a probed account's weekly quota — re-evaluate which
    // account is best now that its limit is known.
    if (current && current.requalify) {
      current.requalify = false;
      const next = this._selectNext(exclude, model);
      if (next) return next;
    }
    if (this._isAvailable(current, model) && !exclude?.has(current.index)) {
      // A strictly higher-priority (lower value) available account preempts a
      // healthy current one. Within the same priority tier we stay put, so the
      // common case (all accounts at the default priority 0) is unchanged and
      // never thrashes — preemption only triggers when priorities differ.
      const betterExists = this.accounts.some(a =>
        this._isAvailable(a, model) && !exclude?.has(a.index) && (a.priority || 0) < (current.priority || 0));
      return betterExists ? this._selectNext(exclude, model) : current;
    }
    const next = this._selectNext(exclude, model);
    if (next) return next;
    // No account is under the switch threshold. Before refusing locally, allow a
    // throttled probe so a stale/poisoned cached quota can't pin us in a
    // permanent "all exhausted" state — the probe's real response refreshes the
    // quota (or upstream's own 429 converts soft exhaustion into a hard
    // rate-limit hold). null here means the caller emits the synthetic 429.
    return this._selectProbe(exclude, model);
  }

  /**
   * Like getActiveAccount, but if the selected account's OAuth token has ALREADY
   * expired it blocks on a refresh before returning — so a caller that injects
   * the token immediately (the MITM relay) never sends a dead token and eats a
   * 401. A token that is merely expiring soon (still valid) is left to the
   * caller's opportunistic background refresh; only a hard-expired one blocks.
   */
  async getActiveAccountFresh(exclude = null, model = null) {
    const account = this.getActiveAccount(exclude, model);
    if (account && account.type === 'oauth' && account.refreshToken
        && isTokenExpired(account.expiresAt)) {
      await this.ensureTokenFresh(account.index); // coalesces with any in-flight refresh
    }
    return account;
  }

  _isProbeable(account) {
    if (!account) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A 429 hold is respected verbatim at first, but a hold is a snapshot: the
    // 429 that armed it may itself have been transient (e.g. the retry burst
    // after a network flap), and while it lasts NOTHING revalidates it — so a
    // stale hold pins the fleet in synthetic 429s for up to an hour and only a
    // restart (which wipes the in-memory hold) recovers. After the floor, let
    // the account be probed: the probe's real response either clears the hold
    // (any non-429 → clearRateLimited) or re-arms it with a fresh retry-after.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return Date.now() >= (account.throttledAt || 0) + this.throttleProbeFloorMs;
    }
    return true;
  }

  /** Highest utilization across all known quota dimensions (0-1), used to pick
   * the least-exhausted probe target. Mirrors the ratios in _isNearQuota. */
  _maxUtilization(account) {
    const q = account.quota;
    let max = 0;
    if (q.unified5h != null) max = Math.max(max, q.unified5h);
    if (q.unified7d != null) max = Math.max(max, q.unified7d);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      max = Math.max(max, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      max = Math.max(max, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return max;
  }

  /**
   * Pick an account to send a single revalidation probe upstream when every
   * account reads as over the switch threshold. Throttled to one probe per
   * probeIntervalMs so a genuinely-exhausted fleet isn't hammered — between
   * probes this returns null and the caller falls back to the synthetic 429.
   * The chosen account is the least-utilized probeable one (most likely to have
   * stale headroom), so the refreshed quota corrects the cache fastest.
   */
  _selectProbe(exclude = null, model = null) {
    const now = Date.now();
    if (now < this._nextProbeAt) return null;

    let best = null;
    let bestPriority = Infinity;
    let bestUsage = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A Fable-exhausted account can't serve a Fable request even as a probe —
      // it would just 429 again — so skip it for Fable and let the caller emit
      // the synthetic 429 when no other account is available.
      if (isFableModel(model) && this._fableExhausted(account)) continue;
      const priority = account.priority || 0;
      const usage = this._maxUtilization(account);
      if (priority < bestPriority ||
          (priority === bestPriority && usage < bestUsage)) {
        bestPriority = priority;
        bestUsage = usage;
        best = account;
      }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this.currentIndex = best.index;
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null) {
    if (!account) return false;

    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.throttledAt = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    // Model-scoped exhaustion: a spent Fable weekly bucket only bars Fable
    // requests. Non-Fable requests still route here normally.
    if (isFableModel(model) && this._fableExhausted(account)) return false;

    return true;
  }

  /** True when this account's Fable weekly bucket is at/over the switch
   * threshold. The reset is cleared by refreshExpiredQuotas before selection, so
   * a non-null value here is still live. Model-scoped: only gates Fable requests. */
  _fableExhausted(account) {
    const q = account.quota;
    return q.unified7dFable != null && q.unified7dFable >= this.switchThreshold;
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    let changed = false;
    let session = false;

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      changed = true;
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      q.unified7dSonnet = null;
      q.unified7dSonnetReset = null;
      changed = true;
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      q.unified7dFable = null;
      q.unified7dFableReset = null;
      changed = true;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
      changed = true;
    }

    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return;

    let best = null;
    let bestWeekly = current.quota.unified7dReset;
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      if (!this._isAvailable(acc)) continue; // enough session & weekly quota left
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  _isNearQuota(account) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Unified quotas (Claude Max) — utilization is already 0-1
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  /**
   * Pick the best available account by selection order, WITHOUT mutating state:
   *   1. lowest `priority` value (operator-controlled; default 0, lower = preferred)
   *   2. then the account with no known weekly limit — using it lets us
   *      discover its quota
   *   3. then the account whose weekly limit expires soonest: that quota is
   *      closest to refreshing, so spending it first preserves accounts whose
   *      weekly window resets further out.
   * With all priorities at the default 0, this reduces to the weekly-reset
   * heuristic. Returns the account or null if none are available.
   */
  _pickBestAvailable(exclude = null, model = null) {
    let best = null;
    let bestPriority = Infinity;
    let bestReset = Infinity;

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      if (exclude?.has(account.index)) continue;
      // _isAvailable filters out accounts at/above the switch threshold, so the
      // soonest-expiring pick only ever lands on an account whose 5-hour quota
      // is still below 98%.
      if (!this._isAvailable(account, model)) continue;

      const priority = account.priority || 0;
      // Unknown weekly reset sorts first so we fill it in.
      const weeklyReset = account.quota.unified7dReset || -Infinity;
      if (priority < bestPriority ||
          (priority === bestPriority && weeklyReset < bestReset)) {
        bestPriority = priority;
        bestReset = weeklyReset;
        best = account;
      }
    }
    return best;
  }

  /**
   * Select the active account up front (e.g. on daemon launch, once persisted
   * quota has been restored) so we start on the highest-priority / soonest-
   * resetting account instead of blindly on index 0. Mirrors rotation order.
   * Returns the chosen account, or the existing current one if none are
   * available (the server still starts; requests 429 until a window resets).
   */
  selectActiveAccount() {
    this.refreshExpiredQuotas(); // drop any restored windows that already expired
    const best = this._pickBestAvailable();
    if (!best) return this.accounts[this.currentIndex] || null;
    this.currentIndex = best.index;
    best.probing = best.quota.unified7dReset == null;
    const wk = best.quota.unified7d != null
      ? `${(best.quota.unified7d * 100).toFixed(1)}% weekly used`
      : 'weekly quota unknown';
    console.log(`[TeamClaude] Starting on account "${best.name}" (priority ${best.priority || 0}, ${wk})`);
    return best;
  }

  _selectNext(exclude = null, model = null) {
    const best = this._pickBestAvailable(exclude, model);
    if (best) {
      const switched = best.index !== this.currentIndex;
      this.currentIndex = best.index;
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    const u7dOi = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(u7dOi)) account.quota.unified7dFable = u7dOi;
    const r7dOi = headers['anthropic-ratelimit-unified-7d_oi-reset'];
    if (r7dOi) account.quota.unified7dFableReset = parseInt(r7dOi, 10) * 1000;

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = usage.fiveHour.utilization;
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = usage.sevenDay.utilization;
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    if (usage.sevenDaySonnet) {
      if (usage.sevenDaySonnet.utilization != null) q.unified7dSonnet = usage.sevenDaySonnet.utilization;
      if (usage.sevenDaySonnet.resetAt != null) q.unified7dSonnetReset = usage.sevenDaySonnet.resetAt;
    }
    if (usage.sevenDayFable) {
      if (usage.sevenDayFable.utilization != null) q.unified7dFable = usage.sevenDayFable.utilization;
      if (usage.sevenDayFable.resetAt != null) q.unified7dFableReset = usage.sevenDayFable.resetAt;
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    // Marks when the hold was (re-)armed: a revalidation probe is allowed only
    // after throttleProbeFloorMs from here, so a probe that 429s again pushes
    // the next probe out by a full floor rather than hammering upstream.
    account.throttledAt = Date.now();
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Clear a rate-limit hold after live proof it no longer binds: any non-429
   * upstream response on a throttled account (a revalidation probe reaching
   * here, or a hold armed moments before traffic resumed). No-op otherwise.
   */
  clearRateLimited(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.status !== 'throttled') return;
    account.status = 'active';
    account.rateLimitedUntil = null;
    account.throttledAt = null;
    console.log(`[TeamClaude] Account "${account.name}" revalidated — rate limit no longer applies, back in rotation`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshFn(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Reserve 'error' (which drops the account from rotation until re-login)
        // for a GENUINE auth rejection: the refresh token itself is no longer
        // valid — revoked, or invalidated by an account/plan migration. A
        // transient failure (network, 5xx, timeout) must NOT sideline a healthy
        // account: keep its current token and retry on the next request. This is
        // what kept accounts wrongly "errored" after a momentary refresh blip.
        const isAuthRejection = err.status === 400 || err.status === 401 || err.status === 403;
        if (isAuthRejection) {
          account.status = 'error';
          console.error(`[TeamClaude] Account "${account.name}" needs re-login (refresh token rejected) — run: teamclaude login`);
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      accountUuid: acctData.accountUuid || null,
      orgUuid: acctData.orgUuid || null,
      orgName: acctData.orgName || null,
      priority: acctData.priority || 0,
      disabled: acctData.disabled || false,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      // Unknown quota until the first response — probe it like startup accounts.
      probing: true,
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, quota };
    });
  }

  /**
   * Restore quota learned in a previous run. Matches saved entries to accounts
   * by identity. Stale windows are not special-cased here — _clearExpiredQuotas
   * wipes any restored window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => sameIdentity(s, account));
      if (!match || !match.quota) continue;
      for (const f of PERSISTED_QUOTA_FIELDS) {
        if (match.quota[f] != null) account.quota[f] = match.quota[f];
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        orgName: a.orgName || null,
        priority: a.priority || 0,
        disabled: a.disabled || false,
        status: a.status,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
