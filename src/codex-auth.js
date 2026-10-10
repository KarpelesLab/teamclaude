// Codex (OpenAI) credentials.
//
// The Codex CLI keeps its ChatGPT login in ~/.codex/auth.json, shaped much
// like Claude Code's own credentials file: an access/refresh pair plus the id
// of the account the token is scoped to. That last field is the part with no
// Anthropic analogue in the body — OpenAI carries it in the ChatGPT-Account-Id
// header instead, which is why the Codex path needs no request-body rewrite.
//
// Token refresh is a plain OAuth refresh_token grant against auth.openai.com
// using the Codex CLI's own client id, so a pooled account stays live the same
// way an Anthropic one does.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import { proxyFetch } from './upstream-fetch.js';
import { tokenPairFromResponse } from './oauth.js';
import { envVar } from './brand.js';
import { LOGIN_TIMEOUT_MS, codeRace, openBrowser, pasteFromTerminal } from './login-flow.js';
import { safeLine, sanitizeText } from './safe-text.js';
/** @typedef {import('./types.js').CodedError} CodedError */

export const DEFAULT_CODEX_CREDENTIALS_PATH = '~/.codex/auth.json';

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
// Confirmed by a live authorization attempt: adding `api` is rejected with
// invalid_scope ("The OAuth 2.0 Client is not allowed to request scope 'api'").
// The token this client issues is a ChatGPT credential, not an API-platform
// one, which is the same reason the upstream is chatgpt.com.
const SCOPES = 'openid profile email offline_access';
// OpenAI registered a single fixed redirect for this client, so the callback
// server cannot take an ephemeral port the way the Anthropic flow does — the
// authorization request is rejected unless the URI matches exactly.
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
// The Codex CLI's OAuth client. It is the `aud` claim of the id_token the CLI
// itself stores, i.e. this is the client the user already consented to — we
// refresh their existing grant rather than minting a new one.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Decode a JWT payload without verifying it. Claims are used for labelling only. */
function decodeJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a Codex login from disk.
 *
 * Returns the credential fields the account manager needs, plus `email` and
 * `planType` when the id_token carries them — those are cosmetic (they name
 * the account in status output) and their absence is never fatal.
 */
export async function importCodexCredentials(filePath = DEFAULT_CODEX_CREDENTIALS_PATH, { home = homedir() } = {}) {
  const resolvedPath = filePath.replace(/^~/, home);
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
  const tokens = raw.tokens || {};

  const claims = decodeJwtClaims(tokens.id_token) || {};
  const auth = claims['https://api.openai.com/auth'] || {};

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    // Scopes the token to one ChatGPT account. Prefer the id_token claim and
    // fall back to the stored value: they agree in practice, but the claim is
    // the one the server itself issued.
    accountId: auth.chatgpt_account_id || tokens.account_id,
    email: claims.email,
    planType: auth.chatgpt_plan_type,
    userId: auth.chatgpt_user_id || auth.user_id,
  };
}

/**
 * Exchange a Codex refresh token for a fresh access token.
 *
 * Mirrors the Anthropic refresh contract (`{ accessToken, refreshToken,
 * expiresAt }`) so the account manager can treat both the same. A rotated
 * refresh token is returned when the server issues one, and the old one is
 * kept when it does not.
 * @param {string} refreshToken
 * @param {string} [endpoint]
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the account's own egress proxy
 * @param {{ budgetMs?: number }} [opts] - the call is bounded by it as well, as the Anthropic one is
 */
