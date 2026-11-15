// Opt-in background quota probe.
//
// DISABLED BY DEFAULT. When enabled (config.quotaProbeSeconds > 0), periodically
// reads an OAuth account's quota zero-spend /api/oauth/usage endpoint so idle
// accounts' utilization/reset stay fresh without waiting to rotate onto them.
// A sanctioned active-upstream feature (the other is the opt-in keep-warm
// scheduler, warmer.js); the proxy is otherwise passive. Unlike keep-warm, this
// probe reads a zero-spend endpoint and never consumes message quota.

import { fetchUsage } from './oauth.js';
import { parseResetStatus } from './claude-resets.js';
import { rememberResetReading } from './reset-readings.js';
import { fetchBackendQuota, hasBackendQuota } from './backend-quota.js';
import { providerOf } from './provider.js';
import { fetchCodexUsage } from './codex-usage.js';
import { fetchGrokUsage } from './grok-usage.js';
import { fetchResetCreditDetails, creditDetailsDue, CREDIT_DETAILS_RETRY_MS } from './codex-reset-credits.js';

// Node's timers take a 32-bit signed delay: anything above 2^31-1 ms is
// coerced to 1 ms, so an interval large enough to mean "practically never"
// would instead probe in a tight loop. The TUI and CLI accept any number of
// seconds, so the ceiling lives here where the timer is armed.
export const MAX_PROBE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// How often an account's OAuth profile is read again once its plan is known. A
// plan that lapses shows there (see AccountManager.applyProfileData), and it
// changes far more rarely than quota does.
export const PROFILE_RECHECK_MS = 60 * 60 * 1000;

function clampInterval(ms) {
  return ms > 0 ? Math.min(ms, MAX_PROBE_INTERVAL_MS) : 0;
}

// Which accounts the probe reads, one rule per source. Exported so the status
// payload a server builds before its Prober exists states the same answer the
// Prober will (#512), instead of keeping a copy of the rule.
const isAnthropicProbeTarget = (/** @type {any} */ account) => !!account && providerOf(account) === 'anthropic'
  && account.type === 'oauth' && !!account.credential && !account.upstream;

const isCodexProbeTarget = (/** @type {any} */ account) => !!account && providerOf(account) === 'codex'
  && account.type === 'oauth' && !!account.credential && !!account.accountId && !account.upstream;

const isGrokProbeTarget = (/** @type {any} */ account) => !!account && providerOf(account) === 'grok'
  && account.type === 'oauth' && !!account.credential && !account.upstream;

const isBackendProbeTarget = (/** @type {any} */ account) => !!account?.credential && hasBackendQuota(account);

/**
 * True when the quota probe has something to read for this account: an
 * Anthropic, Codex or Grok subscription, or a third-party backend that publishes a
 * quota of its own. Anything else reads `not-applicable` in the probe status.
 * @param {any} account
 * @returns {boolean}
 */
export function probeApplicable(account) {
  return isAnthropicProbeTarget(account) || isCodexProbeTarget(account) || isGrokProbeTarget(account) || isBackendProbeTarget(account);
}

