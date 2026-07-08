// Runs one AccountManager per provider and routes between them. Each pool
// (Claude, OpenAI/Codex, …) rotates independently; the request path resolves the
// right pool by upstream host via managerFor(), while lifecycle/UI code sees a
// flattened view across every pool.
//
// With a single provider configured — today's default — the router wraps exactly
// one manager and is behaviorally a pass-through, which is what keeps the
// provider seam a no-op until a second provider's accounts are actually added.

import { AccountManager } from './account-manager.js';
import { providerById, providerForHost, DEFAULT_PROVIDER_ID } from './providers/index.js';

export class AccountRouter {
  // `accounts` is the flat config list; each account's optional `provider` field
  // (default 'anthropic') decides which pool it joins. `opts` mirrors the
  // AccountManager options and is passed through to every manager; a provider
  // that supplies its own token-refresh gets it injected here.
  constructor(accounts, switchThreshold = 0.98, opts = {}) {
    // Partition by provider id, preserving first-seen order so the default
    // provider (usually the only one) stays at index 0.
    const groups = new Map();
    for (const acct of accounts || []) {
      const id = acct.provider || DEFAULT_PROVIDER_ID;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(acct);
    }
    if (groups.size === 0) groups.set(DEFAULT_PROVIDER_ID, []);

    this.entries = [];
    for (const [id, group] of groups) {
      const provider = providerById(id);
      // A provider may override token refresh (OpenAI vs Anthropic); fall back to
      // whatever the caller passed (or the AccountManager default).
      const managerOpts = { ...opts };
      if (provider.refresh && managerOpts.refreshFn === undefined) managerOpts.refreshFn = provider.refresh;
      this.entries.push({ provider, manager: new AccountManager(group, switchThreshold, managerOpts) });
    }
    this.defaultManager = this.entries[0].manager;
  }

  get managers() {
    return this.entries.map((e) => e.manager);
  }

  /** The account pool for a given upstream host, falling back to the default. */
  managerFor(host) {
    const provider = providerForHost(host);
    if (provider) {
      const e = this.entries.find((x) => x.provider.id === provider.id);
      if (e) return e.manager;
    }
    return this.defaultManager;
  }

  /** The manager owning a given account object (by reference), or the default. */
  managerOf(account) {
    for (const e of this.entries) {
      if (e.manager.accounts.includes(account)) return e.manager;
    }
    return this.defaultManager;
  }

  /** Flattened view across every pool (status/UI/persistence iteration). */
  get accounts() {
    return this.entries.flatMap((e) => e.manager.accounts);
  }

  // ── aggregate lifecycle (fanned across all pools) ─────────────────────────

  selectActiveAccount() {
    for (const m of this.managers) m.selectActiveAccount();
  }

  refreshExpiredQuotas() {
    for (const m of this.managers) m.refreshExpiredQuotas();
  }

  onTokenRefresh(cb) {
    for (const m of this.managers) m.onTokenRefresh(cb);
  }

  /** Merge each pool's persisted quota into one flat array. */
  exportQuotaState() {
    return this.managers.flatMap((m) => m.exportQuotaState());
  }

  /** Restore into every pool; each manager only adopts its own accounts (by identity). */
  restoreQuotaState(saved) {
    for (const m of this.managers) m.restoreQuotaState(saved);
  }

  /**
   * Add an account to the pool for its provider (creating that pool if it's the
   * first account of a new provider). Returns the account's index within its pool.
   */
  addAccount(acctData) {
    const id = acctData.provider || DEFAULT_PROVIDER_ID;
    let entry = this.entries.find((e) => e.provider.id === id);
    if (!entry) {
      const provider = providerById(id);
      entry = { provider, manager: new AccountManager([], this.defaultManager.switchThreshold, {}) };
      this.entries.push(entry);
    }
    return entry.manager.addAccount(acctData);
  }

  /**
   * Aggregate status across pools. With one pool this is exactly that manager's
   * status; with several, the account lists concatenate and top-level fields come
   * from the default pool (a richer multi-pool shape is a later-phase concern).
   */
  getStatus() {
    if (this.entries.length === 1) return this.defaultManager.getStatus();
    const base = this.defaultManager.getStatus();
    return { ...base, accounts: this.managers.flatMap((m) => m.getStatus().accounts) };
  }

  // ── config / global state ─────────────────────────────────────────────────
  // Routes, pins, and switchThreshold are global config; with a single pool they
  // belong to it. These delegate to the default pool. (Per-pool routing tables
  // are a later-phase concern once a second provider is live.)
  get switchThreshold() { return this.defaultManager.switchThreshold; }
  get currentIndex() { return this.defaultManager.currentIndex; }
  getRoutes() { return this.defaultManager.getRoutes(); }
  setRoutes(routes) { this.defaultManager.setRoutes(routes); }
  setRoutePin(name, idx) { return this.defaultManager.setRoutePin(name, idx); }
  clearRoutePin(name) { return this.defaultManager.clearRoutePin(name); }
  getRoutePin(name) { return this.defaultManager.getRoutePin(name); }

  // ── per-account operations addressed by pool-local index ──────────────────
  // NOTE: these take an index into a single pool. Correct as-is while there's one
  // pool; the prober/warmer/TUI call sites that iterate the flattened `accounts`
  // must resolve the owning manager (via managerOf) once a second pool exists.
  setDisabled(index, disabled) { return this.defaultManager.setDisabled(index, disabled); }
  removeAccount(index) { return this.defaultManager.removeAccount(index); }
  updateAccountTokens(index, tokens) { return this.defaultManager.updateAccountTokens(index, tokens); }
  ensureTokenFresh(index, force) { return this.defaultManager.ensureTokenFresh(index, force); }
  applyUsageData(index, usage) { return this.defaultManager.applyUsageData(index, usage); }
}
