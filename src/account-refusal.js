// Upstream refusals that are about the account, not the request.
//
// Anthropic names them in `error.details.error_code`: an identity check the
// account owner has to pass, an account or organization on hold or disabled,
// an organization that does not admit this endpoint or this address. Another
// request on the same account gets the same answer, so the account leaves
// rotation (AccountManager.markRefused) and status shows upstream's own words.
//
// `oauth_not_allowed_for_organization` is not here: it has its own cooldown
// (isOAuthEntitlementDenied in server.js).

import { sanitizeText } from './safe-text.js';

/** The `error_code` values that refuse the account itself. */
export const ACCOUNT_REFUSAL_CODES = new Set([
  'verification_required',
  'account_on_hold',
  'organization_on_hold',
  'organization_disabled',
  'restricted_regime_endpoint',
  'ip_not_in_allowed_range',
]);

/** Whether the account is out of rotation over one of these refusals. */
export function isRefused(/** @type {Record<string, any>} */ account) {
  return account.status === 'error' && ACCOUNT_REFUSAL_CODES.has(account.errorReason?.code);
}

// Older answers carried no code, only a 400 with one of these messages.
/** @type {[RegExp, string][]} */
const LEGACY_MESSAGES = [
  [/^This organization has been disabled\b/i, 'organization_disabled'],
  [/^Identity verification is required\b/i, 'verification_required'],
];

// A link is shown to the operator as upstream's, so only Anthropic's own hosts.
const LINK_HOSTS = new Set(['claude.ai', 'platform.claude.com', 'portal.anthropic.com']);

/** @param {string} message */
function anthropicLink(message) {
  for (const [match] of message.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const candidate = match.replace(/[.,;:!?)\]}]+$/, '');
    try {
      if (LINK_HOSTS.has(new URL(candidate).hostname)) return candidate;
    } catch { /* not a URL */ }
  }
  return null;
}

/**
 * The account-level refusal in an upstream 400 or 403 body, or null when the
 * answer is about the request (or is not one of these at all).
 * @param {number} status
 * @param {Uint8Array|null} body
 * @returns {{ code: string, message: string, link: string|null }|null}
 */
export function accountRefusal(status, body) {
  if ((status !== 400 && status !== 403) || !body) return null;
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  const error = parsed?.error;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const structured = error?.details?.error_code;
  const code = ACCOUNT_REFUSAL_CODES.has(structured) ? structured
    : status === 400 && structured == null ? LEGACY_MESSAGES.find(([pattern]) => pattern.test(message))?.[1]
    : null;
  if (!code) return null;
  return { code, message: sanitizeText(message) || code, link: anthropicLink(message) };
}
