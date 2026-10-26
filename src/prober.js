// Opt-in background quota probe.
//
// DISABLED BY DEFAULT. When enabled (config.quotaProbeSeconds > 0), periodically
// reads an OAuth account's quota zero-spend /api/oauth/usage endpoint so idle
// accounts' utilization/reset stay fresh without waiting to rotate onto them.
// A sanctioned active-upstream feature (the other is the opt-in keep-warm
// scheduler, warmer.js); the proxy is otherwise passive. Unlike keep-warm, this
// probe reads a zero-spend endpoint and never consumes message quota.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fetchUsage } from './oauth.js';
import { fetchQuotaFor } from './quota-sources.js';
import { isSubscriptionSource } from './subscription-quota.js';
import { usageFromQuotaState } from './usage-display.js';

function resolveQuotaStatePath(p) {
  return String(p).replace(/^~/, homedir());
}

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, timeoutMs = 10_000, log = console.log } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.probeFn = probeFn;
    this.timeoutMs = timeoutMs;
    // per-command min interval (ms): avoids re-executing a probeCommand that
    // the previous cycle is still running (oneshot, no overlapping).
    this._cmdRuns = new Map();
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = intervalMs > 0 ? Date.now() + intervalMs : null;
    this.accountStatus = new Map();
  }

  start() {
    this.reschedule(this.intervalMs);
  }

  /** Change interval at runtime (0 = off). Probes once immediately when on. */
  reschedule(intervalMs) {
    for (const account of this.am.accounts) {
      if (account.disabled || account.retired || !isSubscriptionSource(account.quotaSource)) continue;
      const maxAge = account.quotaSource.maxAgeMs ?? 90000;
      if (!Number.isFinite(maxAge) || maxAge <= 0 || !Number.isFinite(intervalMs)
          || intervalMs <= 0 || intervalMs > maxAge / 3) {
        throw new Error('Subscription quota sources require positive quotaProbeSeconds <= maxAgeMs / 3000 (default: 30 seconds)');
      }
    }
    const wasOn = this.intervalMs > 0 && this.timer;
    this.intervalMs = intervalMs;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (intervalMs > 0) {
      this.nextRunAt = Date.now() + intervalMs;
      // Immediate probe only on an off→on transition — not on every interval
      // change (mirrors warmer.js; avoids an extra burst when the interval is edited).
      // Skip if the caller already awaited probeAll() before listen so a
      // restart does not double-hit CLIProxy management.
      if (!wasOn && !this.lastRunFinishedAt) this.probeAll().catch(() => {});
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

  /** Probe every OAuth account + apikey accounts with probeCommand. Overlapping cycles are skipped. */
  async probeAll() {
    if (this._running) return;
    this._running = true;
    this.lastRunStartedAt = Date.now();
    this.nextRunAt = this.intervalMs > 0 ? this.lastRunStartedAt + this.intervalMs : null;
    try {
      const oauth = this.am.accounts.filter(account =>
        account.type === 'oauth' && account.credential && !account.retired && !account.disabled);
      const cmd = this.am.accounts.filter(account =>
        (account.type === 'apikey') && account.probeCommand && !account.retired && !account.disabled);
      const src = this.am.accounts.filter(account =>
        (account.type === 'apikey') && account.quotaSource && !account.retired && !account.disabled);
      const balance = this.am.accounts.filter(account =>
        account.balanceSource && !account.retired && !account.disabled);
      await Promise.all([
        ...oauth.map(account => this.probeAccount(account)),
        ...cmd.map(account => this.probeCommandAccount(account)),
        ...src.map(account => this.probeQuotaSourceAccount(account)),
        ...balance.map(account => this.probeQuotaSourceAccount(account, account.balanceSource)),
      ]);
    } finally {
      this.lastRunFinishedAt = Date.now();
      this._running = false;
    }
  }

  /** Execute a configured probeCommand for an apikey account. The command
   *  writes quota state JSON to a file; teamclaude reads the file directly
   *  (per-account quotaStateFile) and stamps unified-ratelimit headers via
   *  the anthropic-proxy layer on the next pass.
   *
   *  Single-flight: overlapping cycles skip the same command. */
  async probeCommandAccount(account) {
    const cmd = (account.probeCommand || '').trim();
    if (!cmd) return;
    const last = this._cmdRuns.get(account.name) || 0;
    const minGap = 120_000;  // 2min cooldown — the external probe writes the file
    if (Date.now() - last < minGap) return;
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
    try {
      await new Promise((resolve, reject) => {
        const child = execFile('bash', ['-c', cmd], {
          timeout: this.timeoutMs,
          env: { ...process.env },
        });
        child.on('exit', (code) => {
          this._cmdRuns.set(account.name, Date.now());
          code === 0 ? resolve() : reject(new Error(`probeCommand exit ${code}`));
        });
        child.on('error', reject);
        // Discard stdout/stderr — the probe writes its own file
        child.stdout?.resume();
        child.stderr?.resume();
      });
      await this._applyQuotaStateFile(account);
      const finishedAt = Date.now();
      this._recordAccount(account, { status: 'ok', error: null, startedAt, finishedAt, durationMs: finishedAt - startedAt });
    } catch (err) {
      const finishedAt = Date.now();
      this._recordAccount(account, { status: 'error', error: err?.message || String(err), startedAt, finishedAt, durationMs: finishedAt - startedAt });
    }
  }

  /** Ingest probeCommand's quotaStateFile. Fail-safe: missing/malformed files
   *  leave the account's existing quota untouched. */
  async _applyQuotaStateFile(account) {
    const path = (account.quotaStateFile || '').trim();
    if (!path) return;
    try {
      const raw = await readFile(resolveQuotaStatePath(path), 'utf8');
      const usage = usageFromQuotaState(JSON.parse(raw));
      if (usage) this.am.applyUsageData(account.index, usage);
    } catch {
      // leave existing quota
    }
  }

  /** Probe an apikey account's built-in native quota source (account.quotaSource).
   *  Runs in-process — no shell, no external state file — and applies the
   *  result via applyUsageData. On error the account's existing quota is left
   *  untouched (fail-safe: unknown ranks at Infinity, never 0% used). */
  async probeQuotaSourceAccount(account, source = account.quotaSource) {
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
    try {
      const usage = await this._withTimeout(
        fetchQuotaFor(source, { switchThreshold: this.am.switchThreshold }));
      if (isSubscriptionSource(source) && source !== account.quotaSource) return;
      if (!usage || usage.error) {
        if (isSubscriptionSource(source)) account.subscriptionError = usage?.error || 'Subscription quota probe timed out';
        if (source === account.balanceSource) account.balanceError = usage?.error || 'Balance refresh timed out';
        const finishedAt = Date.now();
        this._recordAccount(account, {
          status: usage?.error ? 'error' : 'timeout',
          error: usage?.error || 'quota source probe timed out',
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        });
        return;
      }
      this.am.applyUsageData(account.index, usage);
      if (source === account.balanceSource) account.balanceError = null;
      const finishedAt = Date.now();
      this._recordAccount(account, {
        status: 'ok',
        error: null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    } catch (err) {
      if (isSubscriptionSource(source) && source !== account.quotaSource) return;
      if (isSubscriptionSource(source)) account.subscriptionError = 'Subscription quota refresh failed';
      if (source === account.balanceSource) account.balanceError = 'Balance refresh failed';
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

  async probeAccount(account) {
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
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
        const probeType = account.type === 'oauth' ? 'oauth-usage'
          : account.probeCommand ? 'probeCommand'
          : account.balanceSource ? 'balance'
          : account.quotaSource ? 'quotaSource'
          : 'not-applicable';
        return {
          name: account.name,
          type: probeType,
          status: probeType === 'not-applicable' ? 'not-applicable' : (status?.status || 'never'),
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
