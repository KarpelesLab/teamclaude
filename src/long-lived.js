// Accounts signed in with `teamclaude login --long-lived`.
//
// That login makes the request `claude setup-token` makes: the ordinary
// authorization-code flow with the scope `user:inference` alone, and
// `expires_in` of one year on the code exchange. The token it returns is not
// refreshed, by Claude Code or here, and serves inference only: an endpoint
// that needs `user:profile` (the profile lookup, the usage read and the reset
// calls on it) answers it 403 `oauth_scope_insufficient`.
//
// So such an account is marked (`accounts[].longLived`), and everything that
// would refresh its token or read its profile or usage leaves it alone. Its
// quota is whatever the responses to its own requests state in their headers.

/** How many days ahead of a long-lived token's expiry status and the log start to warn. */
export const LONG_LIVED_WARN_DAYS = 14;

/**
 * Whether an entry holds a `login --long-lived` token, which is never refreshed.
 * An `importFrom` entry takes its token from a refreshing Claude Code login, so
 * the marker means nothing there. Takes a config entry, a running account or a
 * status row: the last two carry the answer already and no `importFrom`.
 * @param {Record<string, any>|null|undefined} acct
 * @returns {boolean}
 */
export function isLongLived(acct) {
  return acct?.longLived === true && !acct.importFrom;
}
