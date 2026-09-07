// Opt-in "keep-warm" scheduler (issue #76).
//
// DISABLED BY DEFAULT. When enabled (config.warmupSeconds > 0), periodically
// starts the rolling 5-hour session window on idle accounts, so that when the
// active account runs out the next one is not stone cold.
//
// This is the SECOND sanctioned active-upstream feature (the quota probe is the
// first). It differs in an important way and is why it is strictly opt-in: the
// 5h timer only starts on *real usage*, so — unlike the zero-spend
// /api/oauth/usage probe — warming genuinely consumes a little quota (a few
// tokens, a slice of the 5h window, a touch of the weekly bucket) per account
// per window. To keep that cost minimal we warm an account only when its 5h
// window is not already running, and we use the cheapest model.
//
// Mechanism (chosen in #76): for each eligible idle account we spawn a one-shot,
// minimal `claude` (`--bare -p`) pointed at THIS proxy with the account pinned
// via the `/tc-acct/<index>` path prefix. Using the real client means the
// warm-up request is byte-identical to normal Claude Code traffic, routed to
// exactly the account we want to warm.

import { spawn } from 'node:child_process';
import { encodePinComponent } from './claude-env.js';
import {
  ROLLING_NEAR_RESET_TOLERANCE_MS,
  ROLLING_POST_RESET_BUFFER_MS,
  resolveWarmupSchedule,
} from './warmup-schedule.js';

const SCHEDULE_TIMER_GRACE_MS = 60_000;

