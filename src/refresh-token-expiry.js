// When an account's refresh token stops working, where the provider says.
//
// A Claude refresh token seems to live a fixed time from the sign-in that
// issued it, and a rotation does not extend it (issue #674): the account then
// fails with `invalid_grant` / "Refresh token expired" and needs a new login.
// Nothing here assumes how long that is. The date is kept only when it was
// STATED — by the token endpoint, or by the credential file an account was
// imported from — and an account without one simply shows none.
//
// The date describes one refresh-token family. It follows a rotation (the same
// sign-in, a new token), is replaced by a new sign-in, and is never carried
// from one token to an unrelated one.

import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days ahead of a known expiry status and the log start to warn. */
export const REFRESH_TOKEN_WARN_DAYS = 5;

// What a stated date may be and still be believed. Further out than any
// refresh token lives, or long past, is a field that means something else.
const MAX_AHEAD_MS = 10 * 365 * DAY_MS;
const MAX_PAST_MS = DAY_MS;

/**
 * A stored expiry (epoch ms) when it is one, else null. The config file and the
 * status payload are both read from outside this process.
 * @param {unknown} value
 * @returns {number|null}
 */
export function knownRefreshTokenExpiry(value) {
  // Epoch milliseconds only: below 1e11 is epoch seconds (or a count of
  // something), which would read as 1973 and warn "expired" for ever, and
  // above 8.64e15 is no date at all.
  return typeof value === 'number' && value >= 1e11 && value <= 8.64e15 ? value : null;
}

/** @param {unknown} v @returns {number|null} a finite number from a number or a numeric string */
function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The refresh-token expiry a token-endpoint response states, as epoch ms, or
 * null when it states none that can be believed.
 *
 * The name of the field is UNCONFIRMED: nobody has captured a response that
 * carries one. `refresh_token_expires_in` (seconds from now) is the guess from
 * the Claude Code side and `refresh_token_expires_at` the other common
 * spelling (epoch seconds, epoch milliseconds, or an ISO date), so both are
 * read. A response with neither yields null, and no lifetime is assumed.
 *
 * @param {any} data  the parsed response body
 * @param {number} [now]
 * @returns {number|null}
 */
export function refreshTokenExpiryFromResponse(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;
  /** @type {number[]} */
  const stated = [];

  const inSeconds = numberOf(data.refresh_token_expires_in);
  if (inSeconds != null && inSeconds > 0) stated.push(now + inSeconds * 1000);

  const at = data.refresh_token_expires_at;
  const atNumber = numberOf(at);
  if (atNumber != null) {
    // Epoch seconds stay below 1e11 until the year 5138; epoch milliseconds
    // have been above it since 1973.
    if (atNumber > 0) stated.push(atNumber < 1e11 ? atNumber * 1000 : atNumber);
  } else if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) stated.push(parsed);
  }

  const plausible = stated.filter((ms) => ms > now - MAX_PAST_MS && ms <= now + MAX_AHEAD_MS);
  // Both spellings in one response: the sooner one is the safe reading.
  return plausible.length ? Math.round(Math.min(...plausible)) : null;
}

/**
 * The earlier of two expiries, either of which may be unknown.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number|null}
 */
export function earlierRefreshTokenExpiry(a, b) {
  const x = knownRefreshTokenExpiry(a);
  const y = knownRefreshTokenExpiry(b);
  if (x == null) return y;
  if (y == null) return x;
  return Math.min(x, y);
}

/**
 * Put a refresh-token expiry on a record, or take the key off it when there is
 * none: a config row keeps no `null` for a date nobody stated.
 * @template {Record<string, any>} T
 * @param {T} record
 * @param {unknown} value
 * @returns {T}
 */
export function setRefreshTokenExpiry(record, value) {
  const known = knownRefreshTokenExpiry(value);
  if (known != null) /** @type {Record<string, any>} */ (record).refreshTokenExpiresAt = known;
  else delete record.refreshTokenExpiresAt;
  return record;
}

/**
 * The tokens a REFRESH returned, carrying the date of the family they belong
 * to: the earlier of the one already held and the one the response stated. A
 * rotation must never push the date out, and a response that states nothing
 * leaves the held one standing.
 * @template {Record<string, any>} T
 * @param {{ refreshTokenExpiresAt?: unknown }|null|undefined} held  what was refreshed
 *
 * A held date that has already passed is the exception: the refresh that just
 * succeeded disproved it (the lifetime slid, or the date meant something
 * else), so it is dropped for whatever the response states, or for none.
 * Without that a wrong date would warn "expired" on a working account until
 * the next sign-in.
 * @param {T} tokens  what the token endpoint answered
 * @param {number} [now]
 * @returns {T}
 */
export function withFamilyExpiry(held, tokens, now = Date.now()) {
  const kept = knownRefreshTokenExpiry(held?.refreshTokenExpiresAt);
  const disproved = kept != null && kept <= now;
  return setRefreshTokenExpiry({ ...tokens }, earlierRefreshTokenExpiry(disproved ? null : kept, tokens?.refreshTokenExpiresAt));
}

