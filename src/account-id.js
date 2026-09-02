// The identifier a config account entry carries, and the reason it has to exist.
//
// The config list and the AccountManager's are not positionally aligned:
// resolveAccounts drops every entry without a usable credential, so from the
// first drop onward a config index and a manager index name different accounts
// for the life of the process. Nothing on the records recovers the pairing
// either. Two entries can agree on name, account, organization and credential,
// and the credential — the one field that might separate two records of one
// person — is rewritten by the token refresh that makes the pairing matter.
//
// So an entry carries an identifier of its own, assigned before anything can
// read one, never rewritten afterwards, and copied onto the account built from
// the entry by makeAccount.

import { randomUUID } from 'node:crypto';

/**
 * A fresh entry id.
 *
 * Minted where an entry and the account built from it are created together — the
 * TUI's add paths — because the two have to agree on an id before anything reads
 * one. An entry created anywhere else reaches memory through loadConfig or an
 * admission from disk, and both of those assign ids, so those paths mint none of
 * their own.
 */
export function mintAccountId() {
  return randomUUID();
}

/**
 * Give every entry in `accounts` an id that no other entry in the list holds,
 * mutating them in place, and return the list.
 *
 * Entry creation mints an id, so this is for entries that arrive already made:
 * a config written before the field existed, and an entry admitted from disk
 * while the server runs. Calling it as those enter an in-memory list is what
 * makes the uniqueness every lookup assumes true from the first read.
 *
 * A duplicate is re-minted rather than kept. Copying an account section by hand
 * copies its id along with it, and two entries answering to one id collapse
 * onto whichever comes first — the later one would be handed the earlier one's
 * credential, which is the crossing this field exists to prevent.
 */
export function ensureAccountIds(accounts) {
  const seen = new Set();
  for (const acct of accounts || []) {
    if (!acct) continue;
    if (typeof acct.id !== 'string' || acct.id === '' || seen.has(acct.id)) acct.id = mintAccountId();
    seen.add(acct.id);
  }
  return accounts;
}
