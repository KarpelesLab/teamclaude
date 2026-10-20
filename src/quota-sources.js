// Built-in native quota sources for apikey accounts (account.quotaSource).
//
// These run IN-PROCESS inside the Prober — no external .sh probe, no adapter
// QUOTA_STATE_FILE, no systemd timer. Each fetch returns the same `usage` shape
// applyUsageData() consumes ({fiveHour, sevenDay}, utilizations 0-1, resets ms
// epoch) or `{ error, status }` on failure. On failure the Prober leaves the
// account's existing quota untouched (fail-safe: unknown ranks at Infinity,
// never as 0% used).
//
// Credentials are read from a config-DECLARED file (a path, never a value in
// config or logs). The file is refreshed by the owning client (cli-proxy-api
// for antigravity) — teamclaude only reads it at probe time.
//
// Sources:
//   google-antigravity — POST daily-cloudcode-pa.../v1internal:retrieveUserQuotaSummary
//   openai-codex        — GET chatgpt.com/backend-api/wham/usage
//   sakana-tokscale     — GET console.sakana.ai/billing HTML scrape

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { registerBuildFeature } from './build-identity.js';
import { fetchSubscriptionQuota } from './subscription-quota.js';

registerBuildFeature('native-quota-sources');

const ANTIGRAVITY_SUMMARY_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
// The agy/Google control-plane UA the code-assist path requires — without it the
// response omits paidTier/buckets. Same UA CLIProxyAPI's executor uses.
const ANTIGRAVITY_UA = 'antigravity/1.1.9 darwin/arm64 google-api-nodejs-client/10.3.0';

function resolvePath(p) {
  return String(p).replace(/^~/, homedir());
}

/** A Google quota bucket is remainingFraction (0-1) + ISO resetTime. Convert to
 *  the applyUsageData shape: utilization = used fraction, resetAt ms epoch. */
function bucketFromRemaining(remainingFraction, resetTime) {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) return null;
  let resetAt = null;
  if (typeof resetTime === 'string') {
    const parsed = Date.parse(resetTime);
    if (Number.isFinite(parsed)) resetAt = parsed;
  }
  return { utilization: Math.max(0, Math.min(1, 1 - remainingFraction)), resetAt };
}

async function readJson(filePath) {
  if (!filePath) return null;
  return JSON.parse(await readFile(resolvePath(filePath), 'utf-8'));
}

async function readToken(filePath) {
  const data = await readJson(filePath);
  if (!data) return null;
  // CLIProxyAPI antigravity auth file shape: { access_token, refresh_token, ... }.
  return data?.access_token || null;
}

export async function fetchGoogleAntigravityUsage(source) {
  try {
    const token = await readToken(source?.tokenFile);
    if (!token) return { error: 'google-antigravity: no access_token in tokenFile', status: null };

    const res = await fetch(ANTIGRAVITY_SUMMARY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'User-Agent': ANTIGRAVITY_UA,
      },
      body: '{}',
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

    const data = await res.json();
    const bucketMap = source?.bucketMap || { '5h': 'gemini-5h', '7d': 'gemini-weekly' };
    const found = {};
    for (const group of data?.groups || []) {
      for (const bucket of group?.buckets || []) {
        if (bucket?.bucketId === bucketMap['7d'] && !found.sevenDay) found.sevenDay = bucket;
        if (bucket?.bucketId === bucketMap['5h'] && !found.fiveHour) found.fiveHour = bucket;
      }
    }
    const usage = {
      fiveHour: bucketFromRemaining(found.fiveHour?.remainingFraction, found.fiveHour?.resetTime),
      sevenDay: bucketFromRemaining(found.sevenDay?.remainingFraction, found.sevenDay?.resetTime),
      nativeWindowProvider: 'antigravity',
      nativeWindows: (data.groups || []).flatMap(group => (group.buckets || []).flatMap(bucket => {
        const window = bucketFromRemaining(bucket.remainingFraction, bucket.resetTime);
        return window ? [{ bucketId: bucket.bucketId, usedPercent: window.utilization * 100,
          group: group.displayName || null, period: bucket.window || null,
          resetAt: window.resetAt }] : [];
      })),
    };
    if (!usage.fiveHour && !usage.sevenDay) {
      return { error: `google-antigravity: no buckets matched ${JSON.stringify(bucketMap)}`, status: null };
    }
    return usage;
  } catch (err) {
    return { error: err?.message || String(err), status: null };
  }
}