export class Warmer {
  constructor(accountManager, {
    intervalMs = 0,
    schedule = null,
    port,
    apiKey = null,
    model = 'haiku',
    prompt = 'hi',
    spawnFn = defaultSpawn,
    timeoutMs = 120_000,
    log = console.log,
    nowFn = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.schedule = schedule;
    this.port = port;
    this.apiKey = apiKey;
    this.model = model;
    this.prompt = prompt;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.nowFn = nowFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this._stopped = false;
    this._scheduleGeneration = 0;
    this._running = false;
    this._runFinished = null;
    this._abort = null; // AbortController for the in-flight sweep (see warmAll/stop)
    this._deferredWarmups = new Map();
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = intervalMs > 0 ? this.nowFn() + intervalMs : null;
    this.scheduleStatus = null;
    this.accountStatus = new Map();
  }

  start() {
    this._stopped = false;
    if (this.schedule) this.rescheduleSchedule(this.schedule);
    else if (this.intervalMs > 0) this.reschedule(this.intervalMs);
  }

  /** Change interval at runtime (0 = off). Warms once immediately when turned on. */
  reschedule(intervalMs) {
    const wasOn = !this.schedule && this.intervalMs > 0 && this.timer;
    this._scheduleGeneration += 1;
    this._stopped = false;
    this.schedule = null;
    this.scheduleStatus = null;
    this.intervalMs = intervalMs;
    if (this.timer) { this.clearTimeoutFn(this.timer); this.timer = null; }
    this._clearDeferredWarmups();
    this._abort?.abort();

    if (intervalMs > 0) {
      this.nextRunAt = this.nowFn() + intervalMs;
      // Immediate sweep only on an off→on transition. Re-running it on every
      // interval *change* would spend quota each time the interval is edited.
      if (!wasOn) this.warmAll().catch(() => {});
      this.timer = setInterval(() => this.warmAll().catch(() => {}), intervalMs);
      this.timer.unref?.();
      this.log(`[TeamClaude] Keep-warm enabled (every ${Math.round(intervalMs / 1000)}s)`);
    } else if (wasOn) {
      this.nextRunAt = null;
      this.log('[TeamClaude] Keep-warm disabled');
    }
  }

  /** Change to a reset-target schedule without replaying missed runs. */
  rescheduleSchedule(schedule) {
    const scheduleStatus = schedule ? resolveWarmupSchedule(schedule, this.nowFn()) : null;
    const generation = ++this._scheduleGeneration;
    this._stopped = false;
    this.intervalMs = 0;
    this.schedule = schedule;
    if (this.timer) { this.clearTimeoutFn(this.timer); this.timer = null; }
    this._clearDeferredWarmups();
    this._abort?.abort();
    if (!schedule) {
      this.scheduleStatus = null;
      this.nextRunAt = null;
      return;
    }
    this._armSchedule(generation, scheduleStatus);
  }

  _armSchedule(generation, scheduleStatus = null) {
    if (generation !== this._scheduleGeneration || this._stopped || !this.schedule) return;
    this.scheduleStatus = scheduleStatus || resolveWarmupSchedule(this.schedule, this.nowFn());
    this.nextRunAt = Date.parse(this.scheduleStatus.nextWarmupAt);
    const delay = Math.max(0, this.nextRunAt - this.nowFn());
    const intendedAt = this.nextRunAt;
    const timer = this.setTimeoutFn(async () => {
      if (generation !== this._scheduleGeneration || this._stopped || !this.schedule) return;
      if (this.timer === timer) this.timer = null;
      const firedAt = this.nowFn();
      if (firedAt < intendedAt || firedAt >= intendedAt + SCHEDULE_TIMER_GRACE_MS) {
        this._armSchedule(generation);
        return;
      }
      await this.warmAll();
      if (generation === this._scheduleGeneration && !this._stopped && this.schedule) {
        this._armSchedule(generation);
      }
    }, delay);
    this.timer = timer;
    this.timer.unref?.();
    this.log(`[TeamClaude] Keep-warm scheduled for ${this.scheduleStatus.nextWarmupAt}`);
  }

  stop() {
    this._scheduleGeneration += 1;
    this._stopped = true;
    if (this.timer) { this.clearTimeoutFn(this.timer); this.timer = null; }
    this._clearDeferredWarmups();
    this.nextRunAt = null;
    // Cancel an in-flight sweep and kill any child it spawned, so shutdown /
    // `warmup off` doesn't block on a running warm-up or orphan a `claude`.
    this._abort?.abort();
  }

  /**
   * True when `account` is a healthy, idle Anthropic OAuth account whose 5h
   * window is NOT already running. We skip:
   *  - non-OAuth and third-party-backend accounts (`upstream` set) — the 5h
   *    concept is Anthropic-specific;
   *  - disabled / errored / exhausted / throttled accounts — warming them is
   *    pointless or would just 429;
   *  - accounts with a live 5h window — already warm, so warming again only burns
   *    quota for nothing.
   */
  _isWarmCandidate(account) {
    if (account.type !== 'oauth' || !account.credential) return false;
    if (account.upstream) return false;
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted' || account.status === 'throttled') return false;
    return true;
  }

  _isWarmTarget(account, now = this.nowFn()) {
    if (!this._isWarmCandidate(account)) return false;
    const reset = account.quota?.unified5hReset;
    return !(reset && now < reset); // a future reset ⇒ session already running
  }

  /** Warm every eligible account once. Overlapping cycles are skipped. Sequential
   *  on purpose: one subprocess at a time keeps load and the quota burst gentle. */
  async warmAll() {
    if (this._running) return;
    const now = this.nowFn();
    const generation = this._scheduleGeneration;
    const targets = [];
    const deferred = [];
    for (const account of this.am.accounts) {
      if (!this._isWarmCandidate(account)) continue;
      const resetAt = Number(account.quota?.unified5hReset);
      const resetRemaining = resetAt - now;
      if (this.schedule?.mode === 'rolling'
        && Number.isFinite(resetAt)
        && resetRemaining > 0
        && resetRemaining <= ROLLING_NEAR_RESET_TOLERANCE_MS) {
        deferred.push({ account, runAt: resetAt + ROLLING_POST_RESET_BUFFER_MS });
      } else if (this._isWarmTarget(account, now)) {
        targets.push(account);
      }
    }

    await this._warmTargets(targets, { generation });
    for (const item of deferred) {
      this._deferWarmAccount(item.account, item.runAt, generation);
    }
  }

  async _warmTargets(targets, {
    generation = this._scheduleGeneration,
    waitForRunning = false,
    deadline = null,
  } = {}) {
    while (this._running) {
      if (!waitForRunning) return false;
      await this._runFinished;
    }
    if (generation !== this._scheduleGeneration || this._stopped) return false;
    if (deadline !== null && this.nowFn() >= deadline) return false;
    this._running = true;
    let finishRun;
    const runFinished = new Promise(resolve => { finishRun = resolve; });
    this._runFinished = runFinished;
    const abort = this._abort = new AbortController();
    this.lastRunStartedAt = Date.now();
    if (this.intervalMs > 0) this.nextRunAt = this.lastRunStartedAt + this.intervalMs;
    try {
      for (const account of targets) {
        const canContinue = () => generation === this._scheduleGeneration
          && !this._stopped
          && (deadline === null || this.nowFn() < deadline);
        if (abort.signal.aborted || !canContinue()) break;
        const isStillEligible = () => this._isWarmTarget(account);
        if (!isStillEligible()) continue;
        await this.warmAccount(
          account,
          abort.signal,
          canContinue,
          isStillEligible,
        );
      }
      return true;
    } finally {
      this.lastRunFinishedAt = Date.now();
      this._running = false;
      if (this._abort === abort) this._abort = null;
      if (this._runFinished === runFinished) this._runFinished = null;
      finishRun();
    }
  }

  _deferWarmAccount(account, runAt, generation) {
    if (generation !== this._scheduleGeneration || this._stopped || this.schedule?.mode !== 'rolling') return;
    if (this._deferredWarmups.has(account)) return;
    const delay = Math.max(0, runAt - this.nowFn());
    const timer = this.setTimeoutFn(async () => {
      if (this._deferredWarmups.get(account) === timer) this._deferredWarmups.delete(account);
      if (generation !== this._scheduleGeneration || this._stopped || this.schedule?.mode !== 'rolling') return;
      const remaining = runAt - this.nowFn();
      if (remaining > 0) {
        this._deferWarmAccount(account, runAt, generation);
        return;
      }
      const deadline = runAt + SCHEDULE_TIMER_GRACE_MS;
      if (this.nowFn() >= deadline) return;
      if (!this._isWarmTarget(account)) return;
      await this._warmTargets([account], {
        generation,
        waitForRunning: true,
        deadline,
      });
    }, delay);
    this._deferredWarmups.set(account, timer);
    timer.unref?.();
    this.log(`[TeamClaude] Keep-warm delaying "${account.name}" until ${new Date(runAt).toISOString()} (5h reset within 2m)`);
  }

  _clearDeferredWarmups() {
    for (const timer of this._deferredWarmups.values()) this.clearTimeoutFn(timer);
    this._deferredWarmups.clear();
  }

  async warmAccount(account, signal, shouldContinue = () => true, isStillEligible = () => true) {
    const startedAt = Date.now();
    const previousStatus = this.accountStatus.get(account.name);
    this._record(account, { status: 'running', startedAt });
    try {
      await this.am.ensureTokenFresh(account.index);
      if (signal?.aborted || !shouldContinue()) {
        if (previousStatus) this.accountStatus.set(account.name, previousStatus);
        else this.accountStatus.delete(account.name);
        return;
      }
      if (account.status === 'error') {
        const finishedAt = Date.now();
        this._record(account, {
          status: 'error',
          error: 'token refresh rejected; re-login required',
          startedAt, finishedAt, durationMs: finishedAt - startedAt,
        });
        return;
      }
      if (!isStillEligible()) {
        if (previousStatus) this.accountStatus.set(account.name, previousStatus);
        else this.accountStatus.delete(account.name);
        return;
      }
      const code = await this.spawnFn(this._spawnSpec(account, signal));
      const finishedAt = Date.now();
      this._record(account, {
        status: code === 0 ? 'ok' : 'error',
        error: code === 0 ? null : `claude exited ${code}`,
        startedAt, finishedAt, durationMs: finishedAt - startedAt,
      });
    } catch (err) {
      const finishedAt = Date.now();
      this._record(account, {
        status: 'error',
        error: err?.message || String(err),
        startedAt, finishedAt, durationMs: finishedAt - startedAt,
      });
    }
  }

  /** The `claude` invocation for one account. Pure/deterministic so tests can
   *  assert the args and env without spawning anything. */
  _spawnSpec(account, signal) {
    // Pin by accountUuid — a stable identity. The rotation index is NOT usable:
    // it is array position, so removing an account would repoint this at a
    // different one. Fall back to the display name when the uuid isn't known
    // yet (e.g. an API-key account, or before the first profile fetch).
    const pin = encodePinComponent(account.accountUuid || account.name);
    const baseUrl = `http://127.0.0.1:${this.port}/tc-acct/${pin}`;
    return {
      command: 'claude',
      // `--bare -p`: minimal, non-interactive, auth strictly via ANTHROPIC_API_KEY
      // (which this proxy strips and replaces with the pinned account's token).
      args: ['-p', '--bare', '--model', this.model, '--output-format', 'text', this.prompt],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: this.apiKey || 'tc-warm',
      },
      timeoutMs: this.timeoutMs,
      signal, // aborts (and kills the child) when the warmer is stopped
    };
  }

