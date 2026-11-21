// Session move advice, as pure functions. `decideAdvice` reads no clock, account
// or config; AccountManager.sessionAdvice gathers its snapshot. The server only
// advises: moving a session is the operator's session-pin.

/**
 * @typedef {{ enabled: boolean, maxContextTokens: number, cooldownMinutes: number,
 *             ask: boolean }} SessionAdviceConfig
 */

/** @type {SessionAdviceConfig} */
export const SESSION_ADVICE_DEFAULTS = Object.freeze({
  enabled: false,
  maxContextTokens: 150000,
  cooldownMinutes: 60,
  ask: false,
});

/** @param {unknown} v @param {number} fallback */
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * The `sessionAdvice` config block, resolved. As for expiryRouting, only a
 * literal `true` turns a switch on, so a hand-edited `"false"` reads as off.
 * @param {any} cfg
 * @returns {SessionAdviceConfig}
 */
export function normalizeSessionAdvice(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    enabled: c.enabled === true,
    maxContextTokens: positive(c.maxContextTokens, SESSION_ADVICE_DEFAULTS.maxContextTokens),
    cooldownMinutes: positive(c.cooldownMinutes, SESSION_ADVICE_DEFAULTS.cooldownMinutes),
    ask: c.ask === true,
  };
}

/**
 * One session as the decision sees it. `account` is the shown account's name
 * (null: the session is unknown); `context` the cost conversation's last
 * context, null when only a manual pin is known; `currentAvailable` whether its
 * requests are served there (for a manual pin: forwarded); `routerMoves` whether
 * the router's reclaim window moves it on its next request; `destination` the
 * account a move would go to, null when none can take it.
 *
 * @typedef {{ now: number, enabled: boolean, maxContextTokens: number,
 *             expiryOn: boolean, account: string|null, via: 'manual'|'affinity'|null,
 *             context: number|null, currentAvailable: boolean, routerMoves: boolean,
 *             inBand: boolean, destination: string|null, cooldownUntil: number|null }} AdviceSnapshot
 */

/**
 * @typedef {'disabled' | 'unknown-session' | 'pinned-unavailable' | 'expiry-routing-off'
 *         | 'cooldown' | 'context-over-ceiling' | 'current-unavailable' | 'router-moves'
 *         | 'in-band' | 'out-of-band' | 'no-destination'} AdviceReason
 */

/**
 * @typedef {{ recommendation: { to: string, reread: number|null } | null,
 *             reason: AdviceReason }} AdviceDecision
 */

/**
 * Whether to suggest moving the session, and why. A manual pin the forward
 * path refuses is checked before cooldown, ceiling and expiry routing: a manual
 * pin never fails over, so every request is already failing and a move is the
 * only way out.
 * @param {AdviceSnapshot} s
 * @returns {AdviceDecision}
 */
export function decideAdvice(s) {
  const move = () => (s.destination ? { to: s.destination, reread: s.context } : null);
  if (!s.enabled) return { recommendation: null, reason: 'disabled' };
  if (s.account == null) return { recommendation: null, reason: 'unknown-session' };
  if (s.via === 'manual' && !s.currentAvailable) return { recommendation: move(), reason: 'pinned-unavailable' };
  if (!s.expiryOn) return { recommendation: null, reason: 'expiry-routing-off' };
  if (s.cooldownUntil != null && s.now < s.cooldownUntil) return { recommendation: null, reason: 'cooldown' };
  if (s.context != null && s.context > s.maxContextTokens) return { recommendation: null, reason: 'context-over-ceiling' };
  if (!s.currentAvailable) return { recommendation: null, reason: 'current-unavailable' };
  if (s.routerMoves) return { recommendation: null, reason: 'router-moves' };
  if (s.inBand) return { recommendation: null, reason: 'in-band' };
  const to = move();
  return to ? { recommendation: to, reason: 'out-of-band' } : { recommendation: null, reason: 'no-destination' };
}
