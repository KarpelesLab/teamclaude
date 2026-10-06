// Quota/balance readings for THIRD-PARTY backend accounts.
//
// This is the only file that knows a specific provider exists. Everything else
// — the prober that schedules the call, the quota field that stores it, the
// renderer that draws it — handles a normalized reading and never names a
// vendor. Adding a provider is one entry in PROVIDERS; nothing else changes.
//
// Why it cannot be generic all the way down: Anthropic publishes utilization on
// every response through `anthropic-ratelimit-*` headers, and the OAuth usage
// endpoint on top. No other provider we route to does. DeepSeek answers with a
// dollar balance at its own path and its own JSON shape; a provider that
// reports nothing simply has no entry and reads as unknown, exactly as now.
// NanoGPT publishes its subscription windows and its own billing advice.
// Z.ai publishes its coding plan's windows as used-percentages at a monitor
// path of its own, with its own authentication quirk (see ZAI below).
// Kimi reports windows as ratios that lag behind its own counters (see
// kimiResolve); Moonshot's open platform answers with a balance alone.

import { proxyFetch } from './upstream-fetch.js';
import { safeLine } from './safe-text.js';

// A balance reply is a few hundred bytes. The host it comes from is whatever
// `account.upstream` names, so bound the read the way server.js bounds a
// diagnostic error body: a hostile or broken backend must not be able to make
// the proxy buffer an arbitrary response on every probe cycle.
const RESPONSE_LIMIT = 64 * 1024;

/**
 * A normalized reading. `text` is what the operator reads; `utilization` is set
 * only when a provider actually reports a 0-1 fraction, so a renderer can draw
 * a bar for it and fall back to text for everything else. `windows` carries the
 * same utilization per machine-readable window when the provider reports
 * distinct ones, so /teamclaude/quota can bucket it; a balance-only provider
 * has none.
 *
 * @typedef {{ utilization: number, resetAt: number|null }} BackendQuotaWindow
 * @typedef {{ fiveHour?: BackendQuotaWindow, weekly?: BackendQuotaWindow, monthly?: BackendQuotaWindow }} BackendQuotaWindows
 * @typedef {{ label: string, text: string, utilization: number|null, at: number, windows?: BackendQuotaWindows }} BackendQuota
 */

// Z.ai publishes the coding plan's windows at /api/monitor/usage/quota/limit:
// `{ code, data: { level, limits: [...] } }`, where each TOKENS_LIMIT row is one
// window — `unit: 3, number: 5` the five-hour one, `unit: 6, number: 1` the
// weekly one — carrying `percentage` (0-100, used) and `nextResetTime` (ms). A
// TIME_LIMIT row is the monthly MCP-tool allowance and is not a token quota,
// so it is left out. Both windows go into one reading: the bar is the fuller
// of the two — the one that decides whether the account can serve — and the
// text names each with its reset.
const ZAI = {
  path: '/api/monitor/usage/quota/limit',
  headers: (/** @type {string} */ credential) => ({ Authorization: credential, 'Accept-Language': 'en-US,en' }),
  parse(/** @type {any} */ body) {
    const limits = Array.isArray(body?.data?.limits) ? body.data.limits : null;
    if (!limits) return null;
    /** @type {Array<{ name: string, used: number, resetAt: number|null }>} */
    const windows = [];
    for (const row of limits) {
      if (row?.type !== 'TOKENS_LIMIT') continue;
      const pct = Number(row.percentage);
      if (!Number.isFinite(pct)) continue;
      const name = row.unit === 3 && row.number === 5 ? '5h'
        : row.unit === 6 && row.number === 1 ? 'week'
        : null;
      if (!name) continue;
      const reset = Number(row.nextResetTime);
      windows.push({ name, used: Math.min(1, Math.max(0, pct / 100)), resetAt: Number.isFinite(reset) && reset > 0 ? reset : null });
    }
    if (!windows.length) return null;
    const text = windows.map(w => {
      const until = w.resetAt ? formatUntil(w.resetAt - Date.now()) : '';
      return `${w.name} ${Math.round(w.used * 100)}%${until ? ` (resets ${until})` : ''}`;
    }).join(' · ');
    /** @type {BackendQuotaWindows} */
    const structured = {};
    for (const w of windows) {
      if (w.name === '5h') structured.fiveHour = { utilization: w.used, resetAt: w.resetAt };
      else if (w.name === 'week') structured.weekly = { utilization: w.used, resetAt: w.resetAt };
    }
    return { label: 'Plan', text, utilization: Math.max(...windows.map(w => w.used)), windows: structured };
  },
};