export class Prober {
  // `log` resolves the console per call rather than capturing it. A default
  // parameter is evaluated when the constructor runs, and the server builds its
  // prober in the same tick as `server.listen()` — before the listen callback
  // reaches `tui.start()`, which swaps `console.log` for the activity log. The
  // notices below are produced later still, by a reload that changes the probe
  // interval, so a captured `console.log` would put them on a terminal the
  // alternate screen has already covered.
  //
  // `config` is the SHARED config object, not a snapshot: `probeDisabledAccounts`
  // is read off it per cycle, so a TUI toggle or a reload applies on the next
  // probe without a reschedule.
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, codexProbeFn = fetchCodexUsage, grokProbeFn = fetchGrokUsage, codexCreditsFn = fetchResetCreditDetails, profileFn = null, profileIntervalMs = PROFILE_RECHECK_MS, backendFn = fetchBackendQuota, timeoutMs = 10_000, config = null, log = (/** @type {string} */ line) => console.log(line) } = {}) {
    this.am = accountManager;
    /** @type {{ probeDisabledAccounts?: boolean } | null} */
    this.config = config;
    this.intervalMs = clampInterval(intervalMs);
    this.probeFn = probeFn;
    this.codexProbeFn = codexProbeFn;
    this.grokProbeFn = grokProbeFn;
    this.codexCreditsFn = codexCreditsFn;
    // When each Codex account's last credit-row read failed. A failure leaves
    // the dates as due as they were, so without this a 429 or a timeout would
    // be retried on every probe cycle instead of every CREDIT_DETAILS_RETRY_MS.
    /** @type {WeakMap<object, number>} */
    this._creditReadFailedAt = new WeakMap();
    this.profileFn = profileFn;
    this.profileIntervalMs = profileIntervalMs;
    // By account object: names are not unique.
    this.profileReadAt = new WeakMap();
    this.backendFn = backendFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = this.intervalMs > 0 ? Date.now() + this.intervalMs : null;
    this.accountStatus = new Map();
    // One probe per account at a time, keyed by the account object: a card's
    // refresh landing during a fleet cycle would otherwise refresh the token
    // and read the endpoint twice for one answer.
    this._inFlight = new Map();
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
        this._probeable(account) && probeApplicable(account));
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
    return isAnthropicProbeTarget(account);
  }

  _isCodexProbeTarget(account) {
    return isCodexProbeTarget(account);
  }

  /** A third-party backend that publishes a quota of its own. The provider
   * module decides which; nothing in this file knows one by name. */
  _isBackendTarget(account) {
    return isBackendProbeTarget(account);
  }

  // Only accounts in rotation are probed. A probe forces a token refresh and
  // sends the access token upstream, and neither belongs to an account the
  // operator took out of service (`disabled`) or one whose refresh token upstream
  // has already rejected — refreshing it again only rotates the token family
  // once more, and its access token cannot be trusted either. The manager's
  // dead-token guard is keyed on the token value, so a re-login lifts this skip
  // on its own.
  //
  // `probeDisabledAccounts` lifts the first skip, and only that one: the
  // operator asked for a disabled account's quota to stay current while it is
  // out of rotation, and accepts the refresh that comes with it. A dead token
  // stays skipped either way.
  _probeable(account) {
    if (!account?.credential) return false;
    if (account.disabled && this.config?.probeDisabledAccounts !== true) return false;
    if (account._deadRefreshToken && account._deadRefreshToken === account.refreshToken) return false;
    return true;
  }

  /**
   * Probe one account now: the dashboard card's refresh button. It applies the
   * same two rules a fleet cycle does (the account has a quota to read, and is
   * in rotation), so a single refresh never reaches an account the fleet
   * probe would leave alone. A probe of this account already in flight, from a
   * fleet cycle or an earlier click, is joined rather than doubled.
   *
   * @param {any} account
   * @returns {Promise<{ probed: true, status: any } | { probed: false, reason: string }>}
   */
  async probeOne(account) {
    if (!probeApplicable(account)) return { probed: false, reason: 'this account has no quota the probe can read' };
    if (account.disabled) return { probed: false, reason: 'the account is disabled' };
    if (!this._probeable(account)) return { probed: false, reason: 'upstream rejected its refresh token; sign in again' };
    // The probe's own record, not accountStatus: that map is keyed by name,
    // and a namesake (a Claude and a Codex account on one email) probed at the
    // same moment would overwrite it before this read.
    return { probed: true, status: await this.probeAccount(account) };
  }

  /** @param {any} account */
  probeAccount(account) {
    const pending = this._inFlight.get(account);
    if (pending) return pending;
    const run = this._probeAccount(account).finally(() => this._inFlight.delete(account));
    this._inFlight.set(account, run);
    return run;
  }

  async _probeAccount(account) {
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
    // A third-party backend has no Anthropic usage to read; it publishes its own
    // figure, or none. Same schedule, same status row, different source.
    if (this._isBackendTarget(account)) return this._probeBackend(account, startedAt);
    if (this._isCodexProbeTarget(account)) return this._probeCodex(account, startedAt);
    if (isGrokProbeTarget(account)) return this._probePlanUsage(account, startedAt, this.grokProbeFn);
    try {
      await this.am.ensureTokenFresh(account.index);
      const readOptions = {
        onPayload: (/** @type {any} */ data) => rememberResetReading(account, 'claude', { reset: parseResetStatus(data?.cedar_ember) }),
      };
      let usage = await this._withTimeout(this.probeFn(account.credential, account.routing ?? null, readOptions));
      if (usage?.status === 401) {
        // Token rejected: force refresh and retry once.
        await this.am.ensureTokenFresh(account.index, true);
        usage = await this._withTimeout(this.probeFn(account.credential, account.routing ?? null, readOptions));
      }

      if (!usage || usage.error) {
        rememberResetReading(account, 'claude', usage ?? { error: 'probe timed out' });
        // A refused usage read can be the lapsed plan itself; the profile says.
        if (usage) await this._readProfile(account);
        const finishedAt = Date.now();
        return this._recordAccount(account, {
          status: usage?.error ? 'error' : 'timeout',
          error: usage?.error || 'probe timed out',
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        });
      }

      this.am.applyUsageData(account.index, usage);
      await this._readProfile(account);
      const finishedAt = Date.now();
      return this._recordAccount(account, {
        status: 'ok',
        error: null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    } catch (err) {
      const finishedAt = Date.now();
      return this._recordAccount(account, {
        status: 'error',
        error: err?.message || String(err),
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    }
  }

  /** @param {Record<string, any>} account */
  async _readProfile(account) {
    if (!this.profileFn) return;
    const missingTier = !account.rateLimitTier && !account.seatTier
      && account.hasClaudeMax == null && account.hasClaudePro == null;
    // The email too: an account added before emails were kept has none, and
    // the profile read costs no quota. Once found it is kept in the state
    // file, so the wait between re-reads applies again from then on.
    const missingIdentity = missingTier || !account.email;
    const now = Date.now();
    if (!missingIdentity && now - (this.profileReadAt.get(account) ?? -Infinity) < this.profileIntervalMs) return;
    this.profileReadAt.set(account, now);
    const profile = await this._withTimeout(this.profileFn(account.credential, account.routing ?? null));
    this.am.applyProfileData(account.index, profile);
  }

  async _probeCodex(account, startedAt) {
    return this._probePlanUsage(account, startedAt, this.codexProbeFn, async () => {
      // The usage read counts the account's reset credits but does not say when
      // they expire; the credit rows do. Read them only when that count is new
      // or the dates are old, so a probe costs one more read at most that often.
      // Best effort: the quota reading above stands whatever this returns.
      const failedAt = this._creditReadFailedAt.get(account);
      if (creditDetailsDue(account.quota?.resetCredits) && !(failedAt != null && Date.now() - failedAt < CREDIT_DETAILS_RETRY_MS)) {
        const details = await this._withTimeout(this.codexCreditsFn(account, { timeoutMs: this.timeoutMs })).catch(() => null);
        if (details && !details.error && Array.isArray(details.credits)) {
          this._creditReadFailedAt.delete(account);
          this.am.applyResetCreditDetails(account.index, details.credits);
        } else {
          this._creditReadFailedAt.set(account, Date.now());
        }
      }
    });
  }

  /**
   * Read a subscription's plan usage from its provider's own endpoint (Codex,
   * Grok), refreshing the token first and once more on a 401.
   * @param {any} account
   * @param {number} startedAt
   * @param {(account: any) => Promise<any>} fetchUsage
   * @param {() => Promise<void>} [after]  provider extras, once the reading has landed
   */
  async _probePlanUsage(account, startedAt, fetchUsage, after) {
    try {
      await this.am.ensureTokenFresh(account.index);
      let usage = await this._withTimeout(fetchUsage(account));
      if (usage?.status === 401) {
        await this.am.ensureTokenFresh(account.index, true);
        usage = await this._withTimeout(fetchUsage(account));
      }
      if (!usage || usage.error) {
        const finishedAt = Date.now();
        return this._recordAccount(account, { status: usage?.error ? 'error' : 'timeout', error: usage?.error || 'probe timed out', startedAt, finishedAt, durationMs: finishedAt - startedAt });
      }
      this.am.applyPlanUsageData(account.index, usage);
      await after?.();
      const finishedAt = Date.now();
      return this._recordAccount(account, { status: 'ok', error: null, startedAt, finishedAt, durationMs: finishedAt - startedAt });
    } catch (err) {
      const finishedAt = Date.now();
      return this._recordAccount(account, { status: 'error', error: err?.message || String(err), startedAt, finishedAt, durationMs: finishedAt - startedAt });
    }
  }

  /** Read one backend account's own quota through the provider module. */
  async _probeBackend(account, startedAt) {
    const reading = await this.backendFn(account, { timeoutMs: this.timeoutMs })
      .catch(err => ({ error: err?.message || String(err) }));
    const finishedAt = Date.now();
    const failure = reading && 'error' in reading ? reading.error : null;
    const failed = !reading || !!failure;
    if (!failed) this.am.applyBackendQuota(account.index, reading);
    return this._recordAccount(account, {
      status: failed ? 'error' : 'ok',
      error: failed ? (failure || 'no reading') : null,
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
          status: probeApplicable(account) ? (status?.status || 'never') : 'not-applicable',
          lastProbedAt: iso(status?.finishedAt),
          startedAt: iso(status?.startedAt),
          durationMs: status?.durationMs ?? null,
          error: status?.error || null,
        };
      }),
    };
  }

  /** Merge into the account's status row and return the row as it now stands. */
  _recordAccount(account, status) {
    const row = { ...(this.accountStatus.get(account.name) || {}), ...status };
    this.accountStatus.set(account.name, row);
    return row;
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
