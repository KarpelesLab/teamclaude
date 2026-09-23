import { DEFAULT_SWITCH_THRESHOLD, distributionMode } from './account-manager.js';
import { matchAccounts } from './identity.js';
import { THRESHOLD_BUCKET_KEYS, WEEKLY_BUCKET_KEYS } from './model.js';
import { createRollingWarmupSchedule, resolveWarmupSchedule } from './warmup-schedule.js';

/**
 * The rules behind the runtime-tunable settings, as changes to a config object.
 * The CLI commands and the MCP tools share them from here, rather than keeping
 * a copy each. Neither the checks a caller adds on top (the MCP tools declare
 * some in their schemas) nor the TUI settings screen, which still writes these
 * fields directly, go through this module. Nothing here reads or writes the
 * file: the caller decides how the object is loaded and persisted.
 *
 * @typedef {Record<string, any>} Config
 */

/** A refused change. The message is written for whoever asked for the change. */
export class ConfigOpError extends Error {}

// setInterval takes a 32-bit signed millisecond delay, so anything past
// ~2,147,483 s overflows to 1 ms and turns the probe into a storm.
export const MAX_PROBE_SECONDS = 7 * 24 * 3600;

export const ROUTE_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

// The buckets a threshold can be keyed by: the quota windows the manager asks
// thresholdFor() about. An unknown key would be stored and then never
// consulted, so it is refused rather than kept as a typo.
export const QUOTA_BUCKETS = THRESHOLD_BUCKET_KEYS;

// What each mode writes to the config, and what to say once it is set. Keyed by
// the mode `distributionMode` resolves to, so a caller and the router cannot
// disagree about what a setting means.
/** @type {Record<string, { value: boolean|string, said: string }>} */
export const DISTRIBUTE_MODES = {
  off: {
    value: false,
    said: 'Session distribution off — sessions already running keep their accounts and drain; new ones rotate by quota.',
  },
  even: {
    value: true,
    said: 'Session distribution on — new sessions spread across equal-priority accounts, each pinned to its own for cache reuse.',
  },
  adaptive: {
    value: 'adaptive',
    said: 'Session distribution adaptive — new sessions concentrate on the account with the least remaining weekly credit, tapering off as it nears the switch threshold and backing off when it is busy.',
  },
};

const BAD_PERCENT = 'A threshold is a percentage from 1 to 100.';

/**
 * A whole number of seconds, zero included.
 * @param {unknown} seconds
 * @param {string} what
 */
function wholeSeconds(seconds, what) {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0) {
    throw new ConfigOpError(`${what} is a whole number of seconds, or 0 for off.`);
  }
  return seconds;
}

/**
 * @param {Config} config
 * @param {unknown} seconds 0 switches the probe off
 */
export function setProbeSeconds(config, seconds) {
  const value = wholeSeconds(seconds, 'The probe interval');
  if (value > 0 && value < 30) {
    throw new ConfigOpError('Minimum probe interval is 30s (to avoid hammering the usage endpoint).');
  }
  if (value > MAX_PROBE_SECONDS) {
    throw new ConfigOpError(`Maximum probe interval is ${MAX_PROBE_SECONDS}s (7 days).`);
  }
  config.quotaProbeSeconds = value;
}

/**
 * Interval keep-warm. It and a schedule are alternatives, so setting one drops
 * the other.
 * @param {Config} config
 * @param {unknown} seconds 0 switches keep-warm off
 */
export function setWarmupSeconds(config, seconds) {
  const value = wholeSeconds(seconds, 'The keep-warm interval');
  if (value > 0 && value < 60) throw new ConfigOpError('Minimum keep-warm interval is 60s.');
  config.warmupSeconds = value;
  delete config.warmupSchedule;
}

/**
 * @param {Config} config
 * @param {unknown} mode 'reset' (a daily target) or 'rolling' (a five-hour cadence)
 * @param {{ resetTime?: unknown, timezone?: unknown }} schedule
 */
