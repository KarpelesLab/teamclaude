// Presentation only: these choices never change routing or quota admission.
export const USAGE_DISPLAYS = ['auto', 'session', 'balance', 'antigravity', 'cursor', 'codex'];
export const normalizeUsageDisplay = value => USAGE_DISPLAYS.includes(value) ? value : 'auto';

export function quotaWindowDisplay(account) {
  const mode = normalizeUsageDisplay(account.usageDisplay);
  if (['antigravity', 'cursor', 'codex'].includes(mode)) return mode;
  if (mode !== 'auto') return null;
  const type = account.quotaSource?.type || account.subscriptionSource?.type || account.quotaSourceType;
  return { 'google-antigravity': 'antigravity', 'antigravity-subscription': 'antigravity', 'cursor-subscription': 'cursor',
    'openai-codex': 'codex', 'codex-subscription': 'codex' }[type] || null;
}

function secToMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Map a probe-written quota state file (unified_5h/7d fractions) into applyUsageData. */
export function usageFromQuotaState(data, provider = 'codex') {
  if (!data || typeof data !== 'object') return null;
  const five = Number(data.unified_5h_utilization);
  const seven = Number(data.unified_7d_utilization);
  const fiveHour = Number.isFinite(five) ? { utilization: five, resetAt: secToMs(data.unified_5h_reset) } : null;
  const sevenDay = Number.isFinite(seven) ? { utilization: seven, resetAt: secToMs(data.unified_7d_reset) } : null;
  if (!fiveHour && !sevenDay) return null;
  const nativeWindows = [];
  if (fiveHour) nativeWindows.push({
    bucketId: '5h', windowSeconds: 18000,
    usedPercent: fiveHour.utilization * 100, resetAt: fiveHour.resetAt,
  });
  if (sevenDay) nativeWindows.push({
    bucketId: '7d', windowSeconds: 604800,
    usedPercent: sevenDay.utilization * 100, resetAt: sevenDay.resetAt,
  });
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    nativeWindowProvider: provider,
    nativeWindows,
    observedAt: secToMs(data.updated_at) ?? Date.now(),
  };
}

/** Header-learned unified bars when native Codex windows have not been probed yet. */
export function unifiedFallbackWindows(account) {
  const q = account?.quota || {};
  const windows = [];
  if (Number.isFinite(q.unified5h)) windows.push({
    bucketId: '5h', windowSeconds: 18000,
    usedPercent: q.unified5h * 100, resetAt: q.unified5hReset ?? null,
  });
  if (Number.isFinite(q.unified7d)) windows.push({
    bucketId: '7d', windowSeconds: 604800,
    usedPercent: q.unified7d * 100, resetAt: q.unified7dReset ?? null,
  });
  return windows;
}

export function nativeQuotaWindows(account) {
  const mode = quotaWindowDisplay(account);
  if (['antigravity', 'codex'].includes(mode) && account.quota?.subscription?.provider === mode) {
    const windows = account.quota.subscription.windows || [];
    return windows.length ? windows : (mode === 'codex' ? unifiedFallbackWindows(account) : windows);
  }
  if (['antigravity', 'codex'].includes(mode)) {
    const windows = account.quota?.nativeWindowProvider === mode ? account.quota.nativeWindows || [] : [];
    return windows.length ? windows : (mode === 'codex' ? unifiedFallbackWindows(account) : windows);
  }
  const q = account.quota?.subscription;
  if (q?.provider !== ({ cursor: 'cursor' }[mode])) return [];
  return q?.windows || [];
}

export function nativeQuotaSummary(account) {
  const windows = nativeQuotaWindows(account);
  if (!windows.length) return `${quotaWindowDisplay(account)} quota unknown`;
  return windows.map(w => `${w.bucketId || `${w.pool} ${w.period}`} ${w.disabled ? 'inactive' : Number.isFinite(w.usedPercent) ? w.usedPercent.toFixed(1) + '%' : 'unknown'}`).join(' | ');
}

export function usesBalanceDisplay(account) {
  const mode = normalizeUsageDisplay(account.usageDisplay);
  return mode === 'balance' || (mode === 'auto' && account.quota?.balance != null);
}

export function balanceSummary(account, now = Date.now()) {
  const balance = account.quota?.balance;
  if (!balance?.balances?.length) return 'Balance unavailable';
  // Keep currencies separate; the API may return credit in one and debt in another.
  const entries = [...balance.balances].sort((a, b) => Number(b.total) - Number(a.total));
  const amounts = entries.map(b => `${b.currency} ${Number(b.total).toFixed(2)}`).join(' / ');
  const stale = account.balanceError || now - balance.updatedAt > 15 * 60_000;
  return `Balance ${amounts}${stale ? ' (last reading)' : ''}`;
}
