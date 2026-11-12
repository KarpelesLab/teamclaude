// Client routes: one fixed seat per client key (IPM fork, AI-1552).
//
// A client route names the accounts that serve one set of client keys:
//
//   "clientRoutes": [{ "name": "seat-7", "clients": ["pedro"], "accounts": ["seat-7@x"] }],
//   "proxy": { "requireClientRoute": true }
//
// A key on a route is served by its own accounts only, never moved to another
// one by rotation or by a failover hop. With `proxy.requireClientRoute` on, a
// key on no route gets no Anthropic inference at all, and neither does the
// shared proxy.apiKey or a key-less loopback caller unless it pins an account
// explicitly. Codex and every other provider are untouched.
//
// Kept apart from the model routes (`routes`, account-manager.js): those match
// a MODEL to accounts and drive rotation; these match a CLIENT and replace it.
// `getRoutes()`, the CLI, the TUI and the MCP route tools never see them.
//
// Only account NAMES are stored. A reload can add, remove or renumber
// accounts, so a route is resolved against the live list on every request,
// the way TC_ACCT and session pins are. A name that does not resolve to
// exactly one account leaves the route unresolved, and its keys get the
// "seat unavailable" answer rather than some other account.
//
// The answers a bound request gets when its seat cannot serve come from the
// manager's own classifier (unavailableReason), with one difference: the
// switch threshold is ignored. It decides when rotation leaves an account,
// which means nothing with one seat, so a bound seat is used until upstream
// says it is spent. "Spent" is upstream's own word only: the
// anthropic-ratelimit-unified-* headers of a 429 that rejected a window,
// recorded here and replayed verbatim while that window's reset is ahead.
// Nothing here invents a reset time; with no such reading the request goes to
// the seat and upstream answers it.

import { createHash } from 'node:crypto';
import { safeLine } from './safe-text.js';
import { DEFAULT_PROVIDER, providerOf, isSubscriptionAccount } from './provider.js';
import { weeklyBucketForModel } from './model.js';
import { accountSupportsModel } from './openai-chat-adapter.js';

/** Activity-log reasons, one per gate outcome or hard stop. */
export const SEAT_REASONS = Object.freeze({
  noSeat: 'no-seat',
  foreignPin: 'foreign-pin',
  spent: 'spent',
  throttled: 'throttled',
  unavailable: 'unavailable',
  capped: 'capped',
  adminPin: 'admin-pin',
  operatorUnpinned: 'operator-unpinned',
  operatorPin: 'operator-pin',
});

export const norm = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const SEAT_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEAT_POLICY_MODES = new Set(['force', 'recommend']);

/**
 * Resolve the caller's per-seat choices against one renderer-produced route.
 * Anything ambiguous disables force for the whole request; a partial map must
 * never turn a malformed preference into permission to move a conversation.
 *
 * @param {unknown} rawHeader
 * @param {ClientRoute} route
 * @param {number[]} indices
 * @returns {Map<number, 'force'|'recommend'>}
 */
export function parseSeatPolicies(rawHeader, route, indices) {
  /** @type {Map<number, 'force'|'recommend'>} */
  const empty = new Map();
  const slugs = route.name.split('+');
  if (slugs.length !== route.accounts.length || slugs.length !== indices.length
      || new Set(slugs).size !== slugs.length || new Set(indices).size !== indices.length
      || slugs.some(s => !SEAT_SLUG.test(s)) || indices.some(i => !Number.isInteger(i))) return empty;
  if (typeof rawHeader !== 'string' || !rawHeader.trim()) return empty;
  if (rawHeader.length > 4096) return empty;
  const entries = rawHeader.split(',');
  if (entries.length > 64) return empty;
  /** @type {Map<string, 'force'|'recommend'>} */
  const parsed = new Map();
  for (const entry of entries) {
    const parts = entry.trim().split('=');
    if (parts.length !== 2) return empty;
    const slug = parts[0].trim();
    const mode = parts[1].trim();
    if ((slug !== '*' && !SEAT_SLUG.test(slug)) || !SEAT_POLICY_MODES.has(mode)
        || parsed.has(slug) || (slug !== '*' && !slugs.includes(slug))) return empty;
    parsed.set(slug, /** @type {'force'|'recommend'} */ (mode));
  }
  const fallback = parsed.get('*') ?? 'recommend';
  const out = new Map();
  slugs.forEach((slug, i) => out.set(indices[i], parsed.get(slug) ?? fallback));
  return out;
}

