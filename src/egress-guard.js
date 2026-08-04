// Egress pinning — refuse to spend an account from the wrong exit IP.
//
// When a VPN drops mid-session, traffic silently continues from the machine's
// own address. Anthropic answers a request from an unexpected region with 403
// "Request not allowed", and Claude Code reads that 403 as a dead session and
// asks for a re-login — over a network event, with the token still valid. The
// account has already been used from the new address by then.
//
// So the check belongs BEFORE the request: if the exit IP is not the pinned
// one, hold the request until the tunnel is back rather than sending it. A held
// request looks like a slow response; a sent one can cost a re-login.
//
// Opt-in: without `egress.pin` in the config this is inert and nothing here runs.

const DEFAULT_CHECK_URL = 'https://api.ipify.org';
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HOLD_MS = 120_000;
const POLL_MS = 3_000;

export class EgressGuard {
  /**
   * @param {object} opts
   * @param {string|string[]} opts.pin  'auto' (pin whatever is seen first), or one or more allowed IPs
   */
  constructor({ pin, checkUrl = DEFAULT_CHECK_URL, ttlMs = DEFAULT_TTL_MS, holdMs = DEFAULT_HOLD_MS,
    fetchImpl = fetch, pollMs = POLL_MS, log = () => {} } = {}) {
    this.pin = pin || null;
    this.checkUrl = checkUrl;
    this.ttlMs = ttlMs;
    this.holdMs = holdMs;
    this.pollMs = pollMs;
    this._fetch = fetchImpl;
    this.log = log;
    this._ip = null;         // last observed exit IP
    this._checkedAt = 0;     // when it was observed
    this._auto = null;       // the address 'auto' latched onto
    this._inFlight = null;   // coalesces concurrent probes
  }

  enabled() { return !!this.pin; }

  /** The addresses considered correct, once known. */
  allowed() {
    if (this.pin === 'auto') return this._auto ? [this._auto] : [];
    return Array.isArray(this.pin) ? this.pin : [this.pin];
  }

  /**
   * Current exit IP, cached for ttlMs. Returns null when the probe fails — the
   * caller treats that as "unknown", never as "wrong": a probe that cannot
   * complete is usually the same outage that is about to fail the request
   * anyway, and blocking on it would turn a third-party hiccup into an outage
   * of our own.
   */
  async currentIp({ force = false } = {}) {
    if (!force && this._ip && Date.now() - this._checkedAt < this.ttlMs) return this._ip;
    if (this._inFlight) return this._inFlight;

    this._inFlight = (async () => {
      try {
        const res = await this._fetch(this.checkUrl, { signal: AbortSignal.timeout(5_000) });
        const ip = (await res.text()).trim();
        if (!ip) return null;
        this._ip = ip;
        this._checkedAt = Date.now();
        // 'auto' pins the first address it sees. The server starts with the
        // tunnel up in the normal case, so that address is the one to hold for.
        if (this.pin === 'auto' && !this._auto) {
          this._auto = ip;
          this.log(`[TeamClaude] Egress pinned to ${ip}`);
        }
        return ip;
      } catch {
        return null;
      } finally {
        this._inFlight = null;
      }
    })();

    return this._inFlight;
  }

  /** Is `ip` one of the pinned addresses? Unknown (null) counts as allowed. */
  matches(ip) {
    if (!ip) return true;
    const allowed = this.allowed();
    return allowed.length === 0 || allowed.includes(ip);
  }

  /** One check against the pin: { ok, ip, expected }. */
  async check(opts) {
    const ip = await this.currentIp(opts);
    return { ok: this.matches(ip), ip, expected: this.allowed() };
  }

  /**
   * Block until the exit IP is the pinned one again, or the hold budget runs
   * out. Returns { ok, ip, expected, waitedMs } — ok:false means the caller
   * should refuse the request rather than send it from the wrong address.
   */
  async waitUntilPinned({ isAborted = () => false } = {}) {
    const started = Date.now();
    let state = await this.check();
    if (state.ok) return { ...state, waitedMs: 0 };

    this.log(`[TeamClaude] Egress is ${state.ip}, not the pinned ${state.expected.join(', ')} — holding requests`);
    while (Date.now() - started < this.holdMs) {
      if (isAborted()) return { ...state, waitedMs: Date.now() - started };
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
      state = await this.check({ force: true });
      if (state.ok) {
        const waitedMs = Date.now() - started;
        this.log(`[TeamClaude] Egress back on ${state.ip} after ${Math.round(waitedMs / 1000)}s`);
        return { ...state, waitedMs };
      }
    }
    return { ...state, waitedMs: Date.now() - started };
  }
}

/** Build a guard from config, or null when the feature is not configured. */
export function createEgressGuard(config, log) {
  const cfg = config?.egress;
  if (!cfg?.pin) return null;
  return new EgressGuard({
    pin: cfg.pin,
    checkUrl: cfg.checkUrl,
    ttlMs: cfg.ttlSeconds != null ? cfg.ttlSeconds * 1000 : undefined,
    holdMs: cfg.holdSeconds != null ? cfg.holdSeconds * 1000 : undefined,
    log,
  });
}
