/**
 * Keep TeamClaude's fleet tokens aligned with Claude Code's own OAuth refreshes.
 *
 * Claude Code refreshes against `platform.claude.com` (and occasionally
 * `/v1/oauth/token` on the inference host). Those refreshes rotate the
 * refresh-token family. When TeamClaude only holds a *copy* of the previous
 * token, the next `ensureTokenFresh` gets `invalid_grant` and the account is
 * dropped from rotation — even though Claude Code (and the Keychain) still
 * have a working login.
 *
 * Matching is by the refresh_token the client *sent*: that is the only stable
 * handle we have before the response lands. Authorization-code exchanges do
 * not carry one and are ignored.
 */

import { tokenPairFromResponse } from './oauth.js';
import { safeLine } from './safe-text.js';

/**
 * If `requestBody` / `responseBody` are a successful refresh_token grant,
 * copy the new tokens onto every fleet account that still held the old
 * refresh token. Returns the number of accounts updated.
 *
 * @param {import('./account-manager.js').AccountManager} accountManager
 * @param {string|Buffer} requestBody
 * @param {string|Buffer} responseBody
 * @param {number} [status]
 * @returns {number}
 */
export function syncClientOAuthRefresh(accountManager, requestBody, responseBody, status = 200) {
  if (status < 200 || status >= 300) return 0;
  if (!accountManager?.accounts?.length) return 0;

  let req;
  let res;
  try {
    req = JSON.parse(typeof requestBody === 'string' ? requestBody : requestBody.toString('utf8'));
    res = JSON.parse(typeof responseBody === 'string' ? responseBody : responseBody.toString('utf8'));
  } catch {
    return 0;
  }

  if (req?.grant_type && req.grant_type !== 'refresh_token') return 0;
  const sent = req?.refresh_token;
  if (typeof sent !== 'string' || sent === '') return 0;

  let pair;
  try {
    pair = tokenPairFromResponse(res, { previousRefreshToken: sent });
  } catch {
    return 0;
  }

  let updated = 0;
  for (const account of accountManager.accounts) {
    if (account.type !== 'oauth' || account.upstream) continue;
    if (account.refreshToken !== sent) continue;
    const index = account.index;
    if (typeof accountManager.updateAccountTokens === 'function') {
      accountManager.updateAccountTokens(index, pair);
    } else {
      account.credential = pair.accessToken;
      account.refreshToken = pair.refreshToken;
      account.expiresAt = pair.expiresAt;
      if (account.status === 'error') account.status = 'active';
    }
    account._deadRefreshToken = null;
    updated += 1;
    console.log(`[TeamClaude] Synced client OAuth refresh onto account "${safeLine(account.name, 64)}"`);
  }
  return updated;
}