/**
 * The expiry an account holds once `next` has been installed over `held`,
 * where `next` came from somewhere other than a refresh of `held` made here: a
 * sign-in, a reload from disk, the credential store.
 *
 * A different refresh token brings its own date or none — the held date was
 * about a token that is gone. The same refresh token is the same family, so
 * the earlier date stands.
 * @param {{ refreshToken?: unknown, refreshTokenExpiresAt?: unknown }} held
 * @param {{ refreshToken?: unknown, refreshTokenExpiresAt?: unknown }} next
 * @returns {number|null}
 */
export function expiryAfterReplacement(held, next) {
  if (next.refreshToken && next.refreshToken !== held.refreshToken) return knownRefreshTokenExpiry(next.refreshTokenExpiresAt);
  return earlierRefreshTokenExpiry(held.refreshTokenExpiresAt, next.refreshTokenExpiresAt);
}

/** The sign-in command for an account's provider. @param {Record<string, any>|null|undefined} account */
export function loginCommandFor(account) {
  return providerOf(account) === 'codex' ? 'teamclaude login --codex' : 'teamclaude login';
}

/** @param {number} ms @returns {string} the local calendar day, as YYYY-MM-DD */
export function localDate(ms) {
  const d = new Date(ms);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @typedef {{ expiresAt: number, expired: boolean, warn: boolean, phrase: string, text: string }} RefreshTokenExpiryView
 * `phrase` reads after "its refresh token" ("expires in 6 days", "expired");
 * `text` is the whole status cell, date included.
 */

/**
 * How a known expiry reads at `now`, or null when none is known. Whole days
 * are counted down, so "in 1 day" is still more than 24 hours away; past the
 * date it says "expired" rather than a negative count.
 * @param {unknown} expiresAt
 * @param {number} [now]
 * @returns {RefreshTokenExpiryView|null}
 */
export function refreshTokenExpiryView(expiresAt, now = Date.now()) {
  const at = knownRefreshTokenExpiry(expiresAt);
  if (at == null) return null;
  const left = at - now;
  const expired = left <= 0;
  const days = Math.floor(left / DAY_MS);
  const phrase = expired ? 'expired'
    : days < 1 ? 'expires in less than a day'
    : `expires in ${days} day${days === 1 ? '' : 's'}`;
  return {
    expiresAt: at,
    expired,
    warn: left <= REFRESH_TOKEN_WARN_DAYS * DAY_MS,
    phrase,
    text: `refresh token ${phrase} (${localDate(at)})`,
  };
}

/**
 * The view for an account as status and the TUI show it, or null when there is
 * nothing to show: no known date, or an account already out as `error`, whose
 * own line says what happened and what to run.
 * @param {Record<string, any>|null|undefined} account
 * @param {number} [now]
 * @returns {RefreshTokenExpiryView|null}
 */
export function accountRefreshTokenExpiry(account, now = Date.now()) {
  if (!account || account.status === 'error') return null;
  return refreshTokenExpiryView(account.refreshTokenExpiresAt, now);
}

/**
 * The line drawn under an account's TUI row once its refresh token is within
 * the warning window or past its date, with the command that renews it; null
 * outside the window, where the row stays one line.
 * @param {Record<string, any>|null|undefined} account
 * @param {number} [now]
 * @returns {string|null}
 */
export function refreshTokenExpiryWarning(account, now = Date.now()) {
  const view = accountRefreshTokenExpiry(account, now);
  return view?.warn ? `${view.text} \u2014 run: ${loginCommandFor(account)}` : null;
}

/**
 * The server's ahead-of-time warning: one log line per account per day, at
 * most, while its refresh token is within REFRESH_TOKEN_WARN_DAYS of a known
 * expiry. Called from a tick that already runs; the returned function takes the
 * manager's accounts and returns the lines it logged.
 *
 * An account that is disabled, or already in `error`, is left out: the first
 * was put aside on purpose and the second has said so in its own words.
 * Restarting the server says it again, which is the moment an operator reads
 * the log.
 *
 * @param {{ log?: (line: string) => void, now?: () => number }} [opts]
 * @returns {(accounts: Iterable<Record<string, any>>) => string[]}
 */
export function createRefreshTokenExpiryWarner({ log = (line) => console.error(line), now = Date.now } = {}) {
  /** @type {Map<unknown, number>} when each account was last warned about, by entry id (or name) */
  const warnedAt = new Map();
  return (accounts) => {
    const at = now();
    /** @type {string[]} */
    const lines = [];
    const seen = new Set();
    for (const account of accounts) {
      const key = account?.id ?? account?.name;
      seen.add(key);
      if (account?.type !== 'oauth' || account.disabled) continue;
      const view = accountRefreshTokenExpiry(account, at);
      if (!view?.warn) continue;
      const last = warnedAt.get(key);
      if (last != null && at - last < DAY_MS) continue;
      warnedAt.set(key, at);
      const line = `[TeamClaude] Account "${safeLine(account.name, 64)}": its refresh token ${view.phrase} — run: ${loginCommandFor(account)}`;
      lines.push(line);
      log(line);
    }
    // A removed account takes its entry with it.
    for (const key of warnedAt.keys()) if (!seen.has(key)) warnedAt.delete(key);
    return lines;
  };
}
