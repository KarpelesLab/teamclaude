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
//
// Provider is part of it too: a Codex account has no Anthropic UUID at all, so
// without it one email's Claude and ChatGPT subscriptions compare as one account.

import { providerOf } from './provider.js';

/** Stable org discriminator for an account record: org UUID, else org name, else null. */
export function orgKey(acct) {
  return acct?.orgUuid || acct?.orgName || null;
}

/**
 * Whether two records name the same organization: true, false, or null when
 * they carry no field in common to compare.
 *
 * Compared field by field rather than through orgKey. Which field a record
 * carries depends on what the profile returned when the account was added, so
 * one record holding only the uuid and another holding only the name describe
 * one organization while their keys differ — and comparing those keys called
 * one account two, which on the save path carried its row over a second time
 * (#328). The uuid decides when both sides have one; the name decides when
 * both have one and either lacks a uuid; a uuid against a name is no evidence
 * either way.
 */
export function sameOrg(a, b) {
  if (a?.orgUuid && b?.orgUuid) return a.orgUuid === b.orgUuid;
  if (a?.orgName && b?.orgName) return a.orgName === b.orgName;
  return null;
}

/**
 * Whether two account records refer to the same account+org.
 *
 * - Different providers: never the same account, and the one case that needs no
 *   UUID. Checked first because the name fallback below is what a cross-provider
 *   pair reaches — a Codex account has no accountUuid to tell it apart from its
 *   Claude namesake, so one email holding both subscriptions read as one account.
 * - Both have an accountId (the ChatGPT one): it must match, and so must the
 *   userId when both sides have one (members of one ChatGPT workspace share an
 *   accountId). Same evidence class as the accountUuid below, so it decides
 *   before the name.
 * - Both have an accountUuid: it must match. If the organizations can be
 *   compared (see sameOrg) they must also match; but if either side's org is
 *   still unknown we treat them as the same. This lets a freshly-profiled login
 *   backfill a legacy entry (which has no stored org) instead of creating a
 *   duplicate. Once both sides carry a comparable org field, a *different* org
 *   is correctly seen as a distinct account.
 * - Otherwise (API-key accounts, or no UUID yet): fall back to matching by name.
 */
export function sameIdentity(a, b) {
  if (providerOf(a) !== providerOf(b)) return false;
  if (a?.accountId && b?.accountId) {
    return a.accountId === b.accountId && (!a.userId || !b.userId || a.userId === b.userId);
  }
  if (a?.accountUuid && b?.accountUuid) {
    if (a.accountUuid !== b.accountUuid) return false;
    return sameOrg(a, b) !== false;
  }
  return a?.name === b?.name;
}

/**
 * Are these two records definitely NOT the same account? True only when both
 * sides are fully identified and point at different account+org pairs — an
 * unknown UUID or org on either side means "cannot tell", never "different".
 * Two providers are the exception: separate plans, whoever holds them.
 */
export function distinctAccounts(a, b) {
  if (providerOf(a) !== providerOf(b)) return true;
  if (a?.accountId && b?.accountId) {
    return a.accountId !== b.accountId || (!!a.userId && !!b.userId && a.userId !== b.userId);
  }
  if (!a?.accountUuid || !b?.accountUuid) return false;
  if (a.accountUuid !== b.accountUuid) return true;
  return sameOrg(a, b) === false;
}

/**
 * Index of the config entry an incoming login should UPDATE, or -1 to add it as
 * a new one.
 *
 * Identity decides first: the same account+org is the same entry. A bare display
 * name match is accepted only when nothing contradicts it — one person's two
 * organizations share an email, and the display name is derived from that email,
 * so treating equal names as one account overwrites the other org's entry and
 * silently drops an account from the config. The account keeps working until the
 * process that still holds it in memory restarts, which is what makes the loss
 * hard to trace back to the login that caused it.
 */
