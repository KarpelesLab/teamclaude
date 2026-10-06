// callback.net sign-in.
//
// A device-style OAuth2 flow, the one the platform behind callback.net offers a
// CLI: the client asks the API for a POLL TOKEN, shows the user a URL whose
// redirect_uri is `polltoken:<token>`, and polls until the user has approved in
// a browser — any browser, on any machine, which is the point: no local callback
// listener, so it works over SSH and in a container. The poll answers with an
// authorization code, which is exchanged for an access and a refresh token.
//
//   POST OAuth2/App/<client_id>:token_create        → { polltoken, lifetime, xox }
//   (user opens  <base>/_rest/OAuth2:auth?...&redirect_uri=polltoken:<token>)
//   POST OAuth2/App/<client_id>:token_poll          → { retry: true } | { response: { code } }
//   POST OAuth2:token  grant_type=authorization_code → the token
//   POST OAuth2:token  grant_type=refresh_token      → a fresh access token
//
// The token is this install's own and has nothing to do with the pooled
// accounts: it is kept in a file of its own beside the config (0600, written
// atomically), never in the config, so nothing that reads or rewrites accounts
// touches it.

import { readFile, unlink } from 'node:fs/promises';
import { getConfigPath, writeJsonAtomic } from './config.js';
import { envVar } from './brand.js';
import { safeLine } from './safe-text.js';

/**
 * The OAuth2 application this CLI signs in as, registered in callback.net's own
 * realm (an `oaap-…` id). Public by design: the flow uses no client secret.
 * `TEAMROUTER_CALLBACK_CLIENT_ID` overrides it, for a self-registered app or a
 * test realm.
 */
export const CALLBACK_CLIENT_ID = 'oaap-l33xry-xwk5-cvjc-b63o-roumhmtu';

const DEFAULT_BASE = 'https://www.callback.net';
const REST_PREFIX = '/_special/rest/';
// What the sign-in asks for: who the user is (`profile`, the OpenID userinfo)
// and the per-user credential store (`user_credentials`, a scope of
// callback.net's own) that the account sync keeps the pool's tokens in.
// Nothing else, so the grant is as small a thing to lose as it can be.
export const SCOPE = 'profile user_credentials';
// token_poll is a long poll (the API holds it ~10s before answering "retry"),
// so the per-request bound has to sit well above that.
const REQUEST_TIMEOUT_MS = 45_000;
// A reply here is a few hundred bytes.
const MAX_REPLY_BYTES = 1 << 20;
// The pause after a poll that came back empty, before asking again.
const POLL_PAUSE_MS = 1000;
// Used when token_create does not say how long its poll token lives.
const DEFAULT_POLL_LIFETIME_S = 900;

/**
 * @typedef {Object} CallbackToken
 * @property {string} access_token
 * @property {string} [refresh_token]
 * @property {string} [token_type]
 * @property {number} [expires_in]
 * @property {string} client_id     the app the token was issued to; a refresh has to name it
 * @property {number} obtained_at   when this access token was issued, epoch ms
 */

/**
 * @typedef {Error & { token?: string, code?: number, tokenExpired?: boolean, loginRequired?: boolean }} CallbackApiError
 */

/**
 * @typedef {Object} CallOptions
 * @property {string} [base]            API origin (default: callbackBase())
 * @property {string|null} [accessToken]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {boolean} [envelope]  resolve with the whole reply (`data` and `paging`) rather than `data` alone
 */

let warnedBase = /** @type {string|null} */ (null);

/**
 * The origin the API is reached at. An override must be https:, or plain http:
 * to this machine only (a test mock): the access token rides in a header to
 * whatever this names, so an inherited variable must not be able to point it at
 * a cleartext or arbitrary host silently.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(message: string) => void} [warn]
 * @returns {string}
 */
