// Account identity helpers.
//
// An OAuth account is identified by its Anthropic account UUID (the *person*)
// plus the organization it is scoped to. The same email/person can belong to
// multiple organizations — e.g. a corporate Pro org and a personal Max org —
// each with its own OAuth token and quota. The org must therefore be part of
// the identity; otherwise multi-org logins overwrite each other, removals match
// the wrong entry, and token rotation persists onto the wrong account.
//
// The org discriminator prefers the org UUID but falls back to the org name
// (the profile endpoint has always returned a name), so identity still works on
// entries created before org UUIDs were stored.

/** Stable org discriminator for an account record: org UUID, else org name, else null. */
export function orgKey(acct) {
  return acct?.orgUuid || acct?.orgName || null;
}

/**
 * Whether two account records refer to the same account+org.
 *
 * - Both have an accountUuid: it must match. If both org keys are known they
 *   must also match; but if either side's org is still unknown we treat them as
 *   the same. This lets a freshly-profiled login backfill a legacy entry (which
 *   has no stored org) instead of creating a duplicate. Once both sides carry an
 *   org key, a *different* org is correctly seen as a distinct account.
 * - Otherwise (API-key accounts, or no UUID yet): fall back to matching by name.
 */
export function sameIdentity(a, b) {
  if (a?.accountUuid && b?.accountUuid) {
    if (a.accountUuid !== b.accountUuid) return false;
    const ka = orgKey(a);
    const kb = orgKey(b);
    if (ka && kb) return ka === kb;
    return true;
  }
  return a?.name === b?.name;
}

/** The email portion of a display name, stripping any " (org)" suffix. */
export function emailOf(acct) {
  return (acct?.name || '').replace(/ \(.*\)$/, '');
}

/**
 * Find accounts matching a name-or-email query, optionally narrowed by org.
 *
 * An exact display-name match wins outright. Otherwise match by email (so
 * `remove user@x.com` finds `user@x.com (Acme)`). `orgFilter` narrows by org
 * name or org UUID (prefix allowed). Returns the array of matches; the caller
 * decides what to do with 0, 1, or many.
 */
export function matchAccounts(accounts, query, orgFilter) {
  let matches = accounts.filter(a => a.name === query);
  if (matches.length === 0) {
    matches = accounts.filter(a => emailOf(a) === query);
  }
  if (orgFilter) {
    matches = matches.filter(a =>
      (a.orgName && a.orgName === orgFilter) ||
      (a.orgUuid && (a.orgUuid === orgFilter || a.orgUuid.startsWith(orgFilter)))
    );
  }
  return matches;
}