export async function refreshCodexToken(refreshToken, endpoint = TOKEN_ENDPOINT, routing = null, { budgetMs = Infinity } = {}) {
  const timeoutMs = Math.min(Number(envVar('REFRESH_TIMEOUT_MS')) || 30_000, budgetMs);
  if (!(timeoutMs > 0)) throw new Error('Codex token refresh ran out of time');
  const res = await proxyFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(timeoutMs),
    routing,
  });

  if (!res.ok) {
    const text = await res.text();
    const err = /** @type {CodedError} */ (new Error(`Codex token refresh failed (${res.status}): ${text}`));
    // Surfaced so callers can tell a dead refresh token (re-login needed) from
    // a transient server error, exactly as the Anthropic path does.
    err.status = res.status;
    throw err;
  }

  // Same checks as the Anthropic path: a 200 without an access token is an
  // error, not a `Bearer undefined` waiting to happen.
  return tokenPairFromResponse(await res.json(), { previousRefreshToken: refreshToken });
}

// ── Browser login ───────────────────────────────────────────────────────────

/**
 * Build the authorization URL for a Codex login.
 *
 * Pure, so the parameters can be asserted without opening a browser. PKCE is
 * mandatory here: the client is public, so the code exchange is bound to a
 * verifier this process holds rather than to a client secret.
 */
export function buildCodexAuthUrl({ state, codeChallenge, redirectUri = REDIRECT_URI }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // Codex asks for organization claims in the id_token; the account id we need
  // for ChatGPT-Account-Id rides in that same claim set.
  url.searchParams.set('id_token_add_organizations', 'true');
  // Sent by the Codex CLI itself alongside the above. Kept so this request
  // looks like the client it is impersonating rather than a novel variant.
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

/** Exchange an authorization code for tokens, completing the PKCE handshake.
 * @param {{ code: string, codeVerifier: string, redirectUri?: string, routing?: import('./account-routing.js').RoutingProxy|null }} args
 */
export async function exchangeCodexCode({ code, codeVerifier, redirectUri = REDIRECT_URI, routing = null }) {
  const res = await proxyFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    routing,
  });
  if (!res.ok) {
    throw new Error(`Codex token exchange failed (${res.status}): ${await res.text()}`);
  }
  return credentialsFromTokenResponse(await res.json());
}

/**
 * Turn a token response into the same credential shape `importCodexCredentials`
 * returns, so login and import are interchangeable to every caller.
 */
export function credentialsFromTokenResponse(data) {
  const claims = decodeJwtClaims(data.id_token) || {};
  const auth = claims['https://api.openai.com/auth'] || {};
  return {
    ...tokenPairFromResponse(data),
    accountId: auth.chatgpt_account_id,
    email: claims.email,
    planType: auth.chatgpt_plan_type,
    userId: auth.chatgpt_user_id || auth.user_id,
  };
}

/**
 * The request handler for the login callback, settling `resolve`/`reject` with
 * the authorization code or the failure.
 *
 * The state is checked FIRST, and a request without the expected state gets a
 * 400 and settles nothing: port 1455 is open while the user is in the browser,
 * and a stray GET — a drive-by page probing localhost, a scanner, a stale tab —
 * used to abort the whole login by arriving with `?error=` or with no state.
 * A request line Node accepts but URL cannot parse (`GET http://[::1`) is a
 * 400 too: thrown from here it would be an uncaught exception, and the end of
 * the proxy this listener runs inside. Exported for tests, which run it on an
 * ephemeral port instead of 1455.
 *
 * @param {string} expectedState
 * @param {{ resolve: (code: string) => void, reject: (err: Error) => void }} settle
 * @returns {import('node:http').RequestListener}
 */
export function codexCallbackHandler(expectedState, { resolve, reject }) {
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }

    const returnedState = url.searchParams.get('state');
    if (!returnedState || returnedState !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Invalid request</h2><p>State mismatch. You can close this tab.</p></body></html>');
      return;
    }

    const err = url.searchParams.get('error');
    const returnedCode = url.searchParams.get('code');
    const fail = (/** @type {string} */ message) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
      reject(new Error(message));
    };

    // Provider text, bound for a terminal: one plain line, no escapes.
    if (err) return fail(`OAuth error: ${safeLine(err, 80)} ${safeLine(url.searchParams.get('error_description') || '', 200)}`.trim());
    if (!returnedCode) return fail('OAuth callback carried no code');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>');
    resolve(returnedCode);
  };
}

