// A CLIProxyAPI-compatible usage API, read-only.
//
// CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) is another multi-account
// proxy, and some usage dashboards read a fleet's quota through its management
// API rather than through each provider: they list the accounts with
// `GET /v0/management/auth-files`, then for each one ask the proxy to call the
// provider's usage endpoint on the account's behalf with
// `POST /v0/management/api-call`. Answering those two lets such a dashboard
// show every account in this pool without being told about TeamClaude.
//
// The second route is the one to be careful with. In CLIProxyAPI it is a
// generic relay: the caller names any URL, method and headers, and a `$TOKEN$`
// placeholder is replaced with the account's credential. Served that way here,
// any key holder could spend the pool or read the token out through a URL of
// their own choosing. So nothing here relays anything. A request is matched
// against the provider usage URLs the dashboards actually ask for, and the
// answer is built from the quota the account manager already tracks, in the
// provider's own wire shape. No credential is read, no upstream request is
// made, and the caller's `header` and `data` are never looked at.
//
// The readings are as fresh as the account manager's: an account in use is
// read off every response, an idle one by the quota probe (quotaProbeSeconds),
// which is off by default. Three states are kept apart, because a dashboard
// reads them differently. A window the plan meters but that has no live
// reading (it reset, or has not started) is sent as the provider sends one that
// has not started: 0% with no reset time. A window the plan does not meter is
// null, which is how the provider says "no such window". And an account this
// proxy cannot vouch for — never read, or a dead login — answers a non-2xx
// `status_code`, so the dashboard shows it as unreadable rather than idle.

import { emailOf } from './identity.js';
import { DEFAULT_PROVIDER, providerOf } from './provider.js';

/** The path prefix every route of this API is served under. */
export const CLIPROXY_PREFIX = '/v0/management';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// Known, and refused by name: these list and SPEND Codex reset credits, which
// this API does not offer (see answerApiCall).
const CODEX_CREDIT_URLS = [
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
];

const FIVE_HOUR_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 24 * 3600;

/**
 * What `proxy.cliproxyApi` allows: 'read', or null for off. Anything but the
 * exact spelling is off, so a typo cannot open it.
 * @param {Record<string, any>|undefined} proxyConfig
 * @returns {'read'|null}
 */
export function cliproxyApiMode(proxyConfig) {
  return proxyConfig?.cliproxyApi === 'read' ? 'read' : null;
}

/**
 * Whether a request path belongs to this API. Read on the classification path,
 * so an encoded spelling of the prefix is ours too rather than the forwarder's.
 * @param {string} path  from classificationPath
 */
export function isCliproxyPath(path) {
  return path === CLIPROXY_PREFIX || path.startsWith(`${CLIPROXY_PREFIX}/`);
}

/**
 * The key a CLIProxyAPI client presents. Its management key travels as
 * `Authorization: Bearer` or `X-Management-Key`, not as the `x-api-key` the
 * rest of this proxy reads; the caller checks it against the same proxy keys.
 * Only for this API's own paths: anywhere else `Authorization` is the client's
 * provider credential and says nothing about this proxy.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string|undefined}
 */
export function presentedManagementKey(headers) {
  const explicit = headers['x-management-key'];
  if (typeof explicit === 'string' && explicit) return explicit;
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''));
  return match ? match[1].trim() : undefined;
}

/**
 * The provider name CLIProxyAPI gives an account, or null for one this API does
 * not list: only subscription logins have the usage endpoints it reads, so an
 * API key or a third-party backend has nothing to show.
 * @param {Record<string, any>} account
 * @returns {'claude'|'codex'|null}
 */
function cliproxyProvider(account) {
  if (account.type !== 'oauth' || account.upstream) return null;
  const provider = providerOf(account);
  if (provider === 'codex') return 'codex';
  return provider === DEFAULT_PROVIDER ? 'claude' : null;
}

/**
 * The handle an account is listed under and named by in `api-call`. The config
 * entry id where there is one, because positions shift when an account is
 * removed and names are not unique.
 * @param {Record<string, any>} account
 */
function authIndex(account) {
  return account.id || String(account.index);
}

// CLIProxyAPI's page size when a request pages without naming one.
const DEFAULT_PAGE_SIZE = 50;

/**
 * One of auth-files' paging parameters: absent, or a positive whole number.
 * @param {URLSearchParams} query
 * @param {string} key
 * @returns {number|null|undefined}  undefined when absent, null when invalid
 */
