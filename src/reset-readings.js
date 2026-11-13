// Spend handles belong only in memory, keyed by the exact live account.
// Never attach these readings to accounts, normalized usage or saved quota.
import { safeLine } from './safe-text.js';

export const RESET_OPEN_TTL_MS = 5 * 60_000;
export const RESET_READ_FLOOR_MS = 2 * 60_000;

/**
 * @typedef {Object} ResetReading
 * @property {import('./claude-resets.js').ResetStatus|null} reset
 * @property {import('./codex-reset-credits.js').ResetCredit[]|null} credits
 * @property {number|null} seenAt
 * @property {number|null} readAt  Last success or HTTP 429, for the panel's floor.
 * @property {string|null} error
 * @property {number|null} retryAt
 */
/** @type {WeakMap<object, ResetReading>} */
const readings = new WeakMap();

/** @param {object} account */
export function resetReading(account) {
  return readings.get(account) ?? null;
}

/**
 * Record an actual read, not a cache hit. Failed reads retain the last grants.
 * @param {object} account
 * @param {'claude'|'codex'} provider
 * @param {any} read
 * @param {number} [at]
 */
export function rememberResetReading(account, provider, read, at = Date.now()) {
  const previous = resetReading(account);
  const valid = provider === 'claude' ? !!read?.reset : Array.isArray(read?.credits);
  const error = read?.error || (!valid ? `could not read reset ${provider === 'claude' ? 'status' : 'credits'}` : null);
  readings.set(account, error ? {
    reset: previous?.reset ?? null, credits: previous?.credits ?? null,
    seenAt: previous?.seenAt ?? null,
    readAt: read?.status === 429 ? at : previous?.readAt ?? null,
    error: safeLine(error, 120),
    retryAt: Number.isFinite(read?.retryAt) ? read.retryAt : null,
  } : {
    reset: provider === 'claude' ? read.reset : null,
    credits: provider === 'codex' ? read.credits : null,
    seenAt: at, readAt: at, error: null, retryAt: null,
  });
}

/**
 * Both Retry-After forms are valid: delay seconds or an HTTP date.
 * @param {any} response
 * @param {number} [now]
 */
export function resetRetryAt(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (value == null || value.trim() === '') return null;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, at) : null;
}