/**
 * The authorization code from the address the browser was left on, pasted by
 * hand.
 *
 * OpenAI only redirects this client to http://localhost:1455/auth/callback, so
 * a browser on another machine lands on a page that does not load, with the
 * code and the state still in its address bar. That address is what gets
 * pasted. The state must be there and must be this login's: the real redirect
 * always carries it, and an address from another attempt is refused here with
 * a reason rather than sent to the token endpoint to fail there. A missing
 * scheme is forgiven, since some browsers hide it from the address bar.
 *
 * The state is checked before an `error` is reported, as the listener does:
 * otherwise any address could put words in the provider's mouth. And the
 * provider's own text is cut to one plain line, because it is printed on a
 * terminal and could otherwise carry escape sequences there.
 *
 * @param {string} input
 * @param {string} expectedState
 * @returns {string | null}  the code; null for an empty paste
 */
export function parseCodexCallback(input, expectedState) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const url = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  // The link this login handed out, pasted back by mistake: the TUI puts it
  // on the clipboard, so it is the likeliest wrong paste of all.
  if (url && `${url.origin}${url.pathname}` === AUTHORIZE_ENDPOINT) {
    throw new Error('That is the sign-in link itself. Open it in a browser, sign in, and paste the address the browser ends up on');
  }
  const params = url?.searchParams;
  const code = params?.get('code');
  const error = params?.get('error');
  if (!params || (!code && !error)) {
    throw new Error(`That is not the sign-in address. Paste the whole address the browser was sent to; it starts ${REDIRECT_URI}?code=`);
  }
  const state = params.get('state');
  if (!state) throw new Error('That address has no state. Paste the whole address from the browser, not only the code');
  if (state !== expectedState) throw new Error('That address is from a different sign-in attempt (the state does not match). Open this link again and paste the new address');
  if (error) {
    const description = safeLine(params.get('error_description') || '', 200);
    throw new Error(`OpenAI refused the sign-in: ${safeLine(error, 80)}${description ? ` (${description})` : ''}`);
  }
  return code;
}

/** @param {string} s */
function parseUrl(s) {
  try { return new URL(s); } catch { return null; }
}

/**
 * Bind the callback listener, or say why it could not be bound.
 *
 * A failure to bind is not fatal to the login: the pasted address completes
 * it the same way, since the token exchange names the registered redirect
 * whether or not anything was listening on it. A server error after the bind
 * (EMFILE, say) rejects `code`, and so fails the login: an 'error' event with
 * no listener would instead be an uncaught exception, and the end of the
 * proxy. Exported for tests.
 *
 * @param {number} port
 * @param {string} expectedState
 * @returns {Promise<{ server: import('node:http').Server | null, code: Promise<string> | null, error: Error | null }>}
 */
export async function listenForCallback(port, expectedState) {
  /** @type {(code: string) => void} */
  let resolve = () => {};
  /** @type {(err: Error) => void} */
  let reject = () => {};
  /** @type {Promise<string>} */
  const code = new Promise((res, rej) => { resolve = res; reject = rej; });
  const server = http.createServer(codexCallbackHandler(expectedState, { resolve, reject }));
  try {
    // Bind 127.0.0.1 rather than all interfaces: this listener briefly accepts
    // an authorization code, and nothing off this machine should reach it.
    // `ssh -L 1455:localhost:1455` arrives here as a local connection.
    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(port, '127.0.0.1', () => { server.off('error', rej); res(undefined); });
    });
    server.on('error', reject);
    return { server, code, error: null };
  } catch (e) {
    const err = /** @type {CodedError} */ (e);
    return {
      server: null,
      code: null,
      error: err.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is in use (a running \`codex login\` holds it)`)
        : err,
    };
  }
}

