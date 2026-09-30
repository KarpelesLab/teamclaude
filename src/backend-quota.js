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
// Z.ai publishes its coding plan's windows as used-percentages at a monitor
// path of its own, with its own authentication quirk (see ZAI below).

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
 * a bar for it and fall back to text for everything else.
 *
 * @typedef {{ label: string, text: string, utilization: number|null, at: number }} BackendQuota
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
    return { label: 'Plan', text, utilization: Math.max(...windows.map(w => w.used)) };
  },
};

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
      const text = symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
      // `is_available: false` means the account cannot spend, whatever the
      // number says — worth showing, since the balance alone would look fine.
      return {
        label: 'Balance',
        text: body?.is_available === false ? `${text} (unavailable)` : text,
        utilization: null,
      };
    },
  },
  // Z.ai GLM Coding Plan (international host) and its mainland twin. Same
  // monitor endpoint, same reply, same quirk: the monitor wants the raw key
  // in `Authorization`, not `Bearer <key>` — the Anthropic-shaped chat
  // endpoint on the same host accepts either, the monitor only the former.
  { host: 'api.z.ai', ...ZAI },
  { host: 'open.bigmodel.cn', ...ZAI },
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
  try {
    const res = await fetchImpl(url, {
      // A provider that names its own header shape (z.ai's monitor wants the raw
      // key) overrides the bearer default every other backend takes.
      headers: { Accept: 'application/json', ...(provider.headers ? provider.headers(account.credential) : { Authorization: `Bearer ${account.credential}` }) },
      signal,
      // The account's own egress proxy, when it has one (account-routing.js).
      routing: account.routing ?? null,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await readJsonBounded(res, RESPONSE_LIMIT);
    if (body === undefined) return { error: 'response too large' };
    const reading = provider.parse(body);
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
