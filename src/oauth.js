import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import http from 'node:http';
import { proxyFetch } from './upstream-fetch.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CREDENTIALS_PATH = '~/.claude/.credentials.json';
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
 * On macOS the default credentials location is the Keychain, not a file, so
 * when the default path is missing the Keychain is tried before giving up.
 */
export async function importCredentials(filePath, {
  home = homedir(), platform = process.platform, readKeychain = readKeychainCredentials } = {}) {
  const resolvedPath = filePath.replace(/^~/, home);
  let raw;
  try {
    raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
  } catch (err) {
    const isDefaultPath = resolvedPath === DEFAULT_CREDENTIALS_PATH.replace(/^~/, home);
    if (err.code !== 'ENOENT' || platform !== 'darwin' || !isDefaultPath) throw err;
    try {
      raw = await readKeychain();
    } catch (kcErr) {
      throw new Error(`${err.message}; macOS Keychain lookup for "${KEYCHAIN_SERVICE}" also failed: ${kcErr.message}`);
    }
  }

  // Claude Code stores credentials nested under "claudeAiOauth"
  const data = raw.claudeAiOauth || raw;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    subscriptionType: data.subscriptionType,
    rateLimitTier: data.rateLimitTier,
  };
}

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_USAGE_BETA = 'oauth-2025-04-20';
const DEFAULT_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * Refresh an expired OAuth access token using the refresh token.
 * Retries on 5xx and network errors with exponential backoff.
 */