// `-$3.00`, not `$-3.00` — the minus leads the symbol.
const moneyText = (/** @type {string} */ symbol, /** @type {number} */ amount) =>
  amount < 0 ? `-${symbol}${Math.abs(amount).toFixed(2)}` : `${symbol}${amount.toFixed(2)}`;

// The console's account report: undocumented, but it answers on both the
// global and the mainland host — the mainland one on www.bigmodel.cn, which
// open.bigmodel.cn does not serve. A subscription account simply reads zero.
// `availableBalance` wins over `balance`, with an explicit null check first:
// Number(null) is 0 and would silently read as an empty account.
const zaiBalance = (/** @type {string} */ symbol, /** @type {string|undefined} */ origin = undefined) => ({
  url: (/** @type {string} */ upstream) => new URL('/api/biz/account/query-customer-account-report', origin ?? upstream).toString(),
  parse(/** @type {any} */ body) {
    if (body?.success !== true) return null;
    const data = body?.data && typeof body.data === 'object' ? body.data : {};
    const available = data.availableBalance === null || data.availableBalance === undefined ? NaN : Number(data.availableBalance);
    const current = data.balance === null || data.balance === undefined ? NaN : Number(data.balance);
    const amount = Number.isFinite(available) ? available : Number.isFinite(current) ? current : null;
    if (amount === null) return null;
    return { amount, text: moneyText(symbol, amount) };
  },
});

// Moonshot Open Platform (pay-as-you-go, the kimi.com coding subscription is
// a different keyspace): the balance is the whole reading. The currency
// follows the region — .ai bills USD, .cn CNY — and a negative cash balance
// is a deficit in collection, worth saying beside the number.
const moonshot = (/** @type {string} */ symbol) => ({
  path: '/v1/users/me/balance',
  parse(/** @type {any} */ body) {
    if (body?.status !== true || body?.code !== 0) return null;
    const raw = body?.data?.available_balance;
    const balance = raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(balance)) return null;
    const cash = Number(body?.data?.cash_balance);
    const deficit = Number.isFinite(cash) && cash < 0 ? ` · ${moneyText(symbol, Math.abs(cash))} in deficit` : '';
    return { label: 'Balance', text: `${moneyText(symbol, balance)}${deficit}`, utilization: null };
  },
});

// `2h10m`, `3d4h`, `now` — the shape the rest of the status screen uses for a
// reset countdown, without importing the TUI to get it.
function formatUntil(/** @type {number} */ ms) {
  if (!(ms > 0)) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
}

// A Kimi ratio pool: `{ used_ratio, reset_time }`. A ratio that is not a
// non-negative number is no reading at all — the caller falls back to the
// legacy counters.
function kimiRatio(/** @type {any} */ pool) {
  if (!pool || typeof pool !== 'object') return null;
  // Number(null) and Number('') are both 0 — an absent ratio must not read
  // as a real zero, or it would outrank a counter that did move.
  const raw = pool.used_ratio;
  const ratio = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  const reset = Date.parse(pool.reset_time);
  return { utilization: Math.min(1, ratio), resetAt: Number.isFinite(reset) ? reset : null };
}

