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
    // id -> { accountIndex, firstSeen, lastSeen, count }
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
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { accountIndex, firstSeen: now, lastSeen: now, count: 0 };
      this.sessions.set(sessionId, s);
    }
    s.lastSeen = now;
    s.count += 1;
    if (accountIndex != null) s.accountIndex = accountIndex;
    if (now - this._lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
    return s;
  }

  // The account a known (non-expired) session is pinned to, or null if the
  // session is unknown/forgotten. Expired-on-read entries are dropped.
  pinnedAccount(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    if (now - s.lastSeen > this.knownTtlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s.accountIndex ?? null;
  }

  // Active sessions currently pinned to `accountIndex` — the load metric used to
  // spread new sessions across accounts.
  activeCountFor(accountIndex, now = this._now()) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountIndex === accountIndex && now - s.lastSeen <= this.activeTtlMs) n += 1;
    }
    return n;
  }

  // Drop sessions idle longer than the known window.
  sweep(now = this._now()) {
    this._lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.knownTtlMs) this.sessions.delete(id);
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
      const idle = now - s.lastSeen;
      if (idle > this.knownTtlMs) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      if (idle <= this.activeTtlMs) {
        active += 1;
        if (s.accountIndex != null) perAccount[s.accountIndex] = (perAccount[s.accountIndex] || 0) + 1;
      }
    }
    return { known, active, perAccount };
  }
}
