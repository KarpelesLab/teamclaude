import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { proxyFetch } from './upstream-fetch.js';
import { envVar } from './brand.js';
import { creditCount } from './codex-usage.js';
import { LOGIN_TIMEOUT_MS, codeRace, openBrowser, pasteFromTerminal } from './login-flow.js';
import { safeLine } from './safe-text.js';
/** @typedef {import('./types.js').CodedError} CodedError */

const execFileAsync = promisify(execFile);

const DEFAULT_CREDENTIALS_PATH = '~/.claude/.credentials.json';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The login name whose Keychain item to prefer, or null where there isn't one. */
function currentUsername() {
  try { return userInfo().username || null; } catch { return null; }
}

/** Whether a Keychain payload actually carries a usable token. */
function hasToken(raw) {
  return Boolean(raw?.claudeAiOauth?.accessToken || raw?.accessToken);
}

/**
 * Read Claude Code credentials from the macOS Keychain, where Claude Code
 * stores them on darwin (there is no ~/.claude/.credentials.json on macOS).
 *
 * The service name is not unique. Claude Code has been observed leaving a stray
 * `acct="unknown"` item that holds only `mcpOAuth` alongside the real
 * `acct="<login name>"` one, and `find-generic-password -s NAME -w` returns
 * whichever the Keychain yields first. Reading the stray item makes a machine
 * with a perfectly good login look like it has no credentials at all, and the
 * import fails with a "Keychain lookup failed" that sends people off to
 * re-authenticate something that was never broken.
 *
 * So ask for the current user's item first, fall back to the service-only
 * lookup, and take the first payload that actually carries a token — a present
 * but blank `claudeAiOauth` (left behind by a logout) is skipped the same way.
 */
export async function readKeychainCredentials({ exec = execFileAsync, username = currentUsername() } = {}) {
  const base = ['find-generic-password', '-s', KEYCHAIN_SERVICE];
  const lookups = username ? [[...base, '-a', username, '-w'], [...base, '-w']] : [[...base, '-w']];

  let firstParsed = null;
  let firstErr = null;

  for (const args of lookups) {
    let parsed;
    try {
      const { stdout } = await exec('security', args);
      parsed = JSON.parse(stdout.trim());
    } catch (err) {
      firstErr ??= err;
      continue;
    }
    if (hasToken(parsed)) return parsed;
    firstParsed ??= parsed;
  }

  // Nothing had a token. Hand back whatever parsed so the caller's own
  // "no credentials" reporting stays in charge, and only throw if every
  // lookup failed outright.
  if (firstParsed) return firstParsed;
  throw firstErr ?? new Error(`no "${KEYCHAIN_SERVICE}" item found in the Keychain`);
}

/**
 * Import OAuth credentials from a Claude Code credentials file.
 *
 * On macOS Claude Code keeps its live login in the Keychain, and
 * ~/.claude/.credentials.json — when it exists at all — is a snapshot from an
 * earlier login that Claude Code never refreshes. So for the default path on
 * darwin the Keychain is asked first, and the file is only the fallback for a
 * Keychain that carries no token or cannot be read. Reading the file first made
 * a days-old snapshot look like an expired login while Claude Code itself was
 * still signed in. Any other path is a plain file read.
 */
export async function importCredentials(filePath, {
  home = homedir(), platform = process.platform, readKeychain = readKeychainCredentials } = {}) {
  const resolvedPath = filePath.replace(/^~/, home);
  const isDefaultPath = resolvedPath === DEFAULT_CREDENTIALS_PATH.replace(/^~/, home);
  const useKeychain = platform === 'darwin' && isDefaultPath;

  let raw = null;
  let keychainBlank = null; // a Keychain payload that parsed but carried no token
  let keychainErr = null;
  if (useKeychain) {
    try {
      const payload = await readKeychain();
      if (hasToken(payload)) raw = payload;
      else keychainBlank = payload;
    } catch (err) {
      keychainErr = err;
    }
  }

  if (!raw) {
    try {
      raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
    } catch (err) {
      if (!useKeychain || err.code !== 'ENOENT') throw err;
      // No file either. A token-less Keychain payload still goes back to the
      // caller, whose own "no credentials" reporting stays in charge; only a
      // Keychain that could not be read at all is an error here.
      if (keychainBlank) {
        raw = keychainBlank;
      } else {
        const detail = keychainErr ? keychainErr.message : 'no item carried a token';
        throw new Error(`${err.message}; macOS Keychain lookup for "${KEYCHAIN_SERVICE}" also failed: ${detail}`);
      }
    }
  }

  // Claude Code stores credentials nested under "claudeAiOauth"
  const data = raw.claudeAiOauth || raw;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    // Only Claude Code's own store carries this; leave the key out rather than
    // put an undefined one on every imported account.
    ...(data.refreshTokenExpiresAt != null && { refreshTokenExpiresAt: data.refreshTokenExpiresAt }),
    subscriptionType: data.subscriptionType,
    rateLimitTier: data.rateLimitTier,
  };
}

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
// `cedar_ember=1` asks the endpoint to add its banked-reset block (issue #493).
// It is additive: every other field comes back unchanged.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1';
const OAUTH_USAGE_BETA = 'oauth-2025-04-20';
// The banked-reset block is gated on the User-Agent alone, measured against
// the live endpoint: a non-Claude-Code agent reads `ineligible_reason:
// "surface"`, a claude-cli older than 2.1.280 reads `"cli_version"`. This is a
// published Claude Code release. If upstream raises the floor, the block comes
// back ineligible, bankedResets() yields null, and only the reset reading goes
// quiet; the quota buckets do not depend on it.
const USAGE_USER_AGENT = 'claude-cli/2.1.288 (external, cli)';
const DEFAULT_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Refresh an expired OAuth access token using the refresh token.
 * Retries on 5xx and network errors with exponential backoff.
 * `routing` is the account's own egress proxy (account-routing.js); null goes
 * by the fleet path (upstream proxy when configured, direct otherwise).
 * `budgetMs` bounds the whole call, retries included: no attempt goes out once
 * it is spent, and none outlives it — the time a lock held for this renewal
 * has left (credential-sync.js).
 * @param {string} refreshToken
 * @param {string} [endpoint]
 * @param {import('./account-routing.js').RoutingProxy|null} [routing]
 * @param {{ budgetMs?: number }} [opts]
 */
