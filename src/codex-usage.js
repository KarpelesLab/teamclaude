// Read-only Codex subscription usage.
//
// This is an internal ChatGPT endpoint used by Codex clients, not the public
// OpenAI API. Keep it isolated from the Anthropic usage probe so credentials
// are sent only to the provider that issued them.

import { proxyFetch } from './upstream-fetch.js';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/**
 * @param {any} window
 */
function windowReading(window) {
  if (!window || typeof window !== 'object') return null;
  const used = Number(window.used_percent ?? window.usedPercentage ?? window.utilization);
  const seconds = Number(window.limit_window_seconds ?? window.window_seconds);
  if (!Number.isFinite(used) || !Number.isFinite(seconds) || seconds <= 0) return null;
  const reset = Number(window.reset_at ?? window.resetAt);
  return {
    utilization: used / 100,
    resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
    seconds,
  };
}

/**
 * @param {any} rateLimit
 */
function classify(rateLimit) {
  const readings = Object.values(rateLimit || {}).flatMap(w => windowReading(w) ?? []);
  const fiveHour = readings.find(r => r.seconds <= 6 * 60 * 60) || null;
  const sevenDay = readings.find(r => r.seconds >= 6 * 24 * 60 * 60) || null;
  return { fiveHour, sevenDay };
}

/**
 * Name each extra limit from the entry itself.
 *
 * A live subscription sends `additional_rate_limits` as a LIST whose entries
 * name themselves (`metered_feature`, `limit_name`); older readings used an
 * object keyed by the feature. `Object.entries` over a list hands back array
 * indices, so every bucket was filed as "0" and "1" — two accounts' Spark
 * limits collided under one meaningless key, and the header path's name for
 * the same bucket stacked beside it rather than replacing it.
 *
 * `metered_feature` is that header name with a `codex_` prefix (`codex_bengalfox`
 * here is `x-codex-bengalfox-*` there), so stripping it makes the two paths
 * agree on one key per bucket.
 *
 * @param {any} additional
 * @returns {Array<{slug: string, name: string, rateLimit: any}>}
 */
function additionalLimits(additional) {
  if (Array.isArray(additional)) {
    const out = [];
    for (const entry of additional) {
      if (!entry || typeof entry !== 'object') continue;
      const feature = typeof entry.metered_feature === 'string' ? entry.metered_feature.replace(/^codex_/, '') : '';
      const label = typeof entry.limit_name === 'string' ? entry.limit_name : '';
      const slug = feature || label;
      if (!slug) continue;
      out.push({ slug, name: label || slug, rateLimit: entry.rate_limit || entry });
    }
    return out;
  }
  return Object.entries(additional || {})
    .map(([key, value]) => ({ slug: key, name: key, rateLimit: value?.rate_limit || value }));
}

/**
 * Convert the private `/wham/usage` response into TeamClaude quota fields.
 *
 * @param {any} data
 */
export function normalizeCodexUsagePayload(data) {
  const rateLimit = data?.rate_limit || data?.rate_limits;
  const shared = classify(rateLimit);
  const modelBuckets = [];
  for (const { slug, name, rateLimit: extra } of additionalLimits(data?.additional_rate_limits)) {
    const reading = classify(extra);
    if (reading.sevenDay) {
      modelBuckets.push({
        slug,
        name,
        utilization: reading.sevenDay.utilization,
        resetAt: reading.sevenDay.resetAt,
      });
    }
  }
  return {
    fiveHour: shared.fiveHour && { utilization: shared.fiveHour.utilization, resetAt: shared.fiveHour.resetAt },
    sevenDay: shared.sevenDay && { utilization: shared.sevenDay.utilization, resetAt: shared.sevenDay.resetAt },
    modelBuckets,
    planType: data?.plan_type || null,
  };
}

/**
 * Fetch Codex quota without sending an inference request.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function fetchCodexUsage(account, { fetchImpl = proxyFetch, timeoutMs = 10_000, url = CODEX_USAGE_URL } = {}) {
  if (!account?.credential || !account?.accountId) return { error: 'missing Codex account identity' };
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${account.credential}`,
        'ChatGPT-Account-Id': account.accountId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    return normalizeCodexUsagePayload(await res.json());
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}
