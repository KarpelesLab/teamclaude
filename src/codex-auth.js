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
import { exec } from 'node:child_process';
import http from 'node:http';
import { proxyFetch } from './upstream-fetch.js';

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
  };
}

/**
 * Exchange a Codex refresh token for a fresh access token.
 *
 * Mirrors the Anthropic refresh contract (`{ accessToken, refreshToken,
 * expiresAt }`) so the account manager can treat both the same. A rotated
 * refresh token is returned when the server issues one, and the old one is
 * kept when it does not.
 */
export async function refreshCodexToken(refreshToken, endpoint = TOKEN_ENDPOINT) {
  const timeoutMs = Number(process.env.TEAMCLAUDE_REFRESH_TIMEOUT_MS) || 30_000;
  const res = await proxyFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Codex token refresh failed (${res.status}): ${text}`);
    // Surfaced so callers can tell a dead refresh token (re-login needed) from
    // a transient server error, exactly as the Anthropic path does.
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
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

/** Exchange an authorization code for tokens, completing the PKCE handshake. */
export async function exchangeCodexCode({ code, codeVerifier, redirectUri = REDIRECT_URI }) {
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
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: auth.chatgpt_account_id,
    email: claims.email,
    planType: auth.chatgpt_plan_type,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
      : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}

/**
 * Run a browser OAuth login against OpenAI and return the new credentials.
 *
 * The listener must bind port 1455 because that is the only redirect OpenAI
 * accepts for this client. If the Codex CLI is mid-login it already holds that
 * port, which is why the bind failure is reported as such rather than as a
 * generic error.
 */
export async function loginCodex({ noBrowser = false, timeoutMs = 120_000 } = {}) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const authUrl = buildCodexAuthUrl({ state, codeChallenge });

  let server;
  const code = await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }

      const err = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const returnedCode = url.searchParams.get('code');
      const fail = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
        reject(new Error(message));
      };

      if (err) return fail(`OAuth error: ${err} ${url.searchParams.get('error_description') || ''}`.trim());
      if (returnedState !== state) return fail('OAuth state mismatch');
      if (!returnedCode) return fail('OAuth callback carried no code');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Signed in</h2><p>You can close this tab and return to the terminal.</p></body></html>');
      resolve(returnedCode);
    });

    server.on('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${CALLBACK_PORT} is in use. OpenAI only accepts ${REDIRECT_URI} for this client, so close whatever holds it (a running \`codex login\`) and retry.`)
      : e));

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      if (noBrowser) {
        console.log(`Open this URL to sign in:\n${authUrl}`);
      } else {
        console.log('Opening browser for OpenAI sign-in...');
        openBrowser(authUrl);
        console.log(`If it did not open, visit:\n${authUrl}`);
      }
    });

    const timer = setTimeout(() => { reject(new Error('Login timed out after 2 minutes')); server.close(); }, timeoutMs);
    timer.unref();
    // Bind 127.0.0.1 rather than all interfaces: this listener briefly accepts
    // an authorization code, and nothing off this machine should reach it.
  }).finally(() => { server?.close(); });

  return exchangeCodexCode({ code, codeVerifier });
}