export function callbackBase(env = process.env, warn = (m) => console.error(m)) {
  const raw = envVar('CALLBACK_API_BASE', env);
  if (!raw) return DEFAULT_BASE;
  let u = null;
  try { u = new URL(raw); } catch { /* reported below */ }
  const loopback = u && /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(u.hostname);
  if (u && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return u.origin;
  if (warnedBase !== raw) {
    warnedBase = raw;
    warn(`[TeamClaude] ignoring CALLBACK_API_BASE=${JSON.stringify(raw)}: it must be https:// (plain http:// is allowed for loopback only); using ${DEFAULT_BASE}`);
  }
  return DEFAULT_BASE;
}

/**
 * The client id in effect: the environment's, else the built-in one.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function callbackClientId(env = process.env) {
  return (envVar('CALLBACK_CLIENT_ID', env) || CALLBACK_CLIENT_ID).trim();
}

/** Where the token is kept: a sibling of the config, like the state file. */
export function getCallbackAuthPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.callback.json') : `${cfg}.callback`;
}

/**
 * The stored token, or null when this install is not signed in. A file that is
 * not a token (hand-edited, truncated by something else) reads as not signed
 * in rather than as an error: signing in again is the repair either way.
 *
 * @returns {Promise<CallbackToken|null>}
 */
export async function loadCallbackToken() {
  let text;
  try {
    text = await readFile(getCallbackAuthPath(), 'utf-8');
  } catch (/** @type {any} */ err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const token = JSON.parse(text);
    return token && typeof token.access_token === 'string' && token.access_token ? token : null;
  } catch {
    return null;
  }
}

/** @param {CallbackToken} token */
export async function saveCallbackToken(token) {
  await writeJsonAtomic(getCallbackAuthPath(), token);
}

/** Forget the stored token. Not an error when there is none. */
export async function clearCallbackToken() {
  await unlink(getCallbackAuthPath()).catch((/** @type {any} */ err) => { if (err?.code !== 'ENOENT') throw err; });
}

/**
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function readJson(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REPLY_BYTES) throw new Error('callback.net reply too large');
  const text = await res.text();
  if (text.length > MAX_REPLY_BYTES) throw new Error('callback.net reply too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`callback.net answered HTTP ${res.status} with something that is not JSON`);
  }
}

/**
 * The error an API reply describes. The message is the server's, so it is
 * stripped before it can reach a terminal.
 *
 * @param {any} body
 * @param {number} status
 * @returns {CallbackApiError}
 */
function apiError(body, status) {
  /** @type {CallbackApiError} */
  const err = new Error(safeLine(body?.error || body?.message || `callback.net API error (HTTP ${status})`, 200));
  if (typeof body?.token === 'string') err.token = body.token;
  err.code = Number.isFinite(body?.code) ? body.code : status;
  // The platform reports an expired access token this way, and only this way.
  err.tokenExpired = body?.token === 'invalid_request_token' && body?.extra === 'token_expired';
  // No (or no longer any) session: a private endpoint answers with a redirect
  // to the login page, a poll for a dead poll token with error_login_required.
  err.loginRequired = body?.result === 'redirect' || body?.token === 'error_login_required'
    || body?.token === 'error_authentication_required' || (body?.token === 'invalid_request_token' && !err.tokenExpired);
  return err;
}

/**
 * One call to the platform's REST API. Resolves with the reply's `data`;
 * rejects with a CallbackApiError when the API says no.
 *
 * @param {string} method
 * @param {string} path     e.g. `OAuth2/App/<id>:token_create`, `User/@`
 * @param {Record<string, any>|null} [params]
 * @param {CallOptions} [opts]
 * @returns {Promise<any>}
 */
export async function callbackApi(method, path, params = null, { base = callbackBase(), accessToken = null, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, envelope = false } = {}) {
  const url = new URL(REST_PREFIX + path, base);
  /** @type {Record<string, string>} */
  const headers = { 'Sec-Rest-Http': 'false', Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  /** @type {RequestInit} */
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' };
  const bodyless = method === 'GET' || method === 'HEAD';
  if (bodyless) {
    // The platform reads a GET's parameters from `_` as JSON; paging is its own
    // pair of query fields.
    const { results_per_page, page_no, ...rest } = params || {};
    if (results_per_page != null) url.searchParams.set('results_per_page', String(results_per_page));
    if (page_no != null) url.searchParams.set('page_no', String(page_no));
    if (Object.keys(rest).length) url.searchParams.set('_', JSON.stringify(rest));
  } else {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params || {});
  }
  const res = await fetchImpl(url, init);
  const body = await readJson(res);
  if (body && body.result === 'success') return envelope ? body : body.data;
  // The OpenID endpoints (`OAuth2:me`) answer with a bare document, no
  // envelope; an error always carries `result`.
  if (res.ok && body && typeof body === 'object' && body.result === undefined) return body;
  throw apiError(body, res.status);
}

