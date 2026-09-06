import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired, formatMoney } from './oauth.js';
import { providerOf, DEFAULT_PROVIDER, isSubscriptionAccount } from './provider.js';
import { refreshCodexToken } from './codex-auth.js';
import { parseCodexQuota, parseCodexPlanType } from './codex-quota.js';
import { sameIdentity } from './identity.js';
import { weeklyBucketForModel, modelGlobMatches, modelFamily, gatingUtilization, resolveMaxUsage, WEEKLY_BUCKET_KEYS } from './model.js';
import { SessionTracker } from './session-tracker.js';
import { buildQuotaSummary } from './quota-summary.js';
import { ROLLOVER_MIN_JUMP_MS, remapHeld } from './rollover.js';
import { decideBand, pressureOf, pressureRank, assertNever } from './band-decision.js';

// Re-exported for callers that import these model helpers from here.
export { isFableModel, parseRequestModel, parseAdvisorModel } from './model.js';

// How long after a successful token refresh a forced (post-401) refresh is
// suppressed. Long enough to cover the 401s from requests already in flight
// when the token turned over, short enough that a genuinely bad new token
// recovers on the next request rather than staying stuck.
const FORCED_REFRESH_FLOOR_MS = 10_000;
// An organization-level OAuth policy denial is not repaired by an immediate
// retry. Keep the account out of automatic rotation long enough for other
// members to serve, then re-admit it so an administrator's policy change is
// discovered without a restart.
const ENTITLEMENT_DENIAL_COOLDOWN_SECONDS = 5 * 60;

// Fallback when a per-bucket threshold table names neither the bucket nor a
// `default` — the same value the single-number form has always used.
export const DEFAULT_SWITCH_THRESHOLD = 0.98;

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset',
  'unified7dSonnetSeenAt', 'unified7dFableSeenAt',
  'unifiedStatus', 'unifiedStatusSeenAt',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
  'scopedWeekly',
];

// The family (Fable/Sonnet) weekly buckets and the field holding when each was
// last confirmed by upstream. See _clearExpiredQuotas: a SPENT family reading is
// only trusted while it is fresh, because nothing but a request of that family
// can refresh it.
const FAMILY_WEEKLY_BUCKETS = [
  { key: 'unified7dFable', label: 'Fable', usageKey: 'sevenDayFable' },
  { key: 'unified7dSonnet', label: 'Sonnet', usageKey: 'sevenDaySonnet' },
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
    // When each family bucket was last confirmed by upstream (ms timestamp).
    // Only these two buckets need it: they are the ones a spent reading can seal
    // itself into, since selection stops sending the family that would refresh them.
    unified7dSonnetSeenAt: null,
    unified7dFableSeenAt: null,
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    unifiedStatusSeenAt: null,  // ms timestamp of the response that reported it
    // Every model-scoped weekly bucket the usage endpoint named, keyed by its
    // own display_name (lowercased): { fable: { utilization, resetAt }, ... }.
    // Upstream owns this list and it changes, so it is learned rather than
    // declared — a family with no dedicated field above is still metered.
    scopedWeekly: {},
    // Paid-overage state from the usage probe: null until a probe reports it.
    // Not a quota — it says whether exceeding the quotas above costs money
    // on this account rather than stopping it.
    spend: null,
    resetsAt: null,
  };
}

// One level deeper than a spread, for the per-bucket usage split. Each bucket's
// counters are a flat object, so this is the whole depth of the structure.
function copyBuckets(byBucket) {
  const out = {};
  for (const [bucket, counters] of Object.entries(byBucket)) out[bucket] = { ...counters };
  return out;
}

// Build a fresh in-memory account record from a config/disk account object.
// Shared by the constructor and addAccount() so the field set can never drift
// between startup accounts and runtime-added ones (a divergence here once left
// runtime-added accounts without `inFlight`, hanging every request in admit()).
function makeAccount(acct, index) {
  return {
    index,
    // The entry this account was built from. `index` is a position in this list
    // and says nothing about the config list, which drops credential-less
    // entries and is therefore a different shape — see account-pairing.js.
    id: acct.id || null,
    name: acct.name,
    type: acct.type,
    // Which backend this account talks to. Absent means Anthropic, so configs
    // written before providers existed keep working untouched.
    provider: providerOf(acct),
    // Codex scopes a token to one ChatGPT account via a request header; this is
    // that id. The Anthropic counterpart is `accountUuid`, which is patched
    // into the request body instead.
    accountId: acct.accountId || null,
    accountUuid: acct.accountUuid || null,
    orgUuid: acct.orgUuid || null,
    orgName: acct.orgName || null,
    organizationType: acct.organizationType || null,
    rateLimitTier: acct.rateLimitTier || null,
    seatTier: acct.seatTier || null,
    hasClaudeMax: acct.hasClaudeMax ?? null,
    hasClaudePro: acct.hasClaudePro ?? null,
    priority: acct.priority || 0,
    disabled: acct.disabled || false,
    maxUsage: acct.maxUsage ?? null,
    upstream: acct.upstream || null,
    modelMap: acct.modelMap || null,
    // Fields to drop from request bodies for this account (third-party upstreams
    // that reject e.g. `context_management`). See server.js stripBodyFields.
    stripRequestFields: acct.stripRequestFields || null,
    models: acct.models || null,
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
      // The two cache fields upstream reports alongside `input_tokens` and that
      // nothing read until now. `totalInputTokens` counts uncached input only,
      // so on its own it understates what a request cost this account by
      // whatever the cache served, which on a Claude Code turn is nearly all of
      // it: across 873012 sampled usage objects these two carry 99.95% of the
      // input side.
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      // The same two totals split by weekly bucket. Fable meters into its own
      // weekly, so what a point there costs is its own question, and a sum
      // across families cannot be taken apart afterwards.
      byBucket: {},
      totalRequests: 0,
      lastUsed: null,
    },
    rateLimitedUntil: null,
    throttledAt: null,
    // Organization policy can reject OAuth while the credential itself remains
    // valid. This cross-request cooldown is intentionally ephemeral: unlike
    // quota, it is a live routing observation and is re-learned after restart.
    entitlementDeniedUntil: null,
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
    // The refresh token upstream last rejected as invalid, if it is still the
    // one we hold — see the dead-token guard in ensureTokenFresh.
    _deadRefreshToken: null,
  };
}

// Does a declared `models` entry name `model`? The declared side may carry a
// trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); we match it
// against a bare request too. Shared by _accountOwnsModel's two lookups so the
// predicate can't drift.
function modelMatches(declared, model) {
  return declared === model || declared.replace(/\[\d+m\]$/, '') === model;
}

