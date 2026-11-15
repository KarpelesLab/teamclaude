import { randomBytes } from 'node:crypto';
import { DEFAULT_SWITCH_THRESHOLD, distributionMode } from './account-manager.js';
import { matchAccounts } from './identity.js';
import { THRESHOLD_BUCKET_KEYS, WEEKLY_BUCKET_KEYS } from './model.js';
import { createRollingWarmupSchedule, resolveWarmupSchedule } from './warmup-schedule.js';
import { parseEndsAt } from './ends-at.js';

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

// The shortest probe interval. Overlapping cycles are skipped (Prober.probeAll),
// so a short interval never stacks requests, but every cycle still reads the
// usage endpoint once per account: below this it would be hammered.
export const MIN_PROBE_SECONDS = 5;

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
  affinity: {
    value: 'affinity',
    said: 'Session distribution affinity — a 5-hour window about to reset is spent first, then the fullest account; each conversation stays on its account until that account is out of usage.',
  },
  drain: {
    value: 'drain',
    said: 'Session distribution drain — every session uses the account whose weekly quota resets soonest until it runs out, then the next; sessions already distributed keep their accounts and drain.',
  },
  load: {
    value: 'load',
    said: 'Session distribution by load — new sessions go to the account that served the fewest requests in the last ten minutes, each pinned to its own for cache reuse.',
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
  if (value > 0 && value < MIN_PROBE_SECONDS) {
    throw new ConfigOpError(`Minimum probe interval is ${MIN_PROBE_SECONDS}s (to avoid hammering the usage endpoint).`);
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
    throw new ConfigOpError('Session distribution is off, even, adaptive, affinity, drain or load.');
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
  // `typeof` first: isSafeInteger takes unknown and narrows nothing, and the
  // number the callers store and echo must not be typed as possibly absent.
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) throw new ConfigOpError('priority must be an integer, or place must be "first" or "last"');
  account.priority = priority;
  return { name: account.name, priority };
}

/**
 * Cordon an account, or put it back: a cordoned account takes no new
 * conversation, while one already on it keeps being served there.
 *
 * Uncordoning deletes the key, as enabling does: an absent key is the default.
 *
 * @param {any} config
 * @param {string} query
 * @param {boolean} cordoned
 * @param {{ orgFilter?: string }} [spec]
 */
export function setAccountCordoned(config, query, cordoned, spec = {}) {
  if (typeof cordoned !== 'boolean') throw new ConfigOpError('cordoned must be true or false');
  const account = resolveConfiguredAccount(config, query, spec.orgFilter);
  if (cordoned) account.cordoned = true;
  else delete account.cordoned;
  return { name: account.name, cordoned: !!account.cordoned };
}

/**
 * Set or clear an account's end time (accounts[].endsAt): the moment the
 * operator knows it stops being usable, which selection then treats as the
 * deadline for its unspent weekly quota when it comes before the weekly reset.
 *
 * `value` is epoch milliseconds or an ISO 8601 date or date-time; a bare date
 * is the start of that day in local time. `null` clears it by deleting the key,
 * an absent key being the default.
 *
 * Epoch milliseconds are stored as the number. A date is stored as the UTC
 * instant it named when the command ran, so an entry written as a local day
 * does not move when the server later runs in another time zone.
 *
 * @param {any} config
 * @param {string} query
 * @param {string|number|null} value
 * @param {{ orgFilter?: string }} [spec]
 * @returns {{ name: string, endsAt: number|null }}  the end time as epoch ms
 */