/**
 * `OAuth2:token` as a form post, which answers with a bare OAuth2 token
 * document rather than the API's `{ result, data }` envelope.
 *
 * @param {Record<string, string>} form
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, any>>}
 */
async function tokenRequest(form, { base = callbackBase(), fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(new URL(`${REST_PREFIX}OAuth2:token`, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const body = await readJson(res);
  if (!res.ok || body?.result === 'error' || body?.result === 'redirect') throw apiError(body, res.status);
  // Either shape: the bare document, or the envelope around it.
  const token = body?.result === 'success' && body.data ? body.data : body;
  if (!token || typeof token.access_token !== 'string' || !token.access_token) {
    throw new Error('callback.net answered the token request without an access token');
  }
  return token;
}

/**
 * The URL the user opens to approve the sign-in.
 *
 * `token_create` may offer a short link (`xox`, e.g. `oid.jp/P2KA3Z`, with no
 * scheme). It is taken only when it is what it looks like — a host and a short
 * path — and always as https; anything else falls back to the full URL, which
 * is built here and so cannot be anything but the API's own origin.
 *
 * @param {string} base
 * @param {string} clientId
 * @param {string} polltoken
 * @param {unknown} [short]
 * @returns {string}
 */
export function approvalUrl(base, clientId, polltoken, short) {
  if (typeof short === 'string') {
    const bare = short.replace(/^https:\/\//i, '');
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\/[A-Za-z0-9_-]{1,64}$/i.test(bare)) return `https://${bare}`;
  }
  const url = new URL('/_rest/OAuth2:auth', base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `polltoken:${polltoken}`);
  url.searchParams.set('scope', SCOPE);
  return url.toString();
}

/**
 * Sign in: create a poll token, hand the approval URL to `onUrl`, and wait for
 * the user to approve it. Resolves with the token (not yet saved).
 *
 * The wait is bounded by the poll token's own lifetime, which the API states;
 * past it the poll token is dead and no approval can arrive.
 *
 * @param {Object} [opts]
 * @param {string} [opts.clientId]
 * @param {string} [opts.base]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(url: string, info: { lifetimeSeconds: number }) => void} [opts.onUrl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<CallbackToken>}
 */
export async function loginCallback({
  clientId = callbackClientId(),
  base = callbackBase(),
  fetchImpl = fetch,
  onUrl = () => {},
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now = Date.now,
} = {}) {
  if (!clientId) throw new Error('no callback.net client id is configured (set TEAMROUTER_CALLBACK_CLIENT_ID)');
  const app = `OAuth2/App/${encodeURIComponent(clientId)}`;
  const call = { base, fetchImpl };

  // The scope goes to token_create as well as onto the URL: the short link the
  // API hands back carries no query string, so this is where it learns it.
  const created = await callbackApi('POST', `${app}:token_create`, { scope: SCOPE }, call);
  const polltoken = created?.polltoken;
  if (typeof polltoken !== 'string' || !polltoken) throw new Error('callback.net did not return a poll token');
  const lifetimeSeconds = Number.isFinite(created.lifetime) && created.lifetime > 0 ? created.lifetime : DEFAULT_POLL_LIFETIME_S;
  const deadline = now() + lifetimeSeconds * 1000;
  onUrl(approvalUrl(base, clientId, polltoken, created.xox), { lifetimeSeconds });

  for (;;) {
    const polled = await callbackApi('POST', `${app}:token_poll`, { polltoken }, call);
    const code = polled?.response?.code;
    if (polled?.response && (typeof code !== 'string' || !code)) {
      throw new Error('callback.net answered the sign-in without an authorization code');
    }
    if (code) {
      const token = await tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code }, call);
      return /** @type {CallbackToken} */ ({ ...token, client_id: clientId, obtained_at: now() });
    }
    if (now() >= deadline) throw new Error(`the sign-in was not approved within ${Math.round(lifetimeSeconds / 60)} minutes`);
    await sleep(POLL_PAUSE_MS);
  }
}

/**
 * Exchange the refresh token for a fresh access token. The result keeps
 * whatever the reply does not restate (the refresh token, when the server does
 * not rotate it).
 *
 * @param {CallbackToken} token
 * @param {CallOptions & { now?: () => number }} [opts]
 * @returns {Promise<CallbackToken>}
 */
export async function refreshCallbackToken(token, { now = Date.now, ...call } = {}) {
  if (!token?.refresh_token) throw new Error('the callback.net session has expired and cannot be renewed; sign in again');
  const clientId = token.client_id || callbackClientId();
  if (!clientId) throw new Error('the stored callback.net token names no client id; sign in again');
  const fresh = await tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refresh_token }, call);
  return /** @type {CallbackToken} */ ({ ...token, ...fresh, client_id: clientId, obtained_at: now() });
}

