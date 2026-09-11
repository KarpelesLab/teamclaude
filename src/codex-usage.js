// Read-only Codex subscription usage.
//
// This is an internal ChatGPT endpoint used by Codex clients, not the public
// OpenAI API. Keep it isolated from the Anthropic usage probe so credentials
// are sent only to the provider that issued them.

import { proxyFetch } from './upstream-fetch.js';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

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

function classify(rateLimit) {
  const readings = Object.values(rateLimit || {}).map(windowReading).filter(Boolean);
  const fiveHour = readings.find(r => r.seconds <= 6 * 60 * 60) || null;
  const sevenDay = readings.find(r => r.seconds >= 6 * 24 * 60 * 60) || null;
  return { fiveHour, sevenDay };
}

/** Convert the private `/wham/usage` response into TeamClaude quota fields. */
export function normalizeCodexUsagePayload(data) {
  const rateLimit = data?.rate_limit || data?.rate_limits;
  const shared = classify(rateLimit);
  const modelBuckets = [];
  for (const [name, value] of Object.entries(data?.additional_rate_limits || {})) {
    const reading = classify(value?.rate_limit || value);
    if (reading.sevenDay) {
      modelBuckets.push({
        slug: name,
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

/** Fetch Codex quota without sending an inference request. */
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
  } catch (err) {
    return { error: err?.message || String(err), status: null };
  }
}
