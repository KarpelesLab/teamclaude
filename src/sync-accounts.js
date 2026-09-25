import { importCredentials } from './oauth.js';
import { sameIdentity } from './identity.js';
import { safeLine } from './safe-text.js';
import { removedAccountIds } from './account-pairing.js';
import { ensureAccountIds } from './account-id.js';
import { accountSwitchThreshold, accountAllowsExtraUsage, accountRouting } from './account-manager.js';
import { localListener } from './upstream-proxy.js';

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 * @param {Record<string, any>} diskConfig
 * @param {Record<string, any>} memConfig
 * @param {import('./account-manager.js').AccountManager} accountManager
 */
export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  // Greedy 1:1 pairing of disk entries to in-memory accounts, account+org aware.
  // Each disk entry claims at most one unclaimed manager account, so multiple
  // same-person/different-org entries pair correctly instead of all matching the
  // first one with that accountUuid.
  const claimed = new Set();
  const claim = (/** @type {Record<string, any>} */ diskAcct) => {
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
  const claimConfig = (/** @type {Record<string, any>} */ diskAcct) => {
    for (let i = 0; i < memConfig.accounts.length; i++) {
      if (!cfgClaimed.has(i) && sameIdentity(memConfig.accounts[i], diskAcct)) {
        cfgClaimed.add(i);
        return memConfig.accounts[i];
      }
    }
    return null;
  };

  // The TUI's remove changes memory first and saves second. A reload landing
  // between the two reads the file the save has not rewritten yet, finds a row
  // with no running account, and would add it straight back — after which the
  // save writes it back too. The ids are recorded for exactly that window
  // (cleared once the save lands), so a row naming one is the removal itself,
  // not a new account (#422).
  const removed = removedAccountIds(memConfig);
  for (const diskAcct of diskConfig.accounts) {
    if (diskAcct?.id && removed.has(diskAcct.id)) continue;
    const mgrIdx = claim(diskAcct);
    // Claimed once per disk entry and reused below. Calling claimConfig twice
    // for one entry would consume two different config rows.
    const cfgAcct = claimConfig(diskAcct);

    if (mgrIdx < 0) {
      // No manager account — which is NOT the same as "not yet known".
      // resolveAccounts drops every entry without a usable credential (an oauth
      // entry with no token, or an importFrom whose file has gone away — what
      // logging out of Claude Code produces), so such an entry has no account
      // for the life of the process. Pushing a config row for it on every pass
      // grew the list without bound: the save carried the duplicate to disk, the
      // next reload found another unclaimable row, and the pair compounded
      // (#200, #235).
      //
      // The account is still added, so an entry whose credential reappears heals
      // on the next reload rather than needing a restart. Only the duplicate
      // config row is suppressed.
      if (!cfgAcct) {
        // Genuinely new. Both lists take the same object, so the account is
        // built carrying its entry's id and the two pair from the moment they
        // exist. ensureAccountIds runs between the two: a hand-copied section
        // arrives holding an id this list already uses, and re-minting it before
        // the account is built keeps the pair correct.
        memConfig.accounts.push(diskAcct);
        ensureAccountIds(memConfig.accounts);
        cfgClaimed.add(memConfig.accounts.length - 1);
      }
      accountManager.addAccount(diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      added++;
      console.log(cfgAcct
        ? `[TeamClaude] Re-admitting known account "${diskAcct.name}" from config`
        : `[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];

    // Backfill org identity and pick up renames/priority onto the running
    // account (e.g. after disk-side org disambiguation or a `priority` change).
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    for (const field of /** @type {const} */ (['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro'])) {
      if (diskAcct[field] != null) mgr[field] = diskAcct[field];
    }
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    if (diskAcct.priority != null && mgr.priority !== diskAcct.priority) mgr.priority = diskAcct.priority;
    // A list position edited on disk applies on reload for the same reason a
    // priority edit does, and `null` rather than `??` so deleting the field
    // puts the account back among the unplaced instead of leaving it stuck at
    // the position it last held. Display only — see makeAccount.
    mgr.displayOrder = Number.isFinite(diskAcct.displayOrder) ? diskAcct.displayOrder : null;
    // A cap edit applies live for the same reason priority does: it is an
    // operator decision about a running fleet, and waiting for a restart to
    // honour a budget defeats the budget.
    mgr.maxUsage = diskAcct.maxUsage ?? null;
    mgr.maxSpend = diskAcct.maxSpend ?? null;
    // Same for a per-account switch threshold (#409): thresholdFor() reads it
    // straight off the account, so a disk edit takes effect on the very next
    // selection without a restart, exactly like the fleet-wide setting does.
    // Through the constructor's own range check, so an edit to `98` is refused
    // and reported here as it would be at startup. The config entry below keeps
    // the operator's text as written: this only decides what the gate reads.
    mgr.switchThreshold = accountSwitchThreshold(diskAcct);
    // Same for the extra-usage opt-in, and more so: it decides whether the
    // fleet may spend money, so turning it off on disk must stop that now.
    // Through the constructor's own test, so an entry the fallback cannot bill
    // (an API key, a third-party backend, a Codex login) stays opted out on
    // reload as it was at startup; the warning was makeAccount's to give.
    mgr.allowExtraUsage = accountAllowsExtraUsage(diskAcct);
    // Same for a per-account routing proxy: it is read per request off this
    // object (server.js forwardRequest, ensureTokenFresh, the prober), so a
    // disk edit or a `teamclaude routing` change takes effect on the very next
    // request without a restart. Through the constructor's own parse, so a bad
    // URL is refused and reported here as it would be at startup, and so is
    // one that points back at this server's own listener (memConfig's port is
    // the one the server is bound to; a port edit on disk needs a restart).
    accountManager.setRouting(mgr.index, accountRouting(diskAcct, localListener(memConfig)));
    // Read at the moment a refusal asks whether to spend a reset credit, so a
    // disk edit must land here to bind — and an operator who has just exempted
    // an account is doing so precisely because they do not want the next
    // refusal to spend its credit. Negative-only (see makeAccount): only `false`
    // says anything, so removing the key returns the account to following the
    // fleet-wide `autoRedeemResets`.
    mgr.autoRedeemReset = diskAcct.autoRedeemReset !== false;
    // Third-party-backend bindings are read per request off this object
    // (`account.upstream || upstream`, `account.modelMap` in server.js), so a
    // disk edit must land here to take effect on reload. `|| null` mirrors the
    // constructor's normalization, letting a removal on disk revert the account
    // to the fleet default instead of sticking on the old value.
    // Re-arm the one-shot operator line whenever either input it reports on
    // changes — the setting, or the upstream it was reported for. An operator
    // who takes `messageThreads` back off, or who moves the account to a
    // different backend, needs to be told again that continues are refused;
    // otherwise their only signal stays silent. Read before the assignments
    // below, which are what it compares against.
    if (mgr.upstream !== (diskAcct.upstream || null)
      || mgr.messageThreads !== (diskAcct.messageThreads === true)) mgr.threadRefusalReported = false;
    mgr.upstream = diskAcct.upstream || null;
    mgr.modelMap = diskAcct.modelMap || null;
    // Read per request like the two above (server.js rewriteRequestBody), and
    // missing from this sync until #374: an edit waited for a restart.
    mgr.stripRequestFields = diskAcct.stripRequestFields || null;
    mgr.messageThreads = diskAcct.messageThreads === true;
    // Mirror onto the memConfig entry: the TUI save stencil rebuilds
    // diskConfig.accounts from config.accounts as `{ ...diskAcct, ...live }`,
    // so a stale key there would win the spread and silently overwrite this
    // disk edit on the next save — and the following reload would then revert
    // the running account too. Delete-on-absence keeps the saved JSON clean,
    // the same shape a hand edit produces.
    if (cfgAcct) {
      if (diskAcct.upstream) cfgAcct.upstream = diskAcct.upstream; else delete cfgAcct.upstream;
      if (diskAcct.modelMap) cfgAcct.modelMap = diskAcct.modelMap; else delete cfgAcct.modelMap;
      if (diskAcct.stripRequestFields) cfgAcct.stripRequestFields = diskAcct.stripRequestFields; else delete cfgAcct.stripRequestFields;
      if (diskAcct.messageThreads === true) cfgAcct.messageThreads = true; else delete cfgAcct.messageThreads;
      if (diskAcct.maxUsage != null) cfgAcct.maxUsage = diskAcct.maxUsage; else delete cfgAcct.maxUsage;
      if (diskAcct.maxSpend != null) cfgAcct.maxSpend = diskAcct.maxSpend; else delete cfgAcct.maxSpend;
      if (diskAcct.switchThreshold != null) cfgAcct.switchThreshold = diskAcct.switchThreshold; else delete cfgAcct.switchThreshold;
      if (diskAcct.routing) cfgAcct.routing = diskAcct.routing; else delete cfgAcct.routing;
      if (diskAcct.priority != null) cfgAcct.priority = diskAcct.priority; else delete cfgAcct.priority;
      // The TUI's reorder writes this key onto the entry, so after one
      // arrangement every entry carries a value for a hand edit to lose to.
      if (Number.isFinite(diskAcct.displayOrder)) cfgAcct.displayOrder = diskAcct.displayOrder; else delete cfgAcct.displayOrder;
      if (diskAcct.disabled) cfgAcct.disabled = true; else delete cfgAcct.disabled;
      if (diskAcct.allowExtraUsage === true) cfgAcct.allowExtraUsage = true; else delete cfgAcct.allowExtraUsage;
      // Both polarities are mirrored, unlike the flags above: `false` is the
      // side of this key that does something, so a stale mirror of either value
      // would win the save stencil's spread and undo the disk edit.
      if (typeof diskAcct.autoRedeemReset === 'boolean') cfgAcct.autoRedeemReset = diskAcct.autoRedeemReset;
      else delete cfgAcct.autoRedeemReset;
    }
    // Pick up enable/disable toggles; re-enabling clears a stuck error state.
    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    // Existing account — resolve fresh credentials from disk
    /** @type {{ accessToken?: string, refreshToken?: string, expiresAt?: number, apiKey?: string }|null} */
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (/** @type {any} */ err) {
        console.error(`[TeamClaude] Re-import failed for "${safeLine(diskAcct.name, 64)}": ${err.message}`);
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
        console.log(`[TeamClaude] Refreshed credentials for "${safeLine(mgr.name, 64)}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${safeLine(mgr.name, 64)}"`);
    }
  }
  return added;
}
