// Hot-reload account state without importing the executable CLI entry point.
//
// Pure with respect to process lifecycle: no command dispatch, no server bind, no
// globals. Credential import is injected by the CLI caller; tests can omit it.
// The function mutates the deliberately supplied memConfig + AccountManager,
// which is its contract — both must move together or a later TUI save restores
// stale startup policy over a successful disk reload.
//
// Deletions in the reloaded file MUST win. Replacing account records (rather
// than spread-merging disk onto mem) is load-bearing: a spread keeps mem keys
// absent from disk, and the next TUI save writes them back — resurrecting
// modelMap/blockedModels the operator just removed.

import { sameIdentity } from './identity.js';
import { invalidateNormalizedConfigView } from './model-namespace.js';

function findConfigAccount(config, account) {
  if (!Array.isArray(config?.accounts)) return -1;
  return config.accounts.findIndex(a => sameIdentity(a, account));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

/**
 * Top-level reload merge for routes / routingPolicy / rotationGate.
 *
 * ABSENT key ⇒ preserve the running value (B22 / D4b). An explicitly present
 * key is operator intent and applies — including a mode change. Partial
 * objects merge per-field so omitting preserveSessionAffinity/reevaluateMs
 * cannot silently reset dynamic-mode knobs to code defaults.
 */
export function applyTopLevelReload(diskConfig, memConfig, accountManager) {
  if (!diskConfig || !memConfig || !accountManager) return;

  if (hasOwn(diskConfig, 'routes')) {
    memConfig.routes = Array.isArray(diskConfig.routes) ? diskConfig.routes : [];
    accountManager.setRoutes(memConfig.routes);
  }

  if (hasOwn(diskConfig, 'routingPolicy')) {
    const disk = (diskConfig.routingPolicy && typeof diskConfig.routingPolicy === 'object')
      ? diskConfig.routingPolicy : {};
    const cur = memConfig.routingPolicy || accountManager.routingPolicy || {};
    const merged = { ...cur };
    for (const k of ['mode', 'preserveSessionAffinity', 'reevaluateMs']) {
      if (hasOwn(disk, k)) merged[k] = disk[k];
    }
    memConfig.routingPolicy = merged;
    accountManager.setRoutingPolicy(merged);
  }

  // Same D4b contract as routingPolicy: absent ⇒ preserve running; present
  // (including explicit false) is operator intent. Without this, equal-priority
  // OAuth fleets stay sticky-to-currentIndex until a full process restart.
  if (hasOwn(diskConfig, 'distributeSessions')) {
    const val = !!diskConfig.distributeSessions;
    memConfig.distributeSessions = val;
    accountManager.distributeSessions = val;
  }

  if (hasOwn(diskConfig, 'performanceLadder')) {
    memConfig.performanceLadder = Array.isArray(diskConfig.performanceLadder)
      ? diskConfig.performanceLadder.filter(id => typeof id === 'string' && id)
      : [];
  }

  if (hasOwn(diskConfig, 'rotationGate')) {
    const disk = (diskConfig.rotationGate && typeof diskConfig.rotationGate === 'object')
      ? diskConfig.rotationGate : {};
    const cur = memConfig.rotationGate || accountManager.rotationGate || {};
    const merged = { ...cur };
    if (hasOwn(disk, 'mode')) merged.mode = disk.mode;
    memConfig.rotationGate = merged;
    accountManager.setRotationGate(merged);
  }
}

/** Disk is the authority for the account's config shape. Preserve mem-only
 * credential material only when disk omitted it (e.g. importFrom-only entries
 * whose tokens were resolved at startup and never written back). */
function accountRecordFromDisk(memAcct, diskAcct) {
  const merged = { ...diskAcct };
  if (!diskAcct.accessToken && memAcct?.accessToken) {
    merged.accessToken = memAcct.accessToken;
    if (memAcct.refreshToken != null) merged.refreshToken = memAcct.refreshToken;
    if (memAcct.expiresAt != null) merged.expiresAt = memAcct.expiresAt;
  }
  if (!diskAcct.apiKey && memAcct?.apiKey) merged.apiKey = memAcct.apiKey;
  return merged;
}

export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager, {
  importCredentials = null,
  log = console.log,
  warn = console.error,
} = {}) {
  let added = 0;
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

  // Top-level operator policy the request path reads from the shared config:
  // honor deletion the same way account fields do.
  if (Object.prototype.hasOwnProperty.call(diskConfig || {}, 'blockedModels')) {
    memConfig.blockedModels = Array.isArray(diskConfig.blockedModels)
      ? [...diskConfig.blockedModels] : [];
  } else {
    delete memConfig.blockedModels;
  }

  for (const diskAcct of (Array.isArray(diskConfig?.accounts) ? diskConfig.accounts : [])) {
    const mgrIdx = claim(diskAcct);
    if (mgrIdx < 0) {
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      added++;
      log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];
    // Same identity reappearing after a prior retire: revive the tombstone so
    // the process-lifetime index stays the provenance key for this account.
    if (mgr.retired) accountManager.reviveAccount(mgrIdx);
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    const policyChanged = accountManager.updateAccountPolicy(mgr.index, diskAcct);
    const memIdx = findConfigAccount(memConfig, mgr);
    if (memIdx >= 0) {
      memConfig.accounts[memIdx] = accountRecordFromDisk(memConfig.accounts[memIdx], diskAcct);
    }
    if (policyChanged.length) log(`[TeamClaude] Reloaded policy for "${mgr.name}": ${policyChanged.join(', ')}`);

    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom && importCredentials) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        warn(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }
    if (!freshCred) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken || mgr.refreshToken !== freshCred.refreshToken;
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt && freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else     if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }

  // D4c: disk deletions must retire the live account. The `claimed` set already
  // names survivors; unclaimed slots become tombstones (index-stable) rather
  // than splices that would reassign account_index to a different identity.
  for (let i = 0; i < accountManager.accounts.length; i++) {
    if (claimed.has(i)) continue;
    const mgr = accountManager.accounts[i];
    if (!mgr || mgr.retired) continue;
    accountManager.retireAccount(i);
    const memIdx = findConfigAccount(memConfig, mgr);
    if (memIdx >= 0) memConfig.accounts.splice(memIdx, 1);
    log(`[TeamClaude] Retired account "${mgr.name}" (removed from config)`);
  }

  // Hot-swap boundary: accounts/blockedModels on memConfig just changed; drop
  // the ingress collision gate's normalized-view cache so the next request
  // re-reads the new identity (fingerprint miss would also suffice).
  invalidateNormalizedConfigView();
  return added;
}