// ── openai-codex ─────────────────────────────────────────────
// GET chatgpt.com/backend-api/wham/usage with the codex access_token +
// chatgpt-account-id (from the CLIProxyAPI codex auth file). The weekly
// Preserve only windows actually returned by the provider. No synthetic 5h quota.

const CODEX_WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_UA = 'codex-quota-probe/2.0';
function secToMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < 1e12 ? v * 1000 : v;   // OpenAI resets are unix seconds → ms
}

export async function fetchCodexUsage(source) {
  try {
    const auth = await readJson(source?.tokenFile);
    if (!auth) return { error: 'openai-codex: no tokenFile', status: null };
    const tok = auth?.access_token || auth?.tokens?.access_token;
    const acc = auth?.account_id || auth?.tokens?.account_id;
    if (!tok) return { error: 'openai-codex: no access_token in tokenFile', status: null };

    const headers = {
      'Authorization': `Bearer ${tok}`,
      'originator': 'Codex Desktop',
      'User-Agent': CODEX_UA,
    };
    if (acc) headers['chatgpt-account-id'] = acc;

    const res = await fetch(CODEX_WHAM_URL, { headers });
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

    const data = await res.json();
    const windows = [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window];
    const isWindow = w => w && typeof w === 'object' && typeof w.limit_window_seconds === 'number';

    // Weekly: the window longer than 6h (this plan: primary 604800s).
    const weeklyWin = windows.find(w => isWindow(w) && w.limit_window_seconds > 21600) || null;
    const sevenDay = weeklyWin ? {
      utilization: (weeklyWin.used_percent ?? 0) / 100,
      resetAt: secToMs(weeklyWin.reset_at),
    } : null;

    // Compatibility fields for routing; display retains exact native durations.
    const fiveWin = windows.find(w => isWindow(w) && w.limit_window_seconds <= 21600) || null;
    const fiveHour = fiveWin ? {
      utilization: (fiveWin.used_percent ?? 0) / 100,
      resetAt: secToMs(fiveWin.reset_at),
    } : null;

    if (!fiveHour && !sevenDay) {
      return { error: 'openai-codex: no rate_limit windows in response', status: null };
    }
    return { fiveHour, sevenDay, nativeWindowProvider: 'codex',
      nativeWindows: windows.filter(isWindow).map(w => ({
        bucketId: `${w.limit_window_seconds / 3600}h`,
        windowSeconds: w.limit_window_seconds,
        usedPercent: typeof w.used_percent === 'number' ? w.used_percent : null,
        resetAt: secToMs(w.reset_at),
      })) };
  } catch (err) {
    return { error: err?.message || String(err), status: null };
  }
}

// ── sakana-tokscale ──────────────────────────────────────────
// Sakana exposes NO usage/quota API (confirmed by tokscale's investigation:
// github.com/junhoyeo/tokscale docs/providers/sakana.md). The only source is
// the authenticated billing console HTML at console.sakana.ai/billing, fetched
// with a session cookie. Method mirrors tokscale: fetch the page, regex-extract
// the "5-hour" and "Weekly" percentages. Cookie read from $SAKANA_SESSION_COOKIE
// (env wins, tokscale-compatible) or the config-declared cookieFile. The parse
// is layout-coupled; fail-loud semantics match the probe: empty parse + login
// redirect = auth expiry; empty without = layout drift. Both leave the account's
// existing quota untouched.

const SAKANA_BILLING_URL = 'https://console.sakana.ai/billing';
const SAKANA_UA = 'Mozilla/5.0 (X11; Linux x86_64) sakana-quota-probe/1.0';