/**
 * Start a Codex sign-in and hand back what finishing it needs.
 *
 * The listener on port 1455 is always tried, remote session or not: with
 * `ssh -L 1455:localhost:1455` a browser on the laptop reaches it and the
 * sign-in finishes by itself. Whether or not it is listening, `submit` takes
 * the address the browser was left on (see parseCodexCallback), and the first
 * of the two to arrive is exchanged for tokens.
 *
 * Opening a browser is the caller's decision, so this never does.
 *
 * @param {object} [opts]
 * @param {import('./account-routing.js').RoutingProxy | null} [opts.routing]  the about-to-be-added account's own egress proxy
 * @param {AbortSignal | null} [opts.signal]  cancels the wait and closes the listener
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.port]  where to listen; tests only, as the redirect always names 1455
 * @param {typeof exchangeCodexCode} [opts.exchange]  injectable so tests need no token endpoint
 */
export async function startCodexLogin({ routing = null, signal = null, timeoutMs = LOGIN_TIMEOUT_MS, port = CALLBACK_PORT, exchange = exchangeCodexCode } = {}) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = buildCodexAuthUrl({ state, codeChallenge });

  const { server, code, error } = await listenForCallback(port, state);
  const race = codeRace({
    listener: code,
    parse: text => parseCodexCallback(text, state),
    signal,
    timeoutMs,
    onSettle: () => server?.close(),
  });
  const credentials = race.result.then(authCode => exchange({ code: authCode, codeVerifier, routing }));
  // Awaited by every caller; this only stops one that failed before awaiting
  // from leaving a later rejection unhandled, which would end the process.
  credentials.catch(() => {});
  return { url, listening: Boolean(server), listenError: error, submit: race.submit, settled: race.settled, credentials };
}

/**
 * `teamclaude login --codex`: a browser sign-in against OpenAI from the CLI.
 *
 * The browser is opened unless `noBrowser` says not to (the flag, or a remote
 * session). On a terminal the address the browser lands on can be pasted as
 * well, so a browser on another machine still completes the sign-in; that same
 * paste is what keeps the login going when port 1455 is taken. Without a
 * terminal to paste into, a taken port still fails the login, since nothing
 * else could complete it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noBrowser]
 * @param {number} [opts.timeoutMs]
 * @param {import('./account-routing.js').RoutingProxy | null} [opts.routing]  the about-to-be-added account's own egress proxy (login --routing)
 * @param {NodeJS.ReadStream} [opts.input]
 */
export async function loginCodex({ noBrowser = false, timeoutMs = LOGIN_TIMEOUT_MS, routing = null, input = process.stdin } = {}) {
  const canPaste = Boolean(input.isTTY);
  const controller = new AbortController();
  const flow = await startCodexLogin({ routing, signal: controller.signal, timeoutMs });

  if (flow.listenError) {
    if (!canPaste) {
      controller.abort();
      throw new Error(`${sanitizeText(flow.listenError.message)}. OpenAI only accepts ${REDIRECT_URI} for this client, so close whatever holds the port and retry.`);
    }
    console.log(`${sanitizeText(flow.listenError.message)}, so the browser cannot hand the sign-in back here. Paste the address instead, as below.`);
  }
  if (noBrowser) {
    console.log(`Open this URL to sign in (on any device):\n${flow.url}`);
  } else {
    console.log('Opening browser for OpenAI sign-in...');
    openBrowser(flow.url);
    console.log(`If it did not open, visit:\n${flow.url}`);
  }
  if (canPaste) {
    console.log(`\nIn a browser on another machine, the sign-in ends on a ${REDIRECT_URI} page that does not load.`);
    console.log('Copy that page\'s address from the address bar and paste it here.');
    pasteFromTerminal({
      submit: flow.submit,
      settled: flow.settled,
      prompt: flow.listening ? 'Paste the address here (or wait for the browser): ' : 'Paste the address here: ',
      onEnd: () => controller.abort(),
      input,
    });
  }
  return flow.credentials;
}
