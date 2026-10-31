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

// A link is shown to the operator as upstream's, so only a plain https link on
// Anthropic's own hosts: no port, credentials or fragment, and not too long.
const LINK_HOSTS = new Set(['claude.ai', 'platform.claude.com', 'portal.anthropic.com']);
const LINK_DOMAINS = ['claude.ai', 'anthropic.com'];

/**
 * `candidate` as a link to show the operator, or null when it is not one.
 * @param {unknown} candidate
 * @returns {string|null}
 */
export function anthropicLink(candidate) {
  if (typeof candidate !== 'string') return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  const host = url.hostname;
  const anthropic = LINK_HOSTS.has(host) || LINK_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
  const plain = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash;
  return anthropic && plain && url.href.length <= 2048 ? url.href : null;
}

/** The first Anthropic link in a refusal message. @param {string} message */
function messageLink(message) {
  for (const [match] of message.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const link = anthropicLink(match.replace(/[.,;:!?)\]}]+$/, ''));
    if (link) return link;
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
  return { code, message: sanitizeText(message) || code, link: messageLink(message) };
}
