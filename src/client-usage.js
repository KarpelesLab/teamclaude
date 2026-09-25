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
//
// A WebSocket handshake (Remote Control's real-time channel) is booked as a
// `connection`, apart from the request counters: it is not a request and
// carries no tokens, so folding it into `requests` would misstate the usage
// totals — but "which clients open channels here" is a question the same
// table answers (#325).

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

// Windowed usage.
//
// The counters above are lifetime: they answer "how much has this client ever
// spent" and cannot answer "how much in the last day", because nothing records
// WHEN a token was spent. A per-slot tally does, at a bounded cost. Traffic
// lands in the 15-minute slot it arrived in, and a slot that has fallen out of
// the longest window is deleted rather than kept, so the cost is set by the
// window and not by uptime. Slots are sparse — a key seen twice a day holds two
// of them, not ninety-six — which is what keeps this affordable for a dimension
// tracker holding up to `maxKeys` distinct values.
export const USAGE_SLOT_MS = 15 * 60 * 1000;

// The windows rolled up for readers, shortest first. `5h` is the shared quota
// window, so it says what is being spent against the bucket that gates the next
// request; `24h` is the day-scale question an operator actually asks. A 7-day
// rolling window is deliberately absent: the weekly quota is a bucket with a
// reset instant, not a rolling window, so the honest weekly number is "since
// the reset" and would be a baseline, not a tally like this one.
export const USAGE_WINDOWS = { '5h': 5 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

// Retention is the longest window plus one slot. A window's start falls inside
// a slot rather than on its edge, so that oldest slot is only partly covered:
// keeping it overstates the window by less than one slot, dropping it would
// understate it by the same amount, and overstating is the safer of the two for
// a number an operator reads to decide whether they are near a limit.
const RETAINED_SLOTS = Math.ceil(Math.max(...Object.values(USAGE_WINDOWS)) / USAGE_SLOT_MS) + 1;

/** @typedef {{ requests: number, connections: number, inputTokens: number, outputTokens: number }} UsageCounters */
/** @typedef {UsageCounters & { lastUsed: number | null, slots: Map<number, UsageCounters> }} ClientRecord */

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
    // name → { requests, connections, inputTokens, outputTokens, lastUsed(ms),
    //          slots: Map<slotNumber, { requests, connections, inputTokens, outputTokens }> }
    this.clients = new Map();
    this._now = now;
    this.maxKeys = maxKeys;
  }

  _ensure(name) {
    let c = this.clients.get(name);
    if (!c) {
      if (this.clients.size >= this.maxKeys && name !== OVERFLOW_KEY) return this._ensure(OVERFLOW_KEY);
      c = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0, lastUsed: null, slots: new Map() };
      this.clients.set(name, c);
    }
    return c;
  }

  /** Book usage against a client name. A null/empty name is dropped (unattributed). */
  record(name, { requests = 0, connections = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    if (!name) return;
    const c = this._ensure(name);
    c.requests += requests;
    c.connections += connections;
    c.inputTokens += inputTokens;
    c.outputTokens += outputTokens;
    c.lastUsed = this._now();
    // Eviction runs only when this write opens a new slot, and against the
    // same clock reading as lastUsed: a second read of the clock could land
    // past a slot boundary and evict the oldest slot the windows still cover.
    const slotNo = Math.floor(c.lastUsed / USAGE_SLOT_MS);
    const opening = !c.slots.has(slotNo);
    const slot = this._slotFor(c, slotNo);
    if (opening) this._evict(c, c.lastUsed);
    slot.requests += requests;
    slot.connections += connections;
    slot.inputTokens += inputTokens;
    slot.outputTokens += outputTokens;
  }

  /**
   * Drop every slot now outside retention. Runs both when a key opens a new
   * slot and when a key is read out, and needs both: eviction on write alone
   * never runs for a key that has stopped recording, and a dimension keyed on
   * something like a git ref is mostly keys that went silent for good. Those
   * would hold their slots for as long as the process ran, making the cost a
   * function of every distinct key seen since the last restart rather than of
   * the window. So a read prunes too — unusual, but the slots it drops are
   * outside every window and can never be reported again, and the alternative
   * is a timer this file does not have. In practice the reads come on a
   * schedule anyway: the once-a-minute state save in index.js
   * (persistQuotaState → exportState) prunes every key it writes out.
   * @param {ClientRecord} c
   * @param {number} now
   */
  _evict(c, now) {
    const cutoff = Math.floor(now / USAGE_SLOT_MS) - RETAINED_SLOTS;
    // Deleting during iteration is defined for a Map: an entry removed before
    // it is reached is simply never visited.
    for (const slot of c.slots.keys()) if (slot <= cutoff) c.slots.delete(slot);
  }

  /**
   * The tally for `slot`, created on first use. Creation alone does not evict:
   * record() does that when a live write opens a slot, and restore bounds what
   * it admits up front — running a full eviction walk from here made a restore
   * of n slots cost n walks over a growing map.
   * @param {ClientRecord} c
   * @param {number} slot
   * @returns {UsageCounters}
   */
  _slotFor(c, slot) {
    let tally = c.slots.get(slot);
    if (!tally) c.slots.set(slot, tally = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
    return tally;
  }

  /**
   * One client's counters rolled up per window in USAGE_WINDOWS. A window
   * covers its own length plus at most one slot — see RETAINED_SLOTS. Every
   * window is present here, zeros included; whether the set is reported at all
   * is export()'s decision, not this one's.
   * @param {ClientRecord} c
   * @param {number} now
   * @returns {Record<string, UsageCounters>}
   */
  _windows(c, now) {
    /** @type {Record<string, UsageCounters>} */
    const out = {};
    // Cutoffs first, then ONE walk of the slots: this runs per key on every
    // status poll, and the fastest poller in the tree asks once a second.
    /** @type {Array<[number, UsageCounters]>} */
    const cutoffs = [];
    for (const [label, span] of Object.entries(USAGE_WINDOWS)) {
      out[label] = { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 };
      cutoffs.push([Math.floor((now - span) / USAGE_SLOT_MS), out[label]]);
    }
    for (const [slot, t] of c.slots) {
      for (const [from, sum] of cutoffs) {
        if (slot < from) continue;
        sum.requests += t.requests;
        sum.connections += t.connections;
        sum.inputTokens += t.inputTokens;
        sum.outputTokens += t.outputTokens;
      }
    }
    return out;
  }

  /**
   * Plain-object snapshot for /teamclaude/status and the dashboard (lastUsed as
   * ISO string, matching how the status endpoint reports times), carrying the
   * rolled-up windows rather than the slots they were summed from: a reader
   * wants two figures per client, and the tally behind them is up to a hundred
   * rows that the dashboard would have to re-sum on every poll.
   */
  export() {
    const now = this._now();
    return this._snapshot(now, c => {
      const windows = this._windows(c, now);
      // Omitted entirely for a key with nothing in any window, rather than
      // shipped as rows of zeros. The windows nest — the shortest is contained
      // in the longest — so "empty" is unambiguous: no traffic in the longest
      // one. On a dimension carrying a value per git ref, most keys are old
      // branches that are silent for good, and they were the bulk of the
      // payload. A reader that finds no `windows` reads zero for every window,
      // which is what the absence means.
      return Object.values(windows).some(w => w.requests || w.connections || w.inputTokens || w.outputTokens)
        ? { windows }
        : {};
    });
  }

  /**
   * Snapshot for the state file. Carries the slots instead of the windows, so a
   * restart resumes the windows rather than restarting them — an upgrade is
   * exactly when someone looks at the dashboard, and a 24h figure that reads
   * zero after every deploy is worse than not offering one.
   */
  exportState() {
    // An empty `slots` is left out for the same reason `export()` leaves out an
    // empty `windows`: at the key cap the stale rows are most of them.
    return this._snapshot(this._now(), c => (c.slots.size ? { slots: Object.fromEntries(c.slots) } : {}));
  }

  // `now` is passed in rather than read here, so that a caller which also uses
  // it — export() rolls the windows up against it — cannot have eviction run
  // against a second, later instant. Two reads straddling a slot boundary would
  // evict exactly the oldest slot the rollup still reads.
  /** @param {number} now @param {(c: ClientRecord) => Record<string, unknown>} extra */
  _snapshot(now, extra) {
    // Built on a null prototype and copied out with fromEntries, so a name like
    // `__proto__` lands as an own key of a plain object instead of on its
    // prototype (names are operator-configured, but the cost of getting this
    // wrong is silent loss of the row).
    const out = Object.create(null);
    for (const [name, c] of this.clients) {
      this._evict(c, now);
      out[name] = {
        requests: c.requests,
        connections: c.connections,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        lastUsed: c.lastUsed ? new Date(c.lastUsed).toISOString() : null,
        ...extra(c),
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
      c.connections += Number(s.connections) || 0;
      c.inputTokens += Number(s.inputTokens) || 0;
      c.outputTokens += Number(s.outputTokens) || 0;
      const t = s.lastUsed ? Date.parse(s.lastUsed) : NaN;
      if (!Number.isNaN(t) && (c.lastUsed == null || t > c.lastUsed)) c.lastUsed = t;
      this._restoreSlots(c, s.slots);
    }
  }

  /**
   * Slots from a saved snapshot, added onto whatever is already tallied for the
   * same slot. Anything already outside retention is dropped here rather than
   * left for the next write: a proxy that was down for a week would otherwise
   * restore a full set of dead slots and report them as current until its next
   * request. A snapshot from a build that did not keep slots simply has none,
   * and the windows then fill from live traffic. This is also the only place a
   * slot ahead of the clock is refused: a backwards clock step during a run is
   * not caught until the next restart.
   * @param {ClientRecord} c
   * @param {unknown} saved
   */
  _restoreSlots(c, saved) {
    if (!saved || typeof saved !== 'object') return;
    const current = Math.floor(this._now() / USAGE_SLOT_MS);
    const oldest = current - RETAINED_SLOTS;
    for (const [key, t] of Object.entries(saved)) {
      const slot = Number(key);
      // Bounded at BOTH ends. A slot ahead of the clock cannot be a real
      // observation of the past — it is a snapshot written before the clock
      // moved backwards — and admitting one would leave it counting in every
      // window until the clock caught up with it.
      if (!Number.isInteger(slot) || slot <= oldest || slot > current || !t || typeof t !== 'object') continue;
      const tally = this._slotFor(c, slot);
      tally.requests += Number(t.requests) || 0;
      tally.connections += Number(t.connections) || 0;
      tally.inputTokens += Number(t.inputTokens) || 0;
      tally.outputTokens += Number(t.outputTokens) || 0;
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
    return this._snapshot(tracker => tracker.export());
  }

  /** The state-file form, carrying slots. See ClientUsageTracker.exportState(). */
  exportState() {
    return this._snapshot(tracker => tracker.exportState());
  }

  /** @param {(tracker: ClientUsageTracker) => Record<string, unknown>} pick */
  _snapshot(pick) {
    // Null prototype for the same reason ClientUsageTracker.export() uses one:
    // a dimension named `__proto__` must land as an own key, not silently
    // vanish onto the prototype.
    const out = Object.create(null);
    for (const [name, tracker] of this._dimensions) {
      const entries = pick(tracker);
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
