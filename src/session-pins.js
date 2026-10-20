// Operator pins: one client session held on one named account (issue #543).
//
// `teamclaude switch <account>` moves the fleet's current account, so every
// unpinned session follows it. Moving ONE running session — a long task put on
// an API key while subscription quota recovers — used to mean exiting it and
// relaunching under TC_ACCT. This is the runtime form of that launch pin: a map
// from the client's session id to an account the operator named.
//
// Not the SessionTracker's pins. Those are cache-affinity pins per weekly bucket
// and conversation, re-pinned whenever a request is diverted and aged out with
// the cache they protect; they cannot hold a choice. This holds one, and the
// request path applies it exactly where it applies a TC_ACCT pin.
//
// The account is stored by NAME, as TC_ACCT's is, and resolved per request: a
// reload can renumber accounts, and an index would then name a different one.
// In memory only and bounded. A pin is forgotten once its session has been idle
// for the tracker's known window, the same hour after which the proxy forgets
// the session itself; it does not survive a restart.

import { SESSION_KNOWN_TTL_MS } from './session-tracker.js';

export const MAX_SESSION_PINS = 1000;

/**
 * @typedef {Object} SessionPin
 * @property {string} account   the account name the operator chose
 * @property {number} since     when the pin was set
 * @property {number} lastUsed  when it was set or last applied to a request
 */

export class SessionPins {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs]
   * @param {() => number} [opts.now]
   */
  constructor({ ttlMs, now } = {}) {
    /** @type {Map<string, SessionPin>} */
    this.pins = new Map();
    this.ttlMs = ttlMs ?? SESSION_KNOWN_TTL_MS;
    this._now = now || (() => Date.now());
  }

  /**
   * Pin `sessionId` to `account`, or clear its pin when `account` is null.
   * Returns whether a pin was there before.
   * @param {string} sessionId
   * @param {string|null} account
   */
  set(sessionId, account, now = this._now()) {
    this.sweep(now);
    const had = this.pins.delete(sessionId);
    if (account == null) return had;
    // At the cap the pin used longest ago goes: insertion order is use order,
    // since get() re-inserts what it touches.
    while (this.pins.size >= MAX_SESSION_PINS) this.pins.delete(/** @type {string} */ (this.pins.keys().next().value));
    this.pins.set(sessionId, { account, since: now, lastUsed: now });
    return had;
  }

  /**
   * The account name `sessionId` is pinned to, or null. A hit counts as use, so
   * a session that keeps working keeps its pin.
   * @param {string|null} sessionId
   */
  get(sessionId, now = this._now()) {
    if (!sessionId) return null;
    const pin = this.pins.get(sessionId);
    if (!pin) return null;
    if (now - pin.lastUsed > this.ttlMs) {
      this.pins.delete(sessionId);
      return null;
    }
    pin.lastUsed = now;
    this.pins.delete(sessionId);
    this.pins.set(sessionId, pin);
    return pin.account;
  }

  /**
   * Follow an account rename, so a pin keeps naming the account it was set on.
   * @param {string} from
   * @param {string} to
   */
  rename(from, to) {
    if (!from || !to || from === to) return;
    for (const pin of this.pins.values()) if (pin.account === from) pin.account = to;
  }

  /** Drop every pin idle past the window. */
  sweep(now = this._now()) {
    for (const [id, pin] of this.pins) if (now - pin.lastUsed > this.ttlMs) this.pins.delete(id);
  }

  /**
   * The live pins, most recently used first, for status. The session id is shortened to the
   * prefix the activity view shows unless `detail` is set (proxy.sessionDetail):
   * status is readable by every client key, and the rest of the session readout
   * withholds ids on the same terms.
   * @param {{ detail?: boolean }} [opts]
   */
  list({ detail = false } = {}, now = this._now()) {
    this.sweep(now);
    return [...this.pins].reverse().map(([id, pin]) => ({
      session: id.slice(0, 8),
      ...(detail ? { id } : {}),
      account: pin.account,
      since: pin.since,
      lastUsed: pin.lastUsed,
    }));
  }
}