// A Kimi legacy counter: `{ limit, used, remaining, resetTime }`, numbers as
// strings. `used` is authoritative and may exceed the limit in overage;
// `remaining` is the fallback when it is absent. `reliable` is false when
// neither parses — such a counter reads as 0% but cannot substitute for a
// stuck ratio.
function kimiCount(/** @type {any} */ detail) {
  if (!detail || typeof detail !== 'object') return null;
  const limit = Number(detail.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const u = detail.used === null || detail.used === undefined ? NaN : Number(detail.used);
  const rem = detail.remaining === null || detail.remaining === undefined ? NaN : Number(detail.remaining);
  let used = 0;
  let reliable = false;
  if (Number.isFinite(u) && u >= 0) { used = u; reliable = true; } else if (Number.isFinite(rem) && rem >= 0 && rem <= limit) { used = limit - rem; reliable = true; }
  const reset = Date.parse(detail.resetTime);
  return { utilization: Math.min(1, Math.max(0, used / limit)), used, reliable, resetAt: Number.isFinite(reset) ? reset : null };
}

// Kimi's ratio pools lag behind an active session: they read 0 while the
// legacy counters move. A zero ratio beside a moved, reliable counter with
// (almost) the same reset — the two clocks run ~1s apart — is a placeholder,
// not a reading, and the counter wins. A monthly pool marks an account whose
// ratios are real and suppresses the fallback, and the weekly counter must
// parse for either fallback to fire. Rule mirrored from CodexBar.
function kimiResolve(
  /** @type {{ utilization: number, resetAt: number|null }|null} */ ratio,
  /** @type {{ utilization: number, used: number, reliable: boolean, resetAt: number|null }|null} */ count,
  /** @type {{ reliable: boolean }|null} */ weeklyCount,
  /** @type {boolean} */ hasMonthly,
) {
  if (ratio && ratio.utilization === 0 && !hasMonthly
      && weeklyCount?.reliable
      && count && count.used > 0
      && count.resetAt != null && ratio.resetAt != null
      && Math.abs(count.resetAt - ratio.resetAt) <= 2000) {
    return count;
  }
  // A counter that did not parse is no reading at all — the account shows
  // nothing rather than an invented 0%.
  return ratio ?? (count && count.reliable ? count : null);
}

const KIMI = {
  path: '/coding/v1/usages',
  parse(/** @type {any} */ body) {
    const pools = body?.usages && typeof body.usages === 'object' ? body.usages : {};
    const monthly = kimiRatio(pools.limit_month_total);
    const weeklyCount = kimiCount(body?.usage);
    // The 5h counter is the limits[] entry whose window is 300 minutes,
    // however the reply spells the unit.
    const multiplier = /** @type {Record<string, number>} */ ({ TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 });
    const sessionEntry = Array.isArray(body?.limits)
      ? body.limits.find((/** @type {any} */ e) => Number(e?.window?.duration) * (multiplier[String(e?.window?.timeUnit)] || 0) === 300)
      : null;
    // Plans differ in which windows they carry — the newer ones drop the
    // weekly pool for a monthly one. Once the reply has pools, a window it
    // does not name does not exist, and a legacy counter may only stand in
    // for a pool that is named; a reply without pools is the legacy format,
    // where the counters are the only source.
    const hasPools = body?.usages && typeof body.usages === 'object';
    const named = (/** @type {string} */ key) => !hasPools || key in pools;
    const fiveHour = named('limit_5h')
      ? kimiResolve(kimiRatio(pools.limit_5h), kimiCount(sessionEntry?.detail), weeklyCount, monthly != null) : null;
    const weekly = named('limit_7d')
      ? kimiResolve(kimiRatio(pools.limit_7d), weeklyCount, weeklyCount, monthly != null) : null;
    /** @type {BackendQuotaWindows} */
    const windows = {};
    const parts = [];
    for (const [key, name, w] of /** @type {const} */ ([['fiveHour', '5h', fiveHour], ['weekly', 'week', weekly], ['monthly', 'month', monthly]])) {
      if (!w) continue;
      windows[key] = { utilization: w.utilization, resetAt: w.resetAt };
      const until = w.resetAt ? formatUntil(w.resetAt - Date.now()) : '';
      parts.push(`${name} ${Math.round(w.utilization * 100)}%${until ? ` (resets ${until})` : ''}`);
    }
    if (!parts.length) return null;
    return { label: 'Plan', text: parts.join(' · '), utilization: Math.max(...Object.values(windows).map(w => w.utilization)), windows };
  },
};

/**
 * @typedef {Object} BackendQuotaProvider
 * @property {string} host  the upstream host this entry answers for (exact match)
 * @property {string} path  the quota endpoint, resolved against the upstream origin
 * @property {(credential: string) => Record<string, string>} [headers]  the auth header shape, when it is not `Authorization: Bearer`
 * @property {(body: any) => ({ label: string, text: string, utilization: number|null, windows?: BackendQuotaWindows } | null)} parse  the normalized reading, or null for a reply it does not recognize
 * @property {{ url: (upstream: string) => string, parse: (body: any) => ({ amount: number, text: string } | null) }} [balance]  a pay-as-you-go balance endpoint, fetched best-effort after the quota one
 */

/** @type {BackendQuotaProvider[]} */
const PROVIDERS = [
  {
    // DeepSeek: the Anthropic-compatible endpoint lives under /anthropic on the
    // same origin as the account API, so the balance path is resolved against
    // the configured upstream rather than hardcoded — a regional or proxied
    // host keeps working.
    host: 'api.deepseek.com',
    path: '/user/balance',
    parse(/** @type {any} */ body) {
      const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null;
      if (!info) return null;
      const amount = Number(info.total_balance);
      if (!Number.isFinite(amount)) return null;
      // `currency` is the one string in the reply that reaches the operator's
      // terminal (via status-renderer) verbatim when it is not USD/CNY, so it
      // is stripped and bounded like every other externally sourced string.
      const currency = safeLine(String(info.currency || ''), 8).toUpperCase();
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
      const text = symbol ? moneyText(symbol, amount) : `${moneyText('', amount)} ${currency}`;
      // `is_available: false` means the account cannot spend, whatever the
      // number says — worth showing, since the balance alone would look fine.
      return {
        label: 'Balance',
        text: body?.is_available === false ? `${text} (unavailable)` : text,
        utilization: null,
      };
    },
  },
  {
    // NanoGPT subscription: GET /api/subscription/v1/usage answers with the
    // plan's token windows as USED FRACTIONS (`percentUsed`, 0-1, and it "may
    // exceed 1") each with a `resetAt` in epoch milliseconds, plus `routing`,
    // the gateway's own advice on whether the next request is served from the
    // subscription or billed to the pay-as-you-go balance. That advice is the
    // part worth showing: a subscription that has run out does not stop, it
    // starts spending. The reply is bearer- or x-api-key-authenticated, so the
    // default bearer header applies. The path is absolute on purpose — the
    // Anthropic endpoint lives under /api and the usage one beside it.
    host: 'api.nano-gpt.com',
    path: '/api/subscription/v1/usage',
    parse(/** @type {any} */ body) {
      if (!body || typeof body !== 'object' || typeof body.active !== 'boolean') return null;
      if (!body.active) {
        return { label: 'Plan', text: `subscription ${safeLine(String(body.state || 'inactive'), 16)}`, utilization: null };
      }
      /** @type {Array<{ name: string, used: number, resetAt: number|null, degraded: boolean }>} */
      const windows = [];
      // A token-based trial reports one `tokens` window instead of daily/weekly.
      for (const [name, w] of [['day', body.dailyInputTokens], ['week', body.weeklyInputTokens], ['trial', body.tokens]]) {
        if (!w || typeof w !== 'object') continue;
        const used = Number(w.percentUsed);
        if (!Number.isFinite(used) || used < 0) continue;
        const reset = Number(w.resetAt);
        windows.push({ name: /** @type {string} */ (name), used, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, degraded: w.degraded === true });
      }
      if (!windows.length) return null;
      const parts = windows.map(w => {
        const until = w.resetAt ? formatUntil(w.resetAt - Date.now()) : '';
        return `${w.degraded ? '~' : ''}${w.name} ${Math.round(w.used * 100)}%${until ? ` (resets ${until})` : ''}`;
      });
      // Only the two non-default advice values are worth a word; 'subscription'
      // is the normal case and stays silent.
      const mode = body.routing?.recommendedMode;
      if (mode === 'paygo') parts.push(body.routing?.paidSpendPolicyAllowsBalance === false ? 'balance not allowed' : 'billing balance');
      else if (mode === 'unavailable') parts.push('unavailable');
      if (body.state === 'grace') parts.push('grace period');
      return {
        label: 'Plan',
        text: parts.join(' · '),
        utilization: Math.min(1, Math.max(...windows.map(w => w.used))),
      };
    },
  },
  // Z.ai GLM Coding Plan (international host) and its mainland twin. Same
  // monitor endpoint, same reply, same quirk: the monitor wants the raw key
  // in `Authorization`, not `Bearer <key>` — the Anthropic-shaped chat
  // endpoint on the same host accepts either, the monitor only the former.
  // The balance report sits on the console path; for the mainland plan that
  // is www.bigmodel.cn, not the API host.
  { host: 'api.z.ai', ...ZAI, balance: zaiBalance('$') },
  { host: 'open.bigmodel.cn', ...ZAI, balance: zaiBalance('¥', 'https://www.bigmodel.cn') },
  // Kimi for Coding (Moonshot), China and international hosts: same usages
  // endpoint, default bearer. The endpoint rides under /coding on the same
  // origin, so an upstream of https://api.kimi.com/coding resolves correctly.
  { host: 'api.kimi.com', ...KIMI },
  { host: 'api.kimi.ai', ...KIMI },
  { host: 'api.moonshot.ai', ...moonshot('$') },
  { host: 'api.moonshot.cn', ...moonshot('¥') },
];

/**
 * The provider entry for an upstream URL, or null when we know of none.
 *
 * @param {string|null|undefined} upstream
 */
export function providerFor(upstream) {
  if (!upstream || typeof upstream !== 'string') return null;
  let host;
  try { host = new URL(upstream).host.toLowerCase(); } catch { return null; }
  return PROVIDERS.find(p => host === p.host || host.endsWith(`.${p.host}`)) || null;
}

/**
 * True when this account has a backend reading we know how to fetch.
 *
 * @param {Record<string, any>|null|undefined} account
 */
export function hasBackendQuota(account) {
  return !!account?.upstream && !!providerFor(account.upstream);
}

/**
 * Read one backend's quota. Returns a normalized reading, or `{ error }` — the
 * caller records the failure rather than guessing, and never clears a value it
 * could not refresh.
 *
 * @returns {Promise<BackendQuota | { error: string } | null>}
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function fetchBackendQuota(account, { fetchImpl = proxyFetch, timeoutMs = 10_000 } = {}) {
  const provider = providerFor(account?.upstream);
  if (!provider || !account?.credential) return null;

  const url = new URL(provider.path, account.upstream).toString();
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    Accept: 'application/json',
    // A provider that names its own header shape (z.ai's monitor wants the raw
    // key) overrides the bearer default every other backend takes.
    ...(provider.headers ? provider.headers(account.credential) : { Authorization: `Bearer ${account.credential}` }),
  };
  try {
    const res = await fetchImpl(url, {
      headers,
      signal,
      // The account's own egress proxy, when it has one (account-routing.js).
      routing: account.routing ?? null,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await readJsonBounded(res, RESPONSE_LIMIT);
    if (body === undefined) return { error: 'response too large' };
    let reading = provider.parse(body);
    if (provider.balance) {
      // Best-effort: a failing balance service must not discard the quota
      // reading, and its own short deadline bounds the delay it adds. Only a
      // non-zero balance may stand in for a plan reply without windows: a
      // zero is what a healthy subscription account reads, and '$0.00' would
      // mask the monitor having said nothing we understand.
      try {
        const bres = await fetchImpl(provider.balance.url(account.upstream), {
          headers,
          signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
          routing: account.routing ?? null,
        });
        const bbody = bres.ok ? await readJsonBounded(bres, RESPONSE_LIMIT) : undefined;
        const balance = bbody === undefined ? null : provider.balance.parse(bbody);
        if (balance && balance.amount !== 0) {
          if (reading) reading = { ...reading, text: `${reading.text} · balance ${balance.text}` };
          else reading = { label: 'Balance', text: balance.text, utilization: null };
        }
      } catch { /* the quota reading stands on its own */ }
    }
    return reading ? { ...reading, at: Date.now() } : { error: 'unrecognized response' };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Parse a JSON response body of at most `limit` bytes; `undefined` when it is
 * larger (declared or actual). A response without a readable stream (a test
 * double) falls back to `json()`.
 * @param {any} res
 * @param {number} limit
 */
async function readJsonBounded(res, limit) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (typeof res.body?.getReader !== 'function') return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
