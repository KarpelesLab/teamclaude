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
import { proxyFetch } from './upstream-fetch.js';

export const DEFAULT_CODEX_CREDENTIALS_PATH = '~/.codex/auth.json';

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
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
