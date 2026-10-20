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

export function nativeQuotaWindows(account) {
  const mode = quotaWindowDisplay(account);
  if (['antigravity', 'codex'].includes(mode) && account.quota?.subscription?.provider === mode) {
    return account.quota.subscription.windows || [];
  }
  if (['antigravity', 'codex'].includes(mode)) {
    return account.quota?.nativeWindowProvider === mode ? account.quota.nativeWindows || [] : [];
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