export function setWarmupSchedule(config, mode, schedule) {
  if (mode !== 'reset' && mode !== 'rolling') {
    throw new ConfigOpError('A warm-up schedule is reset or rolling.');
  }
  const target = { resetTime: schedule?.resetTime, timezone: schedule?.timezone };
  let stored;
  try {
    if (mode === 'rolling') {
      stored = createRollingWarmupSchedule(target);
    } else {
      const resolved = resolveWarmupSchedule(target);
      stored = { resetTime: resolved.resetTime, timezone: resolved.timezone };
    }
  } catch (err) {
    throw new ConfigOpError(err instanceof Error ? err.message : String(err));
  }
  config.warmupSchedule = stored;
  config.warmupSeconds = 0;
}

/**
 * The stored form of a percentage: a 0–1 ratio quantised to tenths of a
 * percent, so a value set here reads back identically on the settings screen
 * (tui.js quantises the same way). Null when the input is not a percentage
 * this setting accepts.
 * @param {unknown} percent
 * @returns {number|null}
 */
export function thresholdRatio(percent) {
  // Checked before Number(), which makes 1 of `true` and 95 of `[95]`: a 1%
  // threshold takes an account out of rotation almost at once, and not every
  // caller is a person typing digits.
  if (typeof percent !== 'number' && typeof percent !== 'string') return null;
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) return null;
  return Math.round(pct * 10) / 1000;
}

/**
 * The threshold table as `{ default, ...buckets }`, whatever shape it is stored
 * in — a bare number is the default with no bucket overrides.
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
export function thresholdTable(value) {
  // Only a hand edit produces an array; the CLI and the TUI write a number or a
  // keyed object. Spread, it became a table with a bucket named "0" that
  // nothing ever asks about, while the threshold in force stayed the default
  // and nothing said why (#425).
  if (Array.isArray(value)) {
    console.error('[TeamClaude] switchThreshold is an array in the config — expected a number or an object keyed by bucket; using the default');
    return { default: DEFAULT_SWITCH_THRESHOLD };
  }
  if (value && typeof value === 'object') {
    return { default: DEFAULT_SWITCH_THRESHOLD, ...value };
  }
  return { default: typeof value === 'number' ? value : DEFAULT_SWITCH_THRESHOLD };
}

/**
 * One number for every bucket. It replaces a per-bucket table rather than
 * hiding one behind the number now in effect, and names what it dropped.
 * @param {Config} config
 * @param {unknown} percent
 * @returns {{ dropped: string[] }}
 */
export function setThreshold(config, percent) {
  const ratio = thresholdRatio(percent);
  if (ratio === null) throw new ConfigOpError(BAD_PERCENT);
  const dropped = Object.keys(thresholdTable(config.switchThreshold)).filter(b => b !== 'default');
  config.switchThreshold = ratio;
  return { dropped };
}

/**
 * Per-bucket thresholds. A null percentage drops that bucket's override.
 * @param {Config} config
 * @param {Array<[string, unknown]>} pairs
 */
export function setBucketThresholds(config, pairs) {
  const table = thresholdTable(config.switchThreshold);
  for (const [bucket, percent] of pairs) {
    if (bucket !== 'default' && !QUOTA_BUCKETS.includes(bucket)) {
      throw new ConfigOpError(`Unknown quota bucket "${bucket}" — expected one of: default, ${QUOTA_BUCKETS.join(', ')}`);
    }
    if (percent === null) {
      if (bucket === 'default') {
        throw new ConfigOpError('The default threshold is the fallback — set it to a number instead of dropping it.');
      }
      delete table[bucket];
      continue;
    }
    const ratio = thresholdRatio(percent);
    if (ratio === null) throw new ConfigOpError(BAD_PERCENT);
    table[bucket] = ratio;
  }
  // Back to the plain form once the last override is gone: an object holding
  // only `default` is the same setting written the long way.
  const overrides = Object.keys(table).filter(b => b !== 'default');
  config.switchThreshold = overrides.length ? table : table.default;
}

/**
 * @param {Config} config
 * @param {unknown} mode a DISTRIBUTE_MODES key
 * @returns {boolean} whether the stored value changed
 */
