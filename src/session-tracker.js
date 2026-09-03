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

// Per-session token totals, kept per weekly bucket rather than once per session.
// Fable meters into its own weekly bucket, so how much capacity a point there
// costs is a per-family quantity by construction; totals summed across families
// cannot be taken apart again afterwards, and the distinction is gone before
// anything can use it.
//
// The names map one-to-one onto the fields upstream reports in its `usage`
// object, so a reader can line them up with the wire:
// `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens`,
// `output_tokens`.
//
// `context` is the odd one out and is not a sum. It is the size of the last
// context upstream reported reading, which is what one request on this session
// costs to serve; summing it would answer a question nobody asks. The sums,
// read against `firstSeen` and `lastSeen`, give the session's burn rate.
//
// `reports` counts the usage objects that contributed, so a reader can tell "no
// tokens because the session is idle" from "no tokens because nothing was ever
// observed": two states that otherwise look identical at zero.
function emptyTokens() {
  return { cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0, reports: 0 };
}

// The counters in an aggregate sum over KNOWN sessions; the cached footprint
// only over ACTIVE ones. Two populations in one object, so the footprint is
// named for its scope. `context / reports` would otherwise read as an average
// and be a ratio of different denominators.
const COUNTERS = ['cacheRead', 'cacheCreation', 'input', 'output', 'reports'];
function emptyAggregate() {
  return { cacheRead: 0, cacheCreation: 0, input: 0, output: 0, reports: 0, activeContext: 0 };
}