async function readSakanaCookie(source) {
  if (typeof process !== 'undefined' && process.env?.SAKANA_SESSION_COOKIE) {
    return process.env.SAKANA_SESSION_COOKIE;
  }
  if (source?.cookieFile) {
    const raw = await readFile(resolvePath(source.cookieFile), 'utf-8');
    return raw.trim();
  }
  return null;
}

/** First `N%` within 200 chars of the label (mirrors the probe's parse_pct). */
function sakanaPercent(html, labelRe) {
  const m = html.match(new RegExp(labelRe.source + '[^%]{0,200}?([0-9]{1,3}(?:\\.[0-9]+)?)%', 'i'));
  return m ? Number(m[1]) : null;
}

export async function fetchSakanaUsage(source) {
  try {
    const cookie = await readSakanaCookie(source);
    if (!cookie) {
      return { error: 'sakana: no session cookie (cookieFile or $SAKANA_SESSION_COOKIE)', status: null };
    }
    const res = await fetch(SAKANA_BILLING_URL, {
      headers: {
        'Cookie': cookie,
        'User-Agent': SAKANA_UA,
        'Accept': 'text/html,*/*',
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`, status: res.status };
    }
    const html = await res.text();
    const p5 = sakanaPercent(html, /5-?hour/i);
    const p7 = sakanaPercent(html, /weekly/i);
    if (p5 == null && p7 == null) {
      const loginRedirect = /NEXT_REDIRECT[^"]*\/login/i.test(html);
      return {
        error: loginRedirect ? 'sakana: auth expired (billing page redirected to login)'
          : 'sakana: billing page layout drift (no quota values parsed)',
        status: null,
      };
    }
    return {
      fiveHour: p5 != null ? { utilization: p5 / 100, resetAt: null } : null,
      sevenDay: p7 != null ? { utilization: p7 / 100, resetAt: null } : null,
    };
  } catch (err) {
    return { error: err?.message || String(err), status: null };
  }
}

/** Dispatch an account's quotaSource to its built-in implementation.
 *  `ctx` may carry execution context the source needs (e.g. switchThreshold
 *  for the codex synthetic-5h cap). */
export async function fetchQuotaFor(source, ctx = {}) {
  switch (source?.type) {
    case 'cursor-subscription':
    case 'antigravity-subscription':
    case 'codex-subscription':
      return fetchSubscriptionQuota(source);
    case 'deepseek-balance':
      return fetchDeepSeekBalance(source);
    case 'google-antigravity':
      return fetchGoogleAntigravityUsage(source);
    case 'openai-codex':
      return fetchCodexUsage(source, ctx);
    case 'sakana-tokscale':
      return fetchSakanaUsage(source);
    default:
      return { error: `quotaSource: unknown type ${source?.type || '<missing>'}`, status: null };
  }
}

/** DeepSeek's balance is an amount per currency, never a session percentage. */
export async function fetchDeepSeekBalance(source) {
  try {
    if (!source?.tokenFile) return { error: 'DeepSeek balance: token file not configured', status: null };
    const token = (await readFile(resolvePath(source.tokenFile), 'utf-8')).trim();
    if (!token) return { error: 'DeepSeek balance: token file is empty', status: null };
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    // Never expose the error body: providers may echo credential material.
    if (!res.ok) return { error: `DeepSeek balance: HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    const entries = data.balance_infos;
    if (typeof data.is_available !== 'boolean' || !Array.isArray(entries) || !entries.length
        || entries.some(b => !['USD', 'CNY'].includes(b.currency)
          || ['total_balance', 'granted_balance', 'topped_up_balance'].some(k =>
            !['string', 'number'].includes(typeof b[k]) || String(b[k]).trim() === '' || !Number.isFinite(Number(b[k]))))) {
      return { error: 'DeepSeek balance: invalid balance response', status: null };
    }
    return { balance: { available: data.is_available, updatedAt: Date.now(), balances: entries.map(b => ({
      currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance,
    })) } };
  } catch {
    return { error: 'DeepSeek balance: unable to read token file or reach service', status: null };
  }
}
