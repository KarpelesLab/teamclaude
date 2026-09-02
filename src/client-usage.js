// Per-client usage accounting (proxy.clientKeys).
//
// One shared proxy.apiKey means every consumer of a team proxy looks the same:
// the per-account usage the account manager keeps says WHAT was spent, never by
// WHOM. `proxy.clientKeys` gives each consumer their own key + name; the auth
// gates report which entry matched, and the tokens each response reports are
// then booked against that name — per-CLIENT accounting alongside the existing
// per-ACCOUNT accounting, fed by the same response parsing.
//
// The tracker itself is deliberately dumb: a name → counters map. Identity
// resolution (which key matched) lives in the auth gates (server.js / mitm.js);
// token extraction stays where it always was (server.js). This file only
// aggregates, so it can be tested — and reasoned about — in isolation.
//
// Attribution is best-effort by design: loopback traffic that presents no key
// is exempt from the gate and therefore unattributed, as is anything using the
// single shared proxy.apiKey. Deployments that want complete per-client stats
// give every consumer a clientKeys entry and treat the shared key as legacy.

export class ClientUsageTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.clients = new Map(); // name → { requests, inputTokens, outputTokens, lastUsed(ms) }
    this._now = now;
  }

  _ensure(name) {
    let c = this.clients.get(name);
    if (!c) {
      c = { requests: 0, inputTokens: 0, outputTokens: 0, lastUsed: null };
      this.clients.set(name, c);
    }
    return c;
  }

  /** Book usage against a client name. A null/empty name is dropped (unattributed). */
  record(name, { requests = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    if (!name) return;
    const c = this._ensure(name);
    c.requests += requests;
    c.inputTokens += inputTokens;
    c.outputTokens += outputTokens;
    c.lastUsed = this._now();
  }

  /**
   * Plain-object snapshot for the state file and /teamclaude/status
   * (lastUsed as ISO string, matching how the status endpoint reports times).
   */
  export() {
    // Built on a null prototype and copied out with fromEntries, so a name like
    // `__proto__` lands as an own key of a plain object instead of on its
    // prototype (names are operator-configured, but the cost of getting this
    // wrong is silent loss of the row).
    const out = Object.create(null);
    for (const [name, c] of this.clients) {
      out[name] = {
        requests: c.requests,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        lastUsed: c.lastUsed ? new Date(c.lastUsed).toISOString() : null,
      };
    }
    return Object.fromEntries(Object.entries(out));
  }

  /**
   * Restore a snapshot saved by a previous run. Adds onto anything already
   * recorded (restore runs at startup, but being additive means a late restore
   * can never erase live traffic). Malformed entries are skipped, not fatal —
   * the state file is documented as safe to delete, so it must also be safe to
   * hand-edit badly.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, s] of Object.entries(saved)) {
      if (!name || !s || typeof s !== 'object') continue;
      const c = this._ensure(name);
      c.requests += Number(s.requests) || 0;
      c.inputTokens += Number(s.inputTokens) || 0;
      c.outputTokens += Number(s.outputTokens) || 0;
      const t = s.lastUsed ? Date.parse(s.lastUsed) : NaN;
      if (!Number.isNaN(t) && (c.lastUsed == null || t > c.lastUsed)) c.lastUsed = t;
    }
  }
}
