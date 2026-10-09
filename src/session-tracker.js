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
//
// T5 honesty layer: OBSERVABLE session evidence (ctx, lastSemanticSeen, hint,
// last_rejection) lives in a SEPARATE `evidence` Map. The routing pin Map is
// live routing state under distributeSessions — endpoint reads and evidence
// eviction MUST NOT delete pins or change which account a session routes to.
export const SESSION_KNOWN_TTL_MS = 60 * 60 * 1000; // 1h idle → forgotten
export const SESSION_ACTIVE_TTL_MS = 2 * 60 * 1000; // 2min idle → no longer "active"
export const MAX_EVIDENCE_SESSIONS = 1000;
export const CTX_BY_MODEL_CAP = 8;
export const HINT_STALE_MS = 30 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60 * 1000; // bound growth without an external timer

export function estimateWindowTokens(model, contextWindows = null) {
  if (model && contextWindows && Object.prototype.hasOwnProperty.call(contextWindows, model)) {
    const n = Number(contextWindows[model]);
    if (Number.isFinite(n) && n > 0) return { tokens: n, basis: 'config-override' };
  }
  if (typeof model === 'string' && /\[1m\]$/i.test(model)) {
    return { tokens: 1_000_000, basis: '[1m]-tag' };
  }
  return { tokens: 200_000, basis: 'default' };
}