export function findUpsertTarget(accounts, incoming) {
  // A UUID match is evidence; a name match is a guess, and sameIdentity makes
  // both in one pass — it compares UUIDs only when BOTH records carry one and
  // falls back to the name otherwise. So an entry with no UUID matched any
  // incoming record sharing its name, and if it sat earlier in the list it won
  // over the entry whose account+org actually matched, landing the credential on
  // the namesake row (#236). Two entries with one name where the earlier has no
  // UUID is just a hand-added entry beside a logged-in one, or an account added
  // before its first probe.
  //
  // So look for the evidence before accepting the guess — and the strongest
  // evidence first. The uuid pass below still takes sameIdentity's tolerant
  // answer, which says yes to an entry that never stored an organization, so a
  // legacy entry sitting earlier in the list won over the one whose
  // organization actually matched (#327). An entry with no organization ahead
  // of one that has it is a hand-added entry beside a logged-in one, or any
  // account before its first probe.
  if (incoming?.accountUuid) {
    const exact = accounts.findIndex(a => a?.accountUuid === incoming.accountUuid && sameOrg(a, incoming) === true);
    if (exact >= 0) return exact;
    const byUuid = accounts.findIndex(a => a?.accountUuid && sameIdentity(a, incoming));
    if (byUuid >= 0) return byUuid;
  }
  const byIdentity = accounts.findIndex(a => sameIdentity(a, incoming));
  if (byIdentity >= 0) return byIdentity;
  return accounts.findIndex(a => a.name === incoming.name && !distinctAccounts(a, incoming));
}

/**
 * The entry to store at a `findUpsertTarget` hit: `incoming` over `prev`, with
 * two of the existing entry's fields pinned.
 *
 * `name` because a login should not rename an account the operator named. `id`
 * because a running server holds an account built from this entry and finds it
 * again by that id (see account-pairing.js) — reissuing it here would strand
 * that account with no entry to be saved onto, and the token it refreshes next
 * would be dropped instead of persisted. An `incoming` record carrying neither
 * field already leaves both alone; pinning them says so, and keeps saying so if
 * one day it carries them.
 */
export function updateAccountEntry(prev, incoming) {
  return { ...prev, ...incoming, name: prev.name, id: prev.id };
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

/**
 * Whether a failed fetchProfile proves the token is dead, as opposed to merely
 * unreachable. Only a 401 counts. A 5xx, a timeout or a DNS failure says
 * nothing about the token, and neither does a 403: the upstream answers 403
 * "Request not allowed" to a valid token from an unexpected region (see
 * egress-guard.js), and an org-policy 403 is a cooldown at request time, not a
 * dead credential — a fresh token would meet the same answer.
 *
 * @param {Record<string, any>|null|undefined} profile - a fetchProfile result, success or error
 */
export function isTokenRejection(profile) {
  return profile?.status === 401;
}

/**
 * Automatic naming is safe only when the profile identifies the account.
 * An explicit name is the caller's opt-in to importing without detection.
 */
export function canUpsertOAuthAccount(profile, userNamed) {
  // A token the upstream has REJECTED is dead, and --name must not override
  // that. The import reports success and then every request 401s, with nothing
  // pointing back at the account that was already known to be bad at the moment
  // it was added.
  //
  // Only a definitive refusal counts — a 401 the caller could not refresh away
  // (oauth.js profileForCredentials renews a stale access token before the
  // profile gets here). A 5xx, a 403, a timeout or a DNS failure says nothing
  // about the token, and a healthy one must stay importable from a restricted
  // network — which is what `userNamed` is for, and still is.
  if (isTokenRejection(profile)) return false;
  return Boolean(
    userNamed
    || (profile && !profile.error && (profile.accountUuid || profile.email))
  );
}

/**
 * Copy only known profile identity fields. Omitting unavailable fields keeps a
 * named re-import from erasing identity already stored on the account.
 */
/** @returns {{ accountUuid?: string, orgUuid?: string, orgName?: string }} */
export function oauthIdentityFields(profile) {
  if (!profile || profile.error) return {};
  return Object.fromEntries(
    ['accountUuid', 'orgUuid', 'orgName']
      .filter(key => profile[key])
      .map(key => [key, profile[key]])
  );
}
