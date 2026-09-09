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
 * Whether this entry's OAuth token belongs in `config.json` at all.
 *
 * The save used to write `accessToken: am.credential` onto EVERY entry, which
 * is right for an ordinary oauth account and wrong for the other two kinds:
 *
 *   - an API-KEY account's credential is its `apiKey`, so the save mirrored the
 *     same secret into `accessToken` — and makeAccount reads
 *     `acct.accessToken || acct.apiKey`, preferring the mirror. Rotating the key
 *     in config.json was then ignored on the next cold start, while a running
 *     server picked it up, so the failure looked like the provider rejecting a
 *     key that reads correctly in the file (#202).
 *   - an `importFrom` account delegates to a credentials file on purpose. One
 *     save materialised the token into config.json, and from then on the copy
 *     won over re-reading the file, so the entry stopped delegating in practice
 *     (#204).
 *
 * Refreshed tokens for ordinary oauth entries still persist — that is the case
 * this write exists for.
 */
function ownsInlineToken(entry) {
  return entry?.type === 'oauth' && !entry.importFrom;
}

// Entries the operator removed in this process, by id.
//
// The save has to tell two things apart that look identical on disk: a row that
// appeared since the last reload (`teamclaude login` while the server runs —
// keep it) and a row the operator just deleted (drop it). Both are "on disk but
// not in memory", and removal is itself a save, so adopting disk-only rows
// without this would resurrect the account the operator was in the middle of
// deleting.
//
// Held on the config object and non-enumerable, so it never reaches JSON.
const REMOVED = Symbol('removedAccountIds');

/** Record that `id` was deliberately removed, so a save does not adopt it back. */
export function markAccountRemoved(config, id) {
  if (!config || !id) return;
  if (!config[REMOVED]) {
    Object.defineProperty(config, REMOVED, { value: new Set(), enumerable: false, writable: true });
  }
  config[REMOVED].add(id);
}

/** The ids removed so far. */
export function removedAccountIds(config) {
  return config?.[REMOVED] || new Set();
}

/**
 * Forget the removals, once a save has written a list that omits them. After
 * that the rows are gone from disk too, so there is nothing left to re-adopt
 * and keeping the ids would only strand them if the operator re-added the same
 * account later.
 */
export function clearRemovedAccountIds(config) {
  if (config?.[REMOVED]) config[REMOVED].clear();
}

/**
 * Which disk row each config entry merges over, as a Map of config index to disk
 * index. A row is claimed by at most one entry.
 *
 * Evidence before guesswork, in three passes: an exact id, then an account uuid
 * both records carry, then the display name. `sameIdentity` collapses the last
 * two — it compares uuids only when both sides have one and falls back to the
 * name otherwise — so calling it alone lets an entry holding a uuid settle for a
 * namesake's row. Claiming consumes, so that row is then taken from the entry it
 * belonged to, and `importFrom` on it names the file an entry reads its
 * credential from at the next start. findUpsertTarget in identity.js puts the
 * same two questions in this order for the login axis.
 *
 * Ids can disagree with disk — a file written before the field existed, or
 * re-minted by another process — which is why they cannot be the only pass.
 */
function claimDiskRows(configAccounts, diskAccounts) {
  const rowFor = new Map();
  const taken = new Set();
  const claim = (i, matches) => {
    for (const [d, diskAcct] of diskAccounts.entries()) {
      if (taken.has(d) || !matches(diskAcct)) continue;
      taken.add(d);
      rowFor.set(i, d);
      return;
    }
  };
  configAccounts.forEach((a, i) => { if (a?.id) claim(i, d => d?.id === a.id); });
  configAccounts.forEach((a, i) => { if (!rowFor.has(i) && a?.accountUuid) claim(i, d => d?.accountUuid && sameIdentity(d, a)); });
  configAccounts.forEach((a, i) => { if (!rowFor.has(i)) claim(i, d => sameIdentity(d, a)); });
  return rowFor;
}

/**
 * The account list to write to disk: in-memory config entries carrying live
 * credentials from the account each was built into, merged over the on-disk
 * entry so disk-only fields (e.g. importFrom) survive. An entry with no account
 * keeps what it has — there is no live credential to write.
 *
 * The config-to-disk lookup is a different axis from the config-to-manager one,
 * and claimDiskRows is where it is decided: one row per entry, one entry per row.
 */
export function mergeAccountsForSave(configAccounts, managerAccounts, diskAccounts, removedIds = new Set()) {
  // loadConfig normalises a missing list, but this is the function that threw
  // on one (#330), so it holds its own contract too: no rows is an empty list.
  if (!Array.isArray(diskAccounts)) diskAccounts = [];
  const rowFor = claimDiskRows(configAccounts, diskAccounts);

  const merged = configAccounts.map((a, i) => {
    const am = managerAccountFor(managerAccounts, a);
    const live = am && ownsInlineToken(a) ? {
      ...a,
      accessToken: am.credential,
      refreshToken: am.refreshToken,
      expiresAt: am.expiresAt,
    } : a;
    const diskAcct = diskAccounts[rowFor.get(i)];
    return diskAcct ? { ...diskAcct, ...live } : live;
  });

  // Carry over rows that exist on disk and not in memory. The list used to be
  // exactly as long as the in-memory one, so an account added by another
  // process since the last reload — `teamclaude login` or `import` while the
  // server runs — was silently dropped by the next save (#205). The refresh
  // handler already re-reads disk for this reason; the save had no equivalent.
  //
  // A claimed row is one the merge above already folded into an entry, so this
  // loop and the claim have to agree on what counts as already represented. The
  // id alone does not agree: two processes mint different ids for the same
  // pre-id row, so every row would look absent and the whole list would double.
  //
  // Except the ones the operator removed: removal is itself a save, so without
  // that check this would resurrect the account being deleted, on the very
  // write that was meant to delete it.
  const claimed = new Set(rowFor.values());
  const keptIds = new Set(merged.map(a => a?.id).filter(Boolean));
  for (const [d, diskAcct] of diskAccounts.entries()) {
    if (claimed.has(d)) continue;
    if (!diskAcct?.id) continue;                 // nothing for removedIds to match; adopting it could undo a removal
    if (keptIds.has(diskAcct.id)) continue;
    if (removedIds.has(diskAcct.id)) continue;
    merged.push(diskAcct);
  }
  return merged;
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