export class SessionTracker {
  constructor({ knownTtlMs, activeTtlMs, now, maxEvidence } = {}) {
    // id -> { accountIndex, firstSeen, lastSeen, count, inFlight }  — ROUTING ONLY
    this.sessions = new Map();
    // id -> T5 evidence (never consulted by _selectForSession / activeCountFor)
    this.evidence = new Map();
    this.knownTtlMs = knownTtlMs ?? SESSION_KNOWN_TTL_MS;
    this.activeTtlMs = activeTtlMs ?? SESSION_ACTIVE_TTL_MS;
    this.maxEvidence = maxEvidence ?? MAX_EVIDENCE_SESSIONS;
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
      // lastRecoveryCheckAt: watermark for dynrank recovery pull-back (2026-09-19
      // #7 review). A recovered account is timestamped, not one-shot-consumed —
      // see recoveryCheckedThrough / markRecoveryChecked — so two sessions
      // pinned to the same fallback each get their own independent evaluation
      // of the SAME recovery event instead of racing to clear a shared flag.
      s = { accountIndex: null, firstSeen: now, lastSeen: now, count: 0, inFlight: 0, lastRecoveryCheckAt: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // Has this session already evaluated every recovery up to `requalifiedAt`?
  // Read-only; account-manager calls this before deciding whether a recovered
  // account is a NEW opportunity for this specific session.
  recoveryCheckedThrough(sessionId, requalifiedAt, now = this._now()) {
    const s = this.sessions.get(sessionId);
    if (!s) return false; // unknown session: nothing to skip, evaluate it
    if (this._isExpired(s, now)) return false;
    return s.lastRecoveryCheckAt >= requalifiedAt;
  }

  // Advance this session's recovery watermark. Called once per
  // _selectForSession decision (whether or not a pull-back happened), so the
  // SAME session never re-evaluates the SAME recovery event twice, while a
  // DIFFERENT session sharing the fallback is untouched and still sees it as
  // unevaluated.
  markRecoveryChecked(sessionId, requalifiedAt, now = this._now()) {
    if (!sessionId) return;
    const s = this._ensure(sessionId, now);
    if (requalifiedAt > s.lastRecoveryCheckAt) s.lastRecoveryCheckAt = requalifiedAt;
  }

  // ── T5 evidence (separate from routing pins) ───────────────────────────

  _ensureEvidence(sessionId, now) {
    let e = this.evidence.get(sessionId);
    if (!e) {
      this._evictEvidenceIfNeeded(now);
      e = {
        firstSeen: now,
        lastSemanticSeen: null,
        requestCount: 0,
        lastRequest: null,
        lastRejection: null,
        ctxByModel: new Map(), // model -> { contextTokens, asOf, pathClass }
        clientHint: null,
      };
      this.evidence.set(sessionId, e);
    }
    return e;
  }

  // Cap only the evidence Map. Never deletes a routing pin.
  _evictEvidenceIfNeeded(_now) {
    if (this.evidence.size < this.maxEvidence) return;
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, e] of this.evidence) {
      const pin = this.sessions.get(id);
      if (pin && pin.inFlight > 0) continue; // never drop evidence for an in-flight pin
      const at = e.lastSemanticSeen ?? e.firstSeen ?? 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestId = id;
      }
    }
    if (oldestId != null) this.evidence.delete(oldestId);
  }

  /** Stamp semantic activity at request BEGIN. Clears client_hint (supersession). */
  noteSemanticBegin(sessionId, { at, pathClass, model, account } = {}) {
    if (!sessionId) return;
    const now = at ?? this._now();
    const e = this._ensureEvidence(sessionId, now);
    e.lastSemanticSeen = now;
    e.requestCount += 1;
    e.lastRequest = {
      at: new Date(now).toISOString(),
      path_class: pathClass || 'other',
      model: model ?? null,
      account: account ?? null,
    };
    e.clientHint = null;
  }

  /** Refresh semantic stamp at request END so idle_ms excludes stream duration. */
  noteSemanticEnd(sessionId, at = this._now()) {
    if (!sessionId) return;
    const e = this.evidence.get(sessionId);
    if (!e) return;
    e.lastSemanticSeen = at;
  }

  /** Pre-gate rejection (blocked/collision/typed-429) — no beginSession ran. */
  noteSemanticRejection(sessionId, { at, status, reason, model, pathClass } = {}) {
    if (!sessionId) return;
    const now = at ?? this._now();
    const e = this._ensureEvidence(sessionId, now);
    e.lastSemanticSeen = now;
    e.requestCount += 1;
    e.lastRequest = {
      at: new Date(now).toISOString(),
      path_class: pathClass || 'other',
      model: model ?? null,
      account: null,
    };
    e.lastRejection = {
      at: new Date(now).toISOString(),
      status: status ?? null,
      reason: reason ?? null,
    };
    // Rejection is not a model call that resolved a permission prompt — leave hint.
  }

  /**
   * Record observed context occupancy for a model. count_tokens is EXCLUDED
   * (top-level {input_tokens} has no .usage wrapper and is not a window sum) —
   * callers must pass pathClass:'messages' (or omit); count_tokens is a no-op.
   */
  noteUsage(sessionId, model, contextTokens, { at, pathClass } = {}) {
    if (!sessionId || !model || !Number.isFinite(contextTokens)) return;
    if (pathClass === 'count_tokens') return;
    const now = at ?? this._now();
    const e = this._ensureEvidence(sessionId, now);
    // LRU: delete+set moves to newest insertion order.
    if (e.ctxByModel.has(model)) e.ctxByModel.delete(model);
    e.ctxByModel.set(model, {
      contextTokens: Math.max(0, Math.floor(contextTokens)),
      asOf: now,
      pathClass: pathClass || 'messages',
    });
    while (e.ctxByModel.size > CTX_BY_MODEL_CAP) {
      const oldest = e.ctxByModel.keys().next().value;
      e.ctxByModel.delete(oldest);
    }
  }

  /**
   * Optional client-cooperation hint. Only on an existing routing or evidence
   * record — never fabricate sessions from hints.
   */
  noteHint(sessionId, hint, at = this._now()) {
    if (!sessionId || !hint) return { stored: false, reason: 'unknown-session' };
    if (!this.sessions.has(sessionId) && !this.evidence.has(sessionId)) {
      return { stored: false, reason: 'unknown-session' };
    }
    const e = this._ensureEvidence(sessionId, at);
    if (hint.state === 'clear') {
      e.clientHint = null;
      return { stored: true };
    }
    e.clientHint = {
      state: hint.state,
      at: hint.at || new Date(at).toISOString(),
      source: hint.source || null,
      provenance: 'client-reported',
    };
    return { stored: true };
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

  _evidenceExpired(e, now) {
    const stamp = e.lastSemanticSeen ?? e.firstSeen;
    return stamp == null || now - stamp > this.knownTtlMs;
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
    for (const [id, e] of this.evidence) {
      if (this._evidenceExpired(e, now)) this.evidence.delete(id);
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

  /**
   * Pure read for GET /teamclaude/sessions. Filters expired without deleting
   * (B3: status/sessions reads must not mutate routing or evidence maps).
   * Joins routing pins with evidence; includes evidence-only rejection sessions.
   */
  snapshot(now = this._now(), { contextWindows = null, accountNames = null } = {}) {
    const ids = new Set();
    for (const [id, s] of this.sessions) {
      if (!this._isExpired(s, now)) ids.add(id);
    }
    for (const [id, e] of this.evidence) {
      if (!this._evidenceExpired(e, now)) ids.add(id);
    }

    const rows = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      const e = this.evidence.get(id);
      const inFlight = s?.inFlight || 0;
      const busy = inFlight > 0;
      const lastSemantic = e?.lastSemanticSeen ?? null;
      const accountIdx = s?.accountIndex;
      const accountName = (accountIdx != null && accountNames)
        ? (accountNames[accountIdx] ?? null)
        : null;

      const ctxByModel = {};
      let topCtx = null;
      if (e?.ctxByModel) {
        for (const [model, entry] of e.ctxByModel) {
          const win = estimateWindowTokens(model, contextWindows);
          const pct = win.tokens > 0
            ? Math.round((entry.contextTokens / win.tokens) * 1000) / 10
            : null;
          const view = {
            context_tokens: entry.contextTokens,
            window_tokens: win.tokens,
            window_basis: win.basis,
            pct,
            model,
            as_of: new Date(entry.asOf).toISOString(),
            staleness_ms: now - entry.asOf,
          };
          ctxByModel[model] = view;
        }
        topCtx = pickTopCtx(e.ctxByModel, now, this.activeTtlMs, contextWindows);
      }

      let clientHint = null;
      if (e?.clientHint) {
        const hintAt = Date.parse(e.clientHint.at);
        const stale = Number.isFinite(hintAt) && (now - hintAt > HINT_STALE_MS);
        clientHint = { ...e.clientHint, stale: !!stale };
      }

      rows.push({
        session_id: id,
        resume_id: id,
        resume_id_provenance: 'observed-header-unverified',
        state: busy ? 'busy' : 'idle',
        state_basis: busy ? 'in_flight>0' : 'last-semantic-request-age',
        in_flight: inFlight,
        idle_ms: busy ? null : (lastSemantic != null ? now - lastSemantic : null),
        last_request: e?.lastRequest ?? null,
        last_rejection: e?.lastRejection ?? null,
        ctx: topCtx,
        ctx_by_model: ctxByModel,
        client_hint: clientHint,
        account: accountName ?? e?.lastRequest?.account ?? null,
        first_seen: new Date(s?.firstSeen ?? e?.firstSeen ?? now).toISOString(),
        request_count: s?.count ?? e?.requestCount ?? 0,
      });
    }
    return rows;
  }
}

function pickTopCtx(ctxByModel, now, activeTtlMs, contextWindows) {
  let bestActive = null;
  let bestActiveTokens = -1;
  let mostRecent = null;
  let mostRecentAt = -1;
  for (const [model, entry] of ctxByModel) {
    const win = estimateWindowTokens(model, contextWindows);
    const pct = win.tokens > 0
      ? Math.round((entry.contextTokens / win.tokens) * 1000) / 10
      : null;
    const view = {
      context_tokens: entry.contextTokens,
      window_tokens: win.tokens,
      window_basis: win.basis,
      pct,
      model,
      as_of: new Date(entry.asOf).toISOString(),
      staleness_ms: now - entry.asOf,
    };
    if (entry.asOf > mostRecentAt) {
      mostRecentAt = entry.asOf;
      mostRecent = view;
    }
    if (now - entry.asOf <= activeTtlMs && entry.contextTokens > bestActiveTokens) {
      bestActiveTokens = entry.contextTokens;
      bestActive = view;
    }
  }
  return bestActive || mostRecent;
}
