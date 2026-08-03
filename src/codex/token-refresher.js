// Scheduled token refresh for codex accounts.
//
// Every other account type has something that keeps its token current as a side
// effect: a request refreshes on the way through, and the opt-in prober and
// keep-warm scheduler both call ensureTokenFresh. Codex accounts are excluded
// from both of those (the prober reads an Anthropic endpoint that rejects a
// ChatGPT token; warming holds open a session window this plan does not have),
// so on an idle proxy nothing renews them and the token simply expires.
//
// That is survivable — the next request refreshes synchronously before sending
// — but it leaves the proxy holding a stale credential for as long as it stays
// idle, and OpenAI rotates the refresh token on every refresh. The longer
// teamclaude sits on an old one, the likelier some other holder (the Codex CLI)
// rotates the family out from under it, at which point the refresh fails and
// the account drops out of rotation until it is re-imported.
//
// Unlike the prober and warmer this is ON by default and spends no quota: the
// check is a clock comparison, and a refresh only happens near expiry. With the
// observed ~10-day token lifetime that works out to roughly one refresh per
// token, so it does not churn the refresh-token family any harder than the
// lazy path already would.

const DEFAULT_CHECK_INTERVAL_MS = 60_000;

// How far ahead of expiry to renew. Comfortably wider than the request path's
// 5-minute window so a token is replaced well before anything needs it, and far
// short of the token's lifetime so this doesn't refresh on every tick.
const DEFAULT_REFRESH_AHEAD_MS = 30 * 60_000;

export class CodexTokenRefresher {
  constructor(accountManager, {
    intervalMs = DEFAULT_CHECK_INTERVAL_MS,
    refreshAheadMs = DEFAULT_REFRESH_AHEAD_MS,
    log = console.log,
  } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.refreshAheadMs = refreshAheadMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunAt = null;
    this.refreshCount = 0;
  }

  /** Accounts this refresher is responsible for. */
  targets() {
    return this.am.accounts.filter(
      a => a.protocol === 'codex' && a.type === 'oauth' && a.refreshToken && !a.disabled);
  }

  start() {
    if (this.timer) return;
    // Run once immediately: a proxy started after sitting idle for days would
    // otherwise serve its first request on an expired token and pay a
    // synchronous refresh, which is the exact latency this exists to remove.
    this.checkAll().catch(() => {});
    this.timer = setInterval(() => this.checkAll().catch(() => {}), this.intervalMs);
    // Don't hold the event loop open — this must never keep the process alive.
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Refresh every codex account whose token expires within the lookahead
   * window. ensureTokenFresh coalesces with any in-flight refresh and is a
   * no-op for a token that is still comfortably valid, so this is cheap to call
   * often.
   */
  async checkAll() {
    if (this._running) return;
    this._running = true;
    this.lastRunAt = Date.now();
    try {
      const due = this.targets().filter(a => this._isDue(a));
      if (due.length === 0) return;

      await Promise.all(due.map(async account => {
        const secondsLeft = account.expiresAt
          ? Math.round((account.expiresAt - Date.now()) / 1000)
          : null;
        this.log(`[TeamClaude] Codex token for "${account.name}" expires in ${secondsLeft ?? '?'}s — refreshing ahead of use`);
        // Errors are already handled inside ensureTokenFresh, which distinguishes
        // a dead refresh token (sidelines the account) from a transient failure
        // (leaves it serving and retries next tick).
        await this.am.ensureTokenFresh(account.index, false, this.refreshAheadMs);
        this.refreshCount++;
      }));
    } finally {
      this._running = false;
    }
  }

  _isDue(account) {
    // No expiry recorded means we cannot tell how long the token has left.
    // Refreshing on every tick would hammer the token endpoint, so leave it to
    // the request path, which refreshes on a 401.
    if (!account.expiresAt) return false;
    return Date.now() + this.refreshAheadMs >= account.expiresAt;
  }

  status() {
    return {
      enabled: !!this.timer,
      intervalMs: this.intervalMs,
      refreshAheadMs: this.refreshAheadMs,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      refreshCount: this.refreshCount,
      accounts: this.targets().map(a => ({
        name: a.name,
        expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
        due: this._isDue(a),
      })),
    };
  }
}