/**
 * @typedef {{ name: string, clients: string[], accounts: string[] }} ClientRoute
 * @typedef {{
 *   routes: ClientRoute[],
 *   byClient: Map<string, ClientRoute>,
 *   ambiguous: Map<string, string[]>,
 *   warnings: string[],
 * }} ClientRouteTable
 */

/**
 * Parse `clientRoutes` from the config. Never throws: a malformed entry is
 * dropped with a warning, since refusing the whole table on one bad entry
 * would block every key on every other route.
 *
 * A client on two routes is AMBIGUOUS: neither route applies to it and its
 * requests get the "seat unavailable" answer. Picking one would be a guess
 * about which seat a person's quota should come from.
 *
 * @param {unknown} raw
 * @returns {ClientRouteTable}
 */
export function parseClientRoutes(raw) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {ClientRoute[]} */
  const routes = [];
  if (raw != null && !Array.isArray(raw)) {
    warnings.push('clientRoutes is not a list; no client routes apply');
  }
  const list = Array.isArray(raw) ? raw : [];
  const names = new Set();
  list.forEach((entry, i) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) { warnings.push(`clientRoutes[${i}] has no name; ignored`); return; }
    if (names.has(norm(name))) warnings.push(`clientRoutes: route "${safeLine(name, 64)}" appears twice`);
    names.add(norm(name));
    const strings = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
    const clients = strings(entry.clients);
    const accounts = strings(entry.accounts);
    if (!accounts.length) warnings.push(`clientRoutes: route "${safeLine(name, 64)}" names no account; its clients get "seat unavailable"`);
    routes.push({ name, clients, accounts });
  });

  /** @type {Map<string, ClientRoute[]>} */
  const seen = new Map();
  for (const route of routes) {
    for (const c of new Set(route.clients.map(norm))) {
      const on = seen.get(c) || [];
      on.push(route);
      seen.set(c, on);
    }
  }
  const byClient = new Map();
  const ambiguous = new Map();
  for (const [client, on] of seen) {
    if (on.length === 1) { byClient.set(client, on[0]); continue; }
    const routeNames = on.map((r) => r.name);
    ambiguous.set(client, routeNames);
    warnings.push(`clientRoutes: client "${safeLine(client, 64)}" is on ${routeNames.length} routes (${routeNames.map((n) => `"${safeLine(n, 64)}"`).join(', ')}); none applies and it gets "seat unavailable"`);
  }
  return { routes, byClient, ambiguous, warnings };
}

/** @returns {ClientRouteTable} */
export function emptyClientRoutes() {
  return { routes: [], byClient: new Map(), ambiguous: new Map(), warnings: [] };
}

// ── owner-root continuation policies (AI-1903) ─────────────────────────────
//
// `continuationPolicies` is the durable, owner-controlled seat-continuation
// policy the gateway renders into the devs config. A root matches an
// authenticated client key by its normalized name plus the full SHA-256 of the
// key itself, and overrides the per-request `x-teamclaude-seat-policy` header
// for every account of the key's route. The keyHash never leaves this module:
// not in logs, not in status, not in a tracker or offer key.

const KEY_HASH = /^[0-9a-f]{64}$/;
const POLICY_REVISION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The full lowercase-hex SHA-256 of a client key (C1). Never logged, never in
 * status, never part of a tracker or offer key.
 * @param {string} key
 * @returns {string}
 */
