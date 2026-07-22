// Tracks Claude Code sessions by their `x-claude-code-session-id` header so
// teamclaude can (a) report how many sessions are running and (b) optionally
// keep each session pinned to one account while spreading NEW sessions across
// accounts (the opt-in fix for concurrency funnelling — issue #109).
//
// Two windows:
//   - KNOWN: a session is remembered until it goes idle for this long, then
//     forgotten. 1h matches the maximum prompt-cache extension window — past
//     that there is no cache left to preserve, so the pin has no value.
//   - ACTIVE: a session counts as "active" (and toward per-account load) if it
//     made a request this recently. Short, so load-balancing reacts to what is
//     actually running now rather than to sessions merely lingering in the hour.
export const SESSION_KNOWN_TTL_MS = 60 * 60 * 1000; // 1h idle → forgotten
export const SESSION_ACTIVE_TTL_MS = 2 * 60 * 1000; // 2min idle → no longer "active"

const SWEEP_INTERVAL_MS = 60 * 1000; // bound growth without an external timer

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now } = {}) {
    // id -> { accountIndex, firstSeen, lastSeen, count, inFlight }
    this.sessions = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this._now = now || (() => Date.now());
    this._lastSweep = 0;
  }

  // Record that `sessionId` made a request served by `accountIndex`. Refreshes
  // lastSeen (keeping the session "active"/"known") and, when an account is
  // given, (re)pins the session to it. Throttled sweep keeps the map bounded
  // even in a headless server that never renders status.
  touch(sessionId, accountIndex = null, now = this._now()) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.lastSeen = now;
    s.count += 1;
    if (accountIndex != null) s.accountIndex = accountIndex;
    if (now - this._lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
    return s;
  }

  // Mark a request for this session as started. A session with any request in
  // flight counts as active (and non-expirable) for the whole request, however
  // long it streams — a 5-minute completion must not drop out of "active" or the
  // load balancer would under-count that account. Paired with endRequest.
  beginRequest(sessionId, now = this._now()) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.inFlight += 1;
    s.lastSeen = now;
    return s;
  }

  // Mark a request as finished (refreshes recency; releases the in-flight hold).
  endRequest(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.lastSeen = now;
  }

  _ensure(sessionId, now) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { accountIndex: null, firstSeen: now, lastSeen: now, count: 0, inFlight: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // Active = a request in flight now, or one seen within the active window.
  _isActive(s, now) {
    return s.inFlight > 0 || now - s.lastSeen <= this.activeTtlMs;
  }

  // Expired = idle past the known window AND nothing in flight (a long-running
  // request keeps the session alive no matter how old lastSeen is).
  _isExpired(s, now) {
    return s.inFlight === 0 && now - s.lastSeen > this.knownTtlMs;
  }

  // The account a known (non-expired) session is pinned to, or null if the
  // session is unknown/forgotten. Expired-on-read entries are dropped.
  pinnedAccount(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    if (this._isExpired(s, now)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s.accountIndex ?? null;
  }

  // Active sessions currently pinned to `accountIndex` — the load metric used to
  // spread new sessions across accounts. Counts in-flight sessions regardless of
  // how long their request has been streaming.
  activeCountFor(accountIndex, now = this._now()) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountIndex === accountIndex && this._isActive(s, now)) n += 1;
    }
    return n;
  }

  // Drop sessions idle longer than the known window (but never one still in flight).
  sweep(now = this._now()) {
    this._lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) this.sessions.delete(id);
    }
  }

  // { known, active, perAccount: { [index]: activeCount } } — for status/TUI.
  // Sweeps as it goes so a long-lived headless server stays bounded.
  stats(now = this._now()) {
    this._lastSweep = now;
    let known = 0;
    let active = 0;
    const perAccount = {};
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      if (this._isActive(s, now)) {
        active += 1;
        if (s.accountIndex != null) perAccount[s.accountIndex] = (perAccount[s.accountIndex] || 0) + 1;
      }
    }
    return { known, active, perAccount };
  }
}