export async function refreshAccessToken(refreshToken, endpoint = DEFAULT_TOKEN_ENDPOINT, routing = null, { budgetMs = Infinity } = {}) {
  const maxRetries = 2;
  const baseDelayMs = 500;
  // Bound each attempt so a dead pooled socket (after a network drop/reconnect)
  // can't hang the refresh forever. A hung refresh is especially harmful here:
  // ensureTokenFresh coalesces callers into a single _refreshPromise, so one
  // stuck refresh wedges every request for that account until a restart.
  const timeoutMs = Number(envVar('REFRESH_TIMEOUT_MS')) || 30_000;
  const deadline = Date.now() + budgetMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Token refresh ran out of time');

      const res = await proxyFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: DEFAULT_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        routing,
      });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        const err = /** @type {CodedError} */ (new Error(`Token refresh failed (${res.status}): ${text}`));
        // Surface the HTTP status so callers can distinguish a genuine auth
        // rejection (the refresh token is dead — re-login needed) from a
        // transient server error. 5xx is retried above; reaching here with a 5xx
        // means retries were exhausted, which is still transient, not auth.
        err.status = res.status;
        throw err;
      }

      return tokenPairFromResponse(await res.json(), { previousRefreshToken: refreshToken });
    } catch (err) {
      const isNetworkError = err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError' ||
          err.message.includes('fetch failed') ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']
            .includes(/** @type {CodedError} */ (err).code));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * The credential fields of a token-endpoint response, checked.
 *
 * A 200 is not proof the body is usable. One without `access_token` used to be
 * stored as `accessToken: undefined` and sent upstream as `Bearer undefined`,
 * and a non-numeric expiry was stored as-is, where isTokenExpired never fired
 * on it. So a missing or empty access token is an error here, the refresh token
 * is taken only when it is a non-empty string (else the previous one is kept),
 * and the expiry is `expires_at` (seconds or milliseconds) or `expires_in`
 * seconds when either is a finite number — or one hour from now when neither
 * is, which just makes the next refresh happen early.
 */
export function tokenPairFromResponse(data, { previousRefreshToken = undefined, now = Date.now() } = {}) {
  const accessToken = data?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Token response carried no access_token');
  }
  const rotated = data.refresh_token;
  const refreshToken = typeof rotated === 'string' && rotated !== '' ? rotated : previousRefreshToken;
  const expiresIn = Number(data.expires_in);
  const expiresAt = normalizeExpiresAt(data.expires_at)
    ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3600 * 1000);
  return { accessToken, refreshToken, expiresAt };
}

/**
 * Normalize an expires_at value to milliseconds, or null when it is absent or
 * not a positive finite number — a value that cannot be compared with the clock
 * must not pass for one that can.
 * OAuth endpoints may return seconds; Claude Code credentials use milliseconds.
 */
export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const n = Number(expiresAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  // If the value is plausibly in seconds (< 10^12 ≈ year 2001 in ms, year 33658 in s),
  // convert to milliseconds
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Check if an OAuth token is expiring within the given threshold.
 *
 * No expiry at all means unknown, and the token is used until upstream says
 * otherwise. An expiry that is present but not a number is treated as already
 * reached: it cannot be trusted to lie in the future, and refreshing replaces
 * it with one that can be compared.
 */
export function isTokenExpiringSoon(expiresAt, thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  const at = normalizeExpiresAt(expiresAt);
  if (at == null) return true;
  return Date.now() + thresholdMs >= at;
}

/**
 * Check if an OAuth token has ALREADY expired (no safety margin). Used to decide
 * when a token must be refreshed synchronously before it can be injected — a
 * still-valid-but-expiring-soon token is fine to use now and refresh in the
 * background, but an expired one would 401.
 */
export function isTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  const at = normalizeExpiresAt(expiresAt);
  if (at == null) return true; // present but unusable — see isTokenExpiringSoon
  return Date.now() >= at;
}