export function keyHashOf(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The offer-scope key reference (C9/E14): sha256("teamclaude-offer-v1" NUL
 * keyHash), first 32 hex chars. Offers are scoped by this so the full keyHash
 * never enters a tracker/session key, an offer key or a log line.
 * @param {string} keyHash
 * @returns {string}
 */
export function offerKeyRef(keyHash) {
  return createHash('sha256').update(`teamclaude-offer-v1\0${keyHash}`).digest('hex').slice(0, 32);
}

/**
 * @typedef {{ client: string, keyHash: string, mode: 'force'|'recommend', revision: string|null, quarantine: boolean }} ContinuationPolicy
 * @typedef {{ client: string, reason: string, carriedForward: boolean }} ContinuationPolicyError
 * @typedef {{
 *   policies: ContinuationPolicy[],
 *   errors: ContinuationPolicyError[],
 *   loadError: string|null,
 *   byKey: Map<string, ContinuationPolicy>,
 *   failSafeAll: boolean,
 * }} ContinuationPolicyTable
 */

/**
 * Parse the rendered `continuationPolicies` (and the renderer's own
 * `continuationPolicyErrors`) from the config. Never throws, like
 * parseClientRoutes — a malformed list must not take the pool down; it fails
 * safe instead:
 *
 * - absent key: no roots, legacy header behavior for everyone;
 * - present but not a list: `failSafeAll` — EVERY client key recommends and a
 *   legacy force header is ignored, with loadError 'malformed_list';
 * - an entry with a valid client+keyHash but a bad mode or revision: that key
 *   recommends (legacy force never revives), loadError 'malformed_entries';
 * - an entry whose client or keyHash is itself invalid: dropped — it names no
 *   current key.
 *
 * @param {unknown} raw
 * @param {unknown} rawErrors
 * @returns {ContinuationPolicyTable}
 */
export function parseContinuationPolicies(raw, rawErrors) {
  /** @type {ContinuationPolicyError[]} */
  const errors = [];
  if (Array.isArray(rawErrors)) {
    for (const e of rawErrors) {
      const entry = /** @type {Record<string, unknown>|null} */ (e && typeof e === 'object' ? e : null);
      if (entry && typeof entry.client === 'string' && typeof entry.reason === 'string') {
        errors.push({ client: entry.client, reason: entry.reason, carriedForward: entry.carriedForward === true });
      }
    }
  }
  /** @type {ContinuationPolicy[]} */
  const policies = [];
  /** @type {Map<string, ContinuationPolicy>} */
  const byKey = new Map();
  if (raw == null) return { policies, errors, loadError: null, byKey, failSafeAll: false };
  if (!Array.isArray(raw)) return { policies, errors, loadError: 'malformed_list', byKey, failSafeAll: true };
  /** @type {string|null} */
  let loadError = null;
  for (const rawEntry of raw) {
    const entry = /** @type {Record<string, unknown>|null} */ (rawEntry && typeof rawEntry === 'object' ? rawEntry : null);
    const client = typeof entry?.client === 'string' ? entry.client.trim() : '';
    const keyHash = typeof entry?.keyHash === 'string' ? entry.keyHash : '';
    if (!client || !KEY_HASH.test(keyHash)) continue;
    const mode = entry?.mode;
    const revision = entry?.revision;
    /** @type {ContinuationPolicy} */
    let policy;
    if (typeof mode !== 'string' || !SEAT_POLICY_MODES.has(mode)
        || typeof revision !== 'string' || !POLICY_REVISION.test(revision)) {
      policy = { client, keyHash, mode: 'recommend', revision: null, quarantine: false };
      loadError = 'malformed_entries';
    } else {
      policy = { client, keyHash, mode: /** @type {'force'|'recommend'} */ (mode), revision, quarantine: entry?.quarantine === true };
    }
    const mapKey = `${norm(client)}\0${keyHash}`;
    if (byKey.has(mapKey)) continue; // a duplicate record keeps the first
    byKey.set(mapKey, policy);
    policies.push(policy);
  }
  return { policies, errors, loadError, byKey, failSafeAll: false };
}

/** The implicit root every client key gets while the rendered list is unreadable. */
const FAILSAFE_ROOT = /** @type {ContinuationPolicy} */ (Object.freeze({ client: '', keyHash: '', mode: 'recommend', revision: null, quarantine: false }));

/**
 * The owner root governing this caller, or null for the legacy header
 * behavior. Matched by the client name normalized like routeForClient plus the
 * full keyHash (C1); a caller with neither (shared key, key-less loopback) is
 * never governed by a root. While the list is malformed every client key fails
 * safe to recommend.
 * @param {ContinuationPolicyTable|null|undefined} table
 * @param {string|null|undefined} client
 * @param {string|null|undefined} keyHash
 * @returns {ContinuationPolicy|null}
 */
export function matchContinuationPolicy(table, client, keyHash) {
  if (!table || !client || !keyHash) return null;
  if (table.failSafeAll) return FAILSAFE_ROOT;
  return table.byKey.get(`${norm(client)}\0${keyHash}`) ?? null;
}

/**
 * The operator's status view of the parsed policies (C5): every field but the
 * keyHash, which never appears in status.
 * @param {ContinuationPolicyTable|null|undefined} table
 * @returns {{ policies: { client: string, mode: 'force'|'recommend', revision: string|null, quarantine: boolean }[], errors: ContinuationPolicyError[], loadError: string|null }}
 */
export function continuationPolicyStatus(table) {
  return {
    policies: (table?.policies ?? []).map((p) => ({ client: p.client, mode: p.mode, revision: p.revision, quarantine: p.quarantine })),
    errors: (table?.errors ?? []).map((e) => ({ client: e.client, reason: e.reason, carriedForward: e.carriedForward })),
    loadError: table?.loadError ?? null,
  };
}

/**
 * `caller.continuationPolicy` for a client-key status caller (C5): its own
 * root, or the legacy source when no root governs its key.
 * @param {ContinuationPolicyTable|null|undefined} table
 * @param {string|null|undefined} client
 * @param {string|null|undefined} keyHash
 * @returns {{ source: 'root'|'legacy', mode: 'force'|'recommend'|null, revision: string|null }}
 */
export function callerContinuationPolicy(table, client, keyHash) {
  const root = matchContinuationPolicy(table, client, keyHash);
  return root
    ? { source: 'root', mode: root.mode, revision: root.revision }
    : { source: 'legacy', mode: null, revision: null };
}

/**
 * Whether the fork's policy is in force at all: any route, or the switch on.
 * With neither, every path behaves exactly as upstream teamclaude.
 * @param {ClientRouteTable|null|undefined} table
 * @param {any} proxyConfig
 */
export function clientRoutePolicyActive(table, proxyConfig) {
  return (table?.routes?.length ?? 0) > 0 || proxyConfig?.requireClientRoute === true;
}

/**
 * The route a client key is on.
 * @param {ClientRouteTable|null|undefined} table
 * @param {string|null|undefined} client
 * @returns {{ route: ClientRoute } | { ambiguous: string[] } | null}
 */
export function routeForClient(table, client) {
  const c = norm(client);
  if (!c || !table) return null;
  const amb = table.ambiguous.get(c);
  if (amb) return { ambiguous: amb };
  const route = table.byClient.get(c);
  return route ? { route } : null;
}

/**
 * Resolve a route against the live account list. Each name goes through the
 * proxy's own pin resolver (`resolvePin`, server.js resolveAccountPin, passed
 * in to keep this module free of a server.js import), and must then name
 * exactly one account: a display name two accounts share would otherwise bind
 * to whichever comes first. A Codex subscription cannot serve Anthropic
 * inference, so a route naming one is unresolved too.
 *
 * @param {any} accountManager
 * @param {ClientRoute} route
 * @param {(am: any, token: string) => number|null} resolvePin
 * @returns {{ resolved: boolean, indices: number[], problem: string|null }}
 */
export function resolveClientRoute(accountManager, route, resolvePin) {
  const accounts = accountManager.accounts || [];
  /** @type {number[]} */
  const indices = [];
  if (!route.accounts.length) return { resolved: false, indices, problem: 'names no account' };
  for (const name of route.accounts) {
    const i = resolvePin(accountManager, name);
    if (i == null) return { resolved: false, indices: [], problem: `account "${safeLine(name, 64)}" is not configured` };
    const shared = accounts.filter((/** @type {any} */ a) => norm(a.name) === norm(name)).length;
    if (shared > 1) return { resolved: false, indices: [], problem: `account name "${safeLine(name, 64)}" is shared by ${shared} accounts` };
    const a = accounts[i];
    if (isSubscriptionAccount(a) && providerOf(a) !== DEFAULT_PROVIDER) {
      return { resolved: false, indices: [], problem: `account "${safeLine(name, 64)}" is a ${providerOf(a)} subscription` };
    }
    if (!indices.includes(i)) indices.push(i);
  }
  return { resolved: true, indices, problem: null };
}

// ── upstream rejections, recorded for the spent answer ─────────────────────

/**
 * @typedef {{ headers: Record<string, string>, scope: string, resetsAt: number, at: number }} SeatRejection
 */
/** @type {WeakMap<object, SeatRejection>} keyed by the account object */
const rejections = new WeakMap();

const UNIFIED_PREFIX = 'anthropic-ratelimit-unified-';
const resetMs = (/** @type {unknown} */ v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};

/**
 * Record the unified headers of an upstream 429 that rejected a quota window,
 * so a later request for the same window gets upstream's own answer without
 * spending a request to hear it. `scope` is 'all' for the shared 5-hour or
 * weekly window, else the weekly bucket the rejection is about: `7d_oi` is
 * Fable's, and a rejection no window signed is the bucket of the model that
 * met it (Sonnet's weekly bucket has no header of its own). Without a reset
 * time that parses nothing is recorded: the spent answer never invents one.
 *
 * @param {object} account
 * @param {Record<string, string>} headers  the response's anthropic-ratelimit-* headers
 * @param {string|null} model
 * @param {(model: string|null) => string} [bucketFor]  the manager's bucket mapping (routes may override it)
 * @returns {SeatRejection|null}
 */
export function recordSeatRejection(account, headers, model, bucketFor = weeklyBucketForModel, now = Date.now()) {
  const h = headers || {};
  const st = (/** @type {string} */ w) => h[`${UNIFIED_PREFIX}${w}-status`];
  const shared = ['5h', '7d'].filter((w) => st(w) === 'rejected');
  let scope = null;
  /** @type {number[]} */
  let resets = [];
  if (shared.length) {
    scope = 'all';
    resets = shared.map((w) => resetMs(h[`${UNIFIED_PREFIX}${w}-reset`])).filter((v) => v != null);
  } else if (st('7d_oi') === 'rejected') {
    scope = 'unified7dFable';
    resets = [resetMs(h[`${UNIFIED_PREFIX}7d_oi-reset`])].filter((v) => v != null);
  } else if (h[`${UNIFIED_PREFIX}status`] === 'rejected') {
    scope = bucketFor(model);
  }
  if (!scope) return null;
  if (!resets.length) {
    const overall = resetMs(h[`${UNIFIED_PREFIX}reset`]);
    if (overall != null) resets = [overall];
  }
  if (!resets.length) return null;
  const resetsAt = Math.max(...resets);
  if (resetsAt <= now) return null;
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [k, v] of Object.entries(h)) if (k.startsWith(UNIFIED_PREFIX)) kept[k] = String(v);
  const rec = { headers: kept, scope, resetsAt, at: now };
  rejections.set(account, rec);
  return rec;
}