export function setAccountEndsAt(config, query, value, spec = {}) {
  const account = resolveConfiguredAccount(config, query, spec.orgFilter);
  if (value === null) {
    delete account.endsAt;
    return { name: account.name, endsAt: null };
  }
  const endsAt = parseEndsAt(value);
  if (endsAt == null) throw new ConfigOpError('the end time must be an ISO 8601 date or date-time (2026-12-01, 2026-12-01T09:00:00Z) or epoch milliseconds');
  const asEpoch = typeof value === 'number' || /^\d+$/.test(String(value).trim());
  account.endsAt = asEpoch ? endsAt : new Date(endsAt).toISOString();
  return { name: account.name, endsAt };
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

/**
 * Give an account a new name, and carry it into every route that lists the old one.
 *
 * A route names its accounts by exact name, so renaming the account alone would
 * drop it from those routes without a word. The new name is refused when it
 * would resolve to another account (as a name or as an email), since every
 * command looks accounts up that way, and when it is all digits, which a route
 * reads as an account index.
 *
 * @param {any} config
 * @param {string} query
 * @param {unknown} newName
 * @param {{ orgFilter?: string }} [spec]
 * @returns {{ from: string, name: string, routes: string[] }} `routes` names the routes that were updated
 */
export function renameAccount(config, query, newName, spec = {}) {
  const account = resolveConfiguredAccount(config, query, spec.orgFilter);
  if (typeof newName === 'string') refuseControlCharacters(newName, 'An account name');
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!name) throw new ConfigOpError('name the new account name');
  if (/^\d+$/.test(name)) throw new ConfigOpError(`"${name}" is all digits, which a route reads as an account index`);
  const others = (config.accounts || []).filter((/** @type {any} */ a) => a !== account);
  if (matchAccounts(others, name).length) throw new ConfigOpError(`"${name}" already names another account`);

  const from = account.name;
  account.name = name;
  /** @type {string[]} */
  const routes = [];
  for (const r of Array.isArray(config.routes) ? config.routes : []) {
    if (!Array.isArray(r.accounts) || !r.accounts.includes(from)) continue;
    r.accounts = [...new Set(r.accounts.map((/** @type {string} */ a) => a === from ? name : a))];
    routes.push(r.name);
  }
  return { from, name, routes };
}

// ── client keys ──────────────────────────────────────────────────────────────
//
// proxy.clientKeys gives each of the operator's own machines or agents a key
// and a name its usage is booked under (client-usage.js). These are the add and
// revoke steps the dashboard's Clients page sends, so a key no longer has to be
// made up and pasted into the file by hand.

// What a client-key name may contain. The name is shown in the dashboard, in
// `teamclaude status` and as a `[name]` prefix on activity-log lines, so it is
// kept to characters that read the same everywhere and need no escaping.
const CLIENT_KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;

/**
 * A new client key, in the same shape as the generated proxy.apiKey.
 * @returns {string}
 */
export function generateClientKey() {
  return 'tc-' + randomBytes(24).toString('base64url');
}

/**
 * The names of the configured client keys, in file order, each once. Never the
 * keys: this is what the status endpoint shows.
 *
 * @param {any} proxyConfig  config.proxy
 * @returns {string[]}
 */
export function clientKeyNames(proxyConfig) {
  const list = Array.isArray(proxyConfig?.clientKeys) ? proxyConfig.clientKeys : [];
  /** @type {string[]} */
  const names = [];
  for (const entry of list) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (name && entry?.key && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The key stored under a name, for the dashboard's Show details. A name a hand
 * edit gave two keys shows the first; both still work at the gate.
 *
 * @param {any} proxyConfig  config.proxy
 * @param {unknown} rawName
 * @returns {{ name: string, key: string }}
 */
export function showClientKey(proxyConfig, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) throw new ConfigOpError('name the client key');
  const list = Array.isArray(proxyConfig?.clientKeys) ? proxyConfig.clientKeys : [];
  const entry = list.find((/** @type {any} */ e) => typeof e?.name === 'string' && e.name.trim() === name && e.key);
  if (!entry) throw new ConfigOpError(`no client key is named "${name}"`);
  return { name, key: String(entry.key) };
}

/**
 * Add a client key under a new name.
 *
 * A name already in use is refused rather than given a second key: two keys
 * under one name share one usage counter, which is the thing names are for.
 * `firstKey` says the proxy had no key at all before, so callers off this
 * machine, which the open gate admitted until now, will need one from here on.
 *
 * @param {Config} config
 * @param {unknown} rawName
 * @param {string} [key]  the key to store; a fresh one when absent
 * @returns {{ name: string, key: string, firstKey: boolean }}
 */
export function addClientKey(config, rawName, key = generateClientKey()) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) throw new ConfigOpError('name the client key');
  if (!CLIENT_KEY_NAME.test(name)) {
    throw new ConfigOpError('A client key name is up to 64 letters, digits, spaces and . _ @ -, starting with a letter or digit.');
  }
  if (!config.proxy || typeof config.proxy !== 'object') config.proxy = {};
  const proxy = config.proxy;
  if (clientKeyNames(proxy).includes(name)) throw new ConfigOpError(`a client key named "${name}" already exists`);
  const firstKey = !proxy.apiKey && clientKeyNames(proxy).length === 0;
  if (!Array.isArray(proxy.clientKeys)) proxy.clientKeys = [];
  proxy.clientKeys.push({ name, key });
  return { name, key, firstKey };
}