/**
 * An authenticated API call as the signed-in user. An expired access token is
 * renewed once, saved, and the call repeated; a session that cannot be renewed
 * rejects with `loginRequired` set.
 *
 * @param {string} method
 * @param {string} path
 * @param {Record<string, any>|null} [params]
 * @param {CallOptions & { now?: () => number }} [opts]
 * @returns {Promise<any>}
 */
export async function callbackCall(method, path, params = null, opts = {}) {
  // `opts` goes to the plain calls as it is: they read only the fields they know.
  const call = opts;
  const token = await loadCallbackToken();
  if (!token) {
    /** @type {CallbackApiError} */
    const err = new Error('not signed in to callback.net');
    err.loginRequired = true;
    throw err;
  }
  try {
    return await callbackApi(method, path, params, { ...call, accessToken: token.access_token });
  } catch (/** @type {any} */ err) {
    if (!err?.tokenExpired) throw err;
  }
  let fresh;
  try {
    fresh = await refreshCallbackToken(token, opts);
  } catch (/** @type {any} */ err) {
    // A refresh the server REFUSED is a dead session; one that never reached
    // it (network, timeout) is not, and must not read as "sign in again".
    if (err && typeof err.code === 'number' && err.code >= 400 && err.code < 500) err.loginRequired = true;
    throw err;
  }
  await saveCallbackToken(fresh);
  return callbackApi(method, path, params, { ...call, accessToken: fresh.access_token });
}

/**
 * The signed-in user, as the fields a CLI prints. Read from the OpenID
 * userinfo endpoint, which is what the `profile` scope grants: the platform's
 * own `User/@` wants a scope this sign-in does not ask for.
 *
 * @param {CallOptions & { now?: () => number }} [opts]
 * @returns {Promise<{ id: string|null, email: string|null, name: string|null }>}
 */
export async function callbackWhoami(opts = {}) {
  const me = await callbackCall('GET', 'OAuth2:me', null, opts);
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? safeLine(v, 120) : null);
  return { id: text(me?.sub), email: text(me?.email), name: text(me?.name) };
}

/**
 * Sign out: revoke the token upstream (best effort — a server that cannot be
 * reached must not keep the token on disk) and forget it locally.
 *
 * @param {CallOptions} [opts]
 * @returns {Promise<{ wasSignedIn: boolean, revoked: boolean }>}
 */
export async function logoutCallback(opts = {}) {
  const token = await loadCallbackToken();
  if (!token) {
    await clearCallbackToken();
    return { wasSignedIn: false, revoked: false };
  }
  let revoked = false;
  try {
    // The refresh token when there is one: revoking it ends the whole grant,
    // where revoking the access token leaves a way to mint another.
    await callbackApi('POST', 'OAuth2:revoke', { token: token.refresh_token || token.access_token }, { ...opts, accessToken: token.access_token });
    revoked = true;
  } catch { /* forgotten locally regardless */ }
  await clearCallbackToken();
  return { wasSignedIn: true, revoked };
}
