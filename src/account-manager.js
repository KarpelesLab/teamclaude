import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, opts = {}) {
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      orgUuid: acct.orgUuid || null,
      orgName: acct.orgName || null,
      priority: Number.isFinite(acct.priority) ? acct.priority : 0,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      consecutiveFailures: 0,
      quota: emptyQuota(),
      lastQuotaAt: null,
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    this.transientCooldownBaseS = opts.transientCooldownBaseS || 5;
    this.transientCooldownCapS = opts.transientCooldownCapS || 60;
  }

  markTransientFailure(index, reason) {
    const acct = this.accounts[index];
    if (!acct) return;
    acct.consecutiveFailures = (acct.consecutiveFailures || 0) + 1;
    const cooldownS = Math.min(
      this.transientCooldownCapS,
      this.transientCooldownBaseS * Math.pow(2, acct.consecutiveFailures - 1)
    );
    acct.status = 'throttled';
    acct.rateLimitedUntil = Date.now() + (cooldownS * 1000);
    console.warn(`[TeamClaude] Transient failure on "${acct.name}" (${reason}). Cooldown: ${cooldownS}s`);
  }

  noteUpstreamResponse(index) {
    const acct = this.accounts[index];
    if (!acct) return;
    if (acct.consecutiveFailures > 0) {
      console.log(`[TeamClaude] Account "${acct.name}" recovered from transient failures`);
      acct.consecutiveFailures = 0;
    }
  }

  /**
   * Get the best available account by priority (lower `priority` = preferred),
   * ties broken by config order. Always prefers the highest-priority available
   * account, so it switches back up the moment a higher-priority one recovers.
   * Returns null if all accounts are exhausted/unavailable.
   */
  getActiveAccount() {
    const available = this.accounts.filter(a => this._isAvailable(a));
    if (available.length > 0) {
      available.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
      const best = available[0];
      if (best.index !== this.currentIndex) {
        this.currentIndex = best.index;
        console.log(`[TeamClaude] Using account "${best.name}" (priority ${best.priority})`);
      }
      return best;
    }
    return this._selectExhaustedFallback();
  }

  _isAvailable(account) {
    if (!account) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    return true;
  }

  _isNearQuota(account) {
    const q = account.quota;
    const now = Date.now();

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      // A 'rejected' status is almost always 5h exhaustion — clear it on the 5h
      // reset too, so a stale rejection can't keep the account excluded.
      if (q.unifiedStatus === 'rejected') q.unifiedStatus = null;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
    }

    // Unified quotas (Claude Max) — utilization is already 0-1
    // An explicit 'rejected' status means upstream is refusing this account now,
    // even if the reported utilization hasn't crossed the threshold yet.
    if (q.unifiedStatus === 'rejected') return true;
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

  // All accounts unavailable — return the one that resets soonest (only if its
  // reset time has already passed; otherwise null so the caller returns 429).
  _selectExhaustedFallback() {
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
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
   * Set countRequest=false for background probes so they don't inflate the
   * per-account request/usage totals (which should reflect real client traffic).
   */
  updateQuota(accountIndex, headers, { countRequest = true } = {}) {
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

    account.lastQuotaAt = Date.now();
    if (countRequest) {
      account.usage.totalRequests++;
      account.usage.lastUsed = new Date().toISOString();
    }

    // Log when approaching quota — name the window that actually tripped (the
    // checks mirror _isNearQuota's order, so the detail matches the trigger).
    if (this._isNearQuota(account)) {
      const q = account.quota;
      let detail;
      if (q.unifiedStatus === 'rejected') detail = 'status rejected';
      else if (q.unified5h != null && q.unified5h >= this.switchThreshold) detail = `5h ${(q.unified5h * 100).toFixed(1)}%`;
      else if (q.unified7d != null && q.unified7d >= this.switchThreshold) detail = `7d ${(q.unified7d * 100).toFixed(1)}%`;
      else if (q.tokensLimit != null && q.tokensRemaining != null) detail = `tokens ${((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1)}% used`;
      else if (q.requestsLimit != null && q.requestsRemaining != null) detail = `requests ${((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1)}% used`;
      else detail = 'near limit';
      console.log(`[TeamClaude] Account "${account.name}" near limit (${detail}) — will switch on next request`);
    }
  }

  /**
   * Populate quota from Anthropic's OAuth usage endpoint (fetchUsage).
   * Maps the five_hour/seven_day windows onto the unified quota fields.
   * Endpoint utilization is a percentage (0-100); unified* fields are 0-1.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;

    const apply = (win, utilKey, resetKey) => {
      if (win && typeof win.utilization === 'number') {
        q[utilKey] = win.utilization / 100;
        q[resetKey] = win.resets_at ? new Date(win.resets_at).getTime() : null;
      }
    };
    apply(usage.five_hour, 'unified5h', 'unified5hReset');
    apply(usage.seven_day, 'unified7d', 'unified7dReset');

    account.lastQuotaAt = Date.now();
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
   * Mark an account as temporarily unavailable for a given duration. `reason`
   * is purely for the log line (e.g. 'rate limit' for a 429, 'network error'
   * for a failed/aborted upstream connection).
   */
  markRateLimited(accountIndex, retryAfterSeconds, reason = 'rate limit') {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamClaude] Account "${account.name}" unavailable for ${retryAfterSeconds}s (${reason})`);
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
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        // A successful refresh clears a prior error — the account is usable again.
        if (account.status === 'error') {
          account.status = 'active';
          console.log(`[TeamClaude] Account "${account.name}" recovered from error after refresh`);
        }
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
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
      priority: Number.isFinite(acctData.priority) ? acctData.priority : 0,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      quota: emptyQuota(),
      lastQuotaAt: null,
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
   * Compute remaining quota from a quota object. Fractions are 0-1 (1 = full).
   * For Claude Max (unified) only utilization is reported, so remaining is a
   * fraction; for API-key accounts absolute token/request counts are available.
   */
  _remainingSummary(q) {
    const r = {
      session: null,      // fraction 0-1 (Claude Max 5h)
      weekly: null,       // fraction 0-1 (Claude Max 7d)
      tokens: null,       // absolute tokens remaining (API key)
      tokensFraction: null,
      requests: null,     // absolute requests remaining (API key)
      requestsFraction: null,
    };
    if (q.unified5h != null) r.session = Math.max(0, 1 - q.unified5h);
    if (q.unified7d != null) r.weekly = Math.max(0, 1 - q.unified7d);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      r.tokens = q.tokensRemaining;
      r.tokensFraction = q.tokensLimit > 0 ? q.tokensRemaining / q.tokensLimit : null;
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      r.requests = q.requestsRemaining;
      r.requestsFraction = q.requestsLimit > 0 ? q.requestsRemaining / q.requestsLimit : null;
    }
    return r;
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
        priority: a.priority,
        status: a.status,
        quota: { ...a.quota },
        remaining: this._remainingSummary(a.quota),
        lastQuotaAt: a.lastQuotaAt,
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