// Upstream omits a field it has nothing to say about, and has been seen to send
// null. Anything that is not a finite number contributes zero, so one malformed
// report cannot turn a running total into NaN and keep it there.
function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function setAndReturn(map, key, value) {
  map.set(key, value);
  return value;
}

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now } = {}) {
    // id -> { pins: Map<bucketKey, { idx, at }>, firstSeen, lastSeen, count,
    //         inFlight, tokens: Map<bucketKey, ...> }
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
  //
  // `metadata` (`{ client, dimensions }`) labels the session with who asked and
  // under which usage dimensions, for the per-session readout. It is attached
  // here rather than in touch() or recordSession() because this is the one call
  // that runs once per CLIENT request, with the request headers still in scope;
  // the other two run per forward attempt and per route decision.
  beginRequest(sessionId, now = this._now(), metadata = null) {
    if (!sessionId) return null;
    const s = this._ensure(sessionId, now);
    s.inFlight += 1;
    s.lastSeen = now;
    applyMetadata(s, metadata);
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

  /**
   * Add one upstream usage report to a session's running totals, under the
   * weekly quota bucket the request was governed by.
   *
   * Records only what the report carries. A streaming response splits its usage
   * across two events, and the caller merges those into one object before
   * getting here, so this is called once per upstream message however many
   * events that message took to arrive.
   *
   * Four cases this deliberately does NOT special-case, because the tokens were
   * spent upstream whether or not the request finished:
   *
   *   - a stream that fails after `message_start`: the context read happened and
   *     was charged, so it stays counted;
   *   - a request the client abandoned: same, the client leaving does not refund
   *     anything;
   *   - an advisor request: one report covers the whole request, and the
   *     advisor's sub-inference is not separable from the executor's inside it,
   *     so it lands on the executing model's bucket. Splitting it across the two
   *     buckets a request can touch would be inventing a division upstream did
   *     not report;
   *   - a session the tracker has already forgotten: its totals went with its
   *     record, and this will NOT resurrect one. The id is a client-supplied
   *     header, so creating records here would let usage reports repopulate a
   *     map the idle window exists to drain. A report for a session that is gone
   *     is dropped.
   */
  recordTokens(sessionId, bucket, usage, now = this._now()) {
    const s = this._live(sessionId, now);
    if (!s || !usage || !bucket) return null;
    const t = s.tokens.get(bucket) || setAndReturn(s.tokens, bucket, emptyTokens());
    const read = num(usage.cache_read_input_tokens);
    const creation = num(usage.cache_creation_input_tokens);
    const input = num(usage.input_tokens);
    t.cacheRead += read;
    t.cacheCreation += creation;
    t.input += input;
    t.output += num(usage.output_tokens);
    // Only a report that carries the input side describes a context. A
    // `message_delta` carries output alone and would otherwise reset this to 0.
    if (read || creation || input) t.context = read + creation + input;
    t.reports += 1;
    return t;
  }

  // A known, non-expired session's record, or null. Never creates one, and
  // drops an expired one on read like pinnedAccount does.
  _live(sessionId, now) {
    const s = sessionId && this.sessions.get(sessionId);
    if (!s) return null;
    if (this._isExpired(s, now)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return s;
  }

  _ensure(sessionId, now) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        pins: new Map(), firstSeen: now, lastSeen: now, count: 0, inFlight: 0,
        // bucket -> emptyTokens(). On the session's own record rather than in a
        // map beside it, so there is one lifetime and one eviction policy for
        // everything scoped to a session: a second map keyed by session id would
        // need its own bound and its own sweep to stay in step with this one.
        // The same key space as `pins`, so a family's spend and the account it
        // is pinned to are looked up by one bucket key.
        tokens: new Map(),
        // Labels from the request that opened the session (see beginRequest).
        client: null,
        dimensions: null,
      };
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

  // Ids of every known (non-expired) session that carries a pin. Snapshotted when
  // session distribution is turned off, so those sessions can be drained on their
  // existing accounts while new ones route by plain rotation. Expired-on-read
  // entries are dropped, same as pinnedAccount.
  pinnedSessionIds(now = this._now()) {
    const ids = [];
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) { this.sessions.delete(id); continue; }
      if (s.pins.size) ids.push(id);
    }
    return ids;
  }

  // Drop sessions idle longer than the known window (but never one still in flight).
  sweep(now = this._now()) {
    this._lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) this.sessions.delete(id);
    }
  }

  // { known, active, perAccount: { [index]: activeCount }, tokens } — for
  // status/TUI. Sweeps as it goes so a long-lived headless server stays bounded.
  // The token totals come out of the walk this already does: the status endpoint
  // is read on every TUI frame, so nothing here may add a second pass.
  //
  // `tokens` sums the sessions still KNOWN, while `activeContext` beside it sums
  // only the ACTIVE ones, because the two answer different questions: what this
  // fleet has spent, and what it is carrying now. `byBucket` is the same pair
  // per weekly family, which is the only view in which a fleet spending its Opus
  // and its Fable windows at different rates is visible at all.
  //
  // `items` is the same walk, per session instead of summed — off unless the
  // operator asks for it (see `stats({ detail: true })`), because it names every
  // session id, client and project value to whoever reads status.
  stats(now = this._now(), { detail = false } = {}) {
    this._lastSweep = now;
    let known = 0;
    let active = 0;
    const perAccount = {};
    const tokens = emptyAggregate();
    const byBucket = {};
    const items = detail ? [] : null;
    let activeContext = 0;
    for (const [id, s] of this.sessions) {
      if (this._isExpired(s, now)) {
        this.sessions.delete(id);
        continue;
      }
      known += 1;
      if (items) items.push(sessionItem(id, s, this._isActive(s, now)));
      for (const [bucket, t] of s.tokens) {
        const per = byBucket[bucket] || (byBucket[bucket] = emptyAggregate());
        for (const k of COUNTERS) {
          tokens[k] += t[k];
          per[k] += t[k];
        }
      }
      if (this._isActive(s, now)) {
        active += 1;
        // Once per account, on every account this session is currently
        // spending, so the per-account counts can sum to more than `active`.
        for (const idx of this._loadedAccounts(s, now)) {
          perAccount[idx] = (perAccount[idx] || 0) + 1;
        }
        // The live cached footprint, per family and in total. A session holding
        // a big Opus context and a small Fable one contributes to both.
        for (const [bucket, t] of s.tokens) {
          const per = byBucket[bucket] || (byBucket[bucket] = emptyAggregate());
          per.activeContext += t.context;
          activeContext += t.context;
        }
      }
    }
    tokens.activeContext = activeContext;
    tokens.byBucket = byBucket;
    // Newest first: a per-session table is read top-down for what is happening
    // now, and the list is capped by the same TTLs as the map behind it.
    if (items) items.sort((a, b) => b.lastSeen - a.lastSeen);
    return items ? { known, active, perAccount, tokens, items } : { known, active, perAccount, tokens };
  }
}

// One row of the per-session readout. `pins` replaces what used to be a single
// accountIndex: a session holds one pin per weekly bucket, so a session
// spending two families is served by two accounts at once and naming only one
// of them would be wrong rather than merely incomplete.
function sessionItem(id, s, active) {
  return {
    id,
    active,
    inFlight: s.inFlight,
    requests: s.count,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    client: s.client,
    dimensions: s.dimensions ? { ...s.dimensions } : null,
    pins: Object.fromEntries([...s.pins].map(([bucket, p]) => [bucket, p.idx])),
    // #192's numbers, per weekly bucket: what the responses actually reported,
    // cache included. An input+output sum understates a cached session by
    // orders of magnitude, which is why this is not counted from request headers.
    tokens: Object.fromEntries([...s.tokens].map(([bucket, t]) => [bucket, { ...t }])),
  };
}

// Labels are last-write-wins: a session is one client's, and a caller that
// changes the project mid-session means the new one. Absent fields leave the
// existing label alone, so a request without the header does not erase it.
function applyMetadata(s, metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  if (typeof metadata.client === 'string' && metadata.client) s.client = metadata.client;
  const dims = metadata.dimensions;
  if (dims && typeof dims === 'object' && Object.keys(dims).length) {
    s.dimensions = { ...(s.dimensions || {}), ...dims };
  }
}
