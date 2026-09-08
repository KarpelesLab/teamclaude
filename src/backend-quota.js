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

const PROVIDERS = [
  {
    // DeepSeek: the Anthropic-compatible endpoint lives under /anthropic on the
    // same origin as the account API, so the balance path is resolved against
    // the configured upstream rather than hardcoded — a regional or proxied
    // host keeps working.
    host: 'api.deepseek.com',
    path: '/user/balance',
    parse(body) {
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
];

/** The provider entry for an upstream URL, or null when we know of none. */
export function providerFor(upstream) {
  if (!upstream || typeof upstream !== 'string') return null;
  let host;
  try { host = new URL(upstream).host.toLowerCase(); } catch { return null; }
  return PROVIDERS.find(p => host === p.host || host.endsWith(`.${p.host}`)) || null;
}

/** True when this account has a backend reading we know how to fetch. */
export function hasBackendQuota(account) {
  return !!account?.upstream && !!providerFor(account.upstream);
}

/**
 * Read one backend's quota. Returns a normalized reading, or `{ error }` — the
 * caller records the failure rather than guessing, and never clears a value it
 * could not refresh.
 *
 * @returns {Promise<BackendQuota | { error: string } | null>}
 */
export async function fetchBackendQuota(account, { fetchImpl = proxyFetch, timeoutMs = 10_000 } = {}) {
  const provider = providerFor(account?.upstream);
  if (!provider || !account?.credential) return null;

  const url = new URL(provider.path, account.upstream).toString();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${account.credential}`, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await readJsonBounded(res, RESPONSE_LIMIT);
    if (body === undefined) return { error: 'response too large' };
    const reading = provider.parse(body);
    return reading ? { ...reading, at: Date.now() } : { error: 'unrecognized response' };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Parse a JSON response body of at most `limit` bytes; `undefined` when it is
 * larger (declared or actual). A response without a readable stream (a test
 * double) falls back to `json()`.
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