/**
 * The live rejection that covers `model` on `account`, or null. One whose
 * reset has passed is dropped: the window has turned over, and the next
 * request finds out from upstream.
 * @param {object} account
 * @param {string|null} model
 * @param {(model: string|null) => string} [bucketFor]
 */
export function liveSeatRejection(account, model, bucketFor = weeklyBucketForModel, now = Date.now()) {
  const rec = rejections.get(account);
  if (!rec) return null;
  if (rec.resetsAt <= now) { rejections.delete(account); return null; }
  if (rec.scope === 'all' || rec.scope === bucketFor(model)) return rec;
  return null;
}

/** Forget a recorded rejection (a usage-limit reset landed, a test). @param {object} account */
export function clearSeatRejection(account) {
  rejections.delete(account);
}

// ── verdicts and answers ───────────────────────────────────────────────────

/**
 * @typedef {{ kind: 'spent', rejection: SeatRejection }
 *   | { kind: 'throttled', retryAfter: number }
 *   | { kind: 'capped', reason: string }
 *   | { kind: 'unavailable', reason: string }} SeatVerdict
 */

const UNAVAILABLE = new Set(['disabled', 'error', 'entitlement', 'credential', 'routing']);
const CAPPED = new Set(['capped', 'spend-capped', 'advisor-capped']);