/** Normalize the OAuth profile fields TeamClaude persists and exposes. */
export function normalizeProfile(data) {
  return {
    accountUuid: data.account?.uuid,
    email: data.account?.email,
    name: data.account?.display_name,
    orgUuid: data.organization?.uuid,
    orgName: data.organization?.name,
    organizationType: data.organization?.organization_type,
    rateLimitTier: data.organization?.rate_limit_tier,
    seatTier: data.organization?.seat_tier,
    hasClaudeMax: data.account?.has_claude_max,
    hasClaudePro: data.account?.has_claude_pro,
  };
}

/**
 * Fetch account profile for an OAuth token.
 * Returns { email, name, orgName, orgType, ... } on success,
 * or { error: 'reason' } on failure.
 * @param {string} accessToken
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the account's own egress proxy
 */
export async function fetchProfile(accessToken, routing = null) {
  try {
    const res = await proxyFetch(PROFILE_URL, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      routing,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      // Carry the status alongside the message, as fetchUsage already does:
      // a caller has to tell "this token is dead" (401) from "we could not
      // reach the endpoint" (5xx, network), and parsing that back out of the
      // string would be fragile. What the status means is decided by the
      // caller (identity.js isTokenRejection); this only reports it.
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status };
    }
    const data = await res.json();
    return normalizeProfile(data);
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

/**
 * The profile behind a credential set, renewing a stale access token first.
 *
 * An import hands over whatever Claude Code left on disk, and that access
 * token is routinely past its hour while the refresh token beside it is still
 * good. A 401 from the profile endpoint on such a token says nothing about the
 * account — the refresh token is what proves it — so the token is refreshed
 * (straight away when the clock already says it has expired, sparing the
 * doomed round trip) and the profile fetched again with the new one. The
 * credentials that come back are the ones to save: the renewed pair over every
 * other field the set came with.
 *
 * `profile.status` is then the upstream's verdict on the set as a whole, which
 * is what identity.js isTokenRejection keys on:
 *   - 401 when the credential is dead: the profile endpoint rejected the access
 *     token and there was no refresh token to renew it with, or the token
 *     endpoint rejected the refresh (400/401/403 — the same reading
 *     account-manager gives a refresh that needs a re-login);
 *   - the token endpoint's status, or null, when the refresh failed for a
 *     reason that says nothing about the token (network, 5xx after retries):
 *     the credential is unreachable, not refused, and stays importable by name.
 * A 403 is neither refreshed nor a rejection: the upstream answers 403 to a
 * valid token from an unexpected region (see egress-guard.js) and under an org
 * policy, and a new token would meet the same answer.
 *
 * @param {Record<string, any>} creds - { accessToken, refreshToken?, expiresAt?, ... }
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the
 * account's own egress proxy; every call here (the profile, and the refresh it
 * may need first) is that account's traffic. Null goes by the fleet path.
 * @param {{ renew?: (creds: Record<string, any>) => Promise<{ accessToken: string, refreshToken: string, expiresAt: number }> }} [opts]
 * renew: the refresh itself, which the caller can put behind the callback.net
 * lock (credential-sync.js refreshOutsideProxy); the default is a plain one.
 * @returns {Promise<{ creds: Record<string, any>, profile: Record<string, any> }>}
 */
export async function profileForCredentials(creds, routing = null, { renew = (c) => refreshAccessToken(c.refreshToken, undefined, routing) } = {}) {
  /** @type {Record<string, any>|null} */
  let profile = isTokenExpired(creds.expiresAt) ? null : await fetchProfile(creds.accessToken, routing);
  if (profile && profile.status !== 401) return { creds, profile };

  if (!creds.refreshToken) {
    // Nothing to renew with: the upstream's answer on the access token is final.
    profile ??= await fetchProfile(creds.accessToken, routing);
    if (profile.status === 401) {
      profile = { ...profile, error: `${profile.error}; no refresh token to renew it with` };
    }
    return { creds, profile };
  }

  let renewed;
  try {
    renewed = await renew(creds);
  } catch (err) {
    // The refresh did not go through. The upstream keeps the last word on the
    // access token itself, so one the clock wrote off is still presented once:
    // a skewed clock must not refuse a token the upstream accepts.
    profile ??= await fetchProfile(creds.accessToken, routing);
    if (profile.status !== 401) return { creds, profile };
    const e = /** @type {CodedError} */ (err);
    const rejected = e.status === 400 || e.status === 401 || e.status === 403;
    return {
      creds,
      profile: rejected
        ? { ...profile, error: `${profile.error}; token refresh rejected: ${e.message}` }
        // Not a verdict: the refresh token may well be good, so this is the
        // unreachable shape, carrying the token endpoint's status if it gave one.
        : { error: `${profile.error}; token refresh failed: ${e.message}`, status: e.status ?? null },
    };
  }

  const fresh = { ...creds, ...renewed };
  return { creds: fresh, profile: await fetchProfile(fresh.accessToken, routing) };
}

// Pull a per-model weekly limit out of the payload's `limits[]` array, which is
// where the endpoint now reports model-scoped quota (a `weekly_scoped` entry
// carrying `scope.model.display_name`). Returns a bucket-shaped object
// { utilization, resets_at } ready for normalizeUsageBucket, or null if absent.
// The legacy top-level `seven_day_<model>` keys read null on current plans.
export function findScopedWeeklyLimit(data, modelNamePattern) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const entry = limits.find((l) =>
    l && l.group === 'weekly' && l.scope?.model?.display_name
    && modelNamePattern.test(l.scope.model.display_name));
  if (!entry) return null;
  return { utilization: entry.percent, resets_at: entry.resets_at };
}

