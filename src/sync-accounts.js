import { importCredentials } from './oauth.js';
import { sameIdentity } from './identity.js';

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  // Greedy 1:1 pairing of disk entries to in-memory accounts, account+org aware.
  // Each disk entry claims at most one unclaimed manager account, so multiple
  // same-person/different-org entries pair correctly instead of all matching the
  // first one with that accountUuid.
  const claimed = new Set();
  const claim = (diskAcct) => {
    for (let i = 0; i < accountManager.accounts.length; i++) {
      if (!claimed.has(i) && sameIdentity(accountManager.accounts[i], diskAcct)) {
        claimed.add(i);
        return i;
      }
    }
    return -1;
  };

  // The memConfig list needs the same greedy 1:1 pairing, for the same reason
  // and then some: it is not index-aligned with the manager (resolveAccounts
  // drops credential-less entries at startup, shifting every later index), and
  // its entries never receive the org backfill below, so a first-match scan
  // pairs an unorged entry with whichever same-uuid disk entry comes first.
  const cfgClaimed = new Set();
  const claimConfig = (diskAcct) => {
    for (let i = 0; i < memConfig.accounts.length; i++) {
      if (!cfgClaimed.has(i) && sameIdentity(memConfig.accounts[i], diskAcct)) {
        cfgClaimed.add(i);
        return memConfig.accounts[i];
      }
    }
    return null;
  };

  for (const diskAcct of diskConfig.accounts) {
    const mgrIdx = claim(diskAcct);

    if (mgrIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      cfgClaimed.add(memConfig.accounts.length - 1);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];

    // Backfill org identity and pick up renames/priority onto the running
    // account (e.g. after disk-side org disambiguation or a `priority` change).
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    if (diskAcct.priority != null && mgr.priority !== diskAcct.priority) mgr.priority = diskAcct.priority;
    // Third-party-backend bindings are read per request off this object
    // (`account.upstream || upstream`, `account.modelMap` in server.js), so a
    // disk edit must land here to take effect on reload. `|| null` mirrors the
    // constructor's normalization, letting a removal on disk revert the account
    // to the fleet default instead of sticking on the old value.
    mgr.upstream = diskAcct.upstream || null;
    mgr.modelMap = diskAcct.modelMap || null;
    // Mirror onto the memConfig entry: the TUI save stencil rebuilds
    // diskConfig.accounts from config.accounts as `{ ...diskAcct, ...live }`,
    // so a stale key there would win the spread and silently overwrite this
    // disk edit on the next save — and the following reload would then revert
    // the running account too. Delete-on-absence keeps the saved JSON clean,
    // the same shape a hand edit produces.
    const cfgAcct = claimConfig(diskAcct);
    if (cfgAcct) {
      if (diskAcct.upstream) cfgAcct.upstream = diskAcct.upstream; else delete cfgAcct.upstream;
      if (diskAcct.modelMap) cfgAcct.modelMap = diskAcct.modelMap; else delete cfgAcct.modelMap;
    }
    // Pick up enable/disable toggles; re-enabling clears a stuck error state.
    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}
