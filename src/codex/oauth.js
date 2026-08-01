import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import http from 'node:http';

// OAuth configuration for ChatGPT-backed Codex accounts. The client id is the
// public one the Codex CLI ships with: these credentials authenticate a ChatGPT
// subscription, not a platform API key, so there is no secret to protect here.
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPE = 'openid profile email';

// The authorization flow needs offline_access to be issued a refresh token at
// all. The redirect URI is fixed: it is registered against the Codex CLI's
// client id, so the callback listener has to bind this exact port.
const LOGIN_SCOPE = 'openid email profile offline_access';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

// The account id lives in a namespaced claim on the id_token rather than a
// plain field. It is required on every upstream call (as chatgpt-account-id),
// so an account that loses it is unusable even with a valid access token.
const ACCOUNT_ID_CLAIM = 'https://api.openai.com/auth';

export const CODEX_DEFAULT_AUTH_PATH = join(homedir(), '.codex', 'auth.json');

/**
 * Decode a JWT's payload without verifying its signature. We never make a trust
 * decision from these claims — they only supply the account id and an expiry
 * hint for a token the issuer already handed us — so verification would buy
 * nothing and would require fetching OpenAI's JWKS.
 */
export function decodeJwtClaims(token) {
  const payload = typeof token === 'string' ? token.split('.')[1] : null;
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Pull the ChatGPT account id out of an id_token. Falls back through the
 * flattened spelling some token versions use before giving up.
 */
export function extractAccountId(idToken) {
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  return claims[ACCOUNT_ID_CLAIM]?.chatgpt_account_id
    || claims[`${ACCOUNT_ID_CLAIM}.chatgpt_account_id`]
    || null;
}

/**
 * Read the plan type (e.g. "plus", "pro") for display in account listings.
 */
export function extractPlanType(idToken) {
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  return claims[ACCOUNT_ID_CLAIM]?.chatgpt_plan_type
    || claims[`${ACCOUNT_ID_CLAIM}.chatgpt_plan_type`]
    || null;
}

/**
 * Read the account's email, used as the default account name on import.
 */
export function extractEmail(idToken) {
  return decodeJwtClaims(idToken)?.email || null;
}

/**
 * Derive an expiry (ms epoch) for an access token. OpenAI's refresh response
 * carries expires_in, but a credential file imported from the Codex CLI has no
 * expiry field at all — for those we read `exp` off the token itself so an
 * already-dead token is refreshed before its first use rather than after a 401.
 */
export function expiryFromToken(accessToken) {
  const exp = decodeJwtClaims(accessToken)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

/**
 * Refresh a Codex access token using its refresh token.
 *
 * Deliberately mirrors the retry/error contract of the Anthropic
 * refreshAccessToken: retry 5xx and network errors with exponential backoff,
 * and set `err.status` on HTTP failures. AccountManager.ensureTokenFresh keys
 * off that status to tell a dead refresh token (sideline the account, needs
 * re-login) apart from a transient blip (keep the account, retry later), so a
 * codex refresh that threw a bare Error would wrongly look transient forever.
 *
 * Note the wire format differs from Anthropic's: OpenAI wants form-encoded
 * fields, not JSON.
 */
export async function refreshCodexToken(refreshToken) {
  const maxRetries = 2;
  const baseDelayMs = 500;
  const timeoutMs = Number(process.env.TEAMCLAUDE_REFRESH_TIMEOUT_MS) || 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: SCOPE,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        const err = new Error(`Codex token refresh failed (${res.status}): ${text}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const accessToken = data.access_token;
      return {
        accessToken,
        // OpenAI may or may not rotate the refresh token; keep the old one when
        // the response omits it, matching the Anthropic path.
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : expiryFromToken(accessToken),
        // A refresh returns a fresh id_token; re-derive the account id from it
        // so a server-side account migration is picked up rather than pinned to
        // whatever was imported.
        accountId: extractAccountId(data.id_token) || null,
        idToken: data.id_token || null,
      };
    } catch (err) {
      const isNetworkError = err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError' ||
          err.message.includes('fetch failed') ||
          (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
           err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT'));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw err;
    }
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}

/**
 * Listen for the OAuth redirect.
 *
 * Unlike the Anthropic flow this cannot take an ephemeral port: the redirect
 * URI is registered against the Codex CLI's client id, so the callback must
 * arrive on exactly REDIRECT_PORT. A busy port therefore means something else
 * is mid-login (most likely the Codex CLI), which is worth saying plainly
 * rather than surfacing as a bare EADDRINUSE.
 */
function startCodexCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const done = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:system-ui;padding:3rem"><h2>${message}</h2><p>You can close this tab.</p></body></html>`);
      };

      const error = url.searchParams.get('error');
      if (error) {
        done('Authentication failed');
        rejectCode(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description') || ''}`));
        return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        done('Authentication failed');
        rejectCode(new Error('OAuth state mismatch'));
        return;
      }
      const code = url.searchParams.get('code');
      if (code) {
        done('Signed in to TeamClaude');
        resolveCode(code);
      }
    });

    server.listen(REDIRECT_PORT, () => resolve({ codePromise, server }));
    server.on('error', err => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`Port ${REDIRECT_PORT} is in use — close any running \`codex login\` and try again.`)
        : err);
    });

    const timer = setTimeout(() => {
      rejectCode(new Error('Timed out waiting for the OAuth callback'));
      server.close();
    }, 5 * 60_000);
    timer.unref?.();
  });
}

