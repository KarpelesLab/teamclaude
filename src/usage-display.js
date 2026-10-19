// Presentation only: these choices never change routing or quota admission.
export const USAGE_DISPLAYS = ['auto', 'session', 'balance'];
export const normalizeUsageDisplay = value => USAGE_DISPLAYS.includes(value) ? value : 'auto';

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
