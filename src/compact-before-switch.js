// compactBeforeSwitch (issue #709): have Claude Code compact a long
// conversation on the account that still holds its prompt cache, a little
// before rotation moves it to another account.
//
// A prompt cache belongs to one account. After a switch nothing of the
// conversation is cached on the new account, so the whole transcript is written
// to its cache at the cache-write price. Only the client can compact its own
// conversation, and nothing lets a proxy start one. But Claude Code compacts
// and retries by itself when the API answers `400 invalid_request_error: prompt
// is too long` (measured in #709 on Claude Code 2.1.325; not a documented
// contract). So when a long conversation's account is within a margin of its
// switch threshold, the proxy answers ONE request of that conversation with
// that error itself. The client's compaction request then runs on the same
// account, where the transcript is a cache read, and the switch that follows
// carries the summary.
//
// This module holds the three parts that need no server: reading the setting,
// the decision, and the record of who was already asked. The server supplies
// the facts (server.js compactAskFor) and the account manager supplies the
// account and its thresholds (AccountManager.conversationHost, switchWindows),
// so no threshold logic lives here.
//
// The answer is the provider's own error wording for a request the provider
// never saw. That is why the setting is off unless set, and why every doubt in
// the decision resolves to forwarding the request.

export const DEFAULT_MARGIN = 0.04;
export const DEFAULT_MIN_BODY_BYTES = 400_000;
export const DEFAULT_COOLDOWN_SECONDS = 1800;

// A client session is asked at most once in this long, whatever conversation
// the request belongs to. The turn the client retries after compacting opens
// with its summary, so it keys as a new conversation that the per-conversation
// cooldown does not cover; this covers it. Fixed rather than configurable: it
// is a property of how the client retries, not an operator preference.
export const SESSION_GAP_MS = 2 * 60 * 1000;

// Bound on each of the two maps of the record. An entry is two numbers; at the
// cap the oldest goes, which can only make a conversation eligible to be asked
// again earlier than its cooldown, never block one.
export const MAX_COMPACT_ASKS = 5000;

/**
 * @typedef {Object} CompactSettings
 * @property {number} margin        how far below a switch threshold the asking starts (0-1)
 * @property {number} minBodyBytes  the smallest request body that is asked
 * @property {number} cooldownMs    how long one conversation is left alone after being asked
 */

/**
 * @param {unknown} value
 * @param {(n: number) => boolean} valid
 * @param {number} fallback
 * @returns {number}
 */
function field(value, valid, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && valid(value) ? value : fallback;
}

/**
 * The `compactBeforeSwitch` setting as the decision reads it, or null when the
 * feature is off.
 *
 * `true` is on with the defaults. An object is on, with each field that is not
 * a usable number taking its default: `margin` must be above 0 and below 1,
 * `minBodyBytes` and `cooldownSeconds` above 0. Anything else (absent, `false`,
 * a string, a number, an array) is off. Nothing here is fatal: a mistyped
 * value costs the feature, never the server.
 *
 * @param {unknown} raw
 * @returns {CompactSettings|null}
 */
