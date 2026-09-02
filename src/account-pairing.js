// Pairing between the in-memory config account list and the AccountManager's.
//
// The two lists are NOT positionally aligned. resolveAccounts drops every entry
// without a usable credential, so from the first drop onward a config index and
// a manager index name different accounts — permanently, for the life of the
// process. Indexing one list with the other's index writes one account's
// refreshed OAuth tokens onto another account's config record, and that record
// is what gets persisted to disk. On a fleet holding accounts that belong to
// different people, that is a credential crossing rather than a mix-up.
//
// Each entry carries an id unique within its list (see account-id.js), and
// makeAccount copies it onto the account built from the entry, so an account
// names the entry it came from. Pairing is that lookup, which is why it needs no
// evidence and admits no ambiguity: it survives the refresh that rewrites the
// credential, and it separates two entries that agree on everything else.

import { sameIdentity } from './identity.js';

/**
 * The manager account built from config entry `acct`, or null if it has none.
 *
 * An entry without an id is refused rather than searched for. Two records that
 * merely agree on having no id are not the same record, and pairing them would
 * be the guess this module exists to avoid. loadConfig gives every entry it
 * reads an id, so this guards the module's own contract rather than a state the
 * server reaches.
 */
export function managerAccountFor(managerAccounts, acct) {
  if (!acct?.id) return null;
  return managerAccounts.find(m => m?.id === acct.id) || null;
}

/**
 * Index of the config entry that manager account `mgrIdx` was built from, or -1.
 *
 * -1 also covers `mgrIdx` naming no account at all, which is what a caller with
 * no account passes. An account without an id is refused for the same reason
 * managerAccountFor refuses an entry without one.
 */
export function configIndexFor(configAccounts, managerAccounts, mgrIdx) {
  const id = managerAccounts[mgrIdx]?.id;
  if (!id) return -1;
  return configAccounts.findIndex(a => a?.id === id);
}

/**
 * The account list to write to disk: in-memory config entries carrying live
 * credentials from the account each was built into, merged over the on-disk
 * entry so disk-only fields (e.g. importFrom) survive. An entry with no account
 * keeps what it has — there is no live credential to write.
 *
 * The config-to-disk lookup is a different axis and stays on identity, which is
 * not claimed one-to-one: two entries identity cannot separate both merge over
 * the same disk record. No credential moves that way, because the live one above
 * overrides whatever the lookup found — but the record's other fields do move,
 * and `importFrom` among them names the file an entry takes its credential from
 * at the next start. An entry can therefore pick up a delegation that was never
 * its own and read another's credential a restart later. Pairing by id does not
 * reach this axis.
 */
export function mergeAccountsForSave(configAccounts, managerAccounts, diskAccounts) {
  return configAccounts.map(a => {
    const am = managerAccountFor(managerAccounts, a);
    const live = am ? {
      ...a,
      accessToken: am.credential,
      refreshToken: am.refreshToken,
      expiresAt: am.expiresAt,
    } : a;
    const diskAcct = diskAccounts.find(d => sameIdentity(d, a));
    return diskAcct ? { ...diskAcct, ...live } : live;
  });
}

/**
 * Record freshly refreshed tokens on the config entry that manager account
 * `mgrIdx` was built from. Returns the config index written, or -1 if no entry
 * holds its id, in which case nothing is written: an account the config no
 * longer describes has no row of its own, and any row picked for it would be
 * another account's.
 */
export function syncRefreshedTokens(configAccounts, managerAccounts, mgrIdx, newTokens) {
  const i = configIndexFor(configAccounts, managerAccounts, mgrIdx);
  if (i < 0) return -1;
  configAccounts[i].accessToken = newTokens.accessToken;
  configAccounts[i].refreshToken = newTokens.refreshToken;
  configAccounts[i].expiresAt = newTokens.expiresAt;
  return i;
}