/**
 * Revoke a client key by name. Every entry under that name goes, so a key a
 * hand edit gave a duplicate name cannot outlive the revoke. The usage booked
 * under the name stays in the state file.
 *
 * The last key of a proxy without a proxy.apiKey is refused: with no key left
 * the auth gate admits everybody, so the revoke would open the proxy to every
 * caller, the revoked client included, rather than shut one client out.
 *
 * @param {Config} config
 * @param {unknown} rawName
 * @returns {{ name: string, removed: number }}
 */
export function revokeClientKey(config, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) throw new ConfigOpError('name the client key');
  const list = Array.isArray(config.proxy?.clientKeys) ? config.proxy.clientKeys : [];
  const kept = list.filter((/** @type {any} */ e) => (typeof e?.name === 'string' ? e.name.trim() : '') !== name);
  if (kept.length === list.length) throw new ConfigOpError(`no client key is named "${name}"`);
  if (!config.proxy.apiKey && clientKeyNames({ clientKeys: kept }).length === 0) {
    throw new ConfigOpError(`"${name}" is the proxy's last key and there is no proxy.apiKey: revoking it would let anyone use the proxy. Set proxy.apiKey first.`);
  }
  config.proxy.clientKeys = kept;
  return { name, removed: list.length - kept.length };
}