/**
 * Log in to ChatGPT and obtain a Codex credential of our own.
 *
 * This is the alternative to `import --codex`, and the reason to prefer it: an
 * imported credential is a COPY of the Codex CLI's, so both hold one refresh
 * token, and since OpenAI rotates it on every refresh whichever party refreshes
 * second is left holding a dead one. A separate authorization mints an
 * independent refresh-token lineage, so teamclaude and the CLI can refresh on
 * their own schedules without invalidating each other.
 *
 * `prompt=login` forces a fresh authorization rather than silently reusing an
 * existing session, which is what makes the grant independent.
 */
export function buildCodexAuthUrl({ state, codeChallenge }) {
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  // offline_access is what gets a refresh token issued at all.
  authUrl.searchParams.set('scope', LOGIN_SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // Forces a fresh authorization instead of silently reusing an existing
  // session. This is the parameter that makes the resulting grant — and so the
  // refresh-token lineage — independent of the Codex CLI's.
  authUrl.searchParams.set('prompt', 'login');
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  return authUrl.toString();
}

export async function loginCodex() {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  const { codePromise, server } = await startCodexCallbackServer(state);
  const authUrl = new URL(buildCodexAuthUrl({ state, codeChallenge }));

  console.log('Opening browser to sign in to ChatGPT...');
  console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  console.log('Exchanging authorization code for tokens...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Codex token exchange failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const accountId = extractAccountId(data.id_token);
  if (!accountId) {
    throw new Error('Sign-in succeeded but the response carried no ChatGPT account id.');
  }

  return {
    protocol: 'codex',
    type: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token || null,
    accountId,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : expiryFromToken(data.access_token),
    email: extractEmail(data.id_token),
    planType: extractPlanType(data.id_token),
  };
}

/**
 * Import credentials from a Codex CLI auth file (~/.codex/auth.json).
 *
 * Only ChatGPT OAuth credentials are accepted. An `apikey` auth_mode file holds
 * a platform API key, which talks to a different host with different billing
 * and would fail in confusing ways if we silently accepted it here.
 */
export async function importCodexCredentials(filePath = CODEX_DEFAULT_AUTH_PATH) {
  const resolvedPath = filePath.replace(/^~/, homedir());
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));

  const tokens = raw.tokens || {};
  if (raw.auth_mode && raw.auth_mode !== 'chatgpt') {
    throw new Error(
      `Unsupported Codex auth_mode "${raw.auth_mode}" in ${resolvedPath}. ` +
      'Only ChatGPT OAuth credentials are supported; run `codex login` to create them.'
    );
  }
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(`No Codex OAuth tokens found in ${resolvedPath} — run \`codex login\` first.`);
  }

  const accountId = tokens.account_id || extractAccountId(tokens.id_token);
  if (!accountId) {
    throw new Error(
      `Could not determine the ChatGPT account id from ${resolvedPath}. ` +
      'Re-run `codex login` to refresh the credential file.'
    );
  }

  return {
    protocol: 'codex',
    type: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token || null,
    accountId,
    expiresAt: expiryFromToken(tokens.access_token),
    email: extractEmail(tokens.id_token),
    planType: extractPlanType(tokens.id_token),
  };
}