/**
 * Why a bound seat cannot serve this request, or null to send it. Read from
 * unavailableReason, which also clears an expired throttle or window before it
 * answers. Its threshold verdicts ('quota', 'advisor-quota') and its stale
 * upstream verdict ('upstream-rejected') stand only with a live recorded
 * rejection behind them; without one the state is unknown and upstream
 * answers. A model route that excludes the seat ('route') does not apply to a
 * bound request either, as it does not to a pin: the seat is the request's.
 *
 * @param {any} accountManager
 * @param {any} account
 * @param {string|null} model
 * @param {string|null} [advisorModel]
 * @returns {SeatVerdict|null}
 */
export function seatVerdict(accountManager, account, model, advisorModel = null, now = Date.now()) {
  if (!account) return { kind: 'unavailable', reason: 'unresolved' };
  if (!accountSupportsModel(account, model) || !accountSupportsModel(account, advisorModel)) {
    return { kind: 'unavailable', reason: 'model-adapter' };
  }
  const bucketFor = (/** @type {string|null} */ m) => accountManager._weeklyBucketFor?.(m) ?? weeklyBucketForModel(m);
  const reason = accountManager.unavailableReason(account, model, advisorModel);
  const spent = liveSeatRejection(account, model, bucketFor, now)
    || (advisorModel ? liveSeatRejection(account, advisorModel, bucketFor, now) : null);
  if (reason && UNAVAILABLE.has(reason)) return { kind: 'unavailable', reason };
  if (reason && CAPPED.has(reason)) return { kind: 'capped', reason };
  if (spent) return { kind: 'spent', rejection: spent };
  if (reason === 'throttled') {
    const until = Number(account.rateLimitedUntil) || now;
    return { kind: 'throttled', retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
  }
  return null;
}

/**
 * The verdict a set of bound seats gives when none can serve: throttled if any
 * is only throttled (it is the one that comes back soonest), spent if every
 * one is spent, unavailable otherwise.
 * @param {(SeatVerdict|null)[]} verdicts
 * @returns {SeatVerdict|null}
 */
export function combineVerdicts(verdicts) {
  const real = /** @type {SeatVerdict[]} */ (verdicts.filter(Boolean));
  if (!real.length) return null;
  const throttled = real.filter((v) => v.kind === 'throttled');
  if (throttled.length) return throttled.reduce((a, b) => (/** @type {any} */ (a).retryAfter <= /** @type {any} */ (b).retryAfter ? a : b));
  if (real.length === verdicts.length && real.every((v) => v.kind === 'spent')) {
    return real.reduce((a, b) => (/** @type {any} */ (a).rejection.resetsAt <= /** @type {any} */ (b).rejection.resetsAt ? a : b));
  }
  const capped = real.find((v) => v.kind === 'capped');
  return capped || real.find((v) => v.kind === 'unavailable') || real[0];
}

const KIMI_HINT = 'Use `cg kimi on` to keep working meanwhile.';

/**
 * The owner-wide continuation paragraph (C7, verbatim), appended to the
 * actionable multi-seat 429 only when the request carries
 * `x-teamclaude-cg-contract: root-v1` (E7): an older cg answers
 * `cg seat-policy force` on a multi-seat key with a usage error.
 */
export const CG_SEAT_POLICY_ROOT_PARAGRAPH = 'To make all local and remote workers using this key continue automatically on every assigned seat, run `cg seat-policy force`. This durable owner-wide policy takes effect on the next request; run `cg seat-policy recommend` to restore confirmations.';

/**
 * The next account in a seat's queue that can serve now, in config order,
 * skipping the conversation's pinned (spent) one — the account a fresh,
 * handoff-ed conversation would land on. Queue order, not least-loaded: the
 * seat's quota drains one account at a time, and an earlier account whose
 * window has since reset is servable again and correctly found first.
 * @param {any} accountManager
 * @param {number[]} indices  the seat's accounts, in config order
 * @param {number} currentIdx  the pinned account the answer is about
 * @param {string|null} [model]
 * @param {string|null} [advisorModel]
 * @param {Set<number>|null} [excluded]
 * @returns {number|null} the account's index, or null when nothing else serves
 */
export function nextInSeatQueueIndex(accountManager, indices, currentIdx, model = null, advisorModel = null, excluded = null) {
  for (const i of indices) {
    if (i === currentIdx || excluded?.has(i)) continue;
    const account = accountManager.accounts[i];
    if (account && !seatVerdict(accountManager, account, model, advisorModel)) return i;
  }
  return null;
}

/**
 * The named form of nextInSeatQueueIndex for the handoff offer.
 * @param {any} accountManager
 * @param {number[]} indices
 * @param {number} currentIdx
 * @param {string|null} [model]
 * @param {string|null} [advisorModel]
 * @returns {string|null}
 */
export function nextInSeatQueue(accountManager, indices, currentIdx, model = null, advisorModel = null) {
  const i = nextInSeatQueueIndex(accountManager, indices, currentIdx, model, advisorModel);
  return i == null ? null : accountManager.accounts[i].name;
}

/**
 * The HTTP answer for a gate refusal or a bound seat that cannot serve.
 * Shaped for Claude Code: a 403 is a permission refusal; a 429 carrying
 * upstream's unified headers plus `x-should-retry: false` reads as a plan
 * limit and is not retried; a plain 429 with retry-after is a throttle it
 * retries; a 503 with `x-should-retry: false` stops at once.
 *
 * @param {string} reason  one of SEAT_REASONS
 * @param {{ seat?: string|null, verdict?: SeatVerdict|null, detail?: string|null, queue?: { pinned: string, next: string|null }|null, ownerRoot?: boolean }} [info]
 *   queue is set only for a conversation pinned inside a multi-account seat
 *   whose pinned account is spent: pinned names that account, next the seat
 *   queue's next servable account (null when none serves). ownerRoot (the
 *   request carried `x-teamclaude-cg-contract: root-v1`) appends the C7
 *   owner-root paragraph to the actionable continuation message only — the
 *   single-seat and no-candidate variants structurally cannot carry it.
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
export function seatAnswer(reason, { seat = null, verdict = null, detail = null, queue = null, ownerRoot = false } = {}) {
  const shown = seat ? `"${safeLine(seat, 64)}"` : '';
  const json = { 'Content-Type': 'application/json' };
  const err = (/** @type {string} */ type, /** @type {string} */ message) => JSON.stringify({ type: 'error', error: { type, message } });
  switch (reason) {
    case SEAT_REASONS.noSeat:
      return { status: 403, headers: { ...json, 'x-should-retry': 'false' }, body: err('permission_error', `This key has no Claude seat assigned, so it cannot use Claude. Ask an admin for a seat. ${KIMI_HINT}`) };
    case SEAT_REASONS.foreignPin:
      return { status: 403, headers: { ...json, 'x-should-retry': 'false' }, body: err('permission_error', `This key may only use its own Claude seat${shown ? ` ${shown}` : ''}; the pinned account${detail ? ` "${safeLine(detail, 64)}"` : ''} is not on it.`) };
    case SEAT_REASONS.operatorUnpinned:
      return { status: 403, headers: { ...json, 'x-should-retry': 'false' }, body: err('permission_error', 'Unpinned Claude inference with the shared proxy key or from loopback is refused while proxy.requireClientRoute is on. Pin an account (/tc-acct/<name>, TC_ACCT) or use a client key with a seat.') };
    case SEAT_REASONS.spent: {
      const rej = verdict?.kind === 'spent' ? verdict.rejection : null;
      const when = rej ? new Date(rej.resetsAt).toISOString() : null;
      // A conversation pinned inside a multi-account seat is told the queue:
      // the next account would serve, at one full-price cold-cache turn, and
      // a handoff is the cheaper way to get there.
      const continuationMessage = queue && queue.next
        ? `You can keep working by moving to another assigned account; "${safeLine(queue.next, 64)}" appears available. The account "${safeLine(queue.pinned, 64)}", pinned to this conversation, cannot serve this request because its quota is exhausted${when ? ` until ${when}` : ''}. Recommended: run /ipm:handoff and start a new conversation; it will use the next assigned account that appears available, currently "${safeLine(queue.next, 64)}", with a compact summary. If you retry or continue THIS conversation instead, your next prompt confirms that TeamClaude will reprocess the full conversation at full input-token cost on the next assigned account that appears available at that time, using a cold prompt cache, and pin the conversation there. No additional confirmation prompt is required. ${KIMI_HINT}${ownerRoot ? ` ${CG_SEAT_POLICY_ROOT_PARAGRAPH}` : ''}`
        : null;
      const queueHint = queue && !queue.next
        ? ` This conversation is pinned to "${safeLine(queue.pinned, 64)}", and no other account on this seat can serve now.`
        : '';
      return {
        status: 429,
        // Unified headers make Claude Code replace the body with its generic
        // plan-limit banner. This actionable offer must show the whole choice.
        headers: { ...json, ...(continuationMessage ? {} : (rej?.headers || {})), 'x-should-retry': 'false' },
        body: err('rate_limit_error', continuationMessage || `Your Claude seat${shown ? ` ${shown}` : ''} is out of quota${when ? ` until ${when}` : ''}.${queueHint} ${KIMI_HINT}`),
      };
    }
    case SEAT_REASONS.throttled: {
      const after = verdict?.kind === 'throttled' ? verdict.retryAfter : 5;
      return { status: 429, headers: { ...json, 'retry-after': String(after) }, body: err('rate_limit_error', `Your Claude seat${shown ? ` ${shown}` : ''} is rate-limited; retry in ${after}s.`) };
    }
    case SEAT_REASONS.capped: {
      const which = verdict?.kind === 'capped' ? verdict.reason : 'capped';
      return { status: 429, headers: { ...json, 'x-should-retry': 'false' }, body: err('rate_limit_error', `Your Claude seat${shown ? ` ${shown}` : ''} is at the budget cap the operator set (${which}). ${KIMI_HINT}`) };
    }
    default:
      return { status: 503, headers: { ...json, 'x-should-retry': 'false' }, body: err('api_error', `Your Claude seat${shown ? ` ${shown}` : ''} is unavailable${detail ? ` (${safeLine(detail, 120)})` : ''}; the admins have been notified. ${KIMI_HINT}`) };
  }
}