// A linked instance's name is a segment of the relay path
// (/teamclaude/peers/<name>/…), so it keeps to characters that need no
// escaping there, and starting with a letter or digit rules out `.` and `..`.
const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A linked instance's address as typed, made into the form `peers` stores: an
 * http(s) origin with an optional path, no trailing slash. A bare host:port is
 * taken as http, which is how a Tailscale or LAN address is usually written.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function peerAddress(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ConfigOpError('enter the address of the other machine, e.g. http://100.64.0.2:3456');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
  let u;
  try { u = new URL(text); } catch { throw new ConfigOpError(`"${safeShown(raw)}" is not an address`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigOpError('the address must start with http:// or https://');
  // The key has its own field; one in the address would be stored and shown in the clear.
  if (u.username || u.password) throw new ConfigOpError('put the key in the key field, not in the address');
  // peers.js appends the control path to the address, which a query or fragment would swallow.
  if (u.search || u.hash) throw new ConfigOpError('the address cannot have a ? or # part');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Add a linked instance (`peers`) under a new name.
 *
 * A name already in the list is refused rather than replaced: the dashboard
 * keeps the instance it shows by name, and a silent swap would point it at a
 * different machine.
 *
 * @param {Config} config
 * @param {{ name?: unknown, url?: unknown, apiKey?: unknown }} spec
 * @returns {{ name: string, url: string }}
 */
export function addPeer(config, spec) {
  const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
  if (!name) throw new ConfigOpError('name the linked instance');
  if (!PEER_NAME.test(name)) {
    throw new ConfigOpError('A linked instance name is up to 64 letters, digits and . _ -, starting with a letter or digit.');
  }
  const url = peerAddress(spec?.url);
  const apiKey = typeof spec?.apiKey === 'string' ? spec.apiKey.trim() : '';
  if (!apiKey) throw new ConfigOpError('enter the other machine\'s proxy key (its proxy.apiKey)');
  if (apiKey.length > 512 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) throw new ConfigOpError('that proxy key has spaces or control characters in it');
  const list = Array.isArray(config.peers) ? config.peers : [];
  if (list.some((/** @type {any} */ p) => peerEntryName(p) === name)) {
    throw new ConfigOpError(`an instance named "${name}" is already linked; remove it first to change it`);
  }
  config.peers = [...list, { name, url, apiKey }];
  return { name, url };
}

/**
 * Remove a linked instance by name. Every entry under that name goes, the
 * ones the relay skips as malformed included, so none is left to come back.
 *
 * @param {Config} config
 * @param {unknown} rawName
 * @returns {{ name: string, removed: number }}
 */
export function removePeer(config, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) throw new ConfigOpError('name the linked instance');
  const list = Array.isArray(config.peers) ? config.peers : [];
  const kept = list.filter((/** @type {any} */ p) => peerEntryName(p) !== name);
  if (kept.length === list.length) throw new ConfigOpError(`no linked instance is named "${name}"`);
  config.peers = kept;
  return { name, removed: list.length - kept.length };
}

/**
 * Name this instance (`instanceName`): what the dashboard's Instance picker
 * calls the machine it is opened on, and the name it offers another machine
 * that links to it. That other machine may store it as a link name, so it
 * keeps to the same characters. An empty name drops the key, and the host
 * name is used again.
 *
 * @param {Config} config
 * @param {unknown} raw
 * @returns {string}  the name saved, or '' when it was cleared
 */
export function setInstanceName(config, raw) {
  if (typeof raw !== 'string') throw new ConfigOpError('the instance name must be text');
  const name = raw.trim();
  if (!name) { delete config.instanceName; return ''; }
  if (!PEER_NAME.test(name)) {
    throw new ConfigOpError('An instance name is up to 64 letters, digits and . _ -, starting with a letter or digit.');
  }
  config.instanceName = name;
  return name;
}

/**
 * Set the address other machines reach this one at (`instanceAddress`): what
 * the dashboard offers first when it hands out this machine's link, ahead of
 * the address the page was opened at and the proxy's guess from its own
 * interfaces. Stored in the form a linked instance's address is. An empty
 * address drops the key, and the guess is used again.
 *
 * @param {Config} config
 * @param {unknown} raw
 * @returns {string}  the address saved, or '' when it was cleared
 */
export function setInstanceAddress(config, raw) {
  if (typeof raw !== 'string') throw new ConfigOpError('the instance address must be text');
  if (!raw.trim()) { delete config.instanceAddress; return ''; }
  const address = peerAddress(raw);
  config.instanceAddress = address;
  return address;
}

/**
 * Set the share at or below which a measured outside-spend window is left out
 * of the read-out (`outsideSpendHidePercent`, see outside-spend.js). Stored
 * in tenths of a percent, the precision the read-out prints. 0 shows every
 * window.
 *
 * @param {Config} config
 * @param {unknown} raw  a percentage from 0 to 100
 * @returns {number}  the percentage saved
 */
export function setOutsideSpendHidePercent(config, raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw new ConfigOpError('The outside-spend cut-off is a percentage from 0 to 100.');
  }
  const value = Math.round(raw * 10) / 10;
  config.outsideSpendHidePercent = value;
  return value;
}

/** @param {any} entry  one element of config.peers, as found in the file */
function peerEntryName(entry) {
  return typeof entry?.name === 'string' ? entry.name.trim() : '';
}

/** @param {unknown} raw  echoed in an error message: one short line */
function safeShown(raw) {
  return String(raw).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
}
