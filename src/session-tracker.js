// Tracks Claude Code sessions by their `x-claude-code-session-id` header so
// teamclaude can (a) report how many sessions are running and (b) optionally
// keep each session pinned to one account while spreading NEW sessions across
// accounts (the opt-in fix for concurrency funnelling — issue #109).
//
// A session pins PER WEEKLY QUOTA BUCKET, not once overall. Quota and
// eligibility are already decided per bucket — an account whose Fable weekly is
// spent still serves Opus perfectly well — so a single pin per session lets a
// decision taken for one family relocate the whole session:
// a Fable request diverted off the pinned account re-pins the session there,
// and the next Opus request follows it onto an account that was never evaluated
// for Opus and whose Opus cache is cold. Keying each pin by the weekly bucket
// that governs the request keeps the families' affinities independent.
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
    // id -> { pins: Map<bucketKey, { idx, at }>, firstSeen, lastSeen, count, inFlight }
    this.sessions = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this._now = now || (() => Date.now());
    this._lastSweep = 0;
  }

  // Record that `sessionId` made a request served by `accountIndex`, spending
  // the weekly quota `bucket`. Refreshes lastSeen (keeping the session
  // "active"/"known") and re-pins ONLY that bucket — the session's affinity for
  // a family this request did not touch is none of this request's business.
  // Throttled sweep keeps the map bounded even in a headless server that never
  // renders status.
  //
  // A pin needs both an account and a bucket key to mean anything, so a call
  // missing either records the visit and pins nothing. The caller derives the
  // key from operator-supplied routing config and does not validate it, and a
  // key that is not a string names no quota field there either: the session
  // simply keeps re-routing rather than the request path throwing.
  touch(sessionId, accountIndex = null, bucket = null, now = this._now()) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.lastSeen = now;
    s.count += 1;
    if (accountIndex != null && typeof bucket === 'string' && bucket) {
      s.pins.set(bucket, { idx: accountIndex, at: now });
    }
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
  //
  // Finishing also ages the pin the request was spending up to now. `pin.at` is
  // stamped when a request is ROUTED, while `lastSeen` moves again when it ends,
  // so without this a session that has just finished stays inside its active
  // window carrying a pin that aged out during the request: the account that did
  // the work drops out of `activeCountFor` and `perAccount` for as long as the
  // request took, up to the active window. Under-counting an account that just
  // finished work is the funnelling this metric exists to prevent.
  //
  // The newest pin, and only once nothing is left outstanding. Which pin a given
  // request was spending is not recorded (see `_pinCounts`), and the newest is
  // the one a session making requests in sequence just touched. Two concurrent
  // requests on different families can still refresh the wrong one, which is the
  // same limit the in-flight arm has.
  endRequest(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    if (s.inFlight === 0) {
      let newest = null;
      for (const pin of s.pins.values()) if (!newest || pin.at > newest.at) newest = pin;
      if (newest) newest.at = now;
    }
    s.lastSeen = now;
  }

  _ensure(sessionId, now) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { pins: new Map(), firstSeen: now, lastSeen: now, count: 0, inFlight: 0 };
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

  // The account a known (non-expired) session is pinned to for `bucket` — the
  // weekly quota bucket governing the request being routed — or null when the
  // session is unknown/forgotten or has no pin for that bucket yet.
  // Expired-on-read entries are dropped. A bucket is required: "which account is
  // this session on" is precisely the question with no single answer, and
  // answering it anyway is what used to move a session wholesale.
  pinnedAccount(sessionId, bucket, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    if (this._isExpired(s, now)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s.pins.get(bucket)?.idx ?? null;
  }

  // Every account a known session is pinned to across its buckets, most recent
  // pin first — what selection falls back to when a request's own bucket has no
  // pin yet, so the session stays where it already is. Empty for an unknown or
  // expired session (expired-on-read entries are dropped).
  pinnedAccounts(sessionId, now = this._now()) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return [];
    if (this._isExpired(s, now)) {
      this.sessions.delete(sessionId);
      return [];
    }
    return [...s.pins.values()].sort((a, b) => b.at - a.at).map(p => p.idx);
  }

  // Re-point every pin through `mapFn` after the account list is renumbered (see
  // AccountManager.removeAccount). A pin is a bare position in that list, so a
  // removal one slot below silently hands the session to a different account;
  // returning null drops the pin instead, and that bucket re-routes on the
  // session's next request. Every bucket is mapped, since a session may hold
  // pins on several accounts and the removal shifts all of them.
  remapAccounts(mapFn) {
    for (const s of this.sessions.values()) {
      for (const [bucket, pin] of [...s.pins]) {
        const moved = mapFn(pin.idx);
        if (moved == null) s.pins.delete(bucket);
        else pin.idx = moved;
      }
    }
  }

  // Does this pin count as load on `accountIndex` right now? A pin outlives the
  // active window by design — it holds the cache affinity for the whole known
  // hour — so freshness is asked of the PIN and not of the session: one diverted
  // Fable request half an hour ago is not load on that account for the rest of
  // the hour, and counting it there skews the very signal that spreads new
  // sessions. A request in flight keeps the session's pins counted however long
  // it streams, since a 5-minute completion must not read as idle.
  _pinCounts(s, pin, accountIndex, now) {
    return pin.idx === accountIndex && (now - pin.at <= this.activeTtlMs || s.inFlight > 0);
  }

  _pinsInclude(s, accountIndex, now) {
    for (const pin of s.pins.values()) {
      if (this._pinCounts(s, pin, accountIndex, now)) return true;
    }
    return false;
  }

  // The accounts a session counts as load on right now — at most once each,
  // however many of its buckets point at the same one.
  _loadedAccounts(s, now) {
    const out = new Set();
    for (const pin of s.pins.values()) {
      if (this._pinCounts(s, pin, pin.idx, now)) out.add(pin.idx);
    }
    return out;
  }

  // Active sessions currently pinned to `accountIndex` — the load metric used to
  // spread new sessions across accounts. Counts in-flight sessions regardless of
  // how long their request has been streaming. A session spending two accounts
  // is load on both: it counts once per account, not once overall.
  activeCountFor(accountIndex, now = this._now()) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this._isActive(s, now) && this._pinsInclude(s, accountIndex, now)) n += 1;
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
        // Once per account, on every account this session is currently
        // spending, so the per-account counts can sum to more than `active`.
        for (const idx of this._loadedAccounts(s, now)) {
          perAccount[idx] = (perAccount[idx] || 0) + 1;
        }
      }
    }
    return { known, active, perAccount };
  }
}