export function resolveCompactBeforeSwitch(raw) {
  if (raw !== true && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return null;
  const o = /** @type {Record<string, unknown>} */ (raw === true ? {} : raw);
  return {
    margin: field(o.margin, n => n > 0 && n < 1, DEFAULT_MARGIN),
    minBodyBytes: field(o.minBodyBytes, n => n > 0, DEFAULT_MIN_BODY_BYTES),
    cooldownMs: field(o.cooldownSeconds, n => n > 0, DEFAULT_COOLDOWN_SECONDS) * 1000,
  };
}

/**
 * @typedef {Object} AskRecord
 * @property {number} at     when the request was answered
 * @property {number} bytes  the size of the body that was answered
 */

/**
 * Who was already asked to compact, and when. One per fleet: it hangs off the
 * AccountManager, which the base listener and every MITM tunnel listener share,
 * so a client that reaches the proxy both ways is still asked once.
 *
 * Two maps. `conversations` is keyed by pin key (the client session narrowed to
 * the conversation, see conversation.js) and is what lets the compaction
 * request through: it is the same conversation as the request that was asked.
 * `sessions` is keyed by the client session id and covers what follows the
 * compaction, which is a new conversation key.
 *
 * In memory only. A restart forgets it, and the worst that follows is one
 * conversation asked once more.
 */
export class CompactAsks {
  /**
   * @param {Object} [opts]
   * @param {() => number} [opts.now]
   * @param {number} [opts.maxEntries]
   */
  constructor({ now, maxEntries } = {}) {
    /** @type {Map<string, AskRecord>} */
    this.conversations = new Map();
    /** @type {Map<string, AskRecord>} */
    this.sessions = new Map();
    this.maxEntries = maxEntries ?? MAX_COMPACT_ASKS;
    this._now = now || (() => Date.now());
    // Requests answered this way since start, for status.
    this.asked = 0;
  }

  now() {
    return this._now();
  }

  /**
   * Why this request must not be asked, or null when the record allows it.
   *
   *   'conversation-cooldown'  this conversation was asked within the cooldown.
   *       Absolute, whatever the body size: the compaction request is the same
   *       conversation and at least as large as the request that was asked.
   *   'session-gap'            this client session was asked within two minutes.
   *   'session-smaller'        this client session was asked within the cooldown
   *       and this body is smaller than the one that was asked. A compacted
   *       conversation that its system prompt and tools keep above
   *       `minBodyBytes` would otherwise be asked again every two minutes; it
   *       is asked again only once it has grown back to the size that was
   *       asked.
   *
   * Reads only.
   *
   * @param {string} pinKey
   * @param {string} sessionId
   * @param {number} bodyBytes
   * @param {number} cooldownMs
   * @param {number} [now]
   * @returns {'conversation-cooldown'|'session-gap'|'session-smaller'|null}
   */
  blocks(pinKey, sessionId, bodyBytes, cooldownMs, now = this._now()) {
    const conv = this.conversations.get(pinKey);
    if (conv && now - conv.at < cooldownMs) return 'conversation-cooldown';
    const sess = this.sessions.get(sessionId);
    if (sess && now - sess.at < cooldownMs) {
      if (now - sess.at < SESSION_GAP_MS) return 'session-gap';
      if (bodyBytes < sess.bytes) return 'session-smaller';
    }
    return null;
  }

  /**
   * Record that a request was answered with the compaction error.
   *
   * The session entry keeps the largest body asked while its cooldown runs, so
   * a large subagent conversation and a smaller main one in the same session
   * resolve toward asking less.
   *
   * @param {string} pinKey
   * @param {string} sessionId
   * @param {number} bodyBytes
   * @param {number} cooldownMs
   * @param {number} [now]
   */
  record(pinKey, sessionId, bodyBytes, cooldownMs, now = this._now()) {
    this.sweep(cooldownMs, now);
    const prior = this.sessions.get(sessionId);
    const bytes = prior && now - prior.at < cooldownMs ? Math.max(prior.bytes, bodyBytes) : bodyBytes;
    this._put(this.conversations, pinKey, { at: now, bytes: bodyBytes });
    this._put(this.sessions, sessionId, { at: now, bytes });
    this.asked++;
  }

  /**
   * Drop every entry older than the cooldown. Run on each record, which is the
   * only time the maps grow.
   * @param {number} cooldownMs
   * @param {number} [now]
   */
  sweep(cooldownMs, now = this._now()) {
    for (const map of [this.conversations, this.sessions]) {
      for (const [key, rec] of map) {
        if (now - rec.at >= cooldownMs) map.delete(key);
      }
    }
  }

  /**
   * @param {Map<string, AskRecord>} map
   * @param {string} key
   * @param {AskRecord} rec
   */
  _put(map, key, rec) {
    // Deleted first so insertion order is recency, which is what the cap evicts by.
    map.delete(key);
    while (map.size >= this.maxEntries) map.delete(/** @type {string} */ (map.keys().next().value));
    map.set(key, rec);
  }
}

/**
 * The setting as status reports it: whether it is on, the values in force when
 * it is, and how many requests were answered this way since start. Read from
 * the live config, so it agrees with what the next request will be held to.
 *
 * @param {unknown} raw            `config.compactBeforeSwitch`
 * @param {CompactAsks|null|undefined} asks
 * @returns {{ enabled: boolean, margin?: number, minBodyBytes?: number, cooldownSeconds?: number, asked: number }}
 */
export function compactBeforeSwitchStatus(raw, asks) {
  const settings = resolveCompactBeforeSwitch(raw);
  const asked = asks?.asked ?? 0;
  if (!settings) return { enabled: false, asked };
  return { enabled: true, margin: settings.margin, minBodyBytes: settings.minBodyBytes, cooldownSeconds: settings.cooldownMs / 1000, asked };
}

/**
 * @typedef {Object} SwitchWindow
 * @property {string} bucket             the quota bucket (unified5h, unified7d, unified7dFable, ...)
 * @property {number|null} utilization   its reading for this request's model (0-1), null when unknown
 * @property {number} threshold          the switch threshold that applies to it on this account
 */

/**
 * @typedef {Object} CompactDecision
 * @property {boolean} ask
 * @property {string} reason             why not, or 'near-threshold' when asking
 * @property {SwitchWindow} [window]     the window that is inside the margin, when asking
 */

/**
 * Whether this request is answered with the compaction error. Pure: it reads
 * its arguments and the record, and writes neither.
 *
 * The caller has already established what only the server can know: the
 * feature is on, the request is a Claude Code `/v1/messages` completion that no
 * pin forces onto an account, and `windows` are the switch windows of the
 * Claude subscription account that holds this conversation and would serve this
 * request. An empty `windows` means there is no such account.
 *
 * Asked only when some window is inside the margin and none is at its
 * threshold. An account already at a threshold cannot serve the compaction
 * request: rotation would send it to the next account, where nothing is
 * cached, which is the cost this exists to avoid.
 *
 * @param {Object} facts
 * @param {CompactSettings|null} facts.settings
 * @param {number} facts.bodyBytes
 * @param {string|null} facts.pinKey
 * @param {string|null} facts.sessionId
 * @param {SwitchWindow[]|null} facts.windows
 * @param {CompactAsks} facts.asks
 * @param {number} [facts.now]
 * @returns {CompactDecision}
 */
export function decideCompactBeforeSwitch({ settings, bodyBytes, pinKey, sessionId, windows, asks, now = asks.now() }) {
  if (!settings) return { ask: false, reason: 'off' };
  if (!sessionId || !pinKey) return { ask: false, reason: 'no-session' };
  if (!(bodyBytes >= settings.minBodyBytes)) return { ask: false, reason: 'small-body' };
  if (!windows || windows.length === 0) return { ask: false, reason: 'no-account' };
  const known = windows.filter(w => typeof w.utilization === 'number' && Number.isFinite(w.utilization));
  if (known.some(w => /** @type {number} */ (w.utilization) >= w.threshold)) return { ask: false, reason: 'at-threshold' };
  const near = known.find(w => /** @type {number} */ (w.utilization) >= w.threshold - settings.margin);
  if (!near) return { ask: false, reason: 'not-near' };
  const blocked = asks.blocks(pinKey, sessionId, bodyBytes, settings.cooldownMs, now);
  if (blocked) return { ask: false, reason: blocked };
  return { ask: true, reason: 'near-threshold', window: near };
}

/**
 * The two numbers of the error message, formed from the body size alone.
 *
 * `tokens` is bytes / 4 rounded up, the usual estimate; in #709 it matched the
 * client's own count within 1%. `maximum` is the largest multiple of 1000
 * strictly below it. It is not a model's context limit and does not claim to
 * be one: the conversation that is asked is usually well under the real limit,
 * and the message has to read `tokens > maximum` to be the error the client
 * acts on. The gap is kept small because a client that reads the two numbers
 * reads how much it is over by.
 *
 * @param {number} bodyBytes
 * @returns {{ tokens: number, maximum: number }}
 */
export function promptTooLongCounts(bodyBytes) {
  const tokens = Math.max(2, Math.ceil(bodyBytes / 4));
  const maximum = Math.max(1, Math.floor((tokens - 1) / 1000) * 1000);
  return { tokens, maximum };
}

/**
 * The response body: the Anthropic API's error for a prompt over the context
 * limit, in the API's own shape.
 *
 * @param {number} bodyBytes
 * @returns {string}
 */
export function promptTooLongBody(bodyBytes) {
  const { tokens, maximum } = promptTooLongCounts(bodyBytes);
  return JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: `prompt is too long: ${tokens} tokens > ${maximum} maximum` },
  });
}