export function setDistribution(config, mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(DISTRIBUTE_MODES, mode)) {
    throw new ConfigOpError('Session distribution is off, even or adaptive.');
  }
  // Compared as modes, not stored values: a hand-written `"on"` already means
  // even, and rewriting it would be a read-modify-write for nothing.
  const changed = distributionMode(config.distributeSessions) !== mode;
  if (changed) config.distributeSessions = DISTRIBUTE_MODES[mode].value;
  return changed;
}

// C0 and C1 control characters, ESC and the 8-bit CSI among them. These values
// are drawn on a terminal as they are stored (the TUI prints a route's name
// raw), so one that carries an escape sequence would let whoever set it
// repaint or retitle the operator's screen.
const CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Refuse a string that carries a control character, naming the field it came in.
 * @param {string} value
 * @param {string} field
 */
function refuseControlCharacters(value, field) {
  if (CONTROL_CHARACTER.test(value)) {
    throw new ConfigOpError(`${field} must not contain control characters.`);
  }
}

/**
 * @param {unknown} list
 * @param {string} field what the list is, for the refusal of a control character
 * @returns {string[]|null} null when the value is not a list of non-empty strings
 */
function stringList(list, field) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) return null;
    // Before the trim: a stored value is never one the check did not see.
    refuseControlCharacters(item, field);
    out.push(item.trim());
  }
  return out;
}

/**
 * Add a route, or replace the one already holding its name.
 * @param {Config} config
 * @param {{ name?: unknown, match?: unknown, accounts?: unknown, bucket?: unknown, color?: unknown }} spec
 * @returns {{ route: Record<string, any>, updated: boolean, unknownAccounts: string[] }}
 *   `route` as stored; `unknownAccounts` names no configured account, which is
 *   allowed, since a route may be written ahead of the account it names, but
 *   worth telling the caller about
 */
export function upsertRoute(config, spec) {
  if (typeof spec.name === 'string') refuseControlCharacters(spec.name, 'A route name');
  const name = typeof spec.name === 'string' ? spec.name.trim() : '';
  const match = stringList(spec.match, 'A route match glob');
  if (!name || !match?.length) throw new ConfigOpError('A route needs a name and at least one match glob.');
  const accounts = spec.accounts == null ? [] : stringList(spec.accounts, 'A route account');
  if (!accounts) throw new ConfigOpError('Route accounts are a list of account names or indexes.');
  const color = typeof spec.color === 'string' && spec.color ? spec.color.toLowerCase() : null;
  if (color && !ROUTE_COLORS.includes(color)) {
    throw new ConfigOpError(`Unknown color "${spec.color}" — expected one of: ${ROUTE_COLORS.join(', ')}`);
  }

  /** @type {Record<string, any>} */
  const route = { name, match };
  if (accounts.length) route.accounts = accounts;
  if (typeof spec.bucket === 'string' && spec.bucket) {
    refuseControlCharacters(spec.bucket, 'A route bucket');
    // Stored verbatim, this becomes the route's weekly gating key. A typo names
    // a bucket no account's quota map carries, so the route is never gated on
    // its weekly window and nothing says so (#424). `threshold` refuses an
    // unknown bucket for the same reason.
    if (!WEEKLY_BUCKET_KEYS.includes(spec.bucket)) {
      throw new ConfigOpError(`Unknown route bucket "${spec.bucket}" — expected one of: ${WEEKLY_BUCKET_KEYS.join(', ')}`);
    }
    route.bucket = spec.bucket;
  }
  if (color) route.color = color;

  const known = new Set((config.accounts || []).map((/** @type {any} */ a) => a.name));
  const unknownAccounts = accounts.filter(a => !known.has(a) && !/^\d+$/.test(a));

  config.routes = Array.isArray(config.routes) ? config.routes : [];
  const at = config.routes.findIndex((/** @type {any} */ r) => r.name === name);
  if (at >= 0) config.routes[at] = route; else config.routes.push(route);
  return { route, updated: at >= 0, unknownAccounts };
}

/**
 * @param {Config} config
 * @param {unknown} name
 */