/**
 * Every model-scoped weekly limit the usage payload reports, keyed by the family
 * name the endpoint itself uses (`scope.model.display_name`, lowercased).
 *
 * The set of these buckets is upstream's to decide and it moves: alongside the
 * Fable one, a payload carries slots like seven_day_opus / seven_day_sonnet /
 * seven_day_cowork / seven_day_omelette and others that come and go. Reading the
 * names out of the response instead of hard-coding them means a family added
 * upstream is metered correctly without a release — where a hard-coded list
 * silently meters it against the SHARED weekly bucket and overshoots its cap.
 *
 * Returns { [family]: { utilization, resetAt } } — normalized, so an entry is
 * only present when the payload actually reported that bucket.
 */
export function scopedWeeklyLimits(data) {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const out = {};
  for (const l of limits) {
    if (!l || l.group !== 'weekly') continue;
    const name = l.scope?.model?.display_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const bucket = normalizeUsageBucket({ utilization: l.percent, resets_at: l.resets_at });
    if (bucket) out[name.trim().toLowerCase()] = bucket;
  }
  return out;
}

/**
 * Normalize the paid-overage ("extra usage") portion of a /api/oauth/usage
 * payload into { enabled, usedMinor, limitMinor, currency, exponent,
 * userDisabled, disabledReason }, or null when the payload said nothing about
 * spend at all.
 *
 * This is the one part of the usage payload that is not about quota. Every
 * other bucket answers "how much of the plan is left"; this answers "does
 * running out of plan stop this account, or start charging for it". An account
 * with `is_enabled` true does not refuse at its weekly limit — it keeps serving
 * and bills, so the quota bars alone cannot tell an operator that rotation onto
 * it costs money.
 *
 * `extra_usage.is_enabled` is the authority on whether billing can happen, not
 * `spend.enabled` and not the profile endpoint's `has_extra_usage_enabled`:
 * an org can have overage provisioned while the account itself cannot draw on
 * it (out of credits, or switched off by the member), and only this field
 * accounts for both. The amounts come from `spend`, which states its own
 * currency and exponent rather than assuming cents or USD.
 */
export function normalizeSpend(data) {
  const extra = data?.extra_usage;
  const spend = data?.spend;
  if ((!extra || typeof extra !== 'object') && (!spend || typeof spend !== 'object')) return null;

  const money = (m) => {
    if (!m || typeof m !== 'object') return null;
    const minor = typeof m.amount_minor === 'number' ? m.amount_minor : parseFloat(m.amount_minor);
    return Number.isFinite(minor) ? minor : null;
  };

  const usedMinor = money(spend?.used);
  const limitMinor = money(spend?.limit);
  // Prefer the currency/exponent the amounts were quoted in; fall back to the
  // extra_usage block, which describes the same wallet in its own vocabulary.
  const currency = spend?.used?.currency || spend?.limit?.currency || extra?.currency || null;
  const rawExp = spend?.used?.exponent ?? spend?.limit?.exponent ?? extra?.decimal_places;
  const exponent = Number.isFinite(rawExp) ? rawExp : 2;

  return {
    enabled: extra?.is_enabled === true,
    usedMinor,
    limitMinor,
    currency,
    exponent,
    // Distinguishes "the member turned this off" from "upstream will not allow
    // it" (no credits left, spend cap reached). Both read as not-enabled, but
    // only the first is something the operator chose and can undo.
    userDisabled: extra?.user_disabled === true,
    disabledReason: typeof extra?.disabled_reason === 'string' ? extra.disabled_reason : null,
  };
}

/**
 * Render a normalized spend record's used (and, when known, capped) amount as
 * text: "$12.34 of $10,000.00". Minor units and the exponent come from the
 * payload, so a currency that is not two-decimal formats correctly rather than
 * being silently divided by 100.
 */