  getStatus() {
    const schedule = this.scheduleStatus || null;
    return {
      enabled: !!this.schedule || this.intervalMs > 0,
      mode: this.schedule ? 'reset' : (this.intervalMs > 0 ? 'interval' : 'off'),
      intervalSeconds: Math.round(this.intervalMs / 1000),
      ...(schedule || {}),
      running: this._running,
      lastRunStartedAt: iso(this.lastRunStartedAt),
      lastRunFinishedAt: iso(this.lastRunFinishedAt),
      nextRunAt: iso(this.nextRunAt),
      accounts: this.am.accounts.map(account => {
        const status = this.accountStatus.get(account.name);
        const applicable = account.type === 'oauth' && !account.upstream;
        return {
          name: account.name,
          status: applicable ? (status?.status || 'never') : 'not-applicable',
          lastWarmedAt: iso(status?.finishedAt),
          startedAt: iso(status?.startedAt),
          durationMs: status?.durationMs ?? null,
          error: status?.error || null,
        };
      }),
    };
  }

  _record(account, status) {
    this.accountStatus.set(account.name, {
      ...(this.accountStatus.get(account.name) || {}),
      ...status,
    });
  }
}

// Spawn a one-shot `claude`, resolving with its exit code (non-zero ⇒ recorded as
// an error) or rejecting if the binary can't launch (e.g. not on PATH) or the
// warm-up overruns its timeout. stdio is ignored: we only care that a request
// went through to start the timer.
function defaultSpawn({ command, args, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('warm-up aborted')); return; }
    let child;
    try {
      child = spawn(command, args, { env, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`warm-up timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', (err) => { cleanup(); reject(err); });
    child.once('exit', (code, sigName) => {
      cleanup();
      // A signal-killed child (OOM, external kill, our own abort) did NOT
      // complete a warm-up — report it as an error, not a success (code null).
      if (sigName) { reject(new Error(`claude terminated by ${sigName}`)); return; }
      resolve(code ?? 0);
    });
  });
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}
