import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired } from './oauth.js';
import { sameIdentity } from './identity.js';
import { weeklyBucketForModel, modelGlobMatches } from './model.js';
import { SessionTracker } from './session-tracker.js';
import { invalidateNormalizedConfigView } from './model-namespace.js';
import { registerBuildFeature } from './build-identity.js';
import { RotationLedger, resolveHistoryFamily } from './rotation-ledger.js';
import { subscriptionAdmission, isSubscriptionSource } from './subscription-quota.js';
import { normalizeUsageDisplay } from './usage-display.js';

registerBuildFeature('dynamic-routing');
registerBuildFeature('dynrank-model-fidelity');

// Re-exported for callers that import these model helpers from here.
export { isFableModel, parseRequestModel, parseAdvisorModel } from './model.js';

// How long after a successful token refresh a forced (post-401) refresh is
// suppressed. Long enough to cover the 401s from requests already in flight
// when the token turned over, short enough that a genuinely bad new token
// recovers on the next request rather than staying stuck.
const FORCED_REFRESH_FLOOR_MS = 10_000;

/** D2: bounded shadow-decision evidence ring (T7 pattern). Ephemeral. */
export const SHADOW_DECISION_RING_SIZE = 512;

/** D9: defensive cap on provenance `skipped[]` (pathological route size). */
export const SELECTION_SKIPPED_CAP = 8;

/** Allowlist-by-construction — no tokens/keys (T7 privacy discipline). */
export const SHADOW_DECISION_SAFE_FIELDS = Object.freeze([
  'ts', 'model', 'legacy', 'dynamic', 'changed', 'reason',
  'legacyEvidence', 'dynamicEvidence', 'dynamicPickServeable',
]);

/** rank-replay `evidence()` field shape — account name + rank signals only. */
export const SHADOW_EVIDENCE_SAFE_FIELDS = Object.freeze([
  'account', 'routeTier', 'accountCostTier', 'priority',
  'weeklyReset', 'sessionReset', 'utilization',
  'status', 'circuitOpenUntil', 'mappedTo',
]);

const SHADOW_REASON_STAGES = Object.freeze([
  'tier', 'weekly', 'session', 'utilization', 'priority', 'equal',
]);

function emptyReasonHistogram() {
  return Object.fromEntries(SHADOW_REASON_STAGES.map(s => [s, 0]));
}

function copyShadowEvidence(e) {
  if (!e) return null;
  const out = {};
  for (const k of SHADOW_EVIDENCE_SAFE_FIELDS) out[k] = e[k] ?? null;
  return out;
}

function copyShadowDecision(rec) {
  if (!rec) return null;
  return {
    ts: rec.ts ?? null,
    model: rec.model ?? null,
    legacy: rec.legacy ?? null,
    dynamic: rec.dynamic ?? null,
    changed: !!rec.changed,
    reason: rec.reason ?? null,
    legacyEvidence: copyShadowEvidence(rec.legacyEvidence),
    dynamicEvidence: copyShadowEvidence(rec.dynamicEvidence),
    dynamicPickServeable: !!rec.dynamicPickServeable,
  };
}

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
  // Persisted so a restored reading keeps its real age across a restart. Without
  // it, restore produces values with no observation time, which then render as
  // if they were fresh — the exact confusion `observedAt` exists to remove.
  'observedAt',
];

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,            // utilization 0-1
    unified7d: null,            // utilization 0-1
    unified7dSonnet: null,      // utilization 0-1 (Sonnet-specific weekly bucket)
    unified7dFable: null,       // utilization 0-1 (Fable-specific weekly bucket)
    unified5hReset: null,       // ms timestamp
    unified7dReset: null,       // ms timestamp
    unified7dSonnetReset: null, // ms timestamp
    unified7dFableReset: null,  // ms timestamp
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

// R2: optional per-account client-side token budget. Absent/invalid ⇒ null
// (zero-config-inert). The sliding window that consumes this lives only in
// memory — intentionally excluded from exportQuotaState / restoreQuotaState.
function normalizeTokenBudget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const windowSec = Number(raw.windowSec);
  const maxTokens = Number(raw.maxTokens);
  if (!(windowSec > 0) || !(maxTokens > 0)) return null;
  return { windowSec, maxTokens };
}

// Build a fresh in-memory account record from a config/disk account object.
// Shared by the constructor and addAccount() so the field set can never drift
// between startup accounts and runtime-added ones (a divergence here once left
// runtime-added accounts without `inFlight`, hanging every request in admit()).
function makeAccount(acct, index) {
  return {
    index,
    name: acct.name,
    type: acct.type,
    accountUuid: acct.accountUuid || null,
    orgUuid: acct.orgUuid || null,
    orgName: acct.orgName || null,
    priority: acct.priority || 0,
    // Opt in when rounded usage meters reject an account that inference still
    // accepts. Actual 429 holds, auth failures and token budgets remain enforced.
    quotaAdmission: acct.quotaAdmission === 'upstream' ? 'upstream' : 'usage',
    // Hard economic boundary. Dynamic ranking NEVER crosses to a higher-cost
    // tier while a cheaper tier has an eligible account. This is deliberately
    // separate from `priority`: priority is a deterministic fallback/tiebreak,
    // not a disguised per-account tier that kills dynamic ranking whenever all
    // values differ (the production config had seven distinct priorities, so
    // its reset-time comparator was unreachable).
    costTier: Number.isFinite(acct.costTier) ? acct.costTier : 0,
    disabled: acct.disabled || false,
    // D4c: config-reload tombstone. Index stays stable for the process lifetime
    // so provenance account_index cannot be reused by a different account.
    retired: !!acct.retired,
    upstream: acct.upstream || null,
    modelMap: acct.modelMap || null,
    models: acct.models || null,
    // Custom upstreams default closed for Claude Code's beta advisor tool. A
    // provider that implements the variant can opt in explicitly; absence must
    // stay false so an unknown backend enum cannot take down the executor turn.
    supportsAdvisorTools: acct.supportsAdvisorTools === true,
    // Closed provider capability contract. Most Anthropic-compatible upstreams
    // are open/opaque — absence means "do not guess". Adapters like DeepSeek
    // expose a finite model set; for those, configure acceptsModels +
    // strictModelMap so an untranslated id is excluded BEFORE selection rather
    // than forwarded verbatim into a non-retryable 400.
    acceptsModels: Array.isArray(acct.acceptsModels) ? acct.acceptsModels.map(String) : null,
    strictModelMap: !!acct.strictModelMap,
    // T2 rotation gate: family this account EMITS into a transcript, and (opt-in)
    // families its ingress contract ACCEPTS. Absent acceptsHistoryFamilies =
    // tolerant/open (today's behavior). Defaults fail SAFE for custom upstreams
    // (account name ⇒ over-fragment/over-block, never under-block).
    historyFamily: resolveHistoryFamily(acct),
    acceptsHistoryFamilies: Array.isArray(acct.acceptsHistoryFamilies)
      ? acct.acceptsHistoryFamilies.map(String) : null,
    // External probe: teamclaude invokes probeCommand (shell) to refresh a
    // provider whose quota has no API (e.g. Sakana billing-console scrape via
    // Playwright) and reads the resulting JSON from quotaStateFile.
    // None/nil by default; drop-in: set these fields on an apikey account in
    // teamclaude.json and the prober runs the command on its probe interval.
    probeCommand: acct.probeCommand || null,
    quotaStateFile: acct.quotaStateFile || null,
    // Native quota source: the in-process replacement for probeCommand. When
    // set, teamclaude probes the provider directly (no shell, no external
    // state file, no systemd) via the built-in implementation in
    // quota-sources.js, keyed by quotaSource.type. This account's unified
    // quota is then authoritative from the native probe — response-header
    // unified values are ignored (see updateQuota). Mutually exclusive with
    // probeCommand: an account declares one quota authority.
    quotaSource: acct.quotaSource || null,
    balanceSource: acct.balanceSource || null,
    usageDisplay: normalizeUsageDisplay(acct.usageDisplay),
    // Model fidelity hint for dynrank. When unset it is DETECTED from the
    // modelMap (identity = faithful, remap = translated) or the account type
    // (oauth = native Anthropic = faithful; apikey = opaque adapter =
    // translated). Set `fidelity: 'faithful' | 'translated'` only to override
    // the detection for an account the heuristic would misclassify.
    fidelity: acct.fidelity || null,
    credential: acct.accessToken || acct.apiKey,
    refreshToken: acct.refreshToken || null,
    expiresAt: acct.expiresAt || null,
    status: 'active',
    // No quota is known at startup, so start probing: the first response for
    // an account reveals its weekly limit and triggers re-evaluation.
    probing: true,
    quota: emptyQuota(),
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    },
    // R2 client-side budget (config-shaped). tokenWindow is ephemeral — dies
    // with the process; never persisted across restarts.
    tokenBudget: normalizeTokenBudget(acct.tokenBudget),
    tokenWindow: [],
    rateLimitedUntil: null,
    throttledAt: null,
    // Storm control (see admit/release): in-flight upstream requests and the
    // time this account last became the current one (starts a ramp window).
    inFlight: 0,
    rampStartedAt: null,
    // Rate-limit pause (see pauseAccount): a short window during which new
    // requests wait in admit() rather than flooding — set from a 429's
    // retry-after. Distinct from `throttled`/rateLimitedUntil: it does NOT
    // make the account unavailable, so selection never rotates away from it.
    pausedUntil: null,
    // When this account's token was last successfully refreshed. Gates forced
    // (post-401) refreshes so a burst of stale in-flight requests can't rotate
    // the refresh-token family once per request — see ensureTokenFresh.
    _lastRefreshAt: null,
    // Passive provider health. Only custom upstream adapters participate: a
    // transport failure or 502/503/504 is account-specific and should not keep
    // winning selection while healthy siblings exist. The circuit is ephemeral
    // by design — restarting the supervised adapter/data plane is a clean probe.
    consecutiveFailures: 0,
    circuitOpenUntil: null,
    // Half-open single-flight: at most one live request may probe an expired
    // circuit. Stored as a claim timestamp so a leaked claim (request dies
    // without noteProviderResult/releaseCircuitProbe) expires after
    // CIRCUIT_PROBE_CLAIM_TTL_MS rather than hiding the account forever.
    // Availability checks compare age but never clear or refresh the stamp.
    circuitProbeInFlightAt: null,
    latencyEwmaMs: null,
    lastFailure: null,
    lastSuccessAt: null,
  };
}

// Does a declared `models` entry name `model`? The declared side may carry a
// trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); we match it
// against a bare request too. Shared by _accountOwnsModel's two lookups so the
// predicate can't drift.
function modelMatches(declared, model) {
  return declared === model || declared.replace(/\[\d+m\]$/, '') === model;
}

/** Generous bound for a half-open probe claim. A claim older than this is
 * treated as released: readers (_isAvailable) compare only; the next
 * _acquireCircuitProbe re-claims by overwriting the stale timestamp. */
const CIRCUIT_PROBE_CLAIM_TTL_MS = 120_000;

