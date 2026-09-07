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

export const DEFAULT_USAGE_DIMENSION_MAX_KEYS = 500;
export const USAGE_DIMENSION_VALUE_MAX_LENGTH = 200;

// Where usage lands once a tracker is at its key cap. The counters are
// persisted and cumulative, so the cap must never delete a row: evicting the
// least-recently-used one means a burst of distinct values silently erases
// lifetime totals for the values that matter, and the periodic save makes that
// permanent. Folding into one bucket keeps the sum honest and says so in the
// output. A caller whose value is literally `(other)` merges with it — harmless,
// and preferable to a sentinel that no value could ever collide with but that
// also could not be typed by an operator reading the docs.
export const OVERFLOW_KEY = '(other)';

const RESERVED_CUSTOM_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-app',
  'x-claude-code-session-id',
  'x-claude-code-agent-id',
  'x-claude-code-parent-agent-id',
  'x-anthropic-additional-protection',
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;
const DIMENSION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class ClientUsageTracker {
  // `maxKeys` stays unbounded for per-client accounting — clientKeys is
  // operator-configured, so the key space is bounded by the config file. It is
  // set only for the header-derived dimension trackers, whose values come from
  // callers and are therefore unbounded.
  constructor({ now = () => Date.now(), maxKeys = Infinity } = {}) {
    this.clients = new Map(); // name → { requests, inputTokens, outputTokens, lastUsed(ms) }
    this._now = now;
    this.maxKeys = maxKeys;
  }

  _ensure(name) {
    let c = this.clients.get(name);
    if (!c) {
      if (this.clients.size >= this.maxKeys && name !== OVERFLOW_KEY) return this._ensure(OVERFLOW_KEY);
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

/**
 * The same accounting, one tracker per operator-configured dimension.
 *
 * `proxy.clientKeys` answers "who spent this" for a consumer that holds a key.
 * It cannot answer "on what" — one CI key covers every repository it builds.
 * A dimension maps a request header to a counter set, so a caller can label its
 * own traffic (project, ref, team) through ANTHROPIC_CUSTOM_HEADERS without the
 * operator issuing a key per label.
 *
 * Only configured dimensions exist. Per-session cost is NOT a dimension here:
 * SessionTracker already meters it from the response usage, cache tokens
 * included, which is the number that matters — an `input_tokens` sum
 * understates a cached session by orders of magnitude.
 */
export class UsageDimensionTracker {
  constructor({ now = () => Date.now(), maxKeys = DEFAULT_USAGE_DIMENSION_MAX_KEYS } = {}) {
    this._now = now;
    this._dimensions = new Map();
    this._maxKeys = maxKeys;
  }

  _tracker(name) {
    const key = normalizeDimensionName(name);
    if (!key) return null;
    let tracker = this._dimensions.get(key);
    if (!tracker) {
      tracker = new ClientUsageTracker({ now: this._now, maxKeys: this._maxKeys });
      this._dimensions.set(key, tracker);
    }
    return tracker;
  }

  record(dimension, key, usage) {
    const tracker = this._tracker(dimension);
    if (!tracker || !key) return;
    tracker.record(key, usage);
  }

  export() {
    // Null prototype for the same reason ClientUsageTracker.export() uses one:
    // a dimension named `__proto__` must land as an own key, not silently
    // vanish onto the prototype.
    const out = Object.create(null);
    for (const [name, tracker] of this._dimensions) {
      const entries = tracker.export();
      if (Object.keys(entries).length) out[name] = entries;
    }
    return Object.fromEntries(Object.entries(out));
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, entries] of Object.entries(saved)) {
      const tracker = this._tracker(name);
      if (tracker) tracker.restore(entries);
    }
  }
}

/**
 * The dimensions one request contributes to: `[{ name, key }]`, empty when
 * nothing is configured or no configured header was sent. Read from
 * `proxy.usageDimensions` live per request, so a config reload applies to a
 * running server the way clientKeys does.
 */
export function resolveUsageDimensions(proxyConfig, headers = {}) {
  const out = [];
  const configured = Array.isArray(proxyConfig?.usageDimensions) ? proxyConfig.usageDimensions : [];
  for (const entry of configured) {
    const name = normalizeDimensionName(entry?.name);
    const header = normalizeUsageHeaderName(entry?.header);
    if (!name || !header) continue;
    const value = sanitizeUsageDimensionValue(headers[header]);
    if (value) out.push({ name, key: value });
  }
  return out;
}

/**
 * The header names configured as dimensions, lowercased — what to strip before
 * forwarding upstream. An entry is only counted when BOTH its name and header
 * are valid, so this stays exactly the set resolveUsageDimensions() reads: a
 * header the proxy does not consume is not the proxy's to remove.
 */
export function usageDimensionHeaderNames(proxyConfig) {
  const out = new Set();
  const configured = Array.isArray(proxyConfig?.usageDimensions) ? proxyConfig.usageDimensions : [];
  for (const entry of configured) {
    const header = normalizeUsageHeaderName(entry?.header);
    if (header && normalizeDimensionName(entry?.name)) out.add(header);
  }
  return out;
}

export function createUsageRecorder({ client, clientUsage, dimensions, dimensionUsage }) {
  const targets = [];
  if (client && clientUsage) targets.push({ tracker: clientUsage, key: client });
  if (dimensionUsage) {
    for (const dimension of dimensions || []) {
      targets.push({ tracker: dimensionUsage, dimension: dimension.name, key: dimension.key });
    }
  }
  if (!targets.length) return { recordRequest: () => {}, onUsage: null };
  return {
    recordRequest() {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { requests: 1 });
        else target.tracker.record(target.key, { requests: 1 });
      }
    },
    onUsage(inputTokens, outputTokens) {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { inputTokens, outputTokens });
        else target.tracker.record(target.key, { inputTokens, outputTokens });
      }
    },
  };
}

function normalizeDimensionName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return DIMENSION_NAME_RE.test(name) ? name : null;
}

// A configured header must be a valid token, and must not be one the proxy or
// the client already relies on: a dimension is operator config, but pointing one
// at `authorization` or `cookie` would copy a credential into a persisted,
// status-visible counter name.
function normalizeUsageHeaderName(value) {
  if (typeof value !== 'string') return null;
  const header = value.trim().toLowerCase();
  if (!header || !HEADER_NAME_RE.test(header)) return null;
  if (RESERVED_CUSTOM_HEADER_NAMES.has(header)) return null;
  return header;
}

/**
 * Header values reach a terminal renderer and a JSON status payload, so control
 * characters and escape sequences are stripped at ingest rather than at every
 * point of display, and the result is length-capped.
 */
export function sanitizeUsageDimensionValue(value, { maxLength = USAGE_DIMENSION_VALUE_MAX_LENGTH } = {}) {
  if (Array.isArray(value)) value = value.join(', ');
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return null;
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}