function pageParam(query, key) {
  if (!query.has(key)) return undefined;
  const raw = String(query.get(key)).trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

/**
 * `GET /v0/management/auth-files`: every subscription account, in the shape
 * CLIProxyAPI lists its credential files. No credential, account id or
 * organization id is in it — the same fields /teamclaude/status already shows
 * any key holder.
 *
 * The query is CLIProxyAPI's: `name` (an entry's id or name) and `auth_index`
 * narrow the list, and `page` / `page_size` page it, adding `total`, `page`,
 * `page_size` and `has_more`. A paging value that is not a positive whole
 * number is a 400, as there. The order is the fleet's own, not sorted by name.
 * @param {any} accountManager
 * @param {URLSearchParams} [query]
 * @returns {{ status: number, body: Record<string, any> }}
 */
export function authFiles(accountManager, query = new URLSearchParams()) {
  const page = pageParam(query, 'page');
  const pageSize = pageParam(query, 'page_size');
  if (page === null) return { status: 400, body: { error: 'page must be a positive integer' } };
  if (pageSize === null) return { status: 400, body: { error: 'page_size must be a positive integer' } };
  const name = (query.get('name') || '').trim();
  const index = (query.get('auth_index') || '').trim();

  const files = [];
  for (const account of accountManager.accounts) {
    const provider = cliproxyProvider(account);
    if (!provider) continue;
    if (name && authIndex(account) !== name && account.name !== name) continue;
    if (index && authIndex(account) !== index) continue;
    const email = emailOf(account);
    const plan = provider === 'codex' && account.quota?.planType;
    files.push({
      id: authIndex(account),
      auth_index: authIndex(account),
      name: account.name,
      type: provider,
      provider,
      label: account.name,
      ...(email.includes('@') ? { email } : {}),
      status: account.disabled ? 'disabled' : account.status,
      disabled: account.disabled === true,
      // Where CLIProxyAPI's clients look for the Codex plan when the usage
      // reading does not state one.
      ...(plan ? { id_token: { plan_type: plan } } : {}),
    });
  }
  const observedAt = new Date().toISOString();
  if (page === undefined && pageSize === undefined) return { status: 200, body: { observed_at: observedAt, files } };
  const size = pageSize ?? DEFAULT_PAGE_SIZE;
  const start = Math.min(((page ?? 1) - 1) * size, files.length);
  const end = Math.min(start + size, files.length);
  return {
    status: 200,
    body: { observed_at: observedAt, files: files.slice(start, end), total: files.length, page: page ?? 1, page_size: size, has_more: end < files.length },
  };
}

/** @param {number} ratio  0-1 */
function percent(ratio) {
  return Math.round(ratio * 10000) / 100;
}

/** @param {number|null|undefined} ms */
function isoOrNull(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** @param {unknown} value */
function isReading(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether this proxy has ever read the account's windows. The `*WindowStated`
 * flags are set by every reading and persisted, so they still answer after the
 * readings themselves have been cleared by a reset.
 * @param {'claude'|'codex'} provider
 * @param {Record<string, any>} quota
 */
function everRead(provider, quota) {
  const stated = provider === 'claude' ? quota.weeklyWindowStated : quota.sessionWindowStated;
  return stated != null || isReading(quota.unified5h) || isReading(quota.unified7d);
}

/**
 * One Anthropic usage window: `utilization` on the endpoint's 0-100 scale (the
 * quota model keeps 0-1, see normalizeUsageBucket) and `resets_at` as ISO-8601.
 * With no live reading it is the window as the endpoint states one that has
 * not started, 0 and no reset time (see the Fable cap in quota-probe.test.js).
 * @param {number|null|undefined} ratio
 * @param {number|null|undefined} resetAt
 */
function claudeWindow(ratio, resetAt) {
  if (!isReading(ratio)) return { utilization: 0, resets_at: null };
  return { utilization: percent(/** @type {number} */ (ratio)), resets_at: isoOrNull(resetAt) };
}

/**
 * An Anthropic account's quota as `GET /api/oauth/usage` would state it.
 *
 * Each window is null only on a plan known to meter none: the weekly one on a
 * Team seat (`weeklyWindowStated: false`), the 5-hour one on a plan that states
 * no session window (`sessionWindowStated: false`).
 *
 * The per-model weekly caps go in `limits[]` as `weekly_scoped` entries, which
 * is where the endpoint reports them now. The two families with fields of their
 * own come from those fields first: response headers keep them current, while
 * `scopedWeekly` moves only when the probe runs, and selection gates on the
 * fields. `scopedWeekly` supplies every other family the probe read, keyed by
 * its lowercased display name.
 * @param {Record<string, any>} quota
 */
export function claudeUsagePayload(quota) {
  /** @type {Map<string, {name: string, utilization: number, resetAt: number|null}>} */
  const families = new Map();
  for (const [key, name, field] of [['fable', 'Fable', 'unified7dFable'], ['sonnet', 'Sonnet', 'unified7dSonnet']]) {
    if (isReading(quota[field])) families.set(key, { name, utilization: quota[field], resetAt: quota[`${field}Reset`] ?? null });
  }
  for (const [key, bucket] of Object.entries(quota.scopedWeekly || {})) {
    if (families.has(key) || !isReading(bucket?.utilization)) continue;
    families.set(key, { name: key.charAt(0).toUpperCase() + key.slice(1), utilization: bucket.utilization, resetAt: bucket.resetAt ?? null });
  }
  return {
    five_hour: quota.sessionWindowStated === false ? null : claudeWindow(quota.unified5h, quota.unified5hReset),
    seven_day: quota.weeklyWindowStated === false ? null : claudeWindow(quota.unified7d, quota.unified7dReset),
    limits: [...families.values()].map(f => ({
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: percent(f.utilization),
      resets_at: isoOrNull(f.resetAt),
      scope: { model: { display_name: f.name } },
    })),
  };
}

/**
 * One Codex usage window: `used_percent` 0-100, `reset_at` in epoch SECONDS.
 * With no live reading it is an unused window: 0, and no reset time.
 * @param {number|null|undefined} ratio
 * @param {number|null|undefined} resetAt  ms
 * @param {number} seconds
 */
function codexWindow(ratio, resetAt, seconds) {
  if (!isReading(ratio)) return { used_percent: 0, reset_at: null, limit_window_seconds: seconds };
  return {
    used_percent: percent(/** @type {number} */ (ratio)),
    reset_at: isReading(resetAt) ? Math.floor(/** @type {number} */ (resetAt) / 1000) : null,
    limit_window_seconds: seconds,
  };
}

/**
 * A Codex account's quota as `GET /wham/usage` would state it. The shorter
 * window goes first, as upstream orders them; a plan that meters no session
 * window (`sessionWindowStated: false`) has its weekly one as the primary. A
 * reading from before that flag existed counts the session window only when it
 * holds a reading of one.
 * @param {Record<string, any>} quota
 */
export function codexUsagePayload(quota) {
  const session = quota.sessionWindowStated === true || (quota.sessionWindowStated == null && isReading(quota.unified5h));
  const windows = [
    session ? codexWindow(quota.unified5h, quota.unified5hReset, FIVE_HOUR_SECONDS) : null,
    codexWindow(quota.unified7d, quota.unified7dReset, WEEK_SECONDS),
  ].filter(w => w);
  return {
    ...(quota.planType ? { plan_type: quota.planType } : {}),
    rate_limit: { primary_window: windows[0] ?? null, secondary_window: windows[1] ?? null },
  };
}

/**
 * A request URL reduced to what the allowlist compares: origin and path, no
 * query (TeamClaude's own probe adds one to the Anthropic URL) and no trailing
 * slash. Null for anything that is not an absolute https URL.
 * @param {unknown} raw
 */
function comparableUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * `POST /v0/management/api-call`, answered without leaving this process.
 *
 * Returns the HTTP status for the reply and its body: for a request it answers,
 * the CLIProxyAPI envelope `{ status_code, header, body }`, where `body` is the
 * provider payload as a string and `status_code` what the provider would have
 * said; for one it refuses, `{ error }`.
 *
 * Codex reset credits are refused with 501 rather than served. Listing them
 * would put a "redeem" control in front of the user that this API cannot
 * honour: spending one is irreversible, and the only path that spends them
 * here is the redeemer's own policy (autoRedeemResets), which deliberately
 * takes no orders from outside.
 * @param {any} accountManager
 * @param {any} request  the parsed JSON body
 * @returns {{ status: number, body: Record<string, any> }}
 */
export function answerApiCall(accountManager, request) {
  if (!request || typeof request !== 'object') return { status: 400, body: { error: 'invalid body' } };
  const index = request.auth_index ?? request.authIndex ?? request.AuthIndex;
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (!method) return { status: 400, body: { error: 'missing method' } };
  const target = comparableUrl(request.url);
  if (!target) return { status: 400, body: { error: 'invalid url' } };

  if (CODEX_CREDIT_URLS.includes(target)) {
    return { status: 501, body: { error: 'reset credits are not offered through this API' } };
  }
  const provider = target === CLAUDE_USAGE_URL ? 'claude' : target === CODEX_USAGE_URL ? 'codex' : null;
  if (!provider || method !== 'GET') {
    return { status: 403, body: { error: 'only GET of a provider usage endpoint is answered; nothing is relayed upstream' } };
  }

  const account = typeof index === 'string' || typeof index === 'number'
    ? accountManager.accounts.find((/** @type {any} */ a) => cliproxyProvider(a) && authIndex(a) === String(index))
    : null;
  if (!account) return { status: 404, body: { error: 'no account with that auth_index' } };
  if (cliproxyProvider(account) !== provider) {
    return { status: 403, body: { error: `that URL is not a ${cliproxyProvider(account)} usage endpoint` } };
  }

  // An account whose login is dead serves nothing, and its last reading says
  // nothing about now. Through CLIProxyAPI the relayed call would come back 401
  // from the provider; the same status here makes a dashboard show the account
  // as unreadable rather than as healthy with headroom.
  if (account.status === 'error') {
    return providerReply(401, { error: 'this account\'s login was rejected; log it in again' });
  }
  // Nor can an account be vouched for that has never been read: a payload of
  // idle windows would claim a reading nobody took. 503, as a provider says it
  // cannot answer right now; the next response or probe on it fixes this.
  if (!everRead(provider, account.quota)) {
    return providerReply(503, { error: 'no usage reading for this account yet' });
  }
  // A window whose reset has passed is cleared first, so a reading from before
  // it is not reported as current — the same sweep /teamclaude/status runs.
  accountManager.sweepExpiredQuotas();
  return providerReply(200, provider === 'claude' ? claudeUsagePayload(account.quota) : codexUsagePayload(account.quota));
}

/**
 * The CLIProxyAPI envelope around what the provider would have answered. The
 * outer reply is 200 whatever `status_code` says, as CLIProxyAPI's is: the
 * management call itself succeeded.
 * @param {number} statusCode
 * @param {Record<string, any>} payload
 */
function providerReply(statusCode, payload) {
  return {
    status: 200,
    body: { status_code: statusCode, header: { 'Content-Type': ['application/json'] }, body: JSON.stringify(payload) },
  };
}

/**
 * Serve one request under CLIPROXY_PREFIX. The caller has already run the
 * proxy's key gates; this answers the mode, the route and the method.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ accountManager: any, config: Record<string, any>, path: string, readBody: (req: import('node:http').IncomingMessage) => Promise<string> }} ctx
 */
export async function serveCliproxyApi(req, res, { accountManager, config, path, readBody }) {
  const reply = (/** @type {number} */ status, /** @type {Record<string, any>} */ body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // Answered here rather than left to fall through, on or off: an unclaimed
  // path is forwarded upstream with a fleet credential attached.
  if (!cliproxyApiMode(config.proxy)) {
    reply(404, { error: 'the CLIProxyAPI-compatible usage API is off; set proxy.cliproxyApi to "read" to serve it' });
    return;
  }
  const route = path.slice(CLIPROXY_PREFIX.length).replace(/\/+$/, '');
  if (route === '/auth-files' && req.method === 'GET') {
    // The route is matched on the classification path, which has no query.
    const { status, body } = authFiles(accountManager, new URL(req.url || '/', 'http://localhost').searchParams);
    reply(status, body);
    return;
  }
  if (route === '/api-call' && req.method === 'POST') {
    let request;
    try {
      request = JSON.parse((await readBody(req)) || 'null');
    } catch (err) {
      const tooLarge = /** @type {Error} */ (err).message === 'body too large';
      reply(tooLarge ? 413 : 400, { error: tooLarge ? 'request body too large' : 'invalid body' });
      return;
    }
    const { status, body } = answerApiCall(accountManager, request);
    reply(status, body);
    return;
  }
  // CLIProxyAPI clears its own cooldown for an account here after a reset
  // credit is spent; with credits not offered there is nothing to clear.
  if (route === '/reset-quota') {
    reply(501, { error: 'reset-quota is not offered through this API' });
    return;
  }
  reply(404, { error: 'unknown management route (this API serves GET auth-files and POST api-call)' });
}