export function removeRoute(config, name) {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const kept = routes.filter((/** @type {any} */ r) => r.name !== name);
  if (kept.length === routes.length) throw new ConfigOpError(`Route "${name}" not found`);
  config.routes = kept;
}

/**
 * Replace the model blocklist.
 * @param {Config} config
 * @param {unknown} patterns
 */
export function setBlockedModels(config, patterns) {
  if (!Array.isArray(patterns)) throw new ConfigOpError('Blocked models are a list of model patterns.');
  const list = stringList(patterns, 'A blocked-model pattern');
  if (!list) throw new ConfigOpError('Each blocked-model pattern is a non-empty string.');
  config.blockedModels = [...new Set(list)];
}

/**
 * @param {Config} config
 * @param {unknown} mode
 */
export function setDefaultClientMode(config, mode) {
  if (mode !== 'mitm' && mode !== 'base-url') {
    throw new ConfigOpError('The default client mode is mitm or base-url.');
  }
  config.defaultClientMode = mode;
}

// ── account controls ─────────────────────────────────────────────────────────
//
// `teamclaude priority` / `disable` / `enable` resolved and mutated the account
// inline, which left the same three steps — match, disambiguate, mutate — with
// no home a non-CLI caller could reach. These are that, as operations, so the
// CLI, the MCP tools and the dashboard all decide "which account" the same way.

/**
 * The one account `query` names, or a ConfigOpError saying why not.
 *
 * Ambiguity is an error rather than a pick: an email shared by two orgs names a
 * different account in each, and silently taking the first would disable or
 * reprioritize the wrong one.
 *
 * @param {any} config
 * @param {string} query - account name, or the email portion of one
 * @param {string} [orgFilter] - org name or uuid, when the query alone is ambiguous
 */
export function resolveConfiguredAccount(config, query, orgFilter) {
  if (typeof query !== 'string' || !query.trim()) throw new ConfigOpError('name an account');
  const matches = matchAccounts(config.accounts || [], query, orgFilter);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ConfigOpError(`no account matches "${query}"`);
  const orgs = matches.map((/** @type {any} */ a) => a.orgName || a.orgUuid || '(no org)').join(', ');
  throw new ConfigOpError(`"${query}" matches ${matches.length} accounts (${orgs}) — name the org too`);
}

/**
 * Set an account's rotation priority. Lower is preferred.
 *
 * `place` moves the account relative to the rest instead of naming a number,
 * which is what a caller with buttons rather than a number field has: 'first'
 * goes one below the lowest, 'last' one above the highest. Same arithmetic the
 * CLI's --first/--last already used, so the two agree.
 *
 * @param {any} config
 * @param {string} query
 * @param {{ priority?: number, place?: 'first'|'last', orgFilter?: string }} spec
 */
export function setAccountPriority(config, query, spec = {}) {
  const account = resolveConfiguredAccount(config, query, spec.orgFilter);
  const priorities = (config.accounts || []).map((/** @type {any} */ a) => a.priority || 0);
  let priority;
  if (spec.place === 'first') priority = Math.min(0, ...priorities) - 1;
  else if (spec.place === 'last') priority = Math.max(0, ...priorities) + 1;
  else priority = spec.priority;
  if (!Number.isInteger(priority)) throw new ConfigOpError('priority must be an integer, or place must be "first" or "last"');
  account.priority = priority;
  return { name: account.name, priority };
}

/**
 * Take an account out of rotation, or put it back.
 *
 * Enabling deletes the key rather than writing `false`, because that is what
 * the CLI has always written and an absent key is the configured default.
 *
 * @param {any} config
 * @param {string} query
 * @param {boolean} disabled
 * @param {{ orgFilter?: string }} [spec]
 */
export function setAccountDisabled(config, query, disabled, spec = {}) {
  if (typeof disabled !== 'boolean') throw new ConfigOpError('disabled must be true or false');
  const account = resolveConfiguredAccount(config, query, spec.orgFilter);
  if (disabled) account.disabled = true;
  else delete account.disabled;
  return { name: account.name, disabled: !!account.disabled };
}
