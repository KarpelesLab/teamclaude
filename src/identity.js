// Account identity helpers.
//
// An account is identified by its Anthropic account UUID (the *person*) plus the
// organization it's scoped to. The same email/person can belong to multiple
// orgs, each with its own OAuth token and quota, so the org must be part of the
// identity — otherwise multi-org logins collide, removals mis-match, and token
// rotation persists onto the wrong entry.
//
// The org discriminator prefers the org UUID but falls back to the org name
// (which the profile endpoint has always returned), so identity still works even
// when only the name is known. Accounts with neither (legacy entries, API keys,
// or pre-profile imports) fall back to matching by name.

/** Stable-ish org discriminator for an account: org UUID, else org name, else null. */
export function orgKey(acct) {
  return acct?.orgUuid || acct?.orgName || null;
}

/**
 * Whether two account records refer to the same account+org.
 *
 * - Both have an accountUuid: same person requires equal UUID; if both org keys
 *   are known they must match, but if either side's org is still unknown we
 *   treat them as the same (so a freshly-profiled login backfills a legacy
 *   entry instead of duplicating it).
 * - Otherwise (API key / no UUID yet): fall back to matching by name.
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