/** The reason a verdict is logged under. @param {SeatVerdict} v */
export function verdictReason(v) {
  return v.kind === 'spent' ? SEAT_REASONS.spent
    : v.kind === 'throttled' ? SEAT_REASONS.throttled
      : v.kind === 'capped' ? SEAT_REASONS.capped
        : SEAT_REASONS.unavailable;
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * `clientRoutes` for /teamclaude/status: every route with whether it resolves
 * right now. Always a list (empty with none configured), so a reader can tell
 * a build that has client routes from one that does not.
 * @param {any} accountManager
 * @param {(am: any, token: string) => number|null} resolvePin
 */
export function clientRoutesStatus(accountManager, resolvePin) {
  /** @type {ClientRouteTable} */
  const table = accountManager.clientRoutes || emptyClientRoutes();
  return table.routes.map((r) => {
    const res = resolveClientRoute(accountManager, r, resolvePin);
    return {
      name: r.name,
      clients: [...r.clients],
      accounts: [...r.accounts],
      resolved: res.resolved,
      ...(res.problem ? { problem: res.problem } : {}),
    };
  });
}

const WINDOW_FIELDS = [
  ['5h', 'unified5h', 'unified5hReset'],
  ['7d', 'unified7d', 'unified7dReset'],
  ['7d_fable', 'unified7dFable', 'unified7dFableReset'],
  ['7d_sonnet', 'unified7dSonnet', 'unified7dSonnetReset'],
];

/**
 * `caller.seat` for a client-key caller of /teamclaude/status, or null for a
 * key on no route. `resetsAt` (ms) is the recorded spent window's reset when
 * the seat is spent, else the soonest known window reset.
 * @param {any} accountManager
 * @param {string|null|undefined} client
 * @param {(am: any, token: string) => number|null} resolvePin
 */
export function callerSeat(accountManager, client, resolvePin, now = Date.now()) {
  const on = routeForClient(accountManager.clientRoutes, client);
  if (!on) return null;
  if ('ambiguous' in on) return { name: null, routes: on.ambiguous, accounts: [], resolved: false, state: 'unavailable', windows: {}, resetsAt: null };
  const res = resolveClientRoute(accountManager, on.route, resolvePin);
  const account = res.resolved ? accountManager.accounts[res.indices[0]] : null;
  /** @type {Record<string, { utilization: number|null, resetsAt: number|null }>} */
  const windows = {};
  let soonest = null;
  if (account) {
    for (const [label, u, r] of WINDOW_FIELDS) {
      const utilization = account.quota?.[u] ?? null;
      const resetsAt = account.quota?.[r] ?? null;
      if (utilization == null && resetsAt == null) continue;
      windows[label] = { utilization, resetsAt };
      if (resetsAt != null && resetsAt > now && (soonest == null || resetsAt < soonest)) soonest = resetsAt;
    }
  }
  const verdict = res.resolved
    ? combineVerdicts(res.indices.map((i) => seatVerdict(accountManager, accountManager.accounts[i], null, null, now)))
    : { kind: /** @type {const} */ ('unavailable'), reason: 'unresolved' };
  return {
    name: on.route.name,
    accounts: [...on.route.accounts],
    resolved: res.resolved,
    state: verdict ? verdict.kind : 'ok',
    windows,
    resetsAt: verdict?.kind === 'spent' ? verdict.rejection.resetsAt : soonest,
  };
}