// A representative model for a route's own globs, used to report what that route
// does right now (which accounts may serve it, and which one it would pick).
// Taken from the route object rather than looked up by name, so two routes
// sharing a name are still each described by their own globs.
function sampleModelFor(route) {
  return route.match[0].replace(/\*/g, '') || 'model';
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, { refreshFn = refreshAccessToken, codexRefreshFn = refreshCodexToken, throttleProbeFloorMs, familyStaleMs, statusStaleMs, forcedRefreshFloorMs = FORCED_REFRESH_FLOOR_MS, routes, ramp, distributeSessions = false, sessionTracker, expiryRouting } = {}) {
    // How long a just-minted token is trusted against a forced refresh.
    this._forcedRefreshFloorMs = forcedRefreshFloorMs;
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this._codexRefreshFn = codexRefreshFn;
    this.accounts = accounts.map((acct, index) => makeAccount(acct, index));
    this.currentIndex = 0;
    // Session awareness (issue #109). The tracker is always on (passive — it just
    // observes the x-claude-code-session-id header for the status readout).
    // `distributeSessions` gates the behavioural change: keep each session on its
    // account for cache reuse, but spread NEW sessions across equal-priority
    // accounts by load instead of funnelling them all onto the current one.
    this.sessionTracker = sessionTracker || new SessionTracker();
    this.distributeSessions = !!distributeSessions;
    // Sessions still being drained after distribution was turned off (see
    // setDistributeSessions). null = not draining; a Set of session ids otherwise.
    this._drainingSessions = null;
    // Ephemeral per-route manual pins (routeName → account index). Not persisted:
    // like the global manual switch (currentIndex) these are runtime overrides that
    // bias selection for a route's models and reset on restart. A pinned account
    // that becomes ineligible is skipped — routing falls back to best-available.
    this.routePins = new Map();
    // Selection cursor per route (routeName → account index; '' when no route
    // matches). A single global cursor reads traffic that alternates between
    // routes as a rotation: the cursor sits on the other route's account, that
    // account fails this model's route check, and selection "switches" away from
    // it. Each such switch arms the ramp below, so steady interleaved traffic
    // holds both accounts at the ramp floor while nothing has failed over.
    this.routeCursors = new Map();
    // One cursor per provider. `currentIndex` is a single slot, and a request
    // only another provider can serve would otherwise drag it across: a Codex
    // request moved it onto a Codex account and the next Anthropic request moved
    // it straight back, flapping the TUI's current-account marker and re-arming
    // storm control on every alternation. A provider partition is the purest
    // form of "barred for THIS request only" — an Anthropic account serves every
    // Anthropic request perfectly well — so it must not move the fleet, exactly
    // as a spent family bucket does not (#276).
    this.providerCursors = new Map();
    this.switchThreshold = switchThreshold;
    this.setRoutes(routes);
    this.setExpiryRouting(expiryRouting);
    // The rollover mechanism's whole state for the sticky current account: one
    // observation, { idx, windows: name → reset }, of the account traffic was
    // resting on when a request last arrived to find it there. Null while the
    // knob is off: nothing writes one then and none survives the transition.
    this._currentObs = null;
    // Throttle for the held-rollover line, keyed by (account index, WINDOW,
    // reason). Keying by the request bucket would let two windows that share one
    // bucket silence each other; keying by session id is unbounded, since that
    // id is a client-supplied header.
    this._rolloverHeldLogAt = new Map();
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
    // How long a SPENT family (Fable/Sonnet) weekly reading is trusted before it
    // is cleared for revalidation (see _clearExpiredQuotas). Long enough that a
    // genuinely spent bucket costs at most one rejected request per account per
    // window, short enough that a stale reading cannot lock a family out for the
    // rest of the weekly window.
    this.familyStaleMs = familyStaleMs
      ?? (Number(process.env.TEAMCLAUDE_FAMILY_STALE_MS) || 30 * 60_000);
    // Same discipline for the upstream `unified-status`: it is a snapshot of one
    // response, not a subscription, so nothing revalidates it while the account
    // sits idle and acting on an old `rejected` would bar an account whose quota
    // reset hours ago. Past this it is dropped and the local buckets decide.
    this.statusStaleMs = statusStaleMs
      ?? (Number(process.env.TEAMCLAUDE_STATUS_STALE_MS) || 30 * 60_000);
  }

  /**
   * The utilization at which a given quota bucket takes an account out of
   * rotation. One number governed every bucket, which conflates two different
   * risks: 98% of a 5-hour window that refills in two hours is a nuisance, while
   * 98% of a weekly window with six days left means the account is spent for the
   * rest of the week. An operator who wants to rotate off the weekly bucket
   * earlier than the 5-hour one had no way to say so.
   *
   * `switchThreshold` therefore accepts either form:
   *
   *   "switchThreshold": 0.98
   *   "switchThreshold": { "default": 0.98, "unified7d": 0.9 }
   *
   * Bucket keys are the quota field names (unified5h, unified7d, unified7dFable,
   * unified7dSonnet, tokens, requests). Anything unlisted takes `default`, so a
   * bare number behaves exactly as it always has.
   */
  thresholdFor(bucket) {
    const t = this.switchThreshold;
    if (typeof t === 'number') return t;
    if (t && typeof t === 'object') {
      const v = t[bucket] ?? t.default;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return DEFAULT_SWITCH_THRESHOLD;
  }

  /** The single number that best represents the configured threshold, for the
   * places that show one (status header, TUI settings row). */
  get effectiveThreshold() {
    return this.thresholdFor('default');
  }

  /**
   * A per-account usage cap, or null when that bucket is uncapped.
   *
   * `switchThreshold` is a rotation preference: at that level the fleet PREFERS
   * another account, but the all-exhausted probe path deliberately overrides it,
   * because a threshold decision can rest on a stale reading and refusing
   * forever is worse than one revalidating request. A budget is not that. An
   * operator who says "this account stops at 60% of its weekly" wants zero
   * requests past 60%, so `accounts[].maxUsage` is a separate, harder setting —
   * see capExceeded.
   *
   * Same shapes as switchThreshold, per account:
   *
   *   "maxUsage": 0.6
   *   "maxUsage": { "unified5h": 0.6, "unified7d": 0.6, "unified7dFable": 0.8 }
   *
   * Bucket keys are the quota field names (unified5h, unified7d, unified7dFable,
   * unified7dSonnet, tokens, requests). A bare number caps every bucket; in the
   * map form, a bucket that is neither listed nor covered by `default` is
   * uncapped, so a cap is only ever what was asked for.
   */
  capFor(bucket, account) {
    return resolveMaxUsage(account?.maxUsage, bucket);
  }

  /**
   * The bucket that has reached this account's cap for `model`, or null.
   *
   * The shared buckets (unified5h, unified7d) cap every request; a family bucket
   * caps only the family it meters, so a Fable cap stops Fable and leaves Opus
   * alone. Both apply: a Fable request is capped by whichever binds first.
   */
  capExceeded(account, model = null) {
    if (!account?.maxUsage) return null;
    const q = account.quota;
    // Same reason _isNearQuota does this first: a window that has already reset
    // must not read as capped on a value that no longer applies.
    this._clearExpiredQuotas(account);

    const cap5h = this.capFor('unified5h', account);
    if (cap5h != null && q.unified5h != null && q.unified5h >= cap5h) return 'unified5h';

    // The shared weekly bucket caps every request, family requests included:
    // family spend meters into BOTH its own bucket and the shared one (#175), so
    // a budget written against the shared weekly is one that Fable can overrun
    // if only the governing bucket is checked. This is not _isNearQuota's rule —
    // a threshold gates on the governing bucket alone — but a threshold is a
    // preference and a cap is a total.
    const capWeekly = this.capFor('unified7d', account);
    if (capWeekly != null && q.unified7d != null && q.unified7d >= capWeekly) return 'unified7d';

    // …and on top of it, the family bucket that meters THIS model, when the
    // family has one. A Fable cap stops Fable and leaves Opus alone.
    const familyKey = this._weeklyBucketFor(model);
    if (familyKey !== 'unified7d') {
      const familyCap = this.capFor(familyKey, account);
      const familyVal = q[familyKey];
      if (familyCap != null && familyVal != null && familyVal >= familyCap) return familyKey;
    }

    const tokensCap = this.capFor('tokens', account);
    if (tokensCap != null && q.tokensLimit != null && q.tokensRemaining != null
      && 1 - q.tokensRemaining / q.tokensLimit >= tokensCap) return 'tokens';

    const requestsCap = this.capFor('requests', account);
    if (requestsCap != null && q.requestsLimit != null && q.requestsRemaining != null
      && 1 - q.requestsRemaining / q.requestsLimit >= requestsCap) return 'requests';

    return null;
  }

  /** The family weekly bucket that has reached its cap for `model`, or null.
   * The advisor check needs this narrower form: the shared buckets were already
   * decided for the executor model, and only the advisor's own family is new. */
  _familyCapExceeded(account, model) {
    if (!account?.maxUsage) return null;
    const key = this._weeklyBucketFor(model);
    if (key === 'unified7d') return null;
    const cap = this.capFor(key, account);
    const val = account.quota[key];
    return cap != null && val != null && val >= cap ? key : null;
  }

  /** Start (or restart) the ramp window for an account that just became current,
   * so a failover burst is paced onto it rather than all landing at once. */
  _beginRamp(account) {
    if (account && this.ramp.enabled) account.rampStartedAt = Date.now();
  }

  /**
   * Move the cursor, and only the cursor. A reading is taken where a request
   * finds traffic resting, never where a selection aims it, so no caller of
   * this method owes one. The single write here is `_firstSightOn`'s, taken
   * only where the cursor has never been read at all, and it discards nothing.
   */
  _setCurrent(account) {
    this.currentIndex = account.index;
    if (!this.expiryRouting.enabled || !this.expiryRouting.preempt) return;
    this._firstSightOn(this._currentObs ??= { idx: null, windows: new Map(), unescaped: null }, account);
  }

  /**
   * Make the account at `index` current on an operator's say-so: the TUI's 's'
   * and the /teamclaude/switch endpoint are the same act by two routes.
   */
  setCurrentAccount(index) {
    const account = this.accounts[index];
    if (!account) return false;
    this._setCurrent(account);
    return true;
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
  /** True while an account is inside a rate-limit pause (see pauseAccount). The
   * pause deliberately does NOT mark the account throttled, so selection still
   * offers it — a caller choosing a failover target has to ask. */
  isPaused(index, now = Date.now()) {
    const account = this.accounts[index];
    return !!(account?.pausedUntil && now < account.pausedUntil);
  }

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

  /** Keep an OAuth-policy-denied account out of automatic rotation temporarily.
   * Extend an existing cooldown, never shorten it. Returns the expiry timestamp,
   * or null when the account is missing or the cooldown is disabled. */
  markEntitlementDenied(index, seconds = ENTITLEMENT_DENIAL_COOLDOWN_SECONDS) {
    const account = this.accounts[index];
    if (!account) return null;
    const duration = Number(seconds);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const until = Date.now() + duration * 1000;
    account.entitlementDeniedUntil = Math.max(account.entitlementDeniedUntil || 0, until);
    return account.entitlementDeniedUntil;
  }

  /** True while an account is in its OAuth entitlement cooldown. Expiry is
   * consumed lazily so selection immediately re-admits it without a timer. */
  _entitlementDenied(account, now = Date.now()) {
    if (!account?.entitlementDeniedUntil) return false;
    if (now < account.entitlementDeniedUntil) return true;
    account.entitlementDeniedUntil = null;
    console.log(`[TeamClaude] Account "${account.name}" entitlement cooldown expired, marking available`);
    return false;
  }

  /** Public form used by the request path to re-check an account after waiting
   * in storm-control admission. */
  isEntitlementDenied(index, now = Date.now()) {
    return this._entitlementDenied(this.accounts[index], now);
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
   */
  getActiveAccount(exclude = null, model = null, advisorModel = null, sessionId = null, provider = DEFAULT_PROVIDER) {
    // Selection reads this.currentIndex as "where the fleet is". With more than
    // one provider that is a single slot for several fleets, so a request whose
    // provider does not own it borrows the slot for the walk and hands it back.
    //
    // With one provider — every config that predates #246 — `borrowed` is always
    // false and this is the same code it was.
    const owner = providerOf(this.accounts[this.currentIndex]);
    const borrowed = !!this.accounts.length && owner !== provider;
    const saved = this.currentIndex;
    if (borrowed) {
      const own = this.providerCursors.get(provider);
      if (own != null && this.accounts[own] && providerOf(this.accounts[own]) === provider) this.currentIndex = own;
    }

    let account;
    // Scoped rather than threaded through _select/_selectNext/_divertedFor: the
    // whole walk is synchronous, so nothing can interleave and observe it, and
    // the alternative is a provider argument on six private methods that exist
    // to answer a different question.
    this._selectingProvider = provider;
    try {
      account = this._pickActiveAccount(this._excludeOtherProviders(exclude, provider), model, advisorModel, sessionId);
    } finally {
      this._selectingProvider = null;
      // Hand the slot back before anything can observe it moved. Only the
      // provider that owns currentIndex gets to change it.
      if (borrowed) this.currentIndex = saved;
    }

    // Record where this route now sits, whatever path chose it — the steady-state
    // path returns the account the cursor already names and never reaches the
    // rotation code, so recording there alone would leave the cursor unset and
    // the next real failover unpaced.
    if (account) {
      this.routeCursors.set(this._cursorKey(model, advisorModel, provider), account.index);
      this.providerCursors.set(providerOf(account), account.index);
    }
    return account;
  }

  /**
   * Widen a request's exclude set to every account that belongs to a different
   * provider.
   *
   * A provider partition is absolute — an Anthropic account cannot serve an
   * OpenAI Responses request at all — so it is expressed as exclusion rather
   * than threaded through the rotation logic. Everything downstream already
   * reads `exclude`, so cursors, pinning, session affinity, probing and
   * preemption keep working unchanged, and a config with no Codex accounts
   * produces the identical set it did before.
   *
   * Returns the caller's own set untouched when nothing needs excluding, so
   * the common single-provider case allocates nothing.
   */
  _excludeOtherProviders(exclude, provider) {
    // Only SUBSCRIPTION accounts are partitioned. A Claude Max token is issued
    // to Claude and a ChatGPT token to Codex; neither plan can be spent by the
    // other's client, so crossing them is never right. An API key carries no
    // such tie — it is metered capacity, not a seat — so it stays eligible for
    // whichever app is asking, which is what keeps a third-party backend usable
    // from both.
    const foreign = this.accounts.filter(a => providerOf(a) !== provider && isSubscriptionAccount(a));
    if (foreign.length === 0) return exclude;
    const combined = new Set(exclude || []);
    for (const account of foreign) combined.add(account.index);
    return combined;
  }

  _pickActiveAccount(exclude, model, advisorModel, sessionId) {
    // Taken before anything in this pass can move the cursor: the quota-reset
    // switch below moves it, and treating its destination as a resting place
    // prices an account the request was only aimed at. Not taken for an account
    // this request has already tried, which is a failed attempt coming back
    // through selection rather than a place the traffic rested.
    this._restOnCurrent(exclude, model);
    // Here rather than inside the session walks, because a pin is maintained
    // whether or not those walks run: `recordSession` is always on. Read only
    // where the walks read it, a session routed while distribution is off would
    // freeze its observation at the last walk and miss the stays in between.
    if (sessionId) {
      this._restOnPin(sessionId, this._weeklyBucketFor(model), exclude, model);
    }
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas(model);
    // Session-affinity distribution (opt-in): keep a session on its pinned
    // account for cache reuse, and route a new session to the least-loaded
    // account. Only when enabled, only for a real session, and only outside a
    // manual route pin (which must still win). Falls through to the normal walk
    // if nothing session-eligible is found (e.g. the whole tier is exhausted).
    if (sessionId && !this._pinnedAccountForModel(model, advisorModel)) {
      if (this.distributeSessions) {
        const acc = this._selectForSession(sessionId, exclude, model, advisorModel);
        if (acc) return acc;
      } else if (this._isDrainingSession(sessionId)) {
        // Distribution was just turned off. Sessions that already existed keep
        // their account so the prompt cache they built there survives; everything
        // else falls through to the normal quota-driven walk below.
        const acc = this._selectDrainingSession(sessionId, exclude, model, advisorModel);
        if (acc) return acc;
      }
    }
    if (advisorModel) {
      const account = this._select(exclude, model, advisorModel, false);
      if (account) return account;
      // Throttled so a busy advisor session doesn't flood the activity log.
      if (Date.now() >= (this._advisorDegradeLogAt || 0)) {
        this._advisorDegradeLogAt = Date.now() + 60_000;
        console.log(`[TeamClaude] No account eligible for advisor model "${advisorModel}" — routing by request model only`);
      }
    }
    return this._select(exclude, model, null, true);
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
    const current = this.accounts[this.currentIndex];
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
      if (next) { current.requalify = false; return next; }
    }
    if (this._isAvailable(current, model, advisorModel) && !exclude?.has(current.index)) {
      // Rollover preemption (expiry routing): the current account's governing
      // window rolled over, so it is now the freshest and furthest-dated choice.
      // Re-rank rather than stay parked on it until a switch threshold that
      // low-utilization fleets never reach. Every pass reaching here decides the
      // request, the advisor-constrained one included; `allowProbe` gates the
      // exhausted-fleet probe, not which pass is final.
      const rolled = this.expiryRouting.enabled && this.expiryRouting.preempt
        && this._currentRolledOver(current, model);
      if (rolled) {
        const next = this._selectNext(exclude, model, advisorModel);
        // Both ways of not moving end here: nothing eligible, or the re-rank
        // handing back the account being moved off. Neither refreshes the
        // observation, so the next request compares against the same pre-roll
        // reset and asks again.
        if (!next || next.index === current.index) this._noteHeldRollover(current, model, advisorModel, exclude);
        if (next) return next;
      }
      const betterExists = this._preemptedBy(current, model, advisorModel, exclude);
      if (betterExists) return this._selectNext(exclude, model, advisorModel);
      return current;
    }
    // Barred for this request only: keep the family where it was diverted.
    // Barred outright (disabled, throttled, spent): rotate, as before.
    const diverted = this._currentBarredOnlyFor(model, advisorModel, exclude)
      ? this._divertedFor(model, advisorModel, exclude) : null;
    if (diverted) return diverted;
    const next = this._selectNext(exclude, model, advisorModel);
    if (next) return next;
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
    // The pin is per governing bucket, and this request is bound by the
    // EXECUTOR's: one request goes to one account, so the executor's affinity is
    // what binds it and the advisor's model is a constraint on that choice
    // (_isAvailable, below) rather than a second key.
    const bucket = this._weeklyBucketFor(model);
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId, bucket);
    // The bucket's own pin first. Failing that, any account the session already
    // sits on for another family: one session stays on one account unless that
    // account cannot serve the request (the README's "pins it there"). Without
    // this, a session's first request of a second family would go to
    // _pickLeastLoaded, which counts the session's own pin as load and pushes
    // the new family onto a sibling — splitting every mixed-model session
    // across two accounts by construction, not only on a real diversion.
    const candidates = [];
    if (pinIdx != null) candidates.push(pinIdx);
    for (const idx of this.sessionTracker.pinnedAccounts(sessionId)) {
      if (!candidates.includes(idx)) candidates.push(idx);
    }
    for (const idx of candidates) {
      const pinned = this.accounts[idx];
      if (!pinned) continue;
      // Skipping writes nothing and destroys nothing, so a window that rolled
      // while this account was out of reach is still there to be found when
      // traffic returns to it.
      if (!this._isAvailable(pinned, model, advisorModel) || exclude?.has(idx)) continue;
      // Rollover preemption (expiry routing): this candidate rolled over its
      // governing window, so staying would burn the week it just gained while
      // sooner-expiring quota goes unspent — the only pressure-driven force on a
      // pin, at one cache miss per pinned session per rollover. Asked of every
      // candidate rather than the bucket's pin alone, since a session sitting on
      // another family's account is just as stuck, and a rollover re-ranks so
      // that pressure picks the destination.
      if (this.expiryRouting.enabled && this.expiryRouting.preempt
          && this._pinRolledOver(sessionId, pinned, model)) {
        const next = this._pickLeastLoaded(exclude, model, advisorModel);
        if (next && next.index !== idx) {
          // A fleet-wide rollover moves every session pinned to that account at
          // once, so the destination gets the same failover burst any other
          // switch would send it — pace it (issue #84).
          this._beginRamp(next);
          console.log(`[TeamClaude] Session pin on "${pinned.name}" released — its weekly window rolled over; re-routing to "${next.name}"`);
          return next;
        }
        // The traffic did not move, so the observation is left where it is and
        // the next request asks again.
        this._noteHeldRollover(pinned, model, advisorModel, exclude);
        return pinned;
      }
      // Mirror _select's priority preemption so an operator's priority order
      // still wins over a session's stickiness.
      const betterExists = this.accounts.some(a =>
        this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0));
      if (!betterExists) return pinned;
    }
    // No pin was usable, so this is a placement. Placing is aiming: it takes no
    // reading, and the next request to find the pin here takes it.
    return this._pickLeastLoaded(exclude, model, advisorModel);
  }

  /** Best-available biased toward the fewest active sessions, so new sessions
   * spread across equal-priority accounts instead of funnelling onto one. Order:
   * priority → [top pressure band, when expiry routing is on] → fewest active
   * sessions → fewest in-flight → highest expiry pressure (inert when expiry
   * routing is off) → soonest weekly reset (the existing tiebreak). */
  _pickLeastLoaded(exclude = null, model = null, advisorModel = null) {
    const now = Date.now();
    const candidates = this._bandedCandidates(exclude, model, advisorModel);
    // One clock for every candidate: pressure rises continuously as a window
    // nears its reset, so scoring two accounts at different instants decides an
    // exact tie on the microseconds between two Date.now() reads.
    const pressures = this._rankedPressures(candidates, model, now);
    // Ahead of the load terms, because it is the one thing load must not
    // override: an account the tree knows is nearly spent (see _belowBandFloor).
    const spent = this._belowBandFloor(candidates, model, now);
    let best = null;
    let bestPriority = Infinity;
    let bestSpent = Infinity;
    let bestSessions = Infinity;
    let bestInFlight = Infinity;
    let bestPressure = Infinity;
    let bestReset = Infinity;
    candidates.forEach((account, i) => {
      const priority = account.priority || 0;
      const heldOff = spent[i];
      const sessions = this.sessionTracker.activeCountFor(account.index, now);
      const inFlight = account.inFlight || 0;
      const pressure = pressures[i];
      const reset = this._rankedReset(account, model);
      const samePriority = priority === bestPriority;
      const sameSpend = samePriority && heldOff === bestSpent;
      if (priority < bestPriority
        || (samePriority && heldOff < bestSpent)
        || (sameSpend && sessions < bestSessions)
        || (sameSpend && sessions === bestSessions && inFlight < bestInFlight)
        || (sameSpend && sessions === bestSessions && inFlight === bestInFlight && pressure < bestPressure)
        || (sameSpend && sessions === bestSessions && inFlight === bestInFlight && pressure === bestPressure && reset < bestReset)) {
        best = account;
        bestPriority = priority;
        bestSpent = heldOff;
        bestSessions = sessions;
        bestInFlight = inFlight;
        bestPressure = pressure;
        bestReset = reset;
      }
    });
    return best;
  }

  /** Record that a session's request was served by an account (always on, even
   * when distribution is off — the readout is passive). This is what pins a
   * session for future affinity, for the weekly bucket this request spent.
   *
   * The executor's bucket only. An advisor sub-inference runs on the SAME
   * account and spends its family's quota there too, but selection degrades to
   * executor-only when no account is eligible for both models, and upstream
   * then drops the advisor call — so the account may or may not have served
   * that family, and only selection knows which. Claiming it here on a request
   * that was degraded would pin a family to an account that never served it,
   * quite possibly one that cannot. Unclaimed means the session routes that
   * family afresh next request, which is what it did before it had a pin. */
  recordSession(sessionId, accountIndex, model = null) {
    if (!sessionId) return;
    const bucket = this._weeklyBucketFor(model);
    // The pin alone: this runs before the destination's token is refreshed and
    // long before the upstream fetch, so it names where the request is being
    // SENT, and being sent somewhere is not arriving there. The observation is
    // taken where the evidence is, at the start of the NEXT request from
    // wherever this one left the pin (see _restOn).
    this.sessionTracker.touch(sessionId, accountIndex, bucket);
    // Except the FIRST one, which discards nothing: otherwise a session's
    // opening window is first-sighted a request late (see _firstSightOn).
    if (!this.expiryRouting.enabled || !this.expiryRouting.preempt) return;
    this._firstSightOn(this.sessionTracker.refsFor(sessionId, bucket, true),
      this.accounts[accountIndex]);
  }

  /** Mark a session request as in flight / finished. Paired around the whole
   * client request (including retries) so a long streaming completion keeps the
   * session counted as active for its full duration. */
  beginSession(sessionId, metadata = null) {
    if (sessionId) this.sessionTracker.beginRequest(sessionId, undefined, metadata);
  }

  endSession(sessionId) {
    if (sessionId) this.sessionTracker.endRequest(sessionId);
  }

  /** { known, active, perAccount } session counts for status/TUI. */
  sessionStats() {
    return { ...this.sessionTracker.stats(), draining: this.drainingCount() };
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
   * current account if it can serve the model AND nothing preempts it →
   * best-available), but WITHOUT mutating currentIndex and without the
   * exhausted-fleet probe fallback. Returns null when nothing can serve `model`
   * at the moment. The TUI uses this to mark the single account each secondary
   * bucket (Fable/Sonnet) currently routes to — the F7/S7 analogue of the ► that
   * marks the default route's current account. It mirrors every discriminator
   * `_select` uses, so its answer cannot disagree with the next selection, and
   * it decides nothing: no reading is taken and no cursor moves.
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
      const rolled = this.expiryRouting.enabled && this.expiryRouting.preempt
        && this._currentRolledOver(current, model);
      if (!better && !rolled) return current.index;
    }
    // Mirror _select's diversion cursor, so the preview names the account a
    // diverted family will actually land on rather than the one a fresh walk
    // would pick.
    if (this._currentBarredOnlyFor(model)) {
      const diverted = this._divertedFor(model);
      if (diverted) return diverted.index;
    }
    const best = this._pickBestAvailable(null, model);
    return best ? best.index : null;
  }

  _isProbeable(account) {
    if (!account) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A live entitlement cooldown is evidence, not a stale quota estimate. Do
    // not let the all-unavailable probe path defeat it immediately.
    if (this._entitlementDenied(account)) return false;
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
   * shared 5-hour bucket plus the weekly value that gates the model, which is
   * the higher of its family bucket and the shared weekly one. With no model it
   * falls back to the shared weekly. */
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

  /** Weekly utilization (0-1) that gates `model` on this account: the higher of
   * the bucket that governs the model (unified7dFable for Fable,
   * unified7dSonnet for Sonnet, unified7d otherwise) and the shared unified7d,
   * since family spend meters into both. Null when neither reports — see
   * `gatingUtilization` for why that stays null rather than becoming 0. */
  _governingWeekly(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    // A dedicated family bucket does NOT stand alone: family spend meters into
    // the shared weekly too, so an account under its Fable cap can be over the
    // shared one. Gating on the family bucket alone is a one-way ratchet —
    // once the shared weekly caps, family requests are the only ones still
    // admitted, and each one pushes it further over (#175).
    if (key !== 'unified7d') return gatingUtilization(q, key);
    // No dedicated field for this family — but the usage endpoint may still
    // report a weekly bucket scoped to it (upstream adds these over time). Gate
    // on the tighter of that bucket and the shared weekly, so a family with its
    // own cap can't overshoot it just because the code predates the family.
    const scoped = this._scopedWeekly(account, model)?.utilization;
    const known = [q.unified7d, scoped].filter(v => v != null);
    return known.length ? Math.max(...known) : null;

  /**
   * WHY THIS IS NOT `_governingWindow(...).utilization`.
   *
   * The two answer different questions and must be allowed to differ.
   *
   * This one is the GATE: can the account serve this family at all. Family spend
   * meters into the family bucket AND the shared weekly, so the answer is the
   * higher of the two (#175) — otherwise an account at `unified7d` 1.00 with
   * `unified7dFable` 0.20 keeps serving Fable and pushes the shared bucket
   * further past its cap on every request.
   *
   * `_governingWindow` is the RATIO's input: headroom per second until that same
   * window resets. There the value and the clock must come from ONE bucket, as
   * its own comment on `_governingWeeklyReset` insists — pairing one bucket's
   * headroom with another's clock prices the account on quota it will lose
   * before it can spend it.
   *
   * So collapsing them would either revert #175 or misprice the pressure. They
   * stay separate on purpose.
   */
  }

  /** The learned scoped weekly bucket governing `model`, or null. Keyed by the
   * family name the usage endpoint reports, which is what modelFamily derives. */
  _scopedWeekly(account, model) {
    const scoped = account.quota.scopedWeekly;
    if (!scoped || typeof scoped !== 'object') return null;
    const family = modelFamily(model);
    return family === 'other' ? null : (scoped[family] || null);
  }

  /** Reset timestamp (ms) of the weekly bucket that governs `model`, falling back
   * to the shared weekly reset. Used to spend the soonest-expiring quota first.
   *
   * THE RESET DOES NOT TAKE THE MAXIMUM the value above takes, so the two can
   * name different buckets. Both callers (`_pickBestAvailable`,
   * `_pickLeastLoaded`) use it as a ranking tiebreak among accounts that have
   * already passed `_isAvailable`, and nothing here divides a headroom by it.
   * Maxing it would be the error of pairing one bucket's level with another
   * bucket's clock; keeping it on the governing window preserves the existing
   * "spend the family quota that refreshes soonest" heuristic. */
  _governingWeeklyReset(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    return q[`${key}Reset`] || this._scopedWeekly(account, model)?.resetAt || q.unified7dReset || null;
  }

  /** True when the family-specific weekly bucket that governs `model` is spent.
   * Unlike _isNearQuota this ignores the shared 5h/weekly caps. Two call sites:
   * the probe filter in _selectProbe, which skips an account for a probe of a
   * model it definitely can't serve, and the advisor arm of _isAvailable, which
   * asks whether the account can serve the advisor's family as well as the
   * executor's. Returns false for families without a dedicated bucket (they
   * share unified7d, already covered by _isNearQuota).
   *
   * FAMILY-ONLY ON PURPOSE, and it does NOT take the maximum `_governingWeekly`
   * takes. The two answer different questions: this one asks "can this account
   * serve this family at all", the gate asks "is this account near any cap that
   * binds this request". Both call sites want the narrow one. The probe filter
   * wants it because folding the shared bucket in here would skip accounts for
   * probes they could still have served, and a probe is how a stale cached
   * utilization gets corrected, so it would harden the state it exists to
   * escape. The advisor arm wants it because _isNearQuota has already applied
   * the maximum to the executor's model a few lines above, so an account over
   * its shared weekly is refused there and never reaches this line: the shared
   * bucket governs the advisor decision by composition rather than by being
   * folded in twice. A reader seeing two similar helpers diverge may wonder
   * whether one was missed: it was not. */
  _modelWeeklyExhausted(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (key === 'unified7d') return false;
    return q[key] != null && q[key] >= this.thresholdFor(key);
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
    let bestPriority = Infinity;
    let bestUsage = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A family-exhausted account can't serve that family even as a probe — it
      // would just 429 again — so skip it (Fable/Sonnet) and let the caller emit
      // the synthetic 429 when no other account is available.
      if (model && this._modelWeeklyExhausted(account, model)) continue;
      // A cap is the operator's own decision, not a reading that a live request
      // might refresh, so the exhausted-fleet probe does not get to override it.
      // Checked here rather than in _isProbeable because a cap is model-scoped.
      if (this.capExceeded(account, model)) continue;
      // Same for routing/ownership: a probe for a routed or owned model must not
      // land on an ineligible account (it would just reject the unknown model id).
      if (model && !this._routeAllows(account, model)) continue;
      const priority = account.priority || 0;
      const usage = this._maxUtilization(account, model);
      if (priority < bestPriority ||
          (priority === bestPriority && usage < bestUsage)) {
        bestPriority = priority;
        bestUsage = usage;
        best = account;
      }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this._setCurrent(best);
    this._beginRamp(best);
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null, advisorModel = null) {
    return this.unavailableReason(account, model, advisorModel) === null;
  }

  /**
   * Why `account` cannot serve `model` right now, or null when it can. Naming the
   * reason is what lets status output tell a LOCAL threshold decision apart from
   * an UPSTREAM rejection — the two used to be indistinguishable, so an operator
   * seeing `unifiedStatus: allowed` next to a refusing account had no way to know
   * the refusal was the proxy's own doing (issue #166).
   *
   * Returns one of: 'disabled', 'throttled', 'error', 'exhausted',
   * 'upstream-rejected', 'quota', 'route', 'advisor-quota', 'advisor-route'.
   */
  unavailableReason(account, model = null, advisorModel = null) {
    if (!account) return 'error';

    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return 'disabled';

    // An operator budget cap. Checked here, above every transient state, because
    // it is a decision rather than an estimate — and unlike the switch threshold
    // nothing overrides it: _selectProbe skips a capped account too, so an
    // account at its cap receives no requests at all.
    if (this.capExceeded(account, model)) return 'capped';

    // A structured organization-policy 403 means this account cannot serve OAuth
    // requests right now. Skip it across requests until the short cooldown ends.
    //
    // A reason string, not `false`: this function's contract is "a reason, or
    // null when it can serve", and getStatus surfaces the value verbatim. `false`
    // read as available against that contract and, being falsy, made
    // unavailableLine drop the row — so the one state added to make a refusal
    // explainable was the only one that printed no explanation (#258).
    if (this._entitlementDenied(account)) return 'entitlement';

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return 'throttled';
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.throttledAt = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted') return 'exhausted';
    if (account.status === 'error') return 'error';
    // Model-scoped: _isNearQuota checks the shared 5h bucket plus only the weekly
    // bucket that governs this model, so a spent Fable/Sonnet bucket bars just
    // that family — the account still serves every other model normally. It also
    // expires stale windows, so run it before reading unifiedStatus below.
    if (this._isNearQuota(account, model)) return 'quota';

    // Upstream's own verdict. `rejected` means a shared bucket is spent, so the
    // next request would 429 whatever the local counters say — believing it
    // rotates one request earlier instead of spending a rejection to learn the
    // same thing. Only while fresh (see _clearExpiredQuotas), and only for the
    // shared buckets it describes: a family bucket has its own signal.
    if (account.quota.unifiedStatus === 'rejected') return 'upstream-rejected';

    // Route/ownership restriction: a configured route can pin a model pattern to
    // an exclusive set of accounts; failing that, a per-account `models` claim
    // restricts an owned model to its owners. Either way an account not eligible
    // for this model is skipped so the request never lands somewhere it can't run.
    if (model && !this._routeAllows(account, model)) return 'route';

    // An advisor request additionally needs the account to serve the ADVISOR's
    // model: its family bucket must have headroom (the shared buckets were
    // already checked above for the executor) and any route/ownership rule for
    // it must allow this account.
    if (advisorModel) {
      if (this._familyCapExceeded(account, advisorModel)) return 'advisor-capped';
      if (this._modelWeeklyExhausted(account, advisorModel)) return 'advisor-quota';
      if (!this._routeAllows(account, advisorModel)) return 'advisor-route';
    }

    return null;
  }

  /**
   * The available account that would preempt `account` under the priority rule,
   * or null. A strictly lower priority value wins; within the same tier we stay
   * put, so the common case (every account at the default priority 0) never
   * thrashes. Shared by _select, which enforces it, and eligibility(), which
   * reports it — one predicate so the answer cannot drift from the behaviour.
   */
  _preemptedBy(account, model = null, advisorModel = null, exclude = null) {
    return this.accounts.find(a => this._isAvailable(a, model, advisorModel)
      && !exclude?.has(a.index)
      && (a.priority || 0) < (account.priority || 0)) || null;
  }

  /**
   * Whether a request right now would actually route to an account, with a short
   * reason when it would not. A caller that records a manual choice (the control
   * plane's switch endpoint) needs to report whether that choice will take
   * effect, not merely that it was stored: selection drops the choice on the very
   * next request both when the account cannot serve traffic and when another
   * available account outranks it on priority. Both are asked here through the
   * same helpers _select uses, so the flag cannot promise more than the selector
   * delivers.
   * @returns {{eligible: boolean, reason?: string}}
   */
  eligibility(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { eligible: false, reason: 'no such account' };
    // _isAvailable also clears an expired throttle, so the specific reasons below
    // are only consulted once it has actually said no.
    if (!this._isAvailable(account)) {
      if (account.disabled) return { eligible: false, reason: 'disabled' };
      if (account.status === 'error') return { eligible: false, reason: 'in an error state and needs a re-login' };
      if (account.status === 'exhausted') return { eligible: false, reason: 'out of quota' };
      if (account.status === 'throttled') return { eligible: false, reason: 'rate-limited' };
      return { eligible: false, reason: 'at or above the switch threshold' };
    }
    // Healthy, but a higher-priority account preempts it on the next selection.
    // Phrased to read correctly after "<name> is ..." in the caller's message.
    const preemptor = this._preemptedBy(account);
    if (preemptor) {
      return { eligible: false, reason: `outranked by higher-priority account "${preemptor.name}"` };
    }
    return { eligible: true };
  }

  /** Session-distribution toggle (issue #109), applied live on config reload.
   *
   *  Turning it OFF drains rather than cuts. A hard flip moves every distributed
   *  session to the current account on its very next request: each one loses the
   *  prompt cache it built on its old account, and they all arrive at one account
   *  together. So the sessions that exist at the flip are snapshotted and keep
   *  their accounts, while new sessions route by plain rotation — affinity winds
   *  down as those sessions finish. Pass { drain: false } for an immediate cut.
   *
   *  Turning it ON cancels any drain in progress. */
  setDistributeSessions(enabled, { drain = true } = {}) {
    const on = !!enabled;
    if (on) {
      this.distributeSessions = true;
      this._drainingSessions = null;
      return;
    }
    // Only a true → false transition drains; re-applying "off" (every config
    // reload while it is already off) must not resurrect affinity for sessions
    // that have since been routed by plain rotation.
    if (this.distributeSessions && drain) {
      const ids = this.sessionTracker.pinnedSessionIds();
      this._drainingSessions = ids.length ? new Set(ids) : null;
    } else if (!drain) {
      this._drainingSessions = null;
    }
    this.distributeSessions = false;
  }

  /** Is this session one of the ones still being drained onto its old account? */
  _isDrainingSession(sessionId) {
    this._pruneDrain();
    return !!this._drainingSessions?.has(sessionId);
  }

  /** Drop sessions the tracker has forgotten, and end the drain once it empties,
   *  so the manager returns to a plain "off" state without needing a restart.
   *  Unthrottled on purpose: the set only exists during a transient drain and is
   *  bounded by the number of live sessions. */
  _pruneDrain() {
    if (!this._drainingSessions) return;
    for (const id of this._drainingSessions) {
      // pinnedAccounts() is empty for a forgotten session (and evicts it).
      if (!this.sessionTracker.pinnedAccounts(id).length) this._dropDraining(id);
    }
  }

  /** Let one session out of the drain, ending the drain when it was the last. */
  _dropDraining(sessionId) {
    if (!this._drainingSessions) return;
    this._drainingSessions.delete(sessionId);
    if (this._drainingSessions.size === 0) this._drainingSessions = null;
  }

  /** Honour a draining session's existing pin — and only that. Unlike
   *  _selectForSession there is no least-loaded fallback: distribution is being
   *  wound down, so a session that cannot stay put rejoins the normal walk. */
  _selectDrainingSession(sessionId, exclude, model, advisorModel) {
    // Same candidate order as _selectForSession: the request's own bucket pin,
    // then any account the session already sits on for another family.
    const bucket = this._weeklyBucketFor(model);
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId, bucket);
    // The reading was taken at the head of this pass, so this walk writes
    // nothing and cannot spend a roll however it leaves.
    const candidates = pinIdx != null ? [pinIdx] : [];
    for (const idx of this.sessionTracker.pinnedAccounts(sessionId)) {
      if (!candidates.includes(idx)) candidates.push(idx);
    }
    for (const idx of candidates) {
      const pinned = this.accounts[idx];
      if (!pinned || !this._isAvailable(pinned, model, advisorModel) || exclude?.has(idx)) continue;
      // A governing-window rollover ends the drain, which trades expiring quota
      // for a warm cache priced on the window the account had when it started
      // and is otherwise unbounded: an active session renews its own idle
      // window. Breaking hands the session to the ordinary walk, which aims.
      if (this.expiryRouting.enabled && this.expiryRouting.preempt
          && this._pinRolledOver(sessionId, pinned, model)) break;
      // Mirror _select's priority preemption, as _selectForSession does.
      const betterExists = this.accounts.some(a =>
        this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0));
      if (!betterExists) return pinned;
    }
    // The pin is gone or no longer usable: this session has to move anyway, so
    // let it out of the drain now instead of re-checking a dead pin every request.
    this._dropDraining(sessionId);
    return null;
  }

  /** How many sessions are still draining (0 when not draining). */
  drainingCount() {
    this._pruneDrain();
    return this._drainingSessions?.size || 0;
  }

  /**
   * Normalize and store the configurable routing table. A route pins a set of
   * model globs to an exclusive set of accounts (and may override the governing
   * quota bucket). Called from the constructor and on config reload.
   *   { name, match: string|string[], accounts?: (name|index)[], bucket? }
   */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : []).map((r, i) => ({
      name: r.name || `route-${i + 1}`,
      match: (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g),
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : [],
      bucket: r.bucket || null,
      color: r.color || null, // display-only accent for the route's inline marker
    })).filter(r => r.match.length);
    // Drop pins for routes that no longer exist after a reload.
    if (this.routePins?.size) {
      const names = new Set(this.routes.map(r => r.name));
      for (const name of [...this.routePins.keys()]) {
        if (name !== 'fable' && name !== 'sonnet' && !names.has(name)) this.routePins.delete(name);
      }
    }
    // A reload can rename or drop a route, stranding its cursor under a key
    // nothing resolves to. Clearing them costs one extra best-available walk per
    // route and keeps no state that outlives the table it belonged to.
    this.routeCursors?.clear();
  }

  /**
   * Cursor key for a request: its route's name, or — with no route configured —
   * the weekly bucket the model spends, so Fable and Opus keep separate cursors
   * in the default config too (one key for everything let a Fable diversion be
   * read back as the Opus cursor, #276). An advisor request is keyed by both
   * families it needs: it is diverted for the advisor's sake as often as the
   * executor's, and sharing a cursor with plain requests for the executor's
   * model would have each overwrite the other's and re-log the diversion.
   */
  _cursorKey(model, advisorModel = null, provider = this._selectingProvider || DEFAULT_PROVIDER) {
    const own = this._routeForModel(model)?.name || (model ? this._weeklyBucketFor(model) : '');
    const base = (() => {
      if (!advisorModel) return own;
      const adv = this._routeForModel(advisorModel)?.name || this._weeklyBucketFor(advisorModel);
      return adv === own ? own : `${own}+${adv}`;
    })();
    // Namespaced by provider so a diversion recorded for one provider is never
    // read back as another's. Model names do not have to differ between
    // providers, and a bucket key certainly does not — an unprefixed key would
    // hand a Codex request the account an Anthropic request was diverted to.
    // The default provider keeps the bare key, so existing cursors and every
    // single-provider config are unchanged.
    return provider === DEFAULT_PROVIDER ? base : `${provider}\u0000${base}`;
  }

  /**
   * True when the current account can serve in general but not THIS request:
   * its family bucket or cap is spent, a route excludes it, or the advisor
   * model's family is spent. That is a per-request diversion, not a rotation,
   * and the fleet stays where it is. False for disabled / error / throttled /
   * 5h or shared weekly over threshold, which bar every request and must
   * rotate the fleet as before.
   */
  _currentBarredOnlyFor(model, advisorModel = null, exclude = null) {
    const current = this.accounts[this.currentIndex];
    return !!model && !!current && !exclude?.has(current.index)
      && this._isAvailable(current, null) && !this._isAvailable(current, model, advisorModel);
  }

  /**
   * Where this request's family was last diverted to, if that account can still
   * serve it. Consulted only once the current account has been found barred
   * for this request alone, so a family returns to the current account the
   * moment it can serve it again rather than staying diverted out of habit.
   * Yields to a higher-priority account the same way the current account does.
   */
  _divertedFor(model, advisorModel = null, exclude = null) {
    if (!model) return null;
    const idx = this.routeCursors.get(this._cursorKey(model, advisorModel));
    const account = idx != null ? this.accounts[idx] : null;
    if (!account || account.index === this.currentIndex || exclude?.has(account.index)) return null;
    if (!this._isAvailable(account, model, advisorModel)) return null;
    return this._preemptedBy(account, model, advisorModel, exclude) ? null : account;
  }

  /** The account this route was serving from before the current selection, or
   * null when it has none — used to tell a rotation from ordinary routing.
   *
   * Before a route has its own cursor, the global one stands in, but only when
   * it names an account the route could have used: a cursor left on another
   * route's account was never this route's position, so moving off it is not a
   * rotation. */
  _previousCursor(model, advisorModel = null) {
    const recorded = this.routeCursors.get(this._cursorKey(model, advisorModel));
    if (recorded != null) return recorded;
    const current = this.accounts[this.currentIndex];
    return current && this._routeAllows(current, model) ? current.index : null;
  }

  /**
   * The config key is provisional: #176 proposes a `routingStrategy` enum for
   * the adjacent drain-concentration problem, and a value such as `"expiry"` is
   * a plausible home for this behaviour. Enabling changes which accounts
   * selection considers, so only a literal `true` turns it on and a hand-edited
   * `"false"` reads as off. `tolerance` is not coerced, because an explicit 0 is
   * a meaningful setting that clamps to 1, the strictest band.
   */
  setExpiryRouting(cfg) {
    const c = cfg || {};
    const wasWatching = !!(this.expiryRouting?.enabled && this.expiryRouting?.preempt);
    this.expiryRouting = {
      enabled: c.enabled === true,
      tolerance: typeof c.tolerance === 'number' && Number.isFinite(c.tolerance)
        ? Math.max(1, c.tolerance)
        : 1.5,
      preempt: typeof c.preempt === 'boolean' ? c.preempt : true,
    };
    // Nothing survives the knob being off: every observation is dropped when
    // preemption stops and none is written while it is off, so no mechanism
    // state outlives a disabled interval. Turning it back on takes a first
    // reading for everything the fleet is sticky on, which can discard nothing
    // and buys the roll between the reload and the fleet's next request.
    if (!this.expiryRouting.enabled || !this.expiryRouting.preempt) {
      this._currentObs = null;
      this.sessionTracker.clearObservations();
      return;
    }
    // Re-applying the same setting, which every config reload does, must not
    // re-read anything. Redundant with _firstSightOn's own refusal to overwrite
    // an existing reading, and kept because the two say different things: "only
    // the transition seeds" and "an aim never overwrites".
    if (wasWatching) return;
    const current = this.accounts[this.currentIndex];
    if (current) this._firstSightOn(this._currentObs ??= { idx: null, windows: new Map(), unescaped: null }, current);
    for (const { sessionId, bucket, idx } of this.sessionTracker.livePins()) {
      this._firstSightOn(this.sessionTracker.refsFor(sessionId, bucket, true), this.accounts[idx]);
    }
  }

  /**
   * The weekly bucket whose utilization and reset are read together for `model`
   * on this account: the family's own when it reports one, the shared weekly
   * otherwise, decided by presence of the utilization and only that. Not wired
   * into `_governingWeeklyReset`, whose own shared-weekly fallback is the
   * tiebreak's behaviour with the feature off; `_rankedReset` picks between them.
   */
  _governingBucket(account, model) {
    return this._windowForBucket(account, this._weeklyBucketFor(model));
  }

  /**
   * One resolution of which weekly window governs `model`, how spent it is and
   * when it resets, read by the gate, the ratio, the band, the tiebreak and the
   * rollover baseline so no two answer differently. A family with no dedicated
   * bucket may be metered by a scoped one upstream learned for it (#231), which
   * carries its own reset — so the pair travels together, named by `window` so
   * that two families sharing `unified7d` keep separate rollover baselines.
   */
  _governingWindow(account, model) {
    const key = this._governingBucket(account, model);
    const flat = { window: key, utilization: account.quota[key], resetAt: account.quota[`${key}Reset`] };
    if (this._weeklyBucketFor(model) !== 'unified7d') return flat;
    const scoped = this._scopedWeekly(account, model);
    if (scoped?.utilization == null) return flat;
    const scopedWin = { window: `scoped:${modelFamily(model)}`, utilization: scoped.utilization, resetAt: scoped.resetAt };
    if (flat.utilization == null) return scopedWin;
    if (flat.utilization > scoped.utilization) return flat;
    if (flat.utilization < scoped.utilization) return scopedWin;
    // Equally spent, so the clock must choose: the window resetting SOONER runs
    // out first and is the constraint a request meets. Taking the longer one
    // prices the account on quota it will lose before it can spend. Unknown
    // clocks lose to known ones, as everywhere else in the ranking.
    if (flat.resetAt == null) return scopedWin;
    if (scopedWin.resetAt == null) return flat;
    return scopedWin.resetAt < flat.resetAt ? scopedWin : flat;
  }

  /**
   * Expiry pressure of `account` for `model`: headroom in the governing weekly
   * bucket per second until that bucket resets. Headroom alone ignores expiry
   * and reset time alone steers into nearly-drained accounts; the ratio captures
   * both. Weekly only — a 5h denominator is ~30x smaller and would numerically
   * drown the weekly horizons this ordering exists to respect, so the 5h bucket
   * stays an availability gate (`_isNearQuota`). Null when either half is unknown.
   */
  _expiryPressure(account, model = null, now = Date.now()) {
    const pressure = this._pressureVariant(account, model, now);
    switch (pressure.kind) {
      case 'known': return pressure.value;
      case 'absent': return null;
      default: return assertNever(pressure, '_expiryPressure');
    }
  }

  /**
   * The same pressure in the decision layer's own encoding, absence and all.
   * `_expiryPressure` publishes `null` where this says `absent`, because the
   * status payload's `pressure` field is a number. One implementation, so the
   * published figure and the routing decision cannot define the word differently.
   */
  _pressureVariant(account, model = null, now = Date.now()) {
    const [snapshotAccount] = this._bandSnapshot([account], model, now).accounts;
    return pressureOf(snapshotAccount, now);
  }

  /**
   * Each candidate's pressure as a sort key, positionally aligned with
   * `candidates`. With the knob off the term is absent for every account, so it
   * is inert rather than special-cased: the disabled path is the plain term
   * order and not a branch someone has to keep correct.
   */
  _rankedPressures(candidates, model, now) {
    if (!this.expiryRouting.enabled) {
      return candidates.map(() => pressureRank({ kind: 'absent', reason: 'expiry-routing-off' }));
    }
    return this._bandSnapshot(candidates, model, now).accounts
      .map(a => pressureRank(pressureOf(a, now)));
  }

  /**
   * Which of these candidates is known to be nearly spent, as a leading sort
   * term. A bounded absence is not an unknown: its spend is reported, and
   * admitting it as discovery would let an account measured at 95% spent win on
   * having fewer sessions, since load is compared before pressure. It is still
   * selected when nothing above the floor is available, which keeps its window
   * discoverable, and an account with no reading at all is never held off.
   */
  _belowBandFloor(candidates, model, now) {
    if (!this.expiryRouting.enabled) return candidates.map(() => 0);
    const snapshot = this._bandSnapshot(candidates, model, now);
    const decision = decideBand(snapshot);
    const bounds = snapshot.accounts.map(a => {
      const pressure = pressureOf(a, now);
      return pressure.kind === 'absent' ? pressure.lowerBound ?? null : null;
    });
    // Unknown is not zero: the band returns passthrough when no account has a
    // measured pressure, and reading that as "nothing to hold off" would zero
    // the term on a fleet where every account is clockless. With no band floor
    // the best bound is the bar instead, so an account measured below it waits
    // behind the ones that are not.
    const floor = decision.kind === 'banded'
      ? decision.floor
      : Math.max(...bounds.filter(b => b != null), -Infinity);
    if (!Number.isFinite(floor)) return candidates.map(() => 0);
    return bounds.map(b => (b != null && b < floor ? 1 : 0));
  }

  /**
   * The reset both selection loops break an otherwise-exact tie on, and unknown
   * sorts first either way. With expiry routing on it is the governing window's
   * own reset, the one the gate and the ratio just used: `_governingWeeklyReset`
   * prefers the named `${bucket}Reset`, which for a family metered by a learned
   * scoped bucket is the shared weekly — a clock nothing else in the decision
   * consulted. With the knob off it is `_governingWeeklyReset` unconditionally.
   */
  _rankedReset(account, model) {
    return this._rankingReset(account, model) || -Infinity;
  }

  /**
   * The same order, before the unknown-sorts-first coercion. The session-reset
   * switch needs the order and not the coercion: it treats an account whose
   * weekly it has never read as ineligible rather than as the soonest, the
   * opposite of the probe bias a selection tiebreak wants. Both callers come
   * through here so the two cannot rank on different clocks. Null means "not
   * known here", never "resets at the epoch".
   */
  _rankingReset(account, model) {
    if (!this.expiryRouting.enabled) return this._governingWeeklyReset(account, model);
    return this._governingWindow(account, model).resetAt ?? null;
  }

  /**
   * The accounts a selection pass may choose from: everything eligible for this
   * request, narrowed to the top pressure band when expiry routing is on.
   * `_isAvailable` excludes accounts at or above the switch threshold. Shared by
   * both selection loops so they cannot disagree on the candidate set.
   */
  _bandedCandidates(exclude = null, model = null, advisorModel = null) {
    return this._topPressureBand(
      this.accounts.filter(a => !exclude?.has(a.index) && this._isAvailable(a, model, advisorModel)),
      model);
  }

  /**
   * The accounts selection may choose from when expiry routing is on: those
   * within `tolerance` (a ratio, >= 1) of the best pressure in the top priority
   * tier. Band membership rather than a raw sort keeps the comparison
   * transitive, lets distributeSessions spread load across the admitted set
   * (#109), and gives hysteresis for free. A non-empty input never bands to
   * empty.
   */
  _topPressureBand(candidates, model = null) {
    // One clock for the whole band, as in _pickLeastLoaded.
    const decision = decideBand(this._bandSnapshot(candidates, model, Date.now()));
    switch (decision.kind) {
      case 'passthrough': return candidates;
      case 'banded': {
        const byIndex = new Map(candidates.map(a => [a.index, a]));
        return decision.keep.map(i => byIndex.get(i)).filter(Boolean);
      }
      default: return assertNever(decision, '_topPressureBand');
    }
  }

  /**
   * The band decision's view of a candidate set. Reads the accounts and the
   * config; the decision itself reads neither. `now` is an argument so a caller
   * can ask what the band makes of some other instant. Both halves of each
   * account's ratio come from the ONE window `_governingWindow` resolves.
   */
  _bandSnapshot(candidates, model, now) {
    return {
      now,
      enabled: !!this.expiryRouting.enabled,
      tolerance: this.expiryRouting.tolerance,
      accounts: candidates.map(a => {
        const { utilization: used, resetAt: reset } = this._governingWindow(a, model);
        return {
          index: a.index,
          priority: a.priority || 0,
          // Present but not a number passes through as NaN so `pressureOf` can
          // name it `utilization-not-finite`; coercing to null would report it
          // as a window nobody has reported yet, which wants a different action.
          utilization: typeof used === 'number' ? used : (used == null ? null : NaN),
          resetAt: typeof reset === 'number' && reset ? reset : null,
        };
      }),
    };
  }

  /**
   * Has the governing window of this sticky choice rolled over since a request
   * was last found resting on it? A reading is written only where a request
   * ARRIVES to find the choice on an account outside its own tried set; a
   * selection that merely sends a request somewhere writes nothing, because the
   * aimed request may never arrive. A same-account retry (short-wait 429, 401)
   * re-enters with the tried set untouched and looks like a fresh arrival, so the
   * roll it was pushed off is held until a second request confirms the stay; a
   * one-request stay followed by a return preempts once more.
   */
  _restOn(obs, account, model) {
    if (obs.idx !== account.index) {
      // The traffic has moved, so this takes the reading that makes this
      // account's rolls visible while holding the roll it was pushed off:
      // `_firstSightOn` hands that back, and every cursor or pin move goes
      // through `_setCurrent` or `recordSession`, so a fail-back has been
      // offered it before any request reaches here.
      const leaving = obs.idx == null ? null : this.accounts[obs.idx];
      if (leaving && this._anyJumped(obs.windows, leaving)) {
        obs.unescaped = { idx: obs.idx, windows: obs.windows };
      }
      // Established whole, from every window the account presents, so a window
      // that comes back is a first sight rather than a stale value read as a jump.
      obs.idx = account.index;
      obs.windows = new Map(Object.entries(this._accountWindows(account)));
      return;
    }
    // A second request has found the choice where the last one left it, the only
    // evidence that traffic came to rest here. Whatever roll it was pushed off
    // is escaped: holding it longer would preempt off an account traffic has
    // already left and returned to.
    obs.unescaped = null;
    const win = this._governingWindow(account, model);
    // Redundant with _jumped's own null check, and kept because "there is
    // nothing to record" says something different from "what was recorded is
    // unusable".
    if (win.resetAt == null) return;
    // NEVER FORWARD OVER A ROLL THIS CHOICE HAS NOT ESCAPED. The window has
    // jumped since the reading was taken, so the preemption did not stick.
    // Advancing would adopt the week the account just gained and park the fleet
    // on its furthest-dated account. Leave it, and the next request asks again.
    if (this._jumped(obs.windows, win)) return;
    // Only the window this request was governed by is ADVANCED; this request is
    // not evidence about the others. A reading that never freshens still detects
    // the next roll, measured from a value further back rather than a wrong one.
    obs.windows.set(win.window, win.resetAt);
    // A window with no entry at all is different: it has appeared on the account
    // since the reading was taken, most often a learned scoped bucket upstream
    // has just reported. Taking it now discards nothing, and is the difference
    // between seeing that window's first roll and never seeing it.
    for (const [window, reset] of Object.entries(this._accountWindows(account))) {
      if (!obs.windows.has(window)) obs.windows.set(window, reset);
    }
  }

  /**
   * The one write an aim may make, and it must discard nothing: a choice that
   * has never named an account has no roll to forget, and a reading whose
   * account has not rolled forfeits no event by moving. Refused is the case the
   * design turns on — a reading whose account HAS rolled while its traffic has
   * not come to rest elsewhere, the fail-back's only protection. The test is
   * whether ANY window rolled, since an aim discards the whole reading at once.
   */
  _firstSightOn(obs, account) {
    if (!obs || !account) return;
    if (obs.idx != null && obs.idx !== account.index) {
      // A fail-back reaches its origin through a cursor move rather than a rest:
      // the pass returning the traffic finds the cursor still on the account
      // that refused it, so _restOn never sees the arrival. The held roll is
      // given back here, to the account that still owes it.
      if (obs.unescaped?.idx === account.index) {
        obs.idx = account.index;
        obs.windows = obs.unescaped.windows;
        obs.unescaped = null;
        return;
      }
      if (this._anyJumped(obs.windows, this.accounts[obs.idx])) return;
    } else if (obs.idx != null) {
      return;
    }
    obs.idx = account.index;
    obs.windows = new Map(Object.entries(this._accountWindows(account)));
  }

  /** Has ANY window this reading holds rolled over on the account it was taken
   * on? Enumerated over what the ACCOUNT presents now rather than what the
   * reading holds: a window gained since the reading was taken has no entry to
   * compare and is a first sight, which `_jumped` reports as no jump. */
  _anyJumped(reading, account) {
    if (!reading || !account) return false;
    for (const [window, resetAt] of Object.entries(this._accountWindows(account))) {
      if (this._jumped(reading, { window, resetAt })) return true;
    }
    return false;
  }

  /** The reading for the sticky CURRENT account, taken at the top of a selection
   *  pass, before anything in that pass can move the cursor. */
  _restOnCurrent(exclude, model) {
    if (!this.expiryRouting.enabled || !this.expiryRouting.preempt) return;
    const resting = this.accounts[this.currentIndex];
    if (!resting || exclude?.has(resting.index)) return;
    this._currentObs ??= { idx: null, windows: new Map(), unescaped: null };
    this._restOn(this._currentObs, resting, model);
  }

  /** The same reading for a SESSION's pin on the bucket this request is governed
   *  by, by the same rule. Created on demand: a session that has never been
   *  pinned has nothing to observe, and one whose pin this request has already
   *  tried is looking at a failed attempt rather than a resting place. */
  _restOnPin(sessionId, bucket, exclude, model) {
    if (!this.expiryRouting.enabled || !this.expiryRouting.preempt) return;
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId, bucket);
    if (pinIdx == null || exclude?.has(pinIdx)) return;
    const account = this.accounts[pinIdx];
    if (!account) return;
    const obs = this.sessionTracker.refsFor(sessionId, bucket, true);
    if (!obs) return;
    this._restOn(obs, account, model);
  }

  /** Has this session's pin rolled over since traffic was last found resting on
   *  it? Scoped to the window `_governingWindow` names, so one family's roll is
   *  not read from another's clock, and to the account the observation names: a
   *  reading taken on one account is not evidence about another. */
  _pinRolledOver(sessionId, pinned, model) {
    const obs = this.sessionTracker.refsFor(sessionId, this._weeklyBucketFor(model));
    if (!obs || obs.idx !== pinned.index) return false;
    return this._jumped(obs.windows, this._governingWindow(pinned, model));
  }

  /** As _pinRolledOver, for the global current account. */
  _currentRolledOver(current, model) {
    const obs = this._currentObs;
    if (!obs || obs.idx !== current.index) return false;
    return this._jumped(obs.windows, this._governingWindow(current, model));
  }

  /** The comparison itself. Absent on either side is not a jump: a window
   * nothing has read yet, an account with no observation, and one the account is
   * not reporting right now are three different absences, which is why each is
   * checked rather than left to a NaN comparison. The threshold is not redundant
   * either: a window re-reported slightly later has not rolled. */
  _jumped(reading, win) {
    if (!reading) return false;
    const seen = reading.get(win.window);
    if (seen == null || win.resetAt == null) return false;
    return win.resetAt - seen > ROLLOVER_MIN_JUMP_MS;
  }

  /**
   * A rollover fired and the request stayed. Without a line the log reads the
   * same whether nothing rolled over or a rollover cannot resolve, the one
   * failure this feature can have that looks like it working. The reason comes
   * from eligibility, not from which of the re-rank's two ways of saying "stay"
   * it took: an account can be barred with no threshold behind it. This map is
   * log-grade and never decides a preemption.
   */
  _noteHeldRollover(account, model, advisorModel = null, exclude = null) {
    const window = this._governingWindow(account, model).window;
    const elsewhere = this.accounts.some(a => a.index !== account.index
      && !exclude?.has(a.index) && this._isAvailable(a, model, advisorModel));
    const reason = elsewhere ? 'ranks-best' : 'none-eligible';
    const key = `${account.index}:${window}:${reason}`;
    const now = Date.now();
    if (now < (this._rolloverHeldLogAt.get(key) || 0)) return;
    this._rolloverHeldLogAt.set(key, now + 60_000);
    console.log(`[TeamClaude] Account "${account.name}" rolled over its ${window} window ${this._heldRolloverReason(reason)}`);
  }

  /** The half of the held-rollover line that says which of the two cases it is. */
  _heldRolloverReason(reason) {
    switch (reason) {
      case 'none-eligible': return 'but no eligible account can take that traffic — still routing there';
      case 'ranks-best': return 'and still ranks best for it — staying there';
      default: return assertNever(reason, '_noteHeldRollover');
    }
  }

  /** The window a request bucket actually resolves to on this account: its own
   * when the account reports that family's utilization, the shared weekly
   * otherwise. Presence of the utilization decides it, matching _governingWeekly's
   * fallback, so the baseline a rollover is measured against names the window
   * the pressure was read from. */
  _windowForBucket(account, bucket) {
    if (bucket === 'unified7d') return bucket;
    return account.quota[bucket] == null ? 'unified7d' : bucket;
  }

  /** Every bucket a request could be governed by here: the model families' own
   * weekly buckets and the shared one, plus whatever a configured route's
   * `bucket` override names — an override can make _weeklyBucketFor return a
   * bucket the family table never mentions. */
  _windowKeys() {
    const keys = new Set(WEEKLY_BUCKET_KEYS);
    for (const route of this.routes) if (route.bucket) keys.add(route.bucket);
    return keys;
  }

  /**
   * Every named window this account presents, as { windowName: reset }. Both
   * spaces are walked because neither alone is complete: a bucket-only walk
   * cannot name `scoped:opus`, since no bucket is named for Opus. Scoped windows
   * are recorded whether or not they currently bind, because one that starts
   * binding later would otherwise be first-sighted on the very request that
   * should have caught it rolling.
   */
  _accountWindows(account) {
    const out = {};
    for (const bucket of this._windowKeys()) {
      const window = this._windowForBucket(account, bucket);
      const reset = account.quota[`${window}Reset`];
      if (reset != null) out[window] = reset;
    }
    const scoped = account.quota.scopedWeekly;
    if (scoped && typeof scoped === 'object') {
      for (const [family, b] of Object.entries(scoped)) {
        if (b?.resetAt != null) out[`scoped:${family}`] = b.resetAt;
      }
    }
    return out;
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
   * `models` ownership claim (deprecated — use `routes` instead). */
  _routeAllows(account, model) {
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
   * can use with a live eligibility flag, plus `target`: the one account it would
   * pick right now. Everything here is derived for display and thrown away — the
   * entries are fresh objects, never the stored (persisted) route definitions.
   */
  getRoutes() {
    const out = this.routes.map(r => ({
      name: r.name, match: r.match, bucket: r.bucket, color: r.color || null, autocreated: false,
      pinned: this._pinnedName(r.name),
      accounts: this._routeAccountsView(r),
      target: this._routeTarget(sampleModelFor(r)),
    }));

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
        target: this._routeTarget(d.sample),
      });
    }
    return out;
  }

  /** The name of the account a request for `model` would land on right now, or
   * null when nothing can serve it (every candidate disabled, spent or excluded). */
  _routeTarget(model) {
    const idx = this.previewRouteIndex(model);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** The name of the account this route is manually pinned to, or null. */
  _pinnedName(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** Accounts a configured route can use (all accounts when it lists none), each
   * with a live eligibility flag for a representative model of the route. */
  _routeAccountsView(route) {
    const sample = sampleModelFor(route);
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
      // Recorded on the account, not just returned. _clearExpiredQuotas is
      // reached from two directions — refreshExpiredQuotas on the request path,
      // which runs the session-reset switch rule, and _isNearQuota via
      // unavailableReason, which getStatus calls for every account on every
      // read. Whichever noticed first used to consume the event, so with a
      // dashboard polling every 5s the rule almost never ran (#275). The flag
      // outlives the observation; only the request path clears it.
      account.sessionResetPending = true;
      q.unified5h = null;
      q.unified5hReset = null;
      // `rejected` describes the shared buckets and this is one of them: a
      // 5-hour rejection must not outlive the 5-hour window it was about.
      q.unifiedStatus = null;
      q.unifiedStatusSeenAt = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      q.unifiedStatusSeenAt = null;
      changed = true;
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      q.unified7dSonnet = null;
      q.unified7dSonnetReset = null;
      q.unified7dSonnetSeenAt = null;
      changed = true;
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      q.unified7dFable = null;
      q.unified7dFableReset = null;
      q.unified7dFableSeenAt = null;
      changed = true;
    }

    // A family bucket is refreshed ONLY by upstream evidence for that family:
    // the `7d_oi` headers ride on Fable responses (they are absent from every
    // other model's response), and the Sonnet bucket comes from the usage
    // endpoint — an opt-in probe that is off by default. So once such a bucket
    // reads spent, selection stops sending that family to the account, which is
    // also the only thing that could have corrected the reading: it seals itself
    // in until its cached reset passes, up to a week of lockout on an account
    // whose real family quota reset long ago (issue #167).
    //
    // A spent family reading is therefore trusted only while it is fresh. Past
    // the staleness floor it is cleared, the family falls back to the shared
    // weekly bucket, and the next request of that family re-establishes the
    // truth from real headers — a 429 re-arms the gate with a fresh reading and
    // a fresh timestamp, so a genuinely spent bucket costs one rejected request
    // per account per window and no more. A reading with headroom is left alone:
    // it gates nothing, so it cannot seal anything in.
    for (const { key, label } of FAMILY_WEEKLY_BUCKETS) {
      if (q[key] == null || q[key] < this.thresholdFor(key)) continue;
      const seenField = `${key}SeenAt`;
      // Unknown age (restored from an older state file, or set by a path that
      // predates the stamp): start the clock now rather than clearing at once,
      // so a reading is never discarded before it has had a window to prove out.
      if (!q[seenField]) { q[seenField] = now; continue; }
      if (now < q[seenField] + this.familyStaleMs) continue;
      console.log(`[TeamClaude] Account "${account.name}" ${label} weekly reading is stale — revalidating on the next ${label} request`);
      q[key] = null;
      q[`${key}Reset`] = null;
      q[seenField] = null;
      changed = true;
    }

    // Learned scoped buckets expire with their own window like the dedicated
    // ones do: they are replaced wholesale by the next probe, but with the probe
    // off a spent reading would otherwise gate its family until the next manual
    // probe, however long ago its reset passed.
    if (q.scopedWeekly && typeof q.scopedWeekly === 'object') {
      for (const [family, b] of Object.entries(q.scopedWeekly)) {
        if (b?.resetAt && now >= b.resetAt) { delete q.scopedWeekly[family]; changed = true; }
      }
    }

    // The upstream `unified-status` is a snapshot of the last response, and
    // nothing revalidates it while the account is idle — it is cleared with the
    // weekly bucket above, but that window can be a week out. Acting on a
    // `rejected` that old would bar an account whose quota reset hours ago, so
    // the signal expires on its own and the local buckets decide from there.
    if (q.unifiedStatus != null) {
      if (!q.unifiedStatusSeenAt) q.unifiedStatusSeenAt = now;
      else if (now >= q.unifiedStatusSeenAt + this.statusStaleMs) {
        q.unifiedStatus = null;
        q.unifiedStatusSeenAt = null;
        changed = true;
      }
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
  /**
   * Clear windows whose reset has passed, WITHOUT the session-reset switch.
   *
   * For read paths. refreshExpiredQuotas() also runs _switchOnSessionReset,
   * which moves currentIndex — so calling that from getStatus would let a GET
   * on /teamclaude/status rotate the fleet as a side effect of being read, and
   * a polling dashboard would quietly drive routing.
   */
  sweepExpiredQuotas() {
    for (const account of this.accounts) this._clearExpiredQuotas(account);
  }

  refreshExpiredQuotas(model = null) {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      // The flag, not r.session: a status read may have cleared the window
      // seconds earlier, and the rule still has to run. Cleared here because
      // this is the only path that acts on it.
      if (account.sessionResetPending) {
        account.sessionResetPending = false;
        sessionReset.push(account);
      }
    }
    // The model reaches the switch only while the feature is on. Handed no
    // model, the switch runs the same `_isAvailable(acc)` it does with the knob
    // off: threading one in would make the disabled path's candidate filter
    // model-scoped, a live routing change on the path that promises none.
    if (sessionReset.length) {
      this._switchOnSessionReset(sessionReset, this.expiryRouting.enabled ? model : null);
    }
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates, model = null) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone. Read through
    // the ranking so the account is compared on the window that governs THIS
    // request; with the knob off that is the shared weekly.
    const currentReset = current && this._rankingReset(current, model);
    if (!current || currentReset == null) return;

    // Only accounts whose weekly expires sooner than the current one's are
    // candidates: the "and weekly expires sooner" half of what this function is
    // for. Kept separate from the ranking, so the ranking can change without
    // moving the trigger.
    const eligible = [];
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      // Model-scoped, because the request being routed has one: an account whose
      // Fable weekly is spent is still fully usable for Opus, and a switch that
      // ignores the model can install one the model's own picker would refuse.
      if (!this._isAvailable(acc, model)) continue; // enough session & weekly quota left
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = this._rankingReset(acc, model);
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < currentReset) eligible.push(acc);
    }
    if (!eligible.length) return;

    // One clock for every account compared, the incumbent included, as in
    // _pickLeastLoaded.
    const now = Date.now();
    const field = eligible.concat(current);
    const ranks = this._rankedPressures(field, model, now);
    const rankOf = new Map(field.map((a, i) => [a.index, ranks[i]]));

    let best = null;
    for (const acc of eligible) {
      if (!best) { best = acc; continue; }
      const mine = rankOf.get(acc.index);
      const theirs = rankOf.get(best.index);
      // Highest pressure, then soonest reset — the same order the pick uses,
      // through the same function, so the two cannot disagree about which of two
      // accounts is worth more.
      if (mine < theirs
        || (mine === theirs && this._rankedReset(acc, model) < this._rankedReset(best, model))) best = acc;
    }

    // TWO guards, different properties, neither implying the other. Band
    // membership says the account is worth spending at all. The rank comparison
    // says this switch leaves no strictly better account behind, which
    // membership does not claim once a lower tier passes through unbanded.
    if (this.expiryRouting.enabled && !this._bandedCandidates(null, model).includes(best)) return;
    // Strictly worse than what we are on: stay. Equal keeps the reset tiebreak
    // that got us here, and with expiry routing off every rank is absent and
    // equal, so this cannot fire at all.
    if (rankOf.get(best.index) > rankOf.get(current.index)) return;
    // Aiming, like every other cursor move: the reading was taken before this
    // function ran and is left where it is, so a request pushed off here and
    // failed back onto the same account still finds the roll waiting.
    this._setCurrent(best);
    this._beginRamp(best);
    console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
  }

  _isNearQuota(account, model = null) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Shared 5-hour bucket gates every request regardless of model.
    if (q.unified5h != null && q.unified5h >= this.thresholdFor('unified5h')) return true;

    // The HIGHER of the weekly bucket that GOVERNS this model and the shared
    // weekly one. Fable and Sonnet meter their own quota, so a spent Fable
    // bucket still bars only Fable and never an Opus or Sonnet request. But
    // family spend also meters into the shared bucket, so an account over its
    // overall cap is barred from the families too, which is what stops it
    // ratcheting further past that cap. When the family bucket isn't reported
    // (e.g. the plan doesn't expose it) the shared one answers alone.
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null && weeklyVal >= this.thresholdFor(this._weeklyBucketFor(model))) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.thresholdFor('tokens')) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.thresholdFor('requests')) return true;
    }

    return false;
  }

  /**
   * Pick the best available account by selection order, WITHOUT mutating state:
   *   1. lowest `priority` value (operator-controlled; default 0, lower = preferred)
   *   2. then the account with no known weekly limit — using it lets us
   *      discover its quota
   *   3. then the account with the most expiring quota (headroom per second
   *      until its window resets), when expiry routing is on
   *   4. then the account whose weekly limit expires soonest: that quota is
   *      closest to refreshing, so spending it first preserves accounts whose
   *      weekly window resets further out.
   * With expiry routing off, step 3 is absent for every account and this reduces
   * to the weekly-reset heuristic. Returns the account or null if none are
   * available. Step 3 generalises step 4: at equal headroom soonest reset is
   * highest pressure, and the two part only where a timestamp alone would rank a
   * nearly-drained account resetting in an hour over one holding 20x the quota
   * that expires in ten.
   */
  _pickBestAvailable(exclude = null, model = null, advisorModel = null) {
    let best = null;
    let bestPriority = Infinity;
    let bestPressure = Infinity;
    let bestReset = Infinity;

    const candidates = this._bandedCandidates(exclude, model, advisorModel);
    // One clock for every candidate, as in _pickLeastLoaded.
    const now = Date.now();
    const pressures = this._rankedPressures(candidates, model, now);
    candidates.forEach((account, i) => {
      const priority = account.priority || 0;
      const pressure = pressures[i];
      // Rank by the reset of the weekly window that governs THIS model (Fable and
      // Sonnet have their own, and a family can be metered by a learned scoped
      // bucket), so a Fable request spends the account whose Fable window
      // refreshes soonest while preserving accounts that reset later for
      // Opus/Sonnet. Unknown reset sorts first so we probe and fill it in.
      const weeklyReset = this._rankedReset(account, model);
      if (priority < bestPriority
          || (priority === bestPriority && pressure < bestPressure)
          || (priority === bestPriority && pressure === bestPressure && weeklyReset < bestReset)) {
        bestPriority = priority;
        bestPressure = pressure;
        bestReset = weeklyReset;
        best = account;
      }
    });
    return best;
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
    this._setCurrent(best);
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
      const previous = this._previousCursor(model, advisorModel);
      const switched = previous != null && previous !== best.index;
      // A model-scoped exclusion — the current account serves everything but
      // this request (family bucket, cap, route, or the advisor's family) —
      // diverts this request alone. The global cursor stays: the account was
      // chosen, often by hand for a weekly window about to lapse, to be spent by
      // what it can serve, and moving the whole fleet off it for one family's
      // sake undid that on the next request (#276).
      //
      // Through _setCurrent, so a move that DOES happen still records the
      // rollover baseline and ramp bookkeeping the expiry machinery reads.
      // Read before the move: the diversion log names the account being diverted
      // FROM, and _setCurrent would already have changed it.
      const current = this.accounts[this.currentIndex];
      const scoped = this._currentBarredOnlyFor(model, advisorModel, exclude);
      if (!scoped) this._setCurrent(best);
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        this._beginRamp(best);
        console.log(scoped
          ? `[TeamClaude] Diverting "${model}" to "${best.name}" — "${current.name}" cannot serve it`
          : `[TeamClaude] Switched to account "${best.name}"`);
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
      this._setCurrent(soonestAccount);
      this._beginRamp(soonestAccount);
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  /**
   * Apply a Codex response's rate-limit headers.
   *
   * Only fields the response actually stated are assigned: a reading that a
   * given response did not carry must not blank what we already knew, and the
   * catalog fetch carries none at all.
   */
  _updateCodexQuota(account, headers) {
    const parsed = parseCodexQuota(headers);
    const plan = parseCodexPlanType(headers);
    if (plan) account.quota.planType = plan;

    if (parsed.unified5h != null) account.quota.unified5h = parsed.unified5h;
    if (parsed.unified7d != null) account.quota.unified7d = parsed.unified7d;
    if (parsed.unified5hReset != null) account.quota.unified5hReset = parsed.unified5hReset;
    if (parsed.unified7dReset != null) account.quota.unified7dReset = parsed.unified7dReset;

    // A model-scoped weekly bucket is the counterpart of Anthropic's `7d_oi`
    // Fable bucket: it rides only on responses for that model, so stamp when
    // the reading was taken. That timestamp is what lets a spent bucket be
    // revalidated instead of sealing the account out of the family forever.
    for (const bucket of parsed.modelBuckets || []) {
      (account.quota.codexModelBuckets ??= {})[bucket.slug] = {
        name: bucket.name,
        utilization: bucket.utilization,
        resetAt: bucket.resetAt,
        seenAt: Date.now(),
      };
    }

    // Same handshake as the Anthropic path: the first response that reveals a
    // weekly limit ends probing and asks selection to re-evaluate.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null ? Math.round(account.quota.unified7d * 100) : null;
      console.log(`[TeamClaude] "${account.name}" near weekly quota${pct == null ? '' : ` (${pct}%)`}`);
    }
  }

  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Codex reports the same information under its own header names, so it is
    // normalised into the very fields the Anthropic path fills. Everything
    // downstream — the switch threshold, reset countdowns, the TUI bars — then
    // works unchanged rather than needing a parallel Codex-shaped path.
    if (providerOf(account) === 'codex') {
      this._updateCodexQuota(account, headers);
      return;
    }

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    // These headers ride on Fable responses only, so stamp when the reading was
    // taken: that timestamp is what lets a spent reading be revalidated instead
    // of sealing the account out of the family forever (see _clearExpiredQuotas).
    const u7dOi = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(u7dOi)) {
      account.quota.unified7dFable = u7dOi;
      account.quota.unified7dFableSeenAt = Date.now();
    }
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
    if (uStatus) {
      account.quota.unifiedStatus = uStatus;
      account.quota.unifiedStatusSeenAt = Date.now();
    }

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

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

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

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Record one upstream usage report against the account that served it and the
   * session that asked for it.
   *
   * Separate from `updateUsage` rather than folded into it: that one is on the
   * path every existing caller and test already drives, and this adds a second
   * scope (the session) whose lifetime is not the account's. Keeping them apart
   * means nothing that reads the account totals changes behaviour here.
   *
   * Nothing routes on any of this. Both the account totals and the per-session
   * ones are published for an operator to read and are not consulted by
   * selection.
   */
  recordTokenUsage(accountIndex, sessionId, model, usage) {
    if (!usage) return;
    // The same resolver routing uses, so a token total and a routing decision
    // agree about which family a request belonged to. Resolved here rather than
    // at the call sites: they parse a wire format and have no business knowing
    // about quota buckets.
    //
    // It follows that `unified7d` is not "Opus": it is the shared weekly bucket,
    // so Opus, Haiku and any model this cannot classify (absent, empty or
    // unrecognised) all land there together, exactly as they are all gated
    // there. A per-family figure is only as separable as the quota is.
    const bucket = this._weeklyBucketFor(model);
    const account = this.accounts[accountIndex];
    if (account) {
      const read = Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
      const creation = Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
      account.usage.totalCacheReadTokens += read;
      account.usage.totalCacheCreationTokens += creation;
      const per = account.usage.byBucket[bucket]
        || (account.usage.byBucket[bucket] = { cacheReadTokens: 0, cacheCreationTokens: 0 });
      per.cacheReadTokens += read;
      per.cacheCreationTokens += creation;
    }
    // A request with no session id (or one the tracker has forgotten) is still a
    // real spend by the account, so the two scopes are recorded independently.
    this.sessionTracker.recordTokens(sessionId, bucket, usage);
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      // Operator escape hatch: re-enabling is an explicit "try this again", so
      // drop the dead-token guard too — otherwise the account would come back
      // active but never attempt a refresh (see ensureTokenFresh).
      account._deadRefreshToken = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    // A failed probe carries no readings. Treating one as data would let a
    // transient HTTP error clear a bucket below.
    if (!account || !usage || usage.error) return;
    const q = account.quota;

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = usage.fiveHour.utilization;
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = usage.sevenDay.utilization;
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }

    // The family buckets carry a "last confirmed" stamp (see _clearExpiredQuotas).
    // A probe is upstream evidence just like a response header, so it refreshes
    // the stamp — this is the one path that can correct a spent family reading
    // without spending quota, which is why enabling the probe sidesteps the
    // staleness problem entirely.
    //
    // For that to hold, a probe has to be able to say "no such cap" as well as
    // "this much of it is spent". A successful probe that reports a family it
    // once reported is upstream retiring that cap (or the window never having
    // started), and leaving the old number in place would keep gating on a limit
    // that is no longer there — the exact seal-in #167 described, surviving in
    // the path meant to be its escape hatch. So a family MISSING from a payload
    // that enumerated this account's scoped weekly caps is cleared. A payload
    // that carried no such enumeration proves nothing and changes nothing.
    //
    // The reported reset is taken verbatim, null included: an unstarted window
    // has no reset, and keeping a stale one (copied from the shared weekly
    // bucket by the header path) both misdates the bar and misranks the account.
    const now = Date.now();
    for (const { key, label, usageKey } of FAMILY_WEEKLY_BUCKETS) {
      const bucket = usage[usageKey];
      const wasSpent = q[key] != null && q[key] >= this.thresholdFor(key);
      if (bucket && bucket.utilization != null) {
        q[key] = bucket.utilization;
        q[`${key}Reset`] = bucket.resetAt ?? null;
        q[`${key}SeenAt`] = now;
      } else if (!bucket && usage.scopedWeeklyListed) {
        q[key] = null;
        q[`${key}Reset`] = null;
        q[`${key}SeenAt`] = null;
      } else {
        continue;
      }
      // Worth a line: the account was refusing this family and is not any more.
      if (wasSpent && !(q[key] != null && q[key] >= this.thresholdFor(key))) {
        console.log(`[TeamClaude] Account "${account.name}" ${label} weekly quota confirmed available by probe`);
      }
    }
    // Families beyond the two with dedicated fields. Replaced wholesale rather
    // than merged: a bucket that has dropped out of the payload no longer
    // applies, and keeping a remembered copy would gate on a limit that upstream
    // has stopped reporting.
    if (usage.scopedWeekly) q.scopedWeekly = { ...usage.scopedWeekly };

    // Paid overage. Replaced wholesale like the buckets above, and announced
    // once on the transition into billing: an account that starts drawing real
    // money is the one usage change an operator cannot infer from the bars.
    if (usage.spend) {
      const was = q.spend;
      q.spend = { ...usage.spend };
      if (q.spend.enabled && !was?.enabled) {
        console.log(`[TeamClaude] Account "${account.name}" can bill real money past its plan limits (extra usage is enabled upstream)`);
      }
      const spentNow = (q.spend.usedMinor || 0) > 0;
      if (spentNow && !((was?.usedMinor || 0) > 0)) {
        console.log(`[TeamClaude] Account "${account.name}" has started spending real money: ${formatMoney(q.spend)}`);
      }
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /** Apply subscription metadata learned from the OAuth profile endpoint. */
  applyProfileData(accountIndex, profile) {
    const account = this.accounts[accountIndex];
    if (!account || !profile || profile.error) return;
    for (const field of ['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro']) {
      if (profile[field] != null) account[field] = profile[field];
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

    // Dead-token guard: a refresh token upstream already rejected (invalid_grant)
    // will be rejected every time, so retrying it only floods the OAuth endpoint
    // — observed live: 287 identical invalid_grant calls after two accounts' tokens
    // were invalidated (a `/login` elsewhere rotates the token and kills the copy
    // teamclaude holds). Paths that bypass availability checks keep calling this
    // (the quota prober refreshes every OAuth account regardless of status, and a
    // pinned request reaches here without _isAvailable), so marking the account
    // 'error' alone does not stop the retries. Keyed on the token VALUE, not the
    // status: the moment a DIFFERENT refresh token arrives (re-login, config
    // reload, updateAccountTokens) the guard lifts on its own.
    //
    // While it holds, the account must also READ as needing a re-login. A
    // re-import can hand updateAccountTokens a new access token alongside the
    // same dead refresh token; that path resets status to 'active', so without
    // this the access token's 401 would force a refresh that silently does
    // nothing here and the retry would relay the 401 to the client instead of
    // rotating to another account.
    if (account._deadRefreshToken && account._deadRefreshToken === account.refreshToken) {
      if (account.status !== 'error') {
        account.status = 'error';
        console.error(`[TeamClaude] Account "${account.name}" still holds a rejected refresh token — run: teamclaude login`);
      }
      return;
    }

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
        // Each provider mints tokens at its own endpoint with its own client
        // id, so the grant is dispatched by provider. Both return the same
        // { accessToken, refreshToken, expiresAt } shape, which is what lets
        // everything downstream stay provider-agnostic.
        const newTokens = await (providerOf(account) === 'codex'
          ? this._codexRefreshFn(account.refreshToken)
          : this._refreshFn(account.refreshToken));
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account._lastRefreshAt = Date.now();
        account._deadRefreshToken = null; // this token works; clear any stale guard
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
          // Remember WHICH token was rejected so we stop re-sending it (see the
          // dead-token guard above). A transient failure deliberately does not
          // arm this — that token may still be good.
          account._deadRefreshToken = account.refreshToken;
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
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
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
    // Same for the selection cursors: a cursor on the removed account is dropped
    // so the route re-picks, and one above it follows the shift.
    for (const [name, idx] of [...this.routeCursors.entries()]) {
      if (idx === index) this.routeCursors.delete(name);
      else if (idx > index) this.routeCursors.set(name, idx - 1);
    }
    // Session pins are positions in the same list and shift the same way, and so
    // are the rollover observations hanging off them and off the current account.
    const remap = idx => (idx === index ? null : idx > index ? idx - 1 : idx);
    this.sessionTracker.remapAccounts(remap);
    // The observation names its account by index, so it follows the shift or
    // goes away with the account it described. Left behind, it would be read
    // against whichever account inherited the slot; its held roll the same.
    const moved = this._currentObs?.idx == null ? null : remap(this._currentObs.idx);
    if (this._currentObs) {
      this._currentObs = moved == null ? null
        : { idx: moved, windows: this._currentObs.windows, unescaped: remapHeld(this._currentObs.unescaped, remap) };
    }
    // A throttle key names an account by index, so the shift would point a live
    // entry at a different account. Not worth renumbering: the entries expire in
    // a minute and dropping them can only make the next held event report sooner.
    this._rolloverHeldLogAt.clear();
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      const profile = {
        organizationType: a.organizationType,
        rateLimitTier: a.rateLimitTier,
        seatTier: a.seatTier,
        hasClaudeMax: a.hasClaudeMax,
        hasClaudePro: a.hasClaudePro,
      };
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, profile, quota };
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
      for (const field of ['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro']) {
        if (match.profile?.[field] != null) account[field] = match.profile[field];
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  // `sessionDetail` adds the per-session `sessions.items` array. Off unless the
  // operator turns on proxy.sessionDetail: the rows name every session id,
  // client and dimension value to anyone who can read status, and on a shared
  // proxy that is every key holder.
  getStatus({ sessionDetail = false } = {}) {
    // Sweep first: nothing else on the read path does, so an idle server kept
    // reporting a window whose reset had already passed — at its old percentage,
    // with a timestamp in the past — to `status --json`, anything scripted
    // against the endpoint, and the attached TUI, whose own refresh is a no-op
    // precisely because it trusts the server to have done this (#237).
    this.sweepExpiredQuotas();
    const sessions = this.sessionTracker.stats(undefined, { detail: sessionDetail });
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      // Where a request no route claims lands right now — the same derivation
      // as each route's `target`, so a status reader need not assume "the
      // current account" when that account is blocked or outranked.
      defaultTarget: this._routeTarget(null),
      switchThreshold: this.effectiveThreshold,
      // The full table when one is configured, so status output can show the
      // per-bucket values rather than only the representative number.
      switchThresholds: typeof this.switchThreshold === 'object' && this.switchThreshold
        ? { ...this.switchThreshold } : null,
      // The knob as the server resolved it, defaults and clamps applied, so an
      // operator reading status sees the configuration the router is using.
      expiryRouting: { ...this.expiryRouting },
      routes: this.getRoutes(),
      sessions: { ...sessions, distribute: this.distributeSessions, draining: this.drainingCount() },
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        orgName: a.orgName || null,
        priority: a.priority || 0,
        disabled: a.disabled || false,
        maxUsage: a.maxUsage ?? null,
        status: a.status,
        // Why the account is out of rotation right now (null = it can serve).
        // Distinguishes a local threshold decision from an upstream rejection —
        // without it the two are indistinguishable in status output (#166).
        unavailable: this.unavailableReason(a),
        sessions: sessions.perAccount[a.index] || 0,
        // Shared-weekly pressure (model-agnostic), so the ordering the router
        // works from can be read off the payload. Computed whether or not the
        // knob is on: a measurement of the fleet, not a report of the feature's
        // state.
        pressure: this._expiryPressure(a),
        quota: { ...a.quota },
        // `byBucket` is the one nested value under `usage`, so the shallow copy
        // that covers every flat counter beside it would hand the caller a live
        // reference into the account, leaving the payload half snapshot and half
        // window: its per-family figures would keep moving while every other
        // number on the same object stayed put. Every in-process reader today
        // serialises it straight away, so this holds a property rather than
        // fixing a live defect.
        usage: { ...a.usage, byBucket: copyBuckets(a.usage.byBucket) },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
        pausedUntil: a.pausedUntil && a.pausedUntil > Date.now()
          ? new Date(a.pausedUntil).toISOString()
          : null,
        entitlementDeniedUntil: a.entitlementDeniedUntil && a.entitlementDeniedUntil > Date.now()
          ? new Date(a.entitlementDeniedUntil).toISOString()
          : null,
      })),
    };
  }

  /** Return per-account quota and fleet aggregates for status clients. */
  getQuotaSummary() {
    this.refreshExpiredQuotas();
    return buildQuotaSummary(this.accounts);
  }
}
