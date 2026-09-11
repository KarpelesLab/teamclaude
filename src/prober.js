// Opt-in background quota probe.
//
// DISABLED BY DEFAULT. When enabled (config.quotaProbeSeconds > 0), periodically
// reads an OAuth account's quota zero-spend /api/oauth/usage endpoint so idle
// accounts' utilization/reset stay fresh without waiting to rotate onto them.
// A sanctioned active-upstream feature (the other is the opt-in keep-warm
// scheduler, warmer.js); the proxy is otherwise passive. Unlike keep-warm, this
// probe reads a zero-spend endpoint and never consumes message quota.

import { fetchUsage } from './oauth.js';
import { fetchBackendQuota, hasBackendQuota } from './backend-quota.js';
import { providerOf } from './provider.js';

// Node's timers take a 32-bit signed delay: anything above 2^31-1 ms is
// coerced to 1 ms, so an interval large enough to mean "practically never"
// would instead probe in a tight loop. The TUI and CLI accept any number of
// seconds, so the ceiling lives here where the timer is armed.
export const MAX_PROBE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function clampInterval(ms) {
  return ms > 0 ? Math.min(ms, MAX_PROBE_INTERVAL_MS) : 0;
}

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, profileFn = null, backendFn = fetchBackendQuota, timeoutMs = 10_000, log = console.log } = {}) {
    this.am = accountManager;
    this.intervalMs = clampInterval(intervalMs);
    this.probeFn = probeFn;
    this.profileFn = profileFn;
    this.backendFn = backendFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = this.intervalMs > 0 ? Date.now() + this.intervalMs : null;
    this.accountStatus = new Map();
  }

  start() {
    if (this.intervalMs > 0) this.reschedule(this.intervalMs);
  }

  /** Change interval at runtime (0 = off). Probes once immediately when on. */
  reschedule(intervalMs) {
    const wasOn = this.intervalMs > 0 && this.timer;
    intervalMs = clampInterval(intervalMs);
    this.intervalMs = intervalMs;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (intervalMs > 0) {
      this.nextRunAt = Date.now() + intervalMs;
      // Immediate probe only on an off→on transition — not on every interval
      // change (mirrors warmer.js; avoids an extra burst when the interval is edited).
      if (!wasOn) this.probeAll().catch(() => {});
      this.timer = setInterval(() => this.probeAll().catch(() => {}), intervalMs);
      this.timer.unref?.();
      this.log(`[TeamClaude] Quota probe enabled (every ${Math.round(intervalMs / 1000)}s)`);
    } else if (wasOn) {
      this.nextRunAt = null;
      this.log('[TeamClaude] Quota probe disabled');
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.nextRunAt = null;
  }

  /** Probe every OAuth account once. Overlapping cycles are skipped. */
  async probeAll() {
    if (this._running) return;
    this._running = true;
    this.lastRunStartedAt = Date.now();
    this.nextRunAt = this.intervalMs > 0 ? this.lastRunStartedAt + this.intervalMs : null;
    try {
      const accounts = this.am.accounts.filter(account =>
        this._probeable(account) && (this._isProbeTarget(account) || this._isBackendTarget(account)));
      await Promise.all(accounts.map(account => this.probeAccount(account)));
    } finally {
      this.lastRunFinishedAt = Date.now();
      this._running = false;
    }
  }

  /**
   * Whether this account has Anthropic subscription usage to read.
   *
   * `/api/oauth/usage` is Anthropic's own endpoint, and its URL is fixed — a
   * third-party backend account (`upstream` set) carries a DIFFERENT provider's
   * key, which the probe would send to api.anthropic.com every cycle. That
   * leaks the key to a party it was never issued for, and the answer it gets
   * back (429) is recorded as a permanent probe error against an account that
   * is serving traffic perfectly well. The keep-warm scheduler already draws
   * this line (warmer.js `_isWarmTarget`); the probe did not.
   */
  _isProbeTarget(account) {
    return !!account && providerOf(account) === 'anthropic'
      && account.type === 'oauth' && !!account.credential && !account.upstream;
  }

  /** A third-party backend that publishes a quota of its own. The provider
   * module decides which; nothing in this file knows one by name. */
  _isBackendTarget(account) {
    return !!account?.credential && hasBackendQuota(account);
  }

  // Only accounts in rotation are probed. A probe forces a token refresh and
  // sends the access token upstream, and neither belongs to an account the
  // operator took out of service (`disabled`) or one whose refresh token upstream
  // has already rejected — refreshing it again only rotates the token family
  // once more, and its access token cannot be trusted either. The manager's
  // dead-token guard is keyed on the token value, so a re-login lifts this skip
  // on its own.
  _probeable(account) {
    if (!account?.credential) return false;
    if (account.disabled) return false;
    if (account._deadRefreshToken && account._deadRefreshToken === account.refreshToken) return false;
    return true;
  }

  async probeAccount(account) {
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
    // A third-party backend has no Anthropic usage to read; it publishes its own
    // figure, or none. Same schedule, same status row, different source.
    if (this._isBackendTarget(account)) return this._probeBackend(account, startedAt);
    try {
      await this.am.ensureTokenFresh(account.index);
      let usage = await this._withTimeout(this.probeFn(account.credential));
      if (usage?.status === 401) {
        // Token rejected: force refresh and retry once.
        await this.am.ensureTokenFresh(account.index, true);
        usage = await this._withTimeout(this.probeFn(account.credential));
      }

      if (!usage || usage.error) {
        const finishedAt = Date.now();
        this._recordAccount(account, {
          status: usage?.error ? 'error' : 'timeout',
          error: usage?.error || 'probe timed out',
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        });
        return;
      }

      this.am.applyUsageData(account.index, usage);
      const missingTier = !account.rateLimitTier && !account.seatTier
        && account.hasClaudeMax == null && account.hasClaudePro == null;
      if (missingTier && this.profileFn) {
        const profile = await this._withTimeout(this.profileFn(account.credential));
        this.am.applyProfileData(account.index, profile);
      }
      const finishedAt = Date.now();
      this._recordAccount(account, {
        status: 'ok',
        error: null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    } catch (err) {
      const finishedAt = Date.now();
      this._recordAccount(account, {
        status: 'error',
        error: err?.message || String(err),
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    }
  }

  /** Read one backend account's own quota through the provider module. */
  async _probeBackend(account, startedAt) {
    const reading = await this.backendFn(account, { timeoutMs: this.timeoutMs })
      .catch(err => ({ error: err?.message || String(err) }));
    const finishedAt = Date.now();
    const failed = !reading || reading.error;
    if (!failed) this.am.applyBackendQuota(account.index, reading);
    this._recordAccount(account, {
      status: failed ? 'error' : 'ok',
      error: failed ? (reading?.error || 'no reading') : null,
      startedAt, finishedAt, durationMs: finishedAt - startedAt,
    });
  }

  getStatus() {
    return {
      enabled: this.intervalMs > 0,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      running: this._running,
      lastRunStartedAt: iso(this.lastRunStartedAt),
      lastRunFinishedAt: iso(this.lastRunFinishedAt),
      nextRunAt: iso(this.nextRunAt),
      accounts: this.am.accounts.map(account => {
        const status = this.accountStatus.get(account.name);
        return {
          name: account.name,
          status: (this._isProbeTarget(account) || this._isBackendTarget(account))
            ? (status?.status || 'never') : 'not-applicable',
          lastProbedAt: iso(status?.finishedAt),
          startedAt: iso(status?.startedAt),
          durationMs: status?.durationMs ?? null,
          error: status?.error || null,
        };
      }),
    };
  }

  _recordAccount(account, status) {
    this.accountStatus.set(account.name, {
      ...(this.accountStatus.get(account.name) || {}),
      ...status,
    });
  }

  _withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise(resolve => {
        const t = setTimeout(() => resolve(null), this.timeoutMs);
        t.unref?.();
      }),
    ]);
  }
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}