export function formatMoney(spend) {
  if (!spend) return 'unknown';
  const sym = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' }[spend.currency] || '';
  const unit = (minor) => {
    if (minor == null) return null;
    const v = minor / (10 ** (spend.exponent ?? 2));
    const text = v.toLocaleString('en-US', {
      minimumFractionDigits: spend.exponent ?? 2,
      maximumFractionDigits: spend.exponent ?? 2,
    });
    // Suffix the code when there is no symbol for it, so an unfamiliar currency
    // is still identifiable rather than rendering as a bare number.
    return sym ? `${sym}${text}` : `${text}${spend.currency ? ' ' + spend.currency : ''}`;
  };
  const used = unit(spend.usedMinor);
  const limit = unit(spend.limitMinor);
  if (used == null) return limit == null ? 'unknown' : `cap ${limit}`;
  return limit == null ? used : `${used} of ${limit}`;
}

// Normalize one usage bucket from the /api/oauth/usage payload into
// { utilization: 0-1, resetAt: ms-epoch }. The endpoint reports utilization
// as a percentage in the 0-100 range, so 1 means 1%, not 100%.
export function normalizeUsageBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;

  const rawPct = bucket.used_percentage ?? bucket.utilization ?? bucket.usedPercentage;
  const parsedPct = typeof rawPct === 'number' ? rawPct : parseFloat(rawPct);
  const utilization = Number.isFinite(parsedPct)
    ? parsedPct / 100
    : null;

  const rawReset = bucket.resets_at ?? bucket.resetsAt ?? bucket.reset_at ?? bucket.resetAt;
  let resetAt = null;
  if (typeof rawReset === 'number') {
    resetAt = rawReset < 1e12 ? rawReset * 1000 : rawReset;
  } else if (typeof rawReset === 'string') {
    const asNum = Number(rawReset);
    if (Number.isFinite(asNum) && rawReset.trim() !== '') {
      resetAt = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      const parsed = Date.parse(rawReset);
      if (Number.isFinite(parsed)) resetAt = parsed;
    }
  }

  return { utilization, resetAt };
}

/**
 * Fetch OAuth subscription usage from the usage endpoint. This reports quota
 * utilization WITHOUT spending message quota, which is what makes it safe to
 * poll. Returns normalized { fiveHour, sevenDay, sevenDaySonnet, sevenDayFable } buckets
 * plus scopedWeeklyListed (whether the payload enumerated its model-scoped
 * weekly caps), or { error, status } on failure.
 * @param {string} accessToken
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the account's own egress proxy
 * @param {{ fetchImpl?: Function }} [opts]
 */
export async function fetchUsage(accessToken, routing = null, { fetchImpl = proxyFetch } = {}) {
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_USAGE_BETA,
        'Accept': 'application/json',
        'User-Agent': USAGE_USER_AGENT,
      },
      routing,
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status };
    }

    return normalizeUsagePayload(await res.json());
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

/**
 * Map a /api/oauth/usage payload to the buckets the quota model tracks. Pure, so
 * the mapping is testable without a network round trip.
 */
export function normalizeUsagePayload(data) {
  // Every model-scoped weekly cap the payload enumerated, keyed by the family
  // name upstream used. The two families with dedicated fields are read from
  // the same enumeration (the legacy seven_day_<model> keys read null on
  // current plans, so a family sourced from them alone is indistinguishable
  // from a family with no cap); `scopedWeekly` carries these and every other
  // family the payload named, so one upstream adds is metered without a release.
  const scopedWeekly = scopedWeeklyLimits(data);
  return {
    fiveHour: normalizeUsageBucket(data?.five_hour),
    sevenDay: normalizeUsageBucket(data?.seven_day),
    sevenDaySonnet: normalizeUsageBucket(data?.seven_day_sonnet) || scopedWeekly.sonnet || null,
    sevenDayFable: scopedWeekly.fable || null,
    scopedWeekly,
    // Whether this account bills real money past its plan limits, and how
    // much it already has. Carried beside the quota buckets because it comes
    // from the same zero-spend probe response.
    spend: normalizeSpend(data),
    // True when the payload carried that enumeration. It is what makes a
    // MISSING family meaningful: upstream listed this account's scoped weekly
    // caps and that family was not among them. Without the list, a missing
    // family is our own ignorance and nothing may be concluded from it.
    scopedWeeklyListed: Array.isArray(data?.limits),
    // Banked usage-limit resets (the claude.ai "Resets" offer), in the same
    // shape the Codex probe reports its free reset credits, so the status
    // line, the TUI tag and the dashboard badge read both without knowing
    // which provider the account is on.
    resetCredits: bankedResets(data?.cedar_ember),
  };
}