export async function refreshAccessToken(refreshToken, endpoint = DEFAULT_TOKEN_ENDPOINT) {
  const maxRetries = 2;
  const baseDelayMs = 500;
  // Bound each attempt so a dead pooled socket (after a network drop/reconnect)
  // can't hang the refresh forever. A hung refresh is especially harmful here:
  // ensureTokenFresh coalesces callers into a single _refreshPromise, so one
  // stuck refresh wedges every request for that account until a restart.
  const timeoutMs = Number(process.env.TEAMCLAUDE_REFRESH_TIMEOUT_MS) || 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

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
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        const err = new Error(`Token refresh failed (${res.status}): ${text}`);
        // Surface the HTTP status so callers can distinguish a genuine auth
        // rejection (the refresh token is dead — re-login needed) from a
        // transient server error. 5xx is retried above; reaching here with a 5xx
        // means retries were exhausted, which is still transient, not auth.
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: normalizeExpiresAt(data.expires_at) || (Date.now() + (data.expires_in || 3600) * 1000),
      };
    } catch (err) {
      const isNetworkError = err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError' ||
          err.message.includes('fetch failed') ||
          (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
           err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT'));

      if (attempt < maxRetries && isNetworkError) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Normalize an expires_at value to milliseconds.
 * OAuth endpoints may return seconds; Claude Code credentials use milliseconds.
 */
export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return expiresAt;
  // If the value is plausibly in seconds (< 10^12 ≈ year 2001 in ms, year 33658 in s),
  // convert to milliseconds
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

/**
 * Check if an OAuth token is expiring within the given threshold.
 */
export function isTokenExpiringSoon(expiresAt, thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs >= normalizeExpiresAt(expiresAt);
}

/**
 * Check if an OAuth token has ALREADY expired (no safety margin). Used to decide
 * when a token must be refreshed synchronously before it can be injected — a
 * still-valid-but-expiring-soon token is fine to use now and refresh in the
 * background, but an expired one would 401.
 */
export function isTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() >= normalizeExpiresAt(expiresAt);
}

export function needsProxyClientCredential(credentials, now = Date.now()) {
  if (!credentials?.accessToken) return true;
  if (!credentials.expiresAt) return false;
  return normalizeExpiresAt(credentials.expiresAt) <= now;
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
 */
export async function fetchProfile(accessToken) {
  try {
    const res = await proxyFetch(PROFILE_URL, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}` };
    }
    const data = await res.json();
    return normalizeProfile(data);
  } catch (err) {
    return { error: err.message || String(err) };
  }
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
 */
export async function fetchUsage(accessToken) {
  try {
    const res = await proxyFetch(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_USAGE_BETA,
        'Accept': 'application/json',
      },
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
  };
}

// OAuth config (extracted from Claude Code). Client id + token endpoint are
// shared with the refresh path — see DEFAULT_CLIENT_ID / DEFAULT_TOKEN_ENDPOINT.
const OAUTH_AUTHORIZE = 'https://claude.ai/oauth/authorize';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const MANUAL_LOGIN_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

/**
 * Exchange an OAuth authorization code for access/refresh tokens.
 * Shared by both browser-callback and manual/paste login paths.
 */
async function exchangeCodeForTokens(code, state, codeVerifier, redirectUri, tokenEndpoint = DEFAULT_TOKEN_ENDPOINT) {
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
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokens = await tokenRes.json();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: normalizeExpiresAt(tokens.expires_at) || (Date.now() + (tokens.expires_in || 3600) * 1000),
  };
}

/**
 * Parse an authorization code from user input.
 * Accepts either:
 * 1. A full callback URL with ?code= and ?state= parameters
 * 2. A code#state format (manual login success page)
 * 3. A raw authorization code (falls back to using expectedState if provided)
 *
 * A bare code carries no state, so the state check cannot run for that shape:
 * the code is sent with `expectedState` unchecked. PKCE still binds the
 * exchange to this process's code verifier, so a code obtained elsewhere is
 * useless to it. Exported for tests.
 */
export function parseAuthCode(input, expectedState) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try to parse as a URL with ?code= parameter
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code) {
      if (expectedState && state && state !== expectedState) {
        throw new Error('OAuth state mismatch');
      }
      return { code, state: state || expectedState };
    }
  } catch (e) {
    if (e.message === 'OAuth state mismatch') throw e;
  }

  // Try to parse as code#state format (manual login)
  if (trimmed.includes('#')) {
    const parts = trimmed.split('#');
    const code = parts[0].trim();
    const state = parts[1]?.trim();
    if (code) {
      if (expectedState && state && state !== expectedState) {
        throw new Error('OAuth state mismatch');
      }
      return { code, state: state || expectedState };
    }
  }

  // Treat as raw authorization code
  return { code: trimmed, state: expectedState };
}

/**
 * Perform OAuth login via browser with PKCE flow.
 * Opens the user's browser, waits for the callback, exchanges the code for tokens.
 */
export async function loginOAuth() {
  // Generate PKCE
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  // Start local callback server on a random port
  const { port, codePromise, server } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${port}/callback`;

  // Build authorization URL
  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', DEFAULT_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Open browser
  console.log('Opening browser for authentication...');
  console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  // Wait for either the callback server or manual paste from stdin
  let code;
  try {
    code = await raceWithStdinCode(codePromise, state);
  } finally {
    server.close();
  }

  // Exchange code for tokens
  console.log('Exchanging authorization code for tokens...');
  return exchangeCodeForTokens(code, state, codeVerifier, redirectUri);
}

/**
 * Perform OAuth login via manual copy/paste (no local callback server).
 * User opens the authorization URL on any device, logs in, and pastes back
 * the authorization code shown on the success page. Useful for headless
 * machines, remote servers, or when localhost callbacks are unavailable.
 */
export async function loginOAuthWithPastedCode() {
  // Generate PKCE
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const redirectUri = MANUAL_LOGIN_REDIRECT_URI;

  // Build authorization URL
  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', DEFAULT_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Display the authorization URL
  console.log('Authorization URL:');
  console.log(`  ${authUrl.toString()}\n`);
  console.log('Steps:');
  console.log('  1. Open the URL above in a browser (on any device)');
  console.log('  2. Log in to your Claude account');
  console.log('  3. Copy the authorization code shown on the success page');
  console.log('  4. Paste it below\n');

  // Prompt for manual paste
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const input = await new Promise(resolve => {
    rl.question('Paste authorization code (or full callback URL): ', resolve);
  });
  rl.close();

  // Parse the input
  const parsed = parseAuthCode(input, state);
  if (!parsed || !parsed.code) {
    throw new Error('No authorization code provided');
  }

  // Exchange code for tokens
  console.log('Exchanging authorization code for tokens...');
  return exchangeCodeForTokens(parsed.code, parsed.state, codeVerifier, redirectUri);
}

/**
 * Race the callback server promise against manual code entry from stdin.
 * The user can paste the full callback URL or just the authorization code.
 */
function raceWithStdinCode(callbackPromise, expectedState) {
  if (!process.stdin.isTTY) return callbackPromise;

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      rl.close();
      fn(val);
    };

    rl.question('Paste authorization code here (or wait for browser callback): ', answer => {
      if (!answer.trim()) return; // empty input, keep waiting for callback

      try {
        const parsed = parseAuthCode(answer, expectedState);
        if (parsed?.code) {
          settle(resolve, parsed.code);
        }
      } catch (err) {
        settle(reject, err);
      }
    });

    callbackPromise.then(
      code => settle(resolve, code),
      err => settle(reject, err),
    );
  });
}

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
          rejectCode(new Error(`OAuth error: ${error} - ${url.searchParams.get('error_description') || ''}`));
          return;
        }

        if (expectedState && state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>State mismatch. You can close this tab.</p></body></html>');
          rejectCode(new Error('OAuth state mismatch'));
          return;
        }

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

    server.listen(0, () => {
      resolve({ port: server.address().port, codePromise, server });
    });
    server.on('error', reject);

    // Timeout after 2 minutes (unref so it doesn't keep the process alive)
    const timer = setTimeout(() => {
      rejectCode(new Error('Login timed out after 2 minutes'));
      server.close();
    }, 120_000);
    timer.unref();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}