function circuitProbeClaimFresh(account) {
  return account.circuitProbeInFlightAt != null
    && (Date.now() - account.circuitProbeInFlightAt) < CIRCUIT_PROBE_CLAIM_TTL_MS;
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, {
    refreshFn = refreshAccessToken,
    throttleProbeFloorMs,
    forcedRefreshFloorMs = FORCED_REFRESH_FLOOR_MS,
    routes,
    ramp,
    distributeSessions = false,
    sessionTracker,
    routingPolicy = {},
    rotationGate = {},
    rotationLedger = null,
  } = {}) {
    // How long a just-minted token is trusted against a forced refresh.
    this._forcedRefreshFloorMs = forcedRefreshFloorMs;
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this.accounts = accounts.map((acct, index) => makeAccount(acct, index));
    this.currentIndex = 0;
    // Dynrank recovery pull-back (2026-09-19 #7 review, revised): the account
    // field is a TIMESTAMP (requalifiedAt), not a one-shot boolean. A boolean
    // consumed by the first _selectForSession call that looks at it meant a
    // second session pinned to the SAME fallback could never see the same
    // recovery event — sessionTracker now tracks a per-session watermark
    // instead (recoveryCheckedThrough / markRecoveryChecked). This manager-
    // level watermark is a pure O(1) fast path: skip the per-account scan
    // entirely when nothing has recovered since a session last checked.
    this._lastRecoveryAt = 0;
    // T2: per-session served-family ledger. Own TTL (24h), NOT SessionTracker's
    // 1h — poison outlives prompt cache. Default mode enforce is inert until
    // some account declares acceptsHistoryFamilies.
    const gateMode = ['enforce', 'shadow', 'off'].includes(rotationGate?.mode)
      ? rotationGate.mode : 'enforce';
    this.rotationGate = { mode: gateMode };
    this.rotationLedger = rotationLedger || new RotationLedger();
    // Session awareness (issue #109). The tracker is always on (passive — it just
    // observes the x-claude-code-session-id header for the status readout).
    // `distributeSessions` gates the behavioural change: keep each session on its
    // account for cache reuse, but spread NEW sessions across equal-priority
    // accounts by load instead of funnelling them all onto the current one.
    this.sessionTracker = sessionTracker || new SessionTracker();
    this.distributeSessions = !!distributeSessions;
    // Selection policy:
    //   priority-first (default) — v1.1.9 behavior, fully backward compatible.
    //   shadow                   — serve with legacy order, compute/log dynamic
    //                              disagreements for a no-impact rollout.
    //   dynamic                  — costTier first, then use-or-lose quota order;
    //                              priority is only a final deterministic tie.
    const mode = ['priority-first', 'shadow', 'dynamic'].includes(routingPolicy?.mode)
      ? routingPolicy.mode : 'priority-first';
    this.routingPolicy = {
      mode,
      // Existing sessions stay pinned for cache locality unless their account is
      // unavailable. Dynamic re-ranking is for new/unpinned sessions and
      // failover, not a per-request cache-destroying shuffle.
      preserveSessionAffinity: routingPolicy?.preserveSessionAffinity !== false,
      // Headless/no-session callers have no cache identity to pin. Re-evaluate at
      // a bounded cadence so reset rollovers are observed without changing the
      // account on every request. Shadow uses the same cadence for meaningful A/B
      // samples while still serving legacy decisions.
      reevaluateMs: Number.isFinite(routingPolicy?.reevaluateMs)
        ? Math.max(0, routingPolicy.reevaluateMs) : 5 * 60 * 1000,
    };
    // No-session callers still need model/route-local stickiness. One global
    // currentIndex lets a Fable request reset the Opus reevaluation clock and
    // makes unrelated families fight over one cache home. Session-tagged Claude
    // traffic uses SessionTracker; these maps are the equivalent for headless,
    // MCP and manual HTTP clients, keyed by the winning route (or family/id).
    this._dynamicCurrentByKey = new Map();
    this._dynamicEvalAtByKey = new Map();
    this._shadowDecisions = { total: 0, changed: 0, last: null };
    // D2: process-lifetime evidence ring (not persisted — like T7).
    this._shadowRing = new Array(SHADOW_DECISION_RING_SIZE);
    this._shadowRingPushed = 0;
    this._shadowReasonHistogram = emptyReasonHistogram();
    // Count of advisor strip-and-degrade events (blocked / pin-unservable /
    // unmapped). Visible on GET /teamclaude/status so the degrade is never silent.
    this._advisorDegrades = 0;
    // Ephemeral per-route manual pins (routeName → account index). Not persisted:
    // like the global manual switch (currentIndex) these are runtime overrides that
    // bias selection for a route's models and reset on restart. A pinned account
    // that becomes ineligible is skipped — routing falls back to best-available.
    this.routePins = new Map();
    this.switchThreshold = switchThreshold;
    // D7/B55: sticky "deployment declared routes". Once true, an empty table
    // (e.g. index.js `diskConfig.routes || []` wiping on a partial reload) must
    // FAIL CLOSED rather than reopen every account via _accountOwnsModel.
    // Legacy no-routes configs leave this false forever → ownership unchanged.
    this._routesConfigured = false;
    this.setRoutes(routes);
    // Storm control: when rotation switches to a fresh account, a burst of
    // in-flight requests (e.g. dozens of agents failing over together) would all
    // hit it at once and instantly throttle it — cascading down the fleet
    // (issue #84). admit() caps concurrent requests to a just-switched account
    // and ramps the cap up over a short window, so the first few reveal whether
    // it's also near-exhausted before the whole herd commits.
    this.ramp = {
      enabled: true,
      startConc: 1,       // concurrent requests allowed at the instant of a switch
      stepConc: 1,        // cap increase per stepMs
      stepMs: 250,        // → +stepConc every 250ms (default ramps ~4 req/s)
      windowMs: 30_000,   // after this, pacing stops entirely (cap = Infinity)
      pollMs: 50,         // how often a waiting request re-checks the cap
      ...ramp,
    };
    // When every account reads as over-quota we would otherwise refuse locally
    // forever (a stale cached utilization is never re-validated because no
    // request is ever sent). Instead, allow one real upstream probe at most this
    // often to refresh the cached quota. See _selectProbe.
    this.probeIntervalMs = 60_000;
    this._nextProbeAt = 0;
    // Minimum time a 429 hold is respected verbatim before a throttled account
    // becomes probe-eligible (see _isProbeable). Long enough to honor a genuine
    // retry-after, short enough that a stale hold cannot pin the fleet.
    this.throttleProbeFloorMs = throttleProbeFloorMs
      ?? (Number(process.env.TEAMCLAUDE_THROTTLE_PROBE_FLOOR_MS) || 60_000);
  }

  /** Start (or restart) the ramp window for an account that just became current,
   * so a failover burst is paced onto it rather than all landing at once. */
  _beginRamp(account) {
    if (account && this.ramp.enabled) account.rampStartedAt = Date.now();
  }

  /** Max concurrent upstream requests allowed to `account` right now. Infinity
   * once the ramp window has elapsed (or ramping is off / never started). */
  _rampCap(account, now = Date.now()) {
    if (!this.ramp.enabled || account.rampStartedAt == null) return Infinity;
    // Clamp to 0: pauseAccount arms rampStartedAt in the FUTURE (pause-end), so a
    // call during the pause would otherwise yield a negative elapsed → negative
    // cap. admit()'s pause branch already guards this, but keep _rampCap sound on
    // its own — a future start simply means "cap is at its floor (startConc)".
    const elapsed = Math.max(0, now - account.rampStartedAt);
    if (elapsed >= this.ramp.windowMs) { account.rampStartedAt = null; return Infinity; }
    return this.ramp.startConc + Math.floor(elapsed / this.ramp.stepMs) * this.ramp.stepConc;
  }

  /**
   * Reserve a concurrency slot on `account` before sending upstream. Waits while
   * the account is in a rate-limit pause (a 429's retry-after window) and while
   * it is over its current ramp cap. Fail-open: returns true once a slot is taken
   * (always eventually — the pause ends and the ramp cap grows), or false if
   * `isAborted()` reports the client went away while waiting. Pair every `true`
   * with a `release(index)`.
   */
  async admit(index, isAborted) {
    const account = this.accounts[index];
    if (!account) return true;
    while (true) {
      if (isAborted?.()) return false;
      const now = Date.now();
      // Rate-limit pause: hold new requests off this account until the window
      // passes instead of flooding it (which would deepen the 429). Not a
      // rotation trigger — the account stays selectable the whole time.
      if (account.pausedUntil && now < account.pausedUntil) {
        await new Promise(r => setTimeout(r, Math.min(account.pausedUntil - now, this.ramp.pollMs * 4)));
        continue;
      }
      const cap = this.ramp.enabled ? this._rampCap(account, now) : Infinity;
      if (account.inFlight < cap) { account.inFlight++; return true; }
      await new Promise(r => setTimeout(r, this.ramp.pollMs));
    }
  }

  /** Release a slot taken by admit(). Safe to call once per successful admit. */
  release(index) {
    const account = this.accounts[index];
    if (account && account.inFlight > 0) account.inFlight--;
  }

  /**
   * Pause an account after a rate-limit (non-quota) 429 so concurrent requests
   * wait in admit() instead of piling on. Unlike markRateLimited this does NOT
   * set `throttled`/rateLimitedUntil, so _isAvailable still returns true and
   * selection never rotates away — rotation is reserved for quota exhaustion.
   * When the pause lifts, the held requests are released through a fresh ramp
   * window (storm control) so they trickle out rather than flood. Extends an
   * existing pause rather than shortening it.
   */
  pauseAccount(index, seconds) {
    const account = this.accounts[index];
    if (!account) return;
    const until = Date.now() + Math.max(0, seconds) * 1000;
    account.pausedUntil = Math.max(account.pausedUntil || 0, until);
    // Arm the ramp to begin when the pause ends: while paused, admit() holds on
    // the pause branch; once it lifts, _rampCap counts from here and releases the
    // backlog gradually (startConc, then +stepConc per step).
    if (this.ramp.enabled) account.rampStartedAt = account.pausedUntil;
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   *
   * `advisorModel` is the second model an advisor request carries (Claude Code's
   * advisor tool, nested in tools[] — see parseAdvisorModel): the advisor
   * sub-inference runs on the SAME account and spends that model's family
   * bucket, so the account must be eligible for both models. When no account
   * satisfies both, selection degrades to executor-only routing so the main
   * request keeps flowing (upstream then fails just the advisor call).
   *
   * `_shadowObserved` is internal: when a half-open probe claim is held we
   * recurse with the account excluded; the flag keeps shadow evidence at
   * exactly one observation per external call.
   */
  getActiveAccount(exclude = null, model = null, advisorModel = null, sessionId = null, _shadowObserved = false, _gateObserved = false) {
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas();

    // T2 rotation gate — SINGLE CHOKE POINT. Union gate-blocked indices into a
    // COPY of exclude (ctx.tried is passed by reference from server.js; mutating
    // it would corrupt retry bookkeeping and probe-claim recursion). Pins
    // (/tc-acct) never reach here. mode=off / no declarations ⇒ empty set
    // (zero-config-inert routing).
    const gateBlocked = (sessionId && this.rotationGate.mode !== 'off')
      ? this.rotationLedger.incompatibleIndices(sessionId, this.accounts, this.rotationGate.mode)
      : new Set();
    const effectiveExclude = exclude instanceof Set ? new Set(exclude) : new Set();
    if (gateBlocked.size && this.rotationGate.mode === 'enforce') {
      for (const idx of gateBlocked) {
        if (!effectiveExclude.has(idx)) {
          effectiveExclude.add(idx);
          const a = this.accounts[idx];
          this.rotationLedger.noteBlockedSelection(
            this.rotationLedger.familiesOf(sessionId), a?.name);
        }
      }
    } else if (gateBlocked.size && this.rotationGate.mode === 'shadow' && !_gateObserved) {
      // Observe would-block once per external call (probe recursion must not
      // multiply counters).
      _gateObserved = true;
      for (const idx of gateBlocked) {
        const a = this.accounts[idx];
        this.rotationLedger.noteBlockedSelection(
          this.rotationLedger.familiesOf(sessionId), a?.name);
        if (Date.now() >= (this._rotationGateShadowLogAt || 0)) {
          this._rotationGateShadowLogAt = Date.now() + 60_000;
          console.log(`[TeamClaude] Rotation gate (shadow): session ${(sessionId || '').slice(0, 8)} `
            + `(families: ${this.rotationLedger.familiesOf(sessionId).join(',') || '-'}) `
            + `would block "${a?.name}"`);
        }
      }
    }

    // Dynamic routing needs a cache identity, not merely the old optional
    // load-distribution flag. A known session remains on its home account; a NEW
    // session is ranked dynamically. `distributeSessions` still adds active-load
    // balancing to the final tie, but dynamic mode can use the existing tracker
    // without requiring that separate feature to be enabled.
    const sessionAware = !!sessionId && (this.distributeSessions
      || (this.routingPolicy.mode === 'dynamic' && this.routingPolicy.preserveSessionAffinity));
    let account = null;
    if (sessionAware && !this._pinnedAccountForModel(model, advisorModel)) {
      account = this._selectForSession(sessionId, effectiveExclude, model, advisorModel);
    }
    if (!account && advisorModel) {
      account = this._select(effectiveExclude, model, advisorModel, false);
      if (!account) {
        // Throttled so a busy advisor session doesn't flood the activity log.
        if (Date.now() >= (this._advisorDegradeLogAt || 0)) {
          this._advisorDegradeLogAt = Date.now() + 60_000;
          console.log(`[TeamClaude] No account eligible for advisor model "${advisorModel}" — routing by request model only`);
        }
      }
    }
    if (!account) account = this._select(effectiveExclude, model, null, true);
    if (!account) return null;
    // Shadow evidence is per REQUEST decision (not reevaluate ticks), and must
    // cover the session path Claude Code actually uses. Observe once per
    // external call — probe-held recursion must not double-count.
    if (this.routingPolicy.mode === 'shadow' && !_shadowObserved) {
      this._observeShadowDecision(effectiveExclude, model, advisorModel);
      _shadowObserved = true;
    }
    // Request-path state transition: claim the half-open probe slot (if any)
    // before any await. Status/TUI reads never reach here.
    if (this._acquireCircuitProbe(account)) return account;
    const nextExclude = new Set(effectiveExclude);
    nextExclude.add(account.index);
    return this.getActiveAccount(nextExclude, model, advisorModel, sessionId, _shadowObserved, _gateObserved);
  }

  /**
   * Mark a family into the session ledger after a SUCCESSFUL /v1/messages
   * response (status<300). Never call on count_tokens or failed attempts — a
   * failed failover must not self-mark and then block the retry.
   */
  noteServedFamily(sessionId, accountIndex) {
    if (!sessionId) return;
    const account = this.accounts[accountIndex];
    if (!account) return;
    const family = account.historyFamily || resolveHistoryFamily(account);
    const isStrictTier = Array.isArray(account.acceptsHistoryFamilies);
    this.rotationLedger.mark(sessionId, family, { isStrictTier });
  }

  /** Operator hand-back after fleet-side transcript repair. Loud + counted. */
  resetSessionHistory(sessionId) {
    return this.rotationLedger.clear(sessionId);
  }

  /**
   * Typed-409 predicate for the null-account branch: the only otherwise-
   * _isAvailable accounts for this model are gate-blocked. Recomputed
   * model-scoped against _isAvailable (not the stale exclude set).
   */
  rotationGateRefusal(sessionId, model = null, advisorModel = null, tried = null) {
    return this.rotationLedger.gateBlocksAllAvailable(sessionId, this.accounts, {
      mode: this.rotationGate.mode,
      tried,
      isAvailable: (a) => this._isAvailable(a, model, advisorModel),
    });
  }

  setRotationGate(gate = {}) {
    const mode = ['enforce', 'shadow', 'off'].includes(gate?.mode) ? gate.mode : 'enforce';
    this.rotationGate = { mode };
    return this.rotationGate;
  }

  exportSessionFamilies() {
    return this.rotationLedger.export();
  }

  restoreSessionFamilies(saved) {
    const declared = this.accounts.flatMap(a => {
      const names = [a.historyFamily].filter(Boolean);
      if (Array.isArray(a.acceptsHistoryFamilies)) names.push(...a.acceptsHistoryFamilies);
      return names;
    });
    this.rotationLedger.restore(saved, declared);
  }

  /** Record a strip-and-degrade for an advisor id (blocked / pin-unservable /
   * unmapped). Increments the visible counter and shares the unpinned degrade's
   * once-a-minute log throttle so a busy session does not flood the activity log. */
  noteAdvisorDegrade(reason, advisorModel, detail = null) {
    this._advisorDegrades += 1;
    if (Date.now() < (this._advisorDegradeLogAt || 0)) return;
    this._advisorDegradeLogAt = Date.now() + 60_000;
    if (reason === 'blocked') {
      console.log(`[TeamClaude] Advisor model "${advisorModel}" blocked by "${detail}" — stripped; routing by request model only`);
    } else if (reason === 'pin-unservable') {
      console.log(`[TeamClaude] Pinned account "${detail}" cannot serve advisor model "${advisorModel}" — stripped; routing by request model only`);
    } else if (reason === 'unmapped') {
      console.log(`[TeamClaude] Advisor model "${advisorModel}" has no modelMap entry on "${detail}" — stripped; never egressing verbatim`);
    } else {
      console.log(`[TeamClaude] Advisor model "${advisorModel}" stripped (${reason}${detail ? `: ${detail}` : ''})`);
    }
  }

  /** Stable key for no-session dynamic stickiness. Exact model ids are used on
   * purpose: two ids matching one route can have different provider maps or
   * model-scoped quota buckets, so route-name stickiness would cross-contaminate
   * their decisions. Advisor model participates because the selected account
   * must be jointly eligible for both. */
  _dynamicKey(model, advisorModel = null) {
    return `${model || '<default>'}|advisor:${advisorModel || '-'}`;
  }

  _rememberDynamic(key, account) {
    if (!key || !account) return;
    this._dynamicCurrentByKey.set(key, account.index);
    // currentIndex remains the last-served global marker for TUI/backward status;
    // it is no longer the routing authority for dynamic no-session traffic.
    this.currentIndex = account.index;
  }

  /** The selection walk getActiveAccount runs: manual pin → current account →
   * best-available. `allowProbe` gates the exhausted-fleet probe fallback so the
   * advisor-constrained pass can fail soft (degrade to executor-only) instead of
   * burning the throttled probe slot on the stricter constraint. */
  _select(exclude, model, advisorModel, allowProbe) {
    // A manual per-route pin biases selection for that route's models (independent
    // of the global currentIndex). Honored only while eligible — otherwise we fall
    // through to normal best-available selection so requests keep flowing.
    const pinned = this._pinnedAccountForModel(model, advisorModel);
    if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinned.index)) return pinned;
    const key = this._dynamicKey(model, advisorModel);
    const dynamicIdx = this.routingPolicy.mode === 'dynamic' ? this._dynamicCurrentByKey.get(key) : null;
    const current = this.accounts[dynamicIdx ?? this.currentIndex];
    // `model` scopes availability: an account whose Fable weekly bucket is spent
    // is still fully usable for other models, so it is only excluded when THIS
    // request targets Fable (see _isAvailable).
    // `exclude` is a per-request set of indices already tried this request (e.g.
    // an account that just threw a transport error). It is never a persistent
    // status change — the account stays healthy for the next request.
    // We just learned a probed account's weekly quota — re-evaluate which
    // account is best now that its limit is known.
    if (current && current.requalify) {
      // Consume the flag on the final pass; the advisor-constrained pass leaves
      // it set unless it actually switches, so the requalification isn't lost
      // when that pass comes up empty and selection degrades.
      if (allowProbe) current.requalify = false;
      const next = this._selectNext(exclude, model, advisorModel);
      if (next) {
        if (this.routingPolicy.mode === 'dynamic') this._rememberDynamic(key, next);
        current.requalify = false;
        return next;
      }
    }
    // No session id means no prompt-cache identity exists to preserve. Revisit
    // the dynamic rank at a bounded cadence so weekly/session reset rollovers are
    // observed without thrashing on every request. Shadow computes the same
    // decision and records disagreements but continues serving the legacy path.
    const now = Date.now();
    const lastEval = this._dynamicEvalAtByKey.get(key) || 0;
    if (this.routingPolicy.mode !== 'priority-first'
        && (this.routingPolicy.reevaluateMs === 0
          || now - lastEval >= this.routingPolicy.reevaluateMs)) {
      this._dynamicEvalAtByKey.set(key, now);
      const candidate = this._pickBestAvailable(exclude, model, advisorModel);
      if (this.routingPolicy.mode === 'dynamic' && candidate) {
        const switched = candidate.index !== current?.index;
        this._rememberDynamic(key, candidate);
        if (switched) {
          this._beginRamp(candidate);
          console.log(`[TeamClaude] Dynamic re-rank: switched to "${candidate.name}" for model "${model || '<default>'}"`);
        }
        return candidate;
      }
    }
    if (this._isAvailable(current, model, advisorModel) && !exclude?.has(current.index)) {
      // Legacy/shadow preserve the existing static-priority preemption. Dynamic
      // mode deliberately does NOT run this between re-evaluation points: doing
      // so switches to the expiration-first winner, then the very next request
      // bounces straight back to the lower numeric priority — a two-policy
      // oscillation that destroys cache locality and makes dynamic mode a lie.
      if (this.routingPolicy.mode !== 'dynamic') {
        const betterExists = this.accounts.some(a =>
          this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (current.priority || 0));
        if (betterExists) return this._selectNext(exclude, model, advisorModel);
      }
      return current;
    }
    const next = this._selectNext(exclude, model, advisorModel);
    if (next) {
      if (this.routingPolicy.mode === 'dynamic') this._rememberDynamic(key, next);
      return next;
    }
    // No account is under the switch threshold. Before refusing locally, allow a
    // throttled probe so a stale/poisoned cached quota can't pin us in a
    // permanent "all exhausted" state — the probe's real response refreshes the
    // quota (or upstream's own 429 converts soft exhaustion into a hard
    // rate-limit hold). null here means the caller emits the synthetic 429.
    return allowProbe ? this._selectProbe(exclude, model) : null;
  }

  /** Session-affinity selection (opt-in, issue #109). Honor a known session's
   * pin when that account is still eligible and not preempted by a
   * higher-priority one; otherwise route the session to the least-loaded
   * eligible account. Returns null if nothing is eligible, so the caller falls
   * back to the normal quota-driven walk. Does NOT record the pin — that happens
   * on the actual route (recordSession), so retries/failover re-pin naturally. */
  _selectForSession(sessionId, exclude, model, advisorModel) {
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId);
    if (pinIdx != null) {
      const pinned = this.accounts[pinIdx];
      if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinIdx)) {
        // Dynamic mode preserves a healthy session home WITHIN its cost tier
        // (prompt-cache locality) when preserveSessionAffinity is on. A false
        // flag must disable the pin on every path — including when
        // distributeSessions already entered this method. A strictly cheaper
        // eligible tier may reclaim the session — the hard economic boundary
        // must be able to pull back DOWN, not only escalate UP. Same-tier rank
        // changes must not thrash a live cache. Shadow stays request-path
        // NEUTRAL with distributeSessions and uses priority preemption like
        // priority-first.
        if (this.routingPolicy.mode === 'dynamic') {
          if (this.routingPolicy.preserveSessionAffinity) {
            const pinnedTier = this._costTierFor(pinned, model);
            const cheaperEligible = this.accounts.some(a =>
              this._isAvailable(a, model, advisorModel)
              && !exclude?.has(a.index)
              && this._costTierFor(a, model) < pinnedTier);
            // Recovery pull-back (2026-09-19, Eddie-approved; revised after #7
            // review). `_lastRecoveryAt` / `account.requalifiedAt` are TIMESTAMPS
            // an account gets whenever it transitions back to eligible (see
            // _markRequalified — error clear, ordinary disabled->enabled,
            // rate-limit clear, AUTOMATIC rate-limit expiry, OAuth token
            // refresh). Without this, a session that failed over while its home
            // account was down stays on the fallback FOREVER — costTier
            // comparison alone cannot catch this when tiers are unconfigured
            // (every account defaults costTier=0, so `cheaperEligible` above is
            // permanently false).
            //
            // Per-SESSION watermark, not a one-shot flag consumed globally: two
            // sessions pinned to the same fallback must each get an independent
            // look at the SAME recovery event. sessionTracker owns
            // `lastRecoveryCheckAt` per session; this manager only stamps
            // `requalifiedAt` on accounts and reads it (coderabbitai + macroscope,
            // PR #7 — a shared boolean meant the first session to check cleared
            // it, starving every other session sharing that fallback).
            //
            // Fast path: skip the per-account scan entirely when nothing has
            // recovered since this session last checked (`_lastRecoveryAt` is
            // the newest `requalifiedAt` across all accounts).
            let recovered = null;
            if (this._lastRecoveryAt > 0
                && !this.sessionTracker.recoveryCheckedThrough(sessionId, this._lastRecoveryAt)) {
              // Ranking uses dynamicCompare — the same comparator dynamic mode
              // uses everywhere else — not the strict tier `<` above, so a
              // recovery that is merely tied on tier (the common case: costTier
              // unconfigured, or same tier by design) can still win on the
              // comparator's later keys (fidelity, weekly/session reset,
              // utilization, priority). A recovery ranked WORSE than the current
              // pin is correctly left alone — this is "pull back the true home
              // account", not "prefer anything that just changed state".
              for (const a of this.accounts) {
                if (!a.requalifiedAt || a.index === pinned.index) continue;
                if (!this._isAvailable(a, model, advisorModel) || exclude?.has(a.index)) continue;
                if (this.dynamicCompare(a, pinned, model) < 0
                    && (!recovered || this.dynamicCompare(a, recovered, model) < 0)) {
                  recovered = a;
                }
              }
              // This session has now evaluated every recovery up to the current
              // high-water mark, regardless of outcome — it will not re-scan on
              // every subsequent request (the polling/thrash
              // preserveSessionAffinity exists to prevent), but a DIFFERENT
              // session sharing this fallback still has its own watermark and
              // will evaluate the same recovery independently.
              this.sessionTracker.markRecoveryChecked(sessionId, this._lastRecoveryAt);
            }
            if (recovered) {
              this._rememberDynamic(this._dynamicKey(model, advisorModel), recovered);
              this._beginRamp(recovered);
              console.log(`[TeamClaude] Session pin recovery: "${recovered.name}" is back and ranks ahead of "${pinned.name}" — pulling the session back`);
              return recovered;
            }
            if (!cheaperEligible) return pinned;
          }
        } else {
          const betterExists = this.accounts.some(a =>
            this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0));
          if (!betterExists) return pinned;
        }
      }
    }
    return this._pickLeastLoaded(exclude, model, advisorModel);
  }

  /** Best-available for a new session. The selected policy owns the primary
   * order; active sessions and in-flight work resolve a full policy tie, then
   * config order makes the result deterministic. In legacy mode this preserves
   * priority → load → weekly-reset behavior. */
  _pickLeastLoaded(exclude = null, model = null, advisorModel = null) {
    const now = Date.now();
    const eligible = this.accounts.filter(a =>
      !exclude?.has(a.index) && this._isAvailable(a, model, advisorModel));
    const compareLoad = (a, b) => {
      const sessions = this.sessionTracker.activeCountFor(a.index, now)
        - this.sessionTracker.activeCountFor(b.index, now);
      if (sessions) return sessions;
      const inFlight = (a.inFlight || 0) - (b.inFlight || 0);
      if (inFlight) return inFlight;
      return a.index - b.index;
    };
    // Shadow serves the exact priority-first order (neutrality). Dynamic uses
    // expiration-first. Shadow evidence is recorded once per request in
    // getActiveAccount — not here — so session + no-session paths share one counter.
    if (this.routingPolicy.mode === 'priority-first' || this.routingPolicy.mode === 'shadow') {
      return [...eligible].sort((a, b) => {
        const pa = a.priority || 0;
        const pb = b.priority || 0;
        if (pa !== pb) return pa - pb;
        const load = compareLoad(a, b);
        if (load) return load;
        return (this._governingWeeklyReset(a, model) || -Infinity)
          - (this._governingWeeklyReset(b, model) || -Infinity);
      })[0] || null;
    }
    return [...eligible].sort((a, b) => {
      const c = this.dynamicCompare(a, b, model, now);
      return c || compareLoad(a, b);
    })[0] || null;
  }

  /** Record that a session's request was served by an account (always on, even
   * when distribution is off — the readout is passive). This is what pins a
   * session for future affinity. */
  recordSession(sessionId, accountIndex) {
    if (sessionId) this.sessionTracker.touch(sessionId, accountIndex);
  }

  /** Mark a session request as in flight / finished. Paired around the whole
   * client request (including retries) so a long streaming completion keeps the
   * session counted as active for its full duration.
   * `semantic` (T5): only /v1/messages POSTs stamp lastSemanticSeen / clear
   * client_hint — event_logging traffic also hits beginSession and must not. */
  beginSession(sessionId, { semantic = false, pathClass, model, account } = {}) {
    if (sessionId) this.sessionTracker.beginRequest(sessionId);
    if (sessionId && semantic) {
      this.sessionTracker.noteSemanticBegin(sessionId, { pathClass, model, account });
    }
  }

  endSession(sessionId, { semantic = false } = {}) {
    if (sessionId && semantic) this.sessionTracker.noteSemanticEnd(sessionId);
    if (sessionId) this.sessionTracker.endRequest(sessionId);
  }

  /** { known, active, perAccount } session counts for status/TUI. */
  sessionStats() {
    return this.sessionTracker.stats();
  }

  /**
   * Pure read for GET /teamclaude/sessions. Joins routing pins with the T5
   * evidence Map — does not sweep, claim probes, or mutate breaker/quota.
   */
  getSessions(config = {}, now = Date.now()) {
    const accountNames = this.accounts.map(a => a.name);
    const sessions = this.sessionTracker.snapshot(now, {
      contextWindows: config?.contextWindows || null,
      accountNames,
    });
    return { sessions, accountNames };
  }

  /**
   * Like getActiveAccount, but if the selected account's OAuth token has ALREADY
   * expired it blocks on a refresh before returning — so a caller that injects
   * the token immediately (the MITM relay) never sends a dead token and eats a
   * 401. A token that is merely expiring soon (still valid) is left to the
   * caller's opportunistic background refresh; only a hard-expired one blocks.
   */
  async getActiveAccountFresh(exclude = null, model = null, advisorModel = null, sessionId = null) {
    const account = this.getActiveAccount(exclude, model, advisorModel, sessionId);
    if (account && account.type === 'oauth' && account.refreshToken
        && isTokenExpired(account.expiresAt)) {
      await this.ensureTokenFresh(account.index); // coalesces with any in-flight refresh
    }
    return account;
  }

  /**
   * Read-only: the index of the account a request for `model` would be served by
   * right now — the same decision getActiveAccount makes (manual pin → the global
   * current account if it can serve the model → best-available), but WITHOUT
   * mutating currentIndex and without the exhausted-fleet probe fallback. Returns
   * null when nothing can serve `model` at the moment. The TUI uses this to mark
   * the single account each secondary bucket (Fable/Sonnet) currently routes to —
   * the F7/S7 analogue of the ► that marks the default route's current account.
   */
  previewRouteIndex(model) {
    const pinned = this._pinnedAccountForModel(model);
    if (pinned && this._isAvailable(pinned, model)) return pinned.index;
    const current = this.accounts[this.currentIndex];
    if (current && this._isAvailable(current, model)) {
      // Mirror getActiveAccount's priority preemption: a strictly higher-priority
      // available account wins over a healthy current one; same tier stays put.
      const better = this.accounts.some(a =>
        this._isAvailable(a, model) && (a.priority || 0) < (current.priority || 0));
      if (!better) return current.index;
    }
    const best = this._pickBestAvailable(null, model);
    return best ? best.index : null;
  }

  _isProbeable(account) {
    if (!account) return false;
    // Canonical subscriptions refresh through the quota reader, never inference.
    if (isSubscriptionSource(account.quotaSource)) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A 429 hold is respected verbatim at first, but a hold is a snapshot: the
    // 429 that armed it may itself have been transient (e.g. the retry burst
    // after a network flap), and while it lasts NOTHING revalidates it — so a
    // stale hold pins the fleet in synthetic 429s for up to an hour and only a
    // restart (which wipes the in-memory hold) recovers. After the floor, let
    // the account be probed: the probe's real response either clears the hold
    // (any non-429 → clearRateLimited) or re-arms it with a fresh retry-after.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return Date.now() >= (account.throttledAt || 0) + this.throttleProbeFloorMs;
    }
    return true;
  }

  /** Highest utilization across the quota dimensions that govern `model` (0-1),
   * used to pick the least-exhausted probe target. Mirrors _isNearQuota: the
   * shared 5-hour bucket plus the model's governing weekly bucket. With no model
   * it falls back to the shared weekly. */
  _maxUtilization(account, model = null) {
    const q = account.quota;
    let max = 0;
    if (q.unified5h != null) max = Math.max(max, q.unified5h);
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null) max = Math.max(max, weeklyVal);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      max = Math.max(max, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      max = Math.max(max, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return max;
  }

  /** Utilization (0-1) of the weekly bucket that governs `model` on this account:
   * unified7dFable for Fable, unified7dSonnet for Sonnet, unified7d otherwise.
   * Falls back to the shared unified7d when a family-specific bucket isn't
   * reported. Returns null when nothing is known. */
  _governingWeekly(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (q[key] != null) return q[key];
    return key !== 'unified7d' ? q.unified7d : null;
  }

  /** Reset timestamp (ms) of the weekly bucket that governs `model`, falling back
   * to the shared weekly reset. Used to spend the soonest-expiring quota first. */
  _governingWeeklyReset(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    return q[`${key}Reset`] || q.unified7dReset || null;
  }

  /** True when the family-specific weekly bucket that governs `model` is spent.
   * Unlike _isNearQuota this ignores the shared 5h/weekly caps — it is only used
   * to skip an account for a probe of a model it definitely can't serve. Returns
   * false for families without a dedicated bucket (they share unified7d, already
   * covered by _isNearQuota). */
  _modelWeeklyExhausted(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (key === 'unified7d') return false;
    return q[key] != null && q[key] >= this.switchThreshold;
  }

  /**
   * Pick an account to send a single revalidation probe upstream when every
   * account reads as over the switch threshold. Throttled to one probe per
   * probeIntervalMs so a genuinely-exhausted fleet isn't hammered — between
   * probes this returns null and the caller falls back to the synthetic 429.
   * The chosen account is the least-utilized probeable one (most likely to have
   * stale headroom), so the refreshed quota corrects the cache fastest.
   */
  _selectProbe(exclude = null, model = null) {
    const now = Date.now();
    if (now < this._nextProbeAt) return null;

    let best = null;
    let bestTier = Infinity;
    let bestPriority = Infinity;
    let bestUsage = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A family-exhausted account can't serve that family even as a probe — it
      // would just 429 again — so skip it (Fable/Sonnet) and let the caller emit
      // the synthetic 429 when no other account is available.
      if (model && this._modelWeeklyExhausted(account, model)) continue;
      // Same for routing/ownership: a probe for a routed or owned model must not
      // land on an ineligible account (it would just reject the unknown model id).
      if (model && !this._routeAllows(account, model)) continue;
      if (model && !this._acceptsModel(account, model)) continue;
      // The probe is a last-resort attempt after normal availability failed, but
      // cost/quality tiers still govern which uncertainty we pay to resolve.
      const tier = this._costTierFor(account, model);
      const priority = account.priority || 0;
      const usage = this._maxUtilization(account, model);
      if (tier < bestTier
          || (tier === bestTier && priority < bestPriority)
          || (tier === bestTier && priority === bestPriority && usage < bestUsage)) {
        bestTier = tier;
        bestPriority = priority;
        bestUsage = usage;
        best = account;
      }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this.currentIndex = best.index;
    this._beginRamp(best);
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null, advisorModel = null) {
    if (!account) return false;

    // Config-reload tombstone: removed from disk, kept only for index stability.
    if (account.retired) return false;

    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return false;

    // Rate-limit hold: PURE — an expired hold is treated as available without
    // clearing. refreshExpiredQuotas (request path) clears the stamp; status /
    // serveable / TUI reads must not mutate.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return false;
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    // Custom-adapter circuit breaker. A real Anthropic OAuth account has no
    // local adapter boundary, so transport errors there keep the established
    // client-retry semantics rather than being mistaken for account health.
    // PURE with respect to breaker state: an expired circuit is half-open
    // eligible, but this filter never clears circuitOpenUntil or claims the
    // probe slot — GET /teamclaude/status and TUI renders must not close circuits.
    if (account.upstream && account.circuitOpenUntil && Date.now() < account.circuitOpenUntil) {
      return false;
    }
    // Fresh claim blocks; a stale claim is treated as released (read-only —
    // do not clear the stamp here; status/TUI must stay side-effect-free).
    if (account.upstream && circuitProbeClaimFresh(account)) return false;
    // Model-scoped: _isNearQuota checks the shared 5h bucket plus only the weekly
    // bucket that governs this model, so a spent Fable/Sonnet bucket bars just
    // that family — the account still serves every other model normally.
    if (this._isNearQuota(account, model)) return false;
    // R2: optional client-side sliding token budget (accounts with no quota API).
    if (this._isTokenBudgetTripped(account)) return false;

    // Route/ownership restriction: a configured route can pin a model pattern to
    // an exclusive set of accounts; failing that, a per-account `models` claim
    // restricts an owned model to its owners. Either way an account not eligible
    // for this model is skipped so the request never lands somewhere it can't run.
    if (model && !this._routeAllows(account, model)) return false;
    // Provider capability is a SECOND, independent gate. Routes answer "may this
    // account be considered?"; this answers "can its adapter actually translate
    // this exact wire id?" Today these can disagree: a fugu route legitimately
    // listed DeepSeek, but DeepSeek accepts only two model names and received
    // `claude-fugu-ultra` verbatim, returning a non-retryable 400 that stopped the
    // entire fallback chain. Closed adapters opt into strictModelMap; open/opaque
    // adapters remain permissive because teamclaude cannot see their native map.
    if (model && !this._acceptsModel(account, model)) return false;

    // An advisor request additionally needs the account to serve the ADVISOR's
    // model: its family bucket must have headroom (the shared buckets were
    // already checked above for the executor) and any route/ownership rule for
    // it must allow this account.
    if (advisorModel) {
      if (this._modelWeeklyExhausted(account, advisorModel)) return false;
      if (!this._routeAllows(account, advisorModel)) return false;
      if (!this._acceptsModel(account, advisorModel)) return false;
    }

    return true;
  }

  /**
   * D9: compact selection-time skip evidence for provenance. Pure read — does
   * not change ranking or eligibility. Only for routed models; pin bypasses
   * selection so skipped is absent. Entries are route candidates that rank
   * ahead of `selected` and fail `_isAvailable`, with the existing
   * `_unavailableReason` string (no parallel taxonomy). Capped at
   * SELECTION_SKIPPED_CAP; overflow counted in `skipped_more`.
   *
   * @returns {{ skipped: {a:string,r:string}[]|undefined, skipped_more: number|undefined }}
   */
  selectionSkippedAhead(selected, model, advisorModel = null, { pinned = false } = {}) {
    if (pinned || !selected || !model) {
      return { skipped: undefined, skipped_more: undefined };
    }
    const route = this._routeForModel(model);
    if (!route) return { skipped: undefined, skipped_more: undefined };

    const inRoute = (a) => !route.accounts.length
      || route.accounts.includes(a.name)
      || route.accounts.includes(String(a.index));
    const candidates = this.accounts.filter(inRoute);
    if (!candidates.some(a => a.index === selected.index)) {
      return { skipped: undefined, skipped_more: undefined };
    }

    const dynamic = this.routingPolicy.mode === 'dynamic';
    candidates.sort((a, b) => {
      const c = dynamic
        ? this.dynamicCompare(a, b, model)
        : this._legacyCompare(a, b, model);
      return c !== 0 ? c : a.index - b.index;
    });

    const ahead = [];
    for (const a of candidates) {
      if (a.index === selected.index) break;
      // Available-but-unchosen (stickiness) is NOT a skip — only ineligibility.
      const reason = this._unavailableReason(a, model, advisorModel);
      if (reason) ahead.push({ a: a.name, r: reason });
    }
    if (!ahead.length) return { skipped: undefined, skipped_more: undefined };
    if (ahead.length <= SELECTION_SKIPPED_CAP) {
      return { skipped: ahead, skipped_more: undefined };
    }
    return {
      skipped: ahead.slice(0, SELECTION_SKIPPED_CAP),
      skipped_more: ahead.length - SELECTION_SKIPPED_CAP,
    };
  }

  /**
   * Compact machine reason why `account` is not serveable for `model`.
   * Closed enum derived from the same state `_isAvailable` reads — no new
   * bookkeeping. Returns null when the account is serveable.
   *   quota-exhausted | token-budget | circuit-open | probe-held | disabled |
   *   token-expired | route-excluded | not-accepted
   */
  _unavailableReason(account, model = null, advisorModel = null) {
    if (!account) return 'disabled';
    if (account.retired) return 'disabled';
    if (account.disabled) return 'disabled';
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return 'quota-exhausted';
    }
    if (account.status === 'exhausted') return 'quota-exhausted';
    if (account.status === 'error') return 'token-expired';
    if (account.upstream && account.circuitOpenUntil && Date.now() < account.circuitOpenUntil) {
      return 'circuit-open';
    }
    if (account.upstream && circuitProbeClaimFresh(account)) return 'probe-held';
    const subscription = subscriptionAdmission(account, model);
    if (!subscription.allowed) return subscription.reason;
    if (this._isNearQuota(account, model)) return 'quota-exhausted';
    if (this._isTokenBudgetTripped(account)) return 'token-budget';
    if (model && !this._routeAllows(account, model)) return 'route-excluded';
    if (model && !this._acceptsModel(account, model)) return 'not-accepted';
    if (advisorModel) {
      if (this._modelWeeklyExhausted(account, advisorModel)) return 'quota-exhausted';
      if (!this._routeAllows(account, advisorModel)) return 'route-excluded';
      if (!this._acceptsModel(account, advisorModel)) return 'not-accepted';
    }
    return null;
  }

  /**
   * Soonest governing reset (ms) among the account's quota / throttle windows
   * that apply to `model` (null = shared/general buckets only). null when none
   * are known or all have already passed.
   */
  _soonestResetMs(account, model = null) {
    if (!account) return null;
    const now = Date.now();
    const candidates = [];
    if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
      candidates.push(account.rateLimitedUntil);
    }
    const q = account.quota;
    if (q.unified5hReset && q.unified5hReset > now) candidates.push(q.unified5hReset);
    const weeklyReset = this._governingWeeklyReset(account, model);
    if (weeklyReset && weeklyReset > now) candidates.push(weeklyReset);
    // When model is null (general status), also consider family-specific resets
    // so the soonest fleet-visible window surfaces even without a model id.
    if (!model) {
      for (const key of ['unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset']) {
        if (q[key] && q[key] > now) candidates.push(q[key]);
      }
    }
    if (q.resetsAt) {
      const t = typeof q.resetsAt === 'number' ? q.resetsAt : new Date(q.resetsAt).getTime();
      if (Number.isFinite(t) && t > now) candidates.push(t);
    }
    const budgetReset = this._tokenBudgetResetMs(account);
    if (budgetReset != null && budgetReset > now) candidates.push(budgetReset);
    if (!candidates.length) return null;
    return Math.min(...candidates);
  }

  /**
   * ISO reset time for status/serveable, or null when unknown / not throttled.
   * "Not throttled" means the account is not currently constrained by a
   * rate-limit hold, exhausted status, near-quota utilization, or R2 token budget.
   */
  _quotaResetAt(account, model = null) {
    if (!account) return null;
    const held = account.status === 'throttled' && account.rateLimitedUntil
      && Date.now() < account.rateLimitedUntil;
    const constrained = held || account.status === 'exhausted'
      || this._isNearQuota(account, model)
      || this._isTokenBudgetTripped(account);
    if (!constrained) return null;
    const ms = this._soonestResetMs(account, model);
    return ms != null ? new Date(ms).toISOString() : null;
  }

  /**
   * Model-scoped fleet availability for GET /teamclaude/serveable.
   * Evaluates the executor id only (no request body → no advisor id). Callers
   * that care about an advisor model must pass that id as `model` (or rely on
   * ingress, which quantifies over the full id set). Read-only: reuses the
   * pure `_isAvailable` path; never claims a probe slot or clears quota.
   *
   * B19 evidence: each account may gain `routeTier` resolved via `_costTierFor`
   * (same semantics the `rank` CLI prints). Untiered routes omit the field;
   * Infinity (account absent from every tier of a tiered route) serializes as
   * `routeTier: null` + `routeTierNote: "untiered-on-tiered-route"` — JSON has
   * no Infinity.
   */
  getServeable(model = null) {
    const accounts = this.accounts.map(a => {
      const serveableNow = this._isAvailable(a, model);
      const row = {
        name: a.name,
        serveableNow,
        quotaResetAt: this._quotaResetAt(a, model),
      };
      if (!serveableNow) {
        const reason = this._unavailableReason(a, model);
        if (reason) row.reason = reason;
      }
      Object.assign(row, this._routeTierEvidence(a, model));
      return row;
    });
    let soonestMs = Infinity;
    for (const a of this.accounts) {
      const ms = this._soonestResetMs(a, model);
      if (ms != null && ms < soonestMs) soonestMs = ms;
    }
    return {
      model,
      serveable: accounts.some(a => a.serveableNow),
      accounts,
      soonestResetAt: soonestMs === Infinity ? null : new Date(soonestMs).toISOString(),
    };
  }

  /**
   * JSON-safe route-tier evidence for HTTP surfaces. Calls `_costTierFor` —
   * never re-implements tier resolution — so serveable/rank cannot disagree.
   * Returns `{}` (caller omits) on untiered/no route; otherwise `{routeTier}`
   * or `{routeTier:null, routeTierNote}` when the account is absent from every
   * tier of a tiered route.
   */
  _routeTierEvidence(account, model) {
    const route = this._routeForModel(model);
    if (!route?.tiers?.length) return {};
    const tier = this._costTierFor(account, model);
    if (Number.isFinite(tier)) return { routeTier: tier };
    return { routeTier: null, routeTierNote: 'untiered-on-tiered-route' };
  }

  /** Claim the half-open probe slot for a live request. Pure availability may
   * report an expired circuit as eligible; exactly one request may proceed to
   * exercise it. Returns false when another probe holds a fresh claim (or the
   * circuit is still open). A claim older than CIRCUIT_PROBE_CLAIM_TTL_MS is
   * treated as released and re-claimed by overwrite. No-op (returns true) when
   * there is no circuit. */
  _acquireCircuitProbe(account) {
    if (!account?.upstream) return true;
    if (account.circuitOpenUntil && Date.now() < account.circuitOpenUntil) return false;
    if (circuitProbeClaimFresh(account)) return false;
    if (account.circuitOpenUntil && Date.now() >= account.circuitOpenUntil) {
      account.circuitProbeInFlightAt = Date.now();
    }
    return true;
  }

  /** Drop a half-open probe claim without recording a provider result — used when
   * the request abandons the account before an upstream attempt (admit abort,
   * pre-flight failover). noteProviderResult also clears the stamp. */
  releaseCircuitProbe(accountIndex) {
    const a = this.accounts[accountIndex];
    if (a) a.circuitProbeInFlightAt = null;
  }

  /** Whether a closed adapter can turn `model` into a model its upstream knows.
   *
   * Open/opaque adapters have no acceptsModels list and remain permissive. For a
   * closed adapter, modelMap wins; a passthrough id is valid only if it is in the
   * declared accepted set. strictModelMap tightens the contract further: every
   * non-native id must be translated. This is intentionally in eligibility, not
   * rewriteModel(), because discovering incompatibility after account selection
   * produces a 400 response — and teamclaude's correct policy is to never fail
   * over on an arbitrary 400. Prevention is the only honest retry strategy. */
  _acceptsModel(account, model) {
    if (!account || !model) return true;
    const accepted = account.acceptsModels;
    if (!accepted?.length && !account.strictModelMap) return true;
    const mapped = account.modelMap && Object.prototype.hasOwnProperty.call(account.modelMap, model)
      ? account.modelMap[model] : null;
    if (mapped != null) return !accepted?.length || accepted.includes(String(mapped));
    if (account.strictModelMap) return false;
    return !accepted?.length || accepted.includes(String(model));
  }

  /**
   * Normalize and store the configurable routing table. A route pins a set of
   * model globs to an exclusive set of accounts (and may override the governing
   * quota bucket). Called from the constructor and on config reload.
   *   { name, match: string|string[], accounts?: (name|index)[], bucket? }
   */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : []).map((r, i) => {
      const tiers = (Array.isArray(r.tiers) ? r.tiers : []).map((t, j) => ({
        name: t?.name || `tier-${j}`,
        accounts: Array.isArray(t?.accounts) ? t.accounts.map(String) : [],
      })).filter(t => t.accounts.length);
      // A tiered route's eligible set is the union of all tiers. `accounts` is
      // retained for backward compatibility and for untiered routes; when tiers
      // exist they are the authoritative eligibility + fallback structure.
      const tierAccounts = [...new Set(tiers.flatMap(t => t.accounts))];
      return {
        name: r.name || `route-${i + 1}`,
        match: (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g),
        accounts: tiers.length ? tierAccounts : (Array.isArray(r.accounts) ? r.accounts.map(String) : []),
        tiers,
        bucket: r.bucket || null,
        color: r.color || null,
      };
    }).filter(r => r.match.length);
    // Sticky: a non-empty normalized table arms fail-closed for the process life.
    // Clearing via setRoutes([]) (reload wipe) must NOT disarm — that is B55.
    if (this.routes.length > 0) this._routesConfigured = true;
    // Drop pins for routes that no longer exist after a reload.
    if (this.routePins?.size) {
      const names = new Set(this.routes.map(r => r.name));
      for (const name of [...this.routePins.keys()]) {
        if (name !== 'fable' && name !== 'sonnet' && !names.has(name)) this.routePins.delete(name);
      }
    }
    // TUI / reload route edits land here; drop the ingress collision cache so a
    // renamed route account list is visible on the next request.
    invalidateNormalizedConfigView();
  }

  /** The first configured route whose globs match `model`, or null. */
  _routeForModel(model) {
    if (!model || !this.routes?.length) return null;
    return this.routes.find(r => r.match.some(g => modelGlobMatches(g, model))) || null;
  }

  /** The weekly quota bucket that governs `model` — a matching route's `bucket`
   * override wins, otherwise the model family's default bucket. */
  _weeklyBucketFor(model) {
    const route = this._routeForModel(model);
    return route?.bucket || weeklyBucketForModel(model);
  }

  /** Whether `account` may serve `model`. A matching route with an `accounts`
   * list is exclusive (only listed accounts, by name or index). With no matching
   * route — or a route that lists no accounts — it falls back to the per-account
   * `models` ownership claim (deprecated — use `routes` instead).
   *
   * D7/B55: `_accountOwnsModel` is reachable ONLY when the deployment never
   * declared routes. With routes configured, the dangerous entrances that make
   * `_routeForModel` return null without a real "no glob matched" decision
   * (null/unparseable model, empty-after-load table) FAIL CLOSED here — guard
   * the fallback, not each caller. Unmatched model ids with a live non-empty
   * table still use ownership (that is not an entrance to the B47/B55 hole). */
  _routeAllows(account, model) {
    // Empty-table entrance: sticky flag set, table wiped → never ownership.
    if (this._routesConfigured && !this.routes?.length) return false;
    // Null-model entrance: with routes configured, exclusivity is not advisory.
    // Call sites that still gate on `if (model && …)` skip this for status reads;
    // the inference-path refuse lives in server.js (path-aware half).
    if (!model) {
      if (this._routesConfigured) return false;
      return this._accountOwnsModel(account, model);
    }
    const route = this._routeForModel(model);
    if (route && route.accounts.length) {
      return route.accounts.includes(account.name) || route.accounts.includes(String(account.index));
    }
    return this._accountOwnsModel(account, model);
  }

  /** @deprecated Use `routes` with an `accounts` list instead.
   *  Returns true if no account claims model ownership, or this account does. */
  _accountOwnsModel(account, model) {
    for (const a of this.accounts) {
      if (a.models && a.models.some(m => modelMatches(m, model))) {
        // Some other account owns this model — this account must own it too.
        return !!(account.models && account.models.some(m => modelMatches(m, model)));
      }
    }
    return true; // no one claims ownership → any account is fine
  }

  /**
   * The routing table for display: every configured route plus an ephemeral,
   * auto-created route for each model family that some account meters with its
   * own weekly bucket but no configured route already covers. Auto-created routes
   * carry `autocreated: true` and are never persisted — they simply surface the
   * per-model quota the server already respects. Each route lists the accounts it
   * can use with a live eligibility flag.
   *
   * B19 evidence: when a route has configured `tiers`, the entry includes
   * `tiers: [{accounts:[...]}, ...]` (account lists only — the fallback
   * structure auditors need). The `tiers` field is ABSENT for untiered routes
   * (not null, not []) — absence means untiered.
   */
  getRoutes() {
    const out = this.routes.map(r => {
      const entry = {
        name: r.name, match: r.match, bucket: r.bucket, color: r.color || null, autocreated: false,
        pinned: this._pinnedName(r.name),
        accounts: this._routeAccountsView(r),
      };
      // Absence = untiered. Do not emit null or [].
      if (r.tiers?.length) {
        entry.tiers = r.tiers.map(t => ({ accounts: [...t.accounts] }));
      }
      return entry;
    });

    const detected = [];
    if (this.accounts.some(a => a.quota.unified7dFable != null)) {
      detected.push({ name: 'fable', match: ['*fable*'], sample: 'claude-fable-5' });
    }
    if (this.accounts.some(a => a.quota.unified7dSonnet != null)) {
      detected.push({ name: 'sonnet', match: ['*sonnet*'], sample: 'claude-sonnet-4-6' });
    }
    for (const d of detected) {
      if (this._routeForModel(d.sample)) continue; // already covered by a configured route
      out.push({
        name: d.name, match: d.match, bucket: null, color: null, autocreated: true,
        pinned: this._pinnedName(d.name),
        accounts: this.accounts.map(a => ({ name: a.name, eligible: this._isAvailable(a, d.sample) })),
      });
    }
    return out;
  }

  /** The name of the account this route is manually pinned to, or null. */
  _pinnedName(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** Accounts a configured route can use (all accounts when it lists none), each
   * with a live eligibility flag for a representative model of the route. */
  _routeAccountsView(route) {
    const sample = route.match[0].replace(/\*/g, '') || 'model';
    const inRoute = a => !route.accounts.length
      || route.accounts.includes(a.name) || route.accounts.includes(String(a.index));
    return this.accounts.filter(inRoute).map(a => ({ name: a.name, eligible: this._isAvailable(a, sample) }));
  }

  /** A representative model id for a route name (configured or auto fable/sonnet),
   * used to test route-allowance when pinning. Null for an unknown route. */
  _routeSample(routeName) {
    const r = this.routes.find(x => x.name === routeName);
    if (r) return r.match[0]?.replace(/\*/g, '') || 'model';
    if (routeName === 'fable') return 'claude-fable-5';
    if (routeName === 'sonnet') return 'claude-sonnet-4-6';
    return null;
  }

  /**
   * Manually pin a route to an account (ephemeral runtime override). Rejects an
   * account the route's exclusivity/ownership rules disallow. Pinning an account
   * that is merely near-quota/throttled is allowed — it acts as a preference and
   * routing falls back to best-available until the pinned account is eligible.
   * Returns { ok, reason? }.
   */
  setRoutePin(routeName, accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { ok: false, reason: 'no such account' };
    const sample = this._routeSample(routeName);
    if (sample && !this._routeAllows(account, sample)) {
      return { ok: false, reason: `route "${routeName}" does not allow "${account.name}"` };
    }
    this.routePins.set(routeName, accountIndex);
    return { ok: true };
  }

  clearRoutePin(routeName) { this.routePins.delete(routeName); }

  /** The account a route is pinned to, or null. */
  getRoutePin(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx] || null);
  }

  /** The manually-pinned account governing `model`, if any: a configured route's
   * pin wins, else an auto fable/sonnet family pin (only when no configured route
   * covers the model). For an advisor request the executor's pin wins (it is the
   * bulk of the spend); the advisor model's pin applies only when nothing pins
   * the executor. Returns null when nothing is pinned for this model. */
  _pinnedAccountForModel(model, advisorModel = null) {
    return this._pinnedFor(model)
      || (advisorModel ? this._pinnedFor(advisorModel) : null);
  }

  _pinnedFor(model) {
    if (!model || !this.routePins.size) return null;
    const route = this._routeForModel(model);
    if (route) {
      const idx = this.routePins.get(route.name);
      return idx == null ? null : (this.accounts[idx] || null);
    }
    for (const name of ['fable', 'sonnet']) {
      if (this.routePins.has(name) && modelGlobMatches(`*${name}*`, model)) {
        return this.accounts[this.routePins.get(name)] || null;
      }
    }
    return null;
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    let changed = false;
    let session = false;

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      changed = true;
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      q.unified7dSonnet = null;
      q.unified7dSonnetReset = null;
      changed = true;
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      q.unified7dFable = null;
      q.unified7dFableReset = null;
      changed = true;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
      changed = true;
    }

    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      // Expired rate-limit holds used to clear inside _isAvailable; that made
      // every status/TUI read a mutator. Clear them here on the request path.
      // Skip disabled accounts — _isAvailable short-circuits before the hold
      // check, so an operator-disabled account must keep its stamped hold
      // (selection-hardening: soonest-reset must not resurrect it).
      if (!account.disabled
          && account.status === 'throttled' && account.rateLimitedUntil
          && Date.now() >= account.rateLimitedUntil) {
        account.status = 'active';
        account.rateLimitedUntil = null;
        account.throttledAt = null;
        // Recovery pull-back (2026-09-19 #7 review): this is the AUTOMATIC
        // throttle-expiry path, distinct from clearRateLimited's manual/probe
        // path, and it runs on every getActiveAccount call (see
        // refreshExpiredQuotas's call site) — the most common recovery trigger
        // in practice. The original fix covered the manual path and missed
        // this one entirely (coderabbitai, PR #7).
        this._markRequalified(account);
        console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
        changed = true;
      }
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return;

    let best = null;
    let bestWeekly = current.quota.unified7dReset;
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      if (!this._isAvailable(acc)) continue; // enough session & weekly quota left
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      this._beginRamp(best);
      console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  _isNearQuota(account, model = null) {
    if (!subscriptionAdmission(account, model).allowed) return true;
    if (account.quotaAdmission === 'upstream') return false;
    const q = account.quota;
    const now = Date.now();
    // PURE: treat an expired window as non-constraining without clearing.
    // Clearing belongs on the request path via refreshExpiredQuotas — status /
    // serveable reads must not wipe quota state (T3 purity / B3 continuation).

    // Shared 5-hour bucket gates every request regardless of model.
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) {
      if (!q.unified5hReset || now < q.unified5hReset) return true;
    }

    // Only the weekly bucket that GOVERNS this model is checked: Fable and Sonnet
    // meter their own weekly quota, so a spent Fable bucket must not bar an Opus
    // or Sonnet request (and vice versa). When the family bucket isn't reported
    // (e.g. the plan doesn't expose it), fall back to the shared weekly so an
    // account over its overall cap is still treated as near-quota.
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null && weeklyVal >= this.switchThreshold) {
      const weeklyReset = this._governingWeeklyReset(account, model);
      if (!weeklyReset || now < weeklyReset) return true;
    }

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) {
        if (!q.resetsAt || now < new Date(q.resetsAt).getTime()) return true;
      }
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) {
        if (!q.resetsAt || now < new Date(q.resetsAt).getTime()) return true;
      }
    }

    return false;
  }

  /** Legacy v1.1.9 comparison: static priority dominates; unknown weekly reset
   * sorts first so one request measures it. Kept as a named comparator both for
   * backward compatibility and for shadow-mode A/B evidence. */
  _legacyCompare(a, b, model) {
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    if (pa !== pb) return pa - pb;
    const ra = this._governingWeeklyReset(a, model) || -Infinity;
    const rb = this._governingWeeklyReset(b, model) || -Infinity;
    if (ra !== rb) return ra - rb;
    return 0;
  }

  /** A complete weekly window, or Infinity when it cannot support an
   * expiration-first claim. Reset-without-utilization is not evidence: a stale
   * partial probe must not outrank an account whose state is honestly unknown.
   * Family-specific quota wins, then the shared weekly fallback. */
  _completeWeeklyReset(account, model, now = Date.now()) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    const specificReset = q[`${key}Reset`];
    if (q[key] != null && specificReset && specificReset > now) return specificReset;
    if (q.unified7d != null && q.unified7dReset && q.unified7dReset > now) return q.unified7dReset;
    return Infinity;
  }

  /** Complete session/reset signal. Unified 5h is preferred; standard token or
   * request quotas can use `resetsAt` only when a corresponding limit pair is
   * complete. When no header signal qualifies, a configured tokenBudget with a
   * NON-EMPTY window synthesizes the R2 roll-off time (oldest ts + windowSec).
   * Empty window = no evidence = Infinity (honesty: absence must not outrank
   * unknowns). Unknown ranks at Infinity, never as "0% used". */
  _completeSessionReset(account, now = Date.now()) {
    const q = account.quota;
    if (q.unified5h != null && q.unified5hReset && q.unified5hReset > now) return q.unified5hReset;
    const standardComplete = (q.tokensLimit != null && q.tokensRemaining != null)
      || (q.requestsLimit != null && q.requestsRemaining != null);
    if (standardComplete && q.resetsAt) {
      const t = typeof q.resetsAt === 'number' ? q.resetsAt : new Date(q.resetsAt).getTime();
      if (Number.isFinite(t) && t > now) return t;
    }
    // D1: budgeted apikey synthetic expiry (zero-config-inert without tokenBudget).
    if (account.tokenBudget) {
      this._pruneTokenWindow(account, now);
      if (account.tokenWindow?.length) {
        return account.tokenWindow[0].ts + account.tokenBudget.windowSec * 1000;
      }
    }
    return Infinity;
  }

  /** Utilization used only after reset timing ties. Lower first: with the same
   * expiry, drain the account with more capacity remaining. Unknown is Infinity
   * so an opaque paid backend cannot masquerade as pristine quota. When
   * tokenBudget is set and the window is non-empty, windowSum/maxTokens joins
   * the max-of-signals set (D1). */
  _dynamicUtilization(account, model) {
    const q = account.quota;
    const vals = [];
    const weekly = this._governingWeekly(account, model);
    if (weekly != null) vals.push(weekly);
    if (q.unified5h != null) vals.push(q.unified5h);
    if (q.tokensLimit != null && q.tokensRemaining != null && q.tokensLimit > 0) {
      vals.push(1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null && q.requestsLimit > 0) {
      vals.push(1 - q.requestsRemaining / q.requestsLimit);
    }
    if (account.tokenBudget && account.tokenBudget.maxTokens > 0) {
      const sum = this._tokenWindowSum(account);
      if (account.tokenWindow?.length) {
        vals.push(sum / account.tokenBudget.maxTokens);
      }
    }
    return vals.length ? Math.max(...vals) : Infinity;
  }

  /** The cost/fallback tier for this account on THIS model's route. Route tiers
   * are authoritative; account.costTier is the backward-compatible fallback.
   * Numeric account tokens resolve the same way route eligibility does. */
  /** Stamp `account` as having just RECOVERED to an eligible state (error
   * cleared, disabled->enabled, rate-limit cleared or expired, OAuth token
   * refreshed). Advances the manager-wide high-water mark used as an O(1)
   * fast-path skip in `_selectForSession`; per-session evaluation of what
   * recovered is tracked separately by sessionTracker (see
   * recoveryCheckedThrough / markRecoveryChecked) so multiple sessions
   * sharing one fallback each get an independent look at the same event. */
  _markRequalified(account) {
    const now = Date.now();
    account.requalifiedAt = now;
    if (now > this._lastRecoveryAt) this._lastRecoveryAt = now;
  }

  _costTierFor(account, model) {
    const route = this._routeForModel(model);
    if (route?.tiers?.length) {
      const token = String(account.index);
      const i = route.tiers.findIndex(t => t.accounts.includes(account.name) || t.accounts.includes(token));
      return i >= 0 ? i : Infinity;
    }
    return account.costTier;
  }

  /** Fidelity of an account for a requested model: does it serve the model
   *  AS-IS (faithful) or translate it to a different model (translated)?
   *  Lower rank = more faithful (0 = faithful, 1 = translated).
   *  Detection: an explicit `fidelity` hint wins; else a modelMap entry is
   *  faithful iff identity (X→X); else an account with no modelMap is faithful
   *  iff oauth (native Anthropic) — an apikey account routes through an opaque
   *  adapter (codex, antigravity) and is treated as translated. */
  _fidelityRank(account, model) {
    if (!account || !model) return 0;
    if (account.fidelity === 'faithful') return 0;
    if (account.fidelity === 'translated') return 1;
    const mapped = account.modelMap
      && Object.prototype.hasOwnProperty.call(account.modelMap, model)
      ? account.modelMap[model] : null;
    if (mapped != null) return mapped === model ? 0 : 1;
    return account.type === 'oauth' ? 0 : 1;
  }

  /** Dynamic order: hard economic/quality tier for THIS route, then MODEL
   * FIDELITY (honor the user's model selection — faithful accounts serve the
   * requested model as-is and outrank translators), then use-or-lose reset
   * windows, then remaining capacity, with static priority only as a
   * deterministic final tie. A faithful account that is exhausted or otherwise
   * unavailable is already filtered by _isAvailable, so the translator is
   * picked only as the fallback the user asked for. */
  dynamicCompare(a, b, model, now = Date.now()) {
    const ta = this._costTierFor(a, model);
    const tb = this._costTierFor(b, model);
    if (ta !== tb) return ta - tb;
    const fa = this._fidelityRank(a, model);
    const fb = this._fidelityRank(b, model);
    if (fa !== fb) return fa - fb;
    const wa = this._completeWeeklyReset(a, model, now);
    const wb = this._completeWeeklyReset(b, model, now);
    if (wa !== wb) return wa - wb;
    const sa = this._completeSessionReset(a, now);
    const sb = this._completeSessionReset(b, now);
    if (sa !== sb) return sa - sb;
    const ua = this._dynamicUtilization(a, model);
    const ub = this._dynamicUtilization(b, model);
    if (ua !== ub) return ua - ub;
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    if (pa !== pb) return pa - pb;
    return 0;
  }

  /** rank-replay `evidence()` shape — safe fields only (no credentials). */
  _rankEvidence(account, model, now = Date.now()) {
    if (!account) return null;
    const weeklyReset = this._completeWeeklyReset(account, model, now);
    const sessionReset = this._completeSessionReset(account, now);
    const utilization = this._dynamicUtilization(account, model);
    return {
      account: account.name,
      routeTier: this._costTierFor(account, model),
      accountCostTier: account.costTier,
      fidelity: this._fidelityRank(account, model) === 0 ? 'faithful' : 'translated',
      priority: account.priority || 0,
      weeklyReset: Number.isFinite(weeklyReset) ? weeklyReset : null,
      sessionReset: Number.isFinite(sessionReset) ? sessionReset : null,
      utilization: Number.isFinite(utilization) ? utilization : null,
      status: account.status,
      circuitOpenUntil: account.circuitOpenUntil || null,
      mappedTo: account.modelMap?.[model] || null,
    };
  }

  /** First differing dynamicCompare stage between two picks. */
  _shadowDiffReason(legacy, dynamic, model, now = Date.now()) {
    if (!legacy || !dynamic || legacy.index === dynamic.index) return 'equal';
    if (this._costTierFor(legacy, model) !== this._costTierFor(dynamic, model)) return 'tier';
    if (this._fidelityRank(legacy, model) !== this._fidelityRank(dynamic, model)) return 'fidelity';
    if (this._completeWeeklyReset(legacy, model, now)
      !== this._completeWeeklyReset(dynamic, model, now)) return 'weekly';
    if (this._completeSessionReset(legacy, now)
      !== this._completeSessionReset(dynamic, now)) return 'session';
    if (this._dynamicUtilization(legacy, model)
      !== this._dynamicUtilization(dynamic, model)) return 'utilization';
    if ((legacy.priority || 0) !== (dynamic.priority || 0)) return 'priority';
    return 'equal';
  }

  _pushShadowDecision(record) {
    this._shadowRing[this._shadowRingPushed % SHADOW_DECISION_RING_SIZE] = record;
    this._shadowRingPushed += 1;
    if (Object.hasOwn(this._shadowReasonHistogram, record.reason)) {
      this._shadowReasonHistogram[record.reason] += 1;
    }
  }

  _recordShadowDecision(legacy, dynamic, model, advisorModel = null) {
    this._shadowDecisions.total += 1;
    const changed = !!(legacy && dynamic && legacy.index !== dynamic.index);
    if (changed) {
      this._shadowDecisions.changed += 1;
      const signature = `${model || '<default>'}:${legacy.name}->${dynamic.name}`;
      if (this._shadowDecisions.last !== signature) {
        this._shadowDecisions.last = signature;
        console.log(`[TeamClaude] SHADOW routing model="${model || '<default>'}": legacy="${legacy.name}" dynamic="${dynamic.name}"`);
      }
    }
    const now = Date.now();
    const reason = this._shadowDiffReason(legacy, dynamic, model, now);
    // Allowlist-by-construction: named fields only (T7 privacy discipline).
    const record = {
      ts: new Date(now).toISOString(),
      model: model == null ? null : String(model),
      legacy: legacy?.name ?? null,
      dynamic: dynamic?.name ?? null,
      changed,
      reason,
      legacyEvidence: this._rankEvidence(legacy, model, now),
      dynamicEvidence: this._rankEvidence(dynamic, model, now),
      dynamicPickServeable: dynamic
        ? this._isAvailable(dynamic, model, advisorModel)
        : false,
    };
    this._pushShadowDecision(record);
  }

  /** Compare legacy vs dynamic winners for THIS request and record evidence.
   * Called once from getActiveAccount so ticks, session affinity, and
   * sticky-current paths all count the same way. */
  _observeShadowDecision(exclude = null, model = null, advisorModel = null) {
    const eligible = this.accounts.filter(account =>
      !exclude?.has(account.index) && this._isAvailable(account, model, advisorModel));
    if (!eligible.length) return;
    const legacy = [...eligible].sort((a, b) => this._legacyCompare(a, b, model))[0];
    const dynamic = [...eligible].sort((a, b) => this.dynamicCompare(a, b, model))[0];
    this._recordShadowDecision(legacy, dynamic, model, advisorModel);
  }

  /**
   * Pure read of the shadow-decision ring. Default limit = ring capacity so a
   * naked poll cannot omit the newest half (R0 lesson on provenance).
   *
   * An explicit `limit` selects the NEWEST `limit` decisions, not the oldest.
   * Walking forward from the oldest surviving slot reproduced the R0 illusion
   * on the explicit-limit path: an operator polling `?limit=50` during a live
   * incident saw a frozen window of stale evidence while push() kept admitting.
   * Returned order stays chronological (oldest -> newest) within the window.
   */
  getShadowDecisions({ limit } = {}) {
    const capacity = SHADOW_DECISION_RING_SIZE;
    const retained = Math.min(this._shadowRingPushed, capacity);
    let lim = retained;
    if (limit != null && limit !== '') {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) lim = Math.min(n, retained);
    }
    // Absolute index of the first slot in the NEWEST `lim`-sized window.
    const first = this._shadowRingPushed - lim;
    const decisions = [];
    for (let i = 0; i < lim; i++) {
      const slot = this._shadowRing[(first + i) % capacity];
      decisions.push(copyShadowDecision(slot));
    }
    return { capacity, size: retained, decisions };
  }

  _shadowDecisionsStatus() {
    const { total, changed, last } = this._shadowDecisions;
    return {
      total,
      changed,
      last,
      ringSize: Math.min(this._shadowRingPushed, SHADOW_DECISION_RING_SIZE),
      changedRate: total > 0 ? changed / total : 0,
      reasonHistogram: { ...this._shadowReasonHistogram },
    };
  }

  /**
   * Pick the best available account by the configured policy, WITHOUT mutating
   * state. `priority-first` is byte-for-byte the old semantic order; `shadow`
   * serves legacy (evidence is recorded in getActiveAccount); `dynamic` serves
   * expiration-first.
   */
  _pickBestAvailable(exclude = null, model = null, advisorModel = null) {
    const eligible = this.accounts.filter(account =>
      !exclude?.has(account.index) && this._isAvailable(account, model, advisorModel));
    if (!eligible.length) return null;

    const legacy = [...eligible].sort((a, b) => this._legacyCompare(a, b, model))[0];
    if (this.routingPolicy.mode === 'priority-first' || this.routingPolicy.mode === 'shadow') {
      return legacy;
    }
    return [...eligible].sort((a, b) => this.dynamicCompare(a, b, model))[0];
  }

  exportShadowDecisions() {
    // Counters only — the D2 evidence ring is process-lifetime (like T7).
    return {
      total: this._shadowDecisions.total,
      changed: this._shadowDecisions.changed,
      last: this._shadowDecisions.last,
    };
  }

  restoreShadowDecisions(saved) {
    if (!saved || typeof saved !== 'object') return;
    this._shadowDecisions.total = Number.isFinite(saved.total) ? saved.total : 0;
    this._shadowDecisions.changed = Number.isFinite(saved.changed) ? saved.changed : 0;
    this._shadowDecisions.last = saved.last ?? null;
    // Ring + histogram stay ephemeral; a restart begins a fresh evidence window.
  }

  /**
   * Select the active account up front (e.g. on daemon launch, once persisted
   * quota has been restored) so we start on the highest-priority / soonest-
   * resetting account instead of blindly on index 0. Mirrors rotation order.
   * Returns the chosen account, or the existing current one if none are
   * available (the server still starts; requests 429 until a window resets).
   */
  selectActiveAccount() {
    this.refreshExpiredQuotas(); // drop any restored windows that already expired
    const best = this._pickBestAvailable();
    if (!best) return this.accounts[this.currentIndex] || null;
    this.currentIndex = best.index;
    this._beginRamp(best);
    best.probing = best.quota.unified7dReset == null;
    const wk = best.quota.unified7d != null
      ? `${(best.quota.unified7d * 100).toFixed(1)}% weekly used`
      : 'weekly quota unknown';
    console.log(`[TeamClaude] Starting on account "${best.name}" (priority ${best.priority || 0}, ${wk})`);
    return best;
  }

  _selectNext(exclude = null, model = null, advisorModel = null) {
    const best = this._pickBestAvailable(exclude, model, advisorModel);
    if (best) {
      const switched = best.index !== this.currentIndex;
      this.currentIndex = best.index;
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        this._beginRamp(best);
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      // Never resurrect a hard-state account: `disabled` is an operator decision
      // and `error` means the token is broken (needs re-login). Selecting either
      // here would send a live request on an account that must not be used and,
      // below, silently clear its throttle/error state. (Mirrors _isAvailable.)
      if (account.disabled || account.status === 'error') continue;
      // A routed/owned model must not fall back to an ineligible account —
      // neither the executor's nor an advisor's.
      if (model && !this._routeAllows(account, model)) continue;
      if (advisorModel && !this._routeAllows(account, advisorModel)) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      this._beginRamp(soonestAccount);
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Native quotaSource is the single authority for this account's unified
    // quota. Skip header parsing so an adapter-stamped value cannot fight the
    // in-process probe (which is fresher and runs on the probe cadence).
    if (account.quotaSource) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;
    // Only a response that actually carried a unified value refreshes the
    // observation time. Stamping on every response would keep `observedAt`
    // permanently current even while the upstream stopped reporting quota.
    if (!isNaN(u5h) || !isNaN(u7d)) account.quota.observedAt = Date.now();

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    const u7dOi = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(u7dOi)) account.quota.unified7dFable = u7dOi;
    const r7dOi = headers['anthropic-ratelimit-unified-7d_oi-reset'];
    if (r7dOi) account.quota.unified7dFableReset = parseInt(r7dOi, 10) * 1000;

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;


    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /** Record custom-adapter health from one completed attempt. Returns the open
   * duration on failure, or 0 on success. Bounded exponential backoff keeps a
   * dead adapter out of selection without turning a brief blip into a long
   * outage: 2s, 4s, ... max 60s. */
  noteProviderResult(accountIndex, { ok, latencyMs = null, status = null, error = null } = {}) {
    const a = this.accounts[accountIndex];
    if (!a || !a.upstream) return 0;
    a.circuitProbeInFlightAt = null;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      a.latencyEwmaMs = a.latencyEwmaMs == null ? latencyMs : (0.8 * a.latencyEwmaMs + 0.2 * latencyMs);
    }
    if (ok) {
      a.consecutiveFailures = 0;
      a.circuitOpenUntil = null;
      a.lastFailure = null;
      a.lastSuccessAt = Date.now();
      return 0;
    }
    a.consecutiveFailures += 1;
    const openMs = Math.min(60_000, 1000 * 2 ** Math.min(a.consecutiveFailures, 6));
    a.circuitOpenUntil = Date.now() + openMs;
    a.lastFailure = { at: Date.now(), status: status || null, error: error ? String(error).slice(0, 240) : null };
    console.log(`[TeamClaude] Circuit open for custom account "${a.name}" ${openMs}ms after failure #${a.consecutiveFailures}`);
    return openMs;
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /** Drop sliding-window entries older than tokenBudget.windowSec. */
  _pruneTokenWindow(account, now = Date.now()) {
    if (!account?.tokenBudget || !account.tokenWindow?.length) return;
    const cutoff = now - account.tokenBudget.windowSec * 1000;
    while (account.tokenWindow.length && account.tokenWindow[0].ts < cutoff) {
      account.tokenWindow.shift();
    }
  }

  _tokenWindowSum(account, now = Date.now()) {
    this._pruneTokenWindow(account, now);
    if (!account.tokenWindow?.length) return 0;
    let sum = 0;
    for (const e of account.tokenWindow) sum += e.tokens;
    return sum;
  }

  /** True when an optional R2 tokenBudget window is at/over maxTokens. */
  _isTokenBudgetTripped(account) {
    if (!account?.tokenBudget) return false;
    return this._tokenWindowSum(account) >= account.tokenBudget.maxTokens;
  }

  /**
   * ms timestamp when the oldest window entry rolls off (admission retry-after /
   * quotaResetAt). null when the budget is absent or not currently tripped.
   */
  _tokenBudgetResetMs(account) {
    if (!account?.tokenBudget) return null;
    this._pruneTokenWindow(account);
    if (!account.tokenWindow.length) return null;
    if (this._tokenWindowSum(account) < account.tokenBudget.maxTokens) return null;
    return account.tokenWindow[0].ts + account.tokenBudget.windowSec * 1000;
  }

  /**
   * R2: record one completed response's already-parsed usage into the sliding
   * window. No-op when tokenBudget is unset (zero-config-inert). Ephemeral —
   * the window is never written to disk.
   */
  recordTokenBudget(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account?.tokenBudget || !usage) return;
    const input = Number(usage.input);
    const output = Number(usage.output);
    const tokens = (Number.isFinite(input) ? input : 0)
      + (Number.isFinite(output) ? output : 0);
    if (tokens <= 0) return;
    const now = Date.now();
    account.tokenWindow.push({ ts: now, tokens });
    this._pruneTokenWindow(account, now);
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const wasDisabled = account.disabled;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
    // Recovery pull-back (2026-09-19 #7 review): an ORDINARY disabled->enabled
    // transition (status already active/etc, just operator-toggled) is a
    // recovery too — a pinned session lost this account to `disabled` the same
    // way it loses one to `error`, and needs the same chance to pull back.
    // The original fix only armed this inside the error-clearing branch above
    // and missed the plain toggle (coderabbitai, PR #7).
    if (wasDisabled && !disabled) this._markRequalified(account);
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;
    if (usage.balance) q.balance = globalThis.structuredClone(usage.balance);
    if (usage.nativeWindows) {
      q.nativeWindows = globalThis.structuredClone(usage.nativeWindows);
      q.nativeWindowProvider = usage.nativeWindowProvider;
      // Clear a missing short window, including old synthetic Codex readings.
      if (usage.nativeWindowProvider === 'codex' && !usage.fiveHour) {
        q.unified5h = null;
        q.unified5hReset = null;
      }
    }
    if (usage.subscription) {
      q.subscription = globalThis.structuredClone(usage.subscription);
      // Canonical pools replace legacy Claude-shaped probe readings. Retaining
      // those fields could gate Gemini on Claude or invent a Codex 5h limit.
      for (const key of ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
        'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset']) q[key] = null;
      account.subscriptionError = null;
    }

    // Quota freshness. `observedAt` is when the READING was taken, which is not
    // always when we applied it: a state-file-backed probe can succeed right now
    // while the file it read is days old. Sources that know their observation
    // time pass it through (usage.observedAt, epoch ms); everything else is
    // observed at apply time. Without this, a stale reading is indistinguishable
    // from a live one in every consumer (TUI bars, /teamclaude/status).
    if (usage.observedAt != null && Number.isFinite(usage.observedAt)) {
      q.observedAt = usage.observedAt;
    } else {
      q.observedAt = Date.now();
    }

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = usage.fiveHour.utilization;
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = usage.sevenDay.utilization;
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    if (usage.sevenDaySonnet) {
      if (usage.sevenDaySonnet.utilization != null) q.unified7dSonnet = usage.sevenDaySonnet.utilization;
      if (usage.sevenDaySonnet.resetAt != null) q.unified7dSonnetReset = usage.sevenDaySonnet.resetAt;
    }
    if (usage.sevenDayFable) {
      if (usage.sevenDayFable.utilization != null) q.unified7dFable = usage.sevenDayFable.utilization;
      if (usage.sevenDayFable.resetAt != null) q.unified7dFableReset = usage.sevenDayFable.resetAt;
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    // Marks when the hold was (re-)armed: a revalidation probe is allowed only
    // after throttleProbeFloorMs from here, so a probe that 429s again pushes
    // the next probe out by a full floor rather than hammering upstream.
    account.throttledAt = Date.now();
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Clear a rate-limit hold after live proof it no longer binds: any non-429
   * upstream response on a throttled account (a revalidation probe reaching
   * here, or a hold armed moments before traffic resumed). No-op otherwise.
   */
  clearRateLimited(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.status !== 'throttled') return;
    account.status = 'active';
    account.rateLimitedUntil = null;
    account.throttledAt = null;
    // See setDisabled: a pinned session may be on the fallback that covered
    // this account while it was throttled — recovery pull-back offers it back.
    this._markRequalified(account);
    console.log(`[TeamClaude] Account "${account.name}" revalidated — rate limit no longer applies, back in rotation`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // A forced refresh answers a 401, but 401s arrive in bursts: every request
    // already in flight when the token went bad comes back rejected, and each
    // one would force its own refresh. Coalescing only covers refreshes that
    // OVERLAP — these arrive staggered, so they would rotate the refresh-token
    // family once per request and make the proxy the very "other holder
    // rotating the family" that causes this failure in the first place. A 401
    // for a token minted moments ago is stale news from a request sent before
    // the refresh landed, so trust the new token and let the caller retry with
    // it. Only an expiry-driven refresh (force=false) bypasses this — it isn't
    // reacting to a response and can't stampede.
    if (force && account._lastRefreshAt !== null
        && Date.now() - account._lastRefreshAt < this._forcedRefreshFloorMs) {
      return;
    }

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshFn(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account._lastRefreshAt = Date.now();
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Reserve 'error' (which drops the account from rotation until re-login)
        // for a GENUINE auth rejection: the refresh token itself is no longer
        // valid — revoked, or invalidated by an account/plan migration. A
        // transient failure (network, 5xx, timeout) must NOT sideline a healthy
        // account: keep its current token and retry on the next request. This is
        // what kept accounts wrongly "errored" after a momentary refresh blip.
        const isAuthRejection = err.status === 400 || err.status === 401 || err.status === 403;
        if (isAuthRejection) {
          account.status = 'error';
          console.error(`[TeamClaude] Account "${account.name}" needs re-login (refresh token rejected) — run: teamclaude login`);
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') {
      account.status = 'active';
      // See setDisabled: an OAuth token refresh (e.g. after re-auth clears a
      // revoked-grant error) is exactly the "recovered" event a pinned session
      // needs offered back to it.
      this._markRequalified(account);
    }
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /** Update the non-credential policy fields of an existing account during a
   * config reload. These fields are consumed directly by selection/rewrite and
   * were previously snapshotted forever at startup — pressing Reload said
   * "Config reloaded" while a changed modelMap still did nothing. Returns the
   * names of fields that changed for an auditable reload acknowledgment. */
  updateAccountPolicy(index, disk) {
    const a = this.accounts[index];
    if (!a || !disk) return [];
    const changed = [];
    const set = (field, value) => {
      const before = JSON.stringify(a[field]);
      const after = JSON.stringify(value);
      if (before === after) return;
      a[field] = value;
      changed.push(field);
    };
    set('priority', disk.priority || 0);
    set('quotaAdmission', disk.quotaAdmission === 'upstream' ? 'upstream' : 'usage');
    set('usageDisplay', normalizeUsageDisplay(disk.usageDisplay));
    set('balanceSource', disk.balanceSource || null);
    if (JSON.stringify(a.quotaSource) !== JSON.stringify(disk.quotaSource || null)) {
      set('quotaSource', disk.quotaSource || null);
      delete a.quota.subscription;
      delete a.quota.nativeWindows;
      delete a.quota.nativeWindowProvider;
      a.subscriptionError = null;
    }
    set('costTier', Number.isFinite(disk.costTier) ? disk.costTier : 0);
    set('upstream', disk.upstream || null);
    set('modelMap', disk.modelMap || null);
    set('models', disk.models || null);
    set('supportsAdvisorTools', disk.supportsAdvisorTools === true);
    set('acceptsModels', Array.isArray(disk.acceptsModels) ? disk.acceptsModels.map(String) : null);
    set('strictModelMap', !!disk.strictModelMap);
    set('historyFamily', resolveHistoryFamily(disk));
    set('acceptsHistoryFamilies', Array.isArray(disk.acceptsHistoryFamilies)
      ? disk.acceptsHistoryFamilies.map(String) : null);
    // R2 tokenBudget is config-shaped and must hot-reload with the rest of the
    // policy set. The sliding tokenWindow stays ephemeral in memory — only the
    // budget knobs move; counters are never persisted or reset here.
    set('tokenBudget', normalizeTokenBudget(disk.tokenBudget));
    return changed;
  }

  /** Update the runtime selection policy from disk. */
  setRoutingPolicy(policy = {}) {
    const prevMode = this.routingPolicy?.mode;
    const mode = ['priority-first', 'shadow', 'dynamic'].includes(policy?.mode)
      ? policy.mode : 'priority-first';
    this.routingPolicy = {
      mode,
      preserveSessionAffinity: policy?.preserveSessionAffinity !== false,
      reevaluateMs: Number.isFinite(policy?.reevaluateMs)
        ? Math.max(0, policy.reevaluateMs) : 5 * 60 * 1000,
    };
    // Maps left from a prior dynamic window suppress the first honest re-eval
    // after promotion (stale eval clock) and pin requests to a wrong index.
    // Clear only on the transition INTO dynamic — same-mode reloads keep
    // live stickiness; leaving dynamic makes the maps inert until next entry.
    if (mode === 'dynamic' && prevMode !== 'dynamic') {
      this._dynamicCurrentByKey.clear();
      this._dynamicEvalAtByKey.clear();
    }
    return this.routingPolicy;
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push(makeAccount(acctData, index));
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
    // Keep route pins pointing at the right account after the index shift: drop a
    // pin on the removed account, decrement pins that sat above it.
    for (const [name, idx] of [...this.routePins.entries()]) {
      if (idx === index) this.routePins.delete(name);
      else if (idx > index) this.routePins.set(name, idx - 1);
    }
    // Dynamic no-session maps store account indices. Any splice invalidates them
    // (values >= index are off-by-one or dangling). Clear both rather than
    // per-key surgery: the next request re-evaluates with a fresh timestamp.
    this._dynamicCurrentByKey.clear();
    this._dynamicEvalAtByKey.clear();
  }

  /**
   * Retire an account in place (config reload removed it). Keeps the array
   * slot and `index` stable for the process lifetime so provenance cannot
   * mis-attribute a later account that reuses a compacted slot. Credentials
   * stay on the object so an in-flight request that already selected it can
   * finish (no mid-request rug-pull); new selection/pins/probes/warm skip it.
   */
  retireAccount(index) {
    const account = this.accounts[index];
    if (!account || account.retired) return;
    account.retired = true;
    account.disabled = true;
    for (const [name, idx] of [...this.routePins.entries()]) {
      if (idx === index) this.routePins.delete(name);
    }
    if (this.currentIndex === index) {
      const next = this.accounts.findIndex(a => !a.retired && !a.disabled);
      if (next >= 0) this.currentIndex = next;
    }
  }

  /** Undo retireAccount when the same identity reappears on a later reload. */
  reviveAccount(index) {
    const account = this.accounts[index];
    if (!account || !account.retired) return;
    account.retired = false;
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, quota };
    });
  }

  /**
   * Restore quota learned in a previous run. Matches saved entries to accounts
   * by identity. Stale windows are not special-cased here — _clearExpiredQuotas
   * wipes any restored window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => sameIdentity(s, account));
      if (!match || !match.quota) continue;
      for (const f of PERSISTED_QUOTA_FIELDS) {
        if (match.quota[f] != null) account.quota[f] = match.quota[f];
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    const sessions = this.sessionTracker.stats();
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      routingPolicy: { ...this.routingPolicy },
      shadowDecisions: this._shadowDecisionsStatus(),
      advisorDegrades: this._advisorDegrades,
      rotationGate: this.rotationLedger.statusSnapshot(this.rotationGate.mode),
      routes: this.getRoutes(),
      sessions: { ...sessions, distribute: this.distributeSessions },
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        orgName: a.orgName || null,
        priority: a.priority || 0,
        costTier: a.costTier,
        disabled: a.disabled || false,
        status: a.status,
        // General (model=null) availability — weekly buckets are per-family, so
        // this is NOT per-model truth. Callers that need model scope use
        // GET /teamclaude/serveable?model=<id>.
        serveableNow: this._isAvailable(a, null),
        quotaResetAt: this._quotaResetAt(a, null),
        capability: {
          strictModelMap: a.strictModelMap,
          acceptsModels: a.acceptsModels ? [...a.acceptsModels] : null,
        },
        historyFamily: a.historyFamily || null,
        acceptsHistoryFamilies: a.acceptsHistoryFamilies
          ? [...a.acceptsHistoryFamilies] : null,
        sessions: sessions.perAccount[a.index] || 0,
        quota: { ...a.quota },
        usageDisplay: a.usageDisplay,
        quotaSourceType: a.quotaSource?.type || null,
        balanceError: a.balanceError || null,
        subscriptionAdmission: a.quotaSource ? subscriptionAdmission(a) : null,
        subscriptionError: a.subscriptionError || null,
        subscriptionSource: isSubscriptionSource(a.quotaSource) ? {
          type: a.quotaSource.type,
          pool: a.quotaSource.pool || null,
          family: a.quotaSource.family || null,
          maxAgeMs: a.quotaSource.maxAgeMs ?? 90000,
        } : null,
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
        pausedUntil: a.pausedUntil && a.pausedUntil > Date.now()
          ? new Date(a.pausedUntil).toISOString()
          : null,
        health: {
          consecutiveFailures: a.consecutiveFailures,
          circuitOpenUntil: a.circuitOpenUntil && a.circuitOpenUntil > Date.now()
            ? new Date(a.circuitOpenUntil).toISOString() : null,
          latencyEwmaMs: a.latencyEwmaMs,
          lastFailure: a.lastFailure,
          lastSuccessAt: a.lastSuccessAt ? new Date(a.lastSuccessAt).toISOString() : null,
        },
      })),
    };
  }
}