/**
 * The banked usage-limit resets this account holds, from the `cedar_ember`
 * block, or null when the payload says nothing usable about them. Observed
 * shape (Max account, 2026-10-04):
 *
 *   { eligible: true, ineligible_reason: null, grants: [{
 *       label, resets_total: 1, resets_left: 1,
 *       starts_at: '2026-09-22T16:00:00+00:00', ends_at: '2026-10-22T16:00:00+00:00',
 *       clears: ['five_hour', 'seven_day', ...], paused: false, usable_now: true, ... }] }
 *
 * Mapped onto the Codex counts:
 *
 *  - `available` is every reset a live grant still holds, which is what the
 *    claude.ai Resets page shows.
 *  - `applicable` is the subset upstream says can be spent this instant
 *    (`usable_now`, not `paused`); a grant whose `starts_at` is still ahead
 *    reads `usable_now: false`.
 *  - `expiresAt` is the soonest `ends_at` among the grants counted, so the
 *    displays can say when the reset lapses and drop it once it has.
 *
 * An ineligible block is null, not zero. Its reason so far has always been
 * about the caller (`surface`, `cli_version`), not the account, so "none" would
 * be a claim the payload does not make. An eligible block with no live grant is
 * a real zero: the reset was spent or has expired.
 *
 * Grant ids (and the payload's `next_grant_id`) are never read. They are the
 * handle that spends a reset, and spending one stays a manual action in
 * claude.ai or Claude Code.
 *
 * @param {any} block  the payload's `cedar_ember` object
 * @param {number} [now]  ms epoch a grant's expiry is measured against
 * @returns {{available: number, applicable: number, expiresAt: number|null}|null}
 */
export function bankedResets(block, now = Date.now()) {
  if (!block || typeof block !== 'object' || block.eligible !== true) return null;
  if (!Array.isArray(block.grants)) return null;
  let available = 0;
  let applicable = 0;
  /** @type {number|null} */
  let expiresAt = null;
  for (const grant of block.grants) {
    if (!grant || typeof grant !== 'object') continue;
    const left = creditCount(grant.resets_left);
    if (!left) continue;
    const ends = typeof grant.ends_at === 'string' ? Date.parse(grant.ends_at) : NaN;
    if (Number.isFinite(ends) && ends <= now) continue;
    available += left;
    if (grant.usable_now === true && grant.paused !== true) applicable += left;
    if (Number.isFinite(ends) && (expiresAt == null || ends < expiresAt)) expiresAt = ends;
  }
  // Re-capped after summing, for the same width budget creditCount guards.
  return { available: creditCount(available) ?? 0, applicable: creditCount(applicable) ?? 0, expiresAt };
}

// OAuth config (extracted from Claude Code). Client id + token endpoint are
// shared with the refresh path — see DEFAULT_CLIENT_ID / DEFAULT_TOKEN_ENDPOINT.
const OAUTH_AUTHORIZE = 'https://claude.ai/oauth/authorize';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const MANUAL_LOGIN_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

/**
 * Exchange an OAuth authorization code for access/refresh tokens.
 * Shared by both browser-callback and manual/paste login paths.
 * `routing` is the about-to-be-added account's own egress proxy (the login
 * CLI's --routing): the exchange and the profile fetch that follows are that
 * account's traffic too.
 * @param {string} code
 * @param {string} state
 * @param {string} codeVerifier
 * @param {string} redirectUri
 * @param {string} [tokenEndpoint]
 * @param {import('./account-routing.js').RoutingProxy|null} [routing]
 */
async function exchangeCodeForTokens(code, state, codeVerifier, redirectUri, tokenEndpoint = DEFAULT_TOKEN_ENDPOINT, routing = null) {
  const tokenRes = await proxyFetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: DEFAULT_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    routing,
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  return tokenPairFromResponse(await tokenRes.json());
}

/**
 * A paste read as an address, when it is one: anything with a scheme, and a
 * loopback address without one (some browsers hide `http://` in the address
 * bar). A `code#state` or a bare code is not an address, and gets null.
 * @param {string} text
 */
function pastedUrl(text) {
  const t = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t
    : /^(localhost|127\.0\.0\.1):\d+\//i.test(t) ? `http://${t}` : null;
  if (!withScheme) return null;
  try { return new URL(withScheme); } catch { return null; }
}

/**
 * Parse an authorization code from user input.
 * Accepts either:
 * 1. A full callback URL with ?code= and ?state= parameters (the scheme may
 *    be missing from a loopback one)
 * 2. A code#state format (manual login success page)
 * 3. A raw authorization code (falls back to using expectedState if provided)
 *
 * The two forms that carry a state must carry it, and it must be this
 * login's: a paste missing it, or from another attempt, is refused here with
 * a reason the person can act on, rather than sent to the token endpoint to
 * fail there (by then the TUI's panel has closed). A URL carrying `error` is
 * reported only after its state checks out, and the provider's text is cut
 * to one plain line, since it is printed on a terminal.
 *
 * A bare code carries no state, so the state check cannot run for that shape:
 * the code is sent with `expectedState` unchecked. PKCE still binds the
 * exchange to this process's code verifier, so a code obtained elsewhere is
 * useless to it, and a genuine one copied without its `#state` still works.
 * Exported for tests.
 *
 * @param {string} input
 * @param {string} expectedState
 * @returns {{ code: string, state: string } | null}  null for an empty paste
 */
