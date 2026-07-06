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

export class Warmer {
  constructor(accountManager, {
    intervalMs = 0,
    port,
    apiKey = null,
    model = 'haiku',
    prompt = 'hi',
    spawnFn = defaultSpawn,
    timeoutMs = 120_000,
    log = console.log,
  } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.port = port;
    this.apiKey = apiKey;
    this.model = model;
    this.prompt = prompt;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = intervalMs > 0 ? Date.now() + intervalMs : null;
    this.accountStatus = new Map();
  }

  start() {
    if (this.intervalMs > 0) this.reschedule(this.intervalMs);
  }

  /** Change interval at runtime (0 = off). Warms once immediately when turned on. */
  reschedule(intervalMs) {
    const wasOn = this.intervalMs > 0 && this.timer;
    this.intervalMs = intervalMs;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (intervalMs > 0) {
      this.nextRunAt = Date.now() + intervalMs;
      this.warmAll().catch(() => {});
      this.timer = setInterval(() => this.warmAll().catch(() => {}), intervalMs);
      this.timer.unref?.();
      this.log(`[TeamClaude] Keep-warm enabled (every ${Math.round(intervalMs / 1000)}s)`);
    } else if (wasOn) {
      this.nextRunAt = null;
      this.log('[TeamClaude] Keep-warm disabled');
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.nextRunAt = null;
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
  _isWarmTarget(account) {
    if (account.type !== 'oauth' || !account.credential) return false;
    if (account.upstream) return false;
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted' || account.status === 'throttled') return false;
    const reset = account.quota?.unified5hReset;
    return !(reset && Date.now() < reset); // a future reset ⇒ session already running
  }

  /** Warm every eligible account once. Overlapping cycles are skipped. Sequential
   *  on purpose: one subprocess at a time keeps load and the quota burst gentle. */
  async warmAll() {
    if (this._running) return;
    this._running = true;
    this.lastRunStartedAt = Date.now();
    this.nextRunAt = this.intervalMs > 0 ? this.lastRunStartedAt + this.intervalMs : null;
    try {
      const targets = this.am.accounts.filter(account => this._isWarmTarget(account));
      for (const account of targets) {
        await this.warmAccount(account);
      }
    } finally {
      this.lastRunFinishedAt = Date.now();
      this._running = false;
    }
  }

  async warmAccount(account) {
    const startedAt = Date.now();
    this._record(account, { status: 'running', startedAt });
    try {
      await this.am.ensureTokenFresh(account.index);
      const code = await this.spawnFn(this._spawnSpec(account));
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
  _spawnSpec(account) {
    // Pin by INDEX (stable, and free of the spaces/parens real account names
    // carry, which would otherwise need URL-encoding).
    const baseUrl = `http://127.0.0.1:${this.port}/tc-acct/${account.index}`;
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
    };
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
function defaultSpawn({ command, args, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`warm-up timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}