export function parseAuthCode(input, expectedState) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  const mismatch = () => new Error('OAuth state mismatch: that code is from a different sign-in attempt. Open this link again and paste the new code');

  const url = pastedUrl(trimmed);
  if (url) {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    if (!code && !error) throw new Error('That address carries no code. Paste the code the page shows after you sign in, or the whole address it was sent to');
    if (!state) throw new Error('That address has no state. Paste the whole address, not only the code');
    if (expectedState && state !== expectedState) throw mismatch();
    if (error) {
      const description = safeLine(url.searchParams.get('error_description') || '', 200);
      throw new Error(`The sign-in was refused: ${safeLine(error, 80)}${description ? ` (${description})` : ''}`);
    }
    return { code: /** @type {string} */ (code), state };
  }

  if (trimmed.includes('#')) {
    const at = trimmed.indexOf('#');
    const code = trimmed.slice(0, at).trim();
    const state = trimmed.slice(at + 1).trim();
    if (!code || !state) throw new Error('That is not the whole code. Paste all of what the page shows, the part after the # included');
    if (expectedState && state !== expectedState) throw mismatch();
    return { code, state };
  }

  return { code: trimmed, state: expectedState };
}

/**
 * The authorize URL for one redirect. Both of a login's URLs carry the same
 * challenge and state, so either one can complete it.
 * @param {string} redirectUri
 * @param {string} codeChallenge
 * @param {string} state
 */
function buildAuthUrl(redirectUri, codeChallenge, state) {
  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', DEFAULT_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

/** Whether a paste is the address a browser reached on this login's loopback
 *  listener, as opposed to a code from the code page.
 *  @param {string} text  @param {number} port */
function isLoopbackAddress(text, port) {
  const url = pastedUrl(text);
  return url?.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && Number(url.port) === port;
}

/**
 * Start a Claude sign-in and hand back what finishing it needs.
 *
 * The token exchange must name the redirect the code was issued for, and no
 * one redirect serves both ends of the problem, so a login has up to two:
 *
 *  - loopback, http://localhost:<port>/callback: a listener on this machine.
 *    Only a browser on this machine reaches it, and then the sign-in finishes
 *    with nothing to copy. It exists only when `loopback` is set, which a
 *    caller does when it is about to open that browser itself.
 *  - manual, the console's code page: it shows `code#state` for the person to
 *    paste back. It works from any device, so it is the URL handed to the
 *    person (printed, linked, copied) in every case.
 *
 * Both URLs carry the same PKCE challenge and state, and only one code is ever
 * exchanged, so the listener and the paste can race inside one login. Each
 * answer is exchanged under the redirect it came from: a pasted
 * http://localhost:<port>/callback address (a browser that reached the page
 * but not the listener) is the loopback's, and anything else is the code
 * page's.
 *
 * Opening a browser is the caller's decision, so this never does.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.loopback]  also listen on loopback, and return the URL for a local browser
 * @param {import('./account-routing.js').RoutingProxy | null} [opts.routing]  the about-to-be-added account's own egress proxy
 * @param {AbortSignal | null} [opts.signal]  cancels the wait and closes the listener
 * @param {number} [opts.timeoutMs]  0 waits for ever
 * @param {typeof exchangeCodeForTokens} [opts.exchange]  injectable so tests need no token endpoint
 */
export async function startOAuthLogin({ loopback = true, routing = null, signal = null, timeoutMs = LOGIN_TIMEOUT_MS, exchange = exchangeCodeForTokens } = {}) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = buildAuthUrl(MANUAL_LOGIN_REDIRECT_URI, codeChallenge, state);

  const callback = loopback ? await startCallbackServer(state) : null;
  const loopbackRedirect = callback ? `http://localhost:${callback.port}/callback` : null;

  /** @param {string} text */
  const parse = text => {
    // The link this login handed out, pasted back by mistake. It even carries a
    // `code` parameter (`code=true`), which would otherwise be sent as the code
    // and burn the attempt at the token endpoint.
    const pasted = pastedUrl(text);
    if (pasted && `${pasted.origin}${pasted.pathname}` === OAUTH_AUTHORIZE) {
      throw new Error('That is the sign-in link itself. Open it in a browser, sign in, and paste the code the page shows');
    }
    const parsed = parseAuthCode(text, state);
    if (!parsed?.code) return null;
    const redirectUri = callback && loopbackRedirect && isLoopbackAddress(text, callback.port) ? loopbackRedirect : MANUAL_LOGIN_REDIRECT_URI;
    return { code: parsed.code, state: parsed.state || state, redirectUri };
  };
  const race = codeRace({
    listener: callback && loopbackRedirect ? callback.codePromise.then(code => ({ code, state, redirectUri: loopbackRedirect })) : null,
    parse,
    signal,
    timeoutMs,
    onSettle: () => callback?.server.close(),
  });
  const tokens = race.result.then(answer => {
    console.log('Exchanging authorization code for tokens...');
    return exchange(answer.code, answer.state, codeVerifier, answer.redirectUri, DEFAULT_TOKEN_ENDPOINT, routing);
  });
  // Awaited by every caller; this only stops one that failed before awaiting
  // from leaving a later rejection unhandled, which would end the process.
  tokens.catch(() => {});
  return {
    url,
    browserUrl: loopbackRedirect ? buildAuthUrl(loopbackRedirect, codeChallenge, state) : null,
    submit: race.submit,
    settled: race.settled,
    tokens,
  };
}

/**
 * `teamclaude login` on the machine with the browser: open it on the loopback
 * URL and wait for the redirect.
 *
 * On a terminal the code-page URL is printed as the fallback, and its code can
 * be pasted while the browser flow is still waiting; whichever arrives first is
 * used. Without a terminal there is nowhere to paste, so the fallback printed
 * is the loopback URL itself, as before.
 *
 * @param {{ routing?: import('./account-routing.js').RoutingProxy | null, input?: NodeJS.ReadStream }} [opts]
 *   `routing` is the about-to-be-added account's own egress proxy (login --routing).
 */
export async function loginOAuth({ routing = null, input = process.stdin } = {}) {
  const canPaste = Boolean(input.isTTY);
  const controller = new AbortController();
  const flow = await startOAuthLogin({ loopback: true, routing, signal: controller.signal });
  const browserUrl = flow.browserUrl || flow.url;

  console.log('Opening browser for authentication...');
  openBrowser(browserUrl);
  if (!canPaste) {
    console.log(`If it doesn't open, visit:\n  ${browserUrl}\n`);
    return flow.tokens;
  }
  console.log(`If it doesn't open, visit this on any device and paste the code it shows:\n  ${flow.url}\n`);
  pasteFromTerminal({
    submit: flow.submit,
    settled: flow.settled,
    prompt: 'Paste the code here (or wait for the browser): ',
    onEnd: () => controller.abort(),
    input,
  });
  return flow.tokens;
}

/**
 * `teamclaude login --token`, and `teamclaude login` on a remote session: the
 * sign-in with no browser and no listener on this machine.
 *
 * The person opens the URL on any device, signs in, and pastes back the code
 * the page shows. There is no timeout: nothing is listening, so a slow paste
 * holds nothing open. A paste that cannot be used is asked for again; the end
 * of input ends the login.
 *
 * @param {{ routing?: import('./account-routing.js').RoutingProxy | null, input?: NodeJS.ReadStream }} [opts]
 */
export async function loginOAuthWithPastedCode({ routing = null, input = process.stdin } = {}) {
  const controller = new AbortController();
  const flow = await startOAuthLogin({ loopback: false, routing, signal: controller.signal, timeoutMs: 0 });

  console.log('Authorization URL:');
  console.log(`  ${flow.url}\n`);
  console.log('Steps:');
  console.log('  1. Open the URL above in a browser (on any device)');
  console.log('  2. Log in to your Claude account');
  console.log('  3. Copy the authorization code shown on the success page');
  console.log('  4. Paste it below\n');

  pasteFromTerminal({
    submit: flow.submit,
    settled: flow.settled,
    prompt: 'Paste authorization code (or full callback URL): ',
    onEnd: () => controller.abort(new Error('No authorization code provided')),
    input,
  });
  return flow.tokens;
}

/**
 * The loopback listener the browser is redirected back to.
 *
 * Only a request carrying the expected `state` may settle the login. The state
 * is checked FIRST, and a mismatch is answered 400 without touching the
 * promise: this port is briefly open while the user is in the browser, and a
 * stray GET — a drive-by page hitting localhost ports, a scanner, a stale tab —
 * used to abort the whole login by arriving with `?error=` or with no state at
 * all. A request line Node accepts but URL cannot parse (`GET http://[::1`)
 * is a 400 as well, not an exception thrown in the proxy's process; and a
 * server error after the bind rejects the code, not the process, through the
 * 'error' listener kept for the server's whole life. How long it waits is the
 * caller's business (see codeRace), so it keeps no timer of its own.
 * Exported for tests.
 *
 * @param {string} expectedState
 * @returns {Promise<{ port: number, codePromise: Promise<string>, server: import('node:http').Server }>}
 */
export function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    /** @type {(code: string) => void} */
    let resolveCode = () => {};
    /** @type {(err: Error) => void} */
    let rejectCode = () => {};
    /** @type {Promise<string>} */
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }

      if (url.pathname === '/callback') {
        const state = url.searchParams.get('state');
        if (!state || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid request</h2><p>State mismatch. You can close this tab.</p></body></html>');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
          // Provider text, bound for a terminal: one plain line, no escapes.
          rejectCode(new Error(`OAuth error: ${safeLine(error, 80)} - ${safeLine(url.searchParams.get('error_description') || '', 200)}`));
          return;
        }

        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(302, { 'Location': 'https://platform.claude.com/oauth/code/success?app=claude-code' });
          res.end();
          resolveCode(code);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Loopback only: the redirect URI is http://localhost:<port>/callback, so
    // nothing off this machine ever has a reason to reach the listener.
    let listening = false;
    server.listen(0, '127.0.0.1', () => {
      listening = true;
      resolve({ port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, codePromise, server });
    });
    // Before the bind an error is the bind's, and nobody holds codePromise yet
    // to hear it; after, it is the login's.
    server.on('error', err => (listening ? rejectCode(err) : reject(err)));
  });
}
