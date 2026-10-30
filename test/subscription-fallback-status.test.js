import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { normalizeUsagePayload } from '../src/oauth.js';
import { renderStatus } from '../src/status-renderer.js';

for (const { label, weekly, extra, spendEnabled, usedMinor = 0, tier, reason, text } of [
  { label: 'included quota', weekly: 98, tier: 'free', reason: 'quota', text: /Fallback\s+included quota available past switch threshold/ },
  { label: 'usage credits', weekly: 100, tier: 'paid', reason: 'quota', text: /Fallback\s+subscription usage credits available/ },
  { label: 'credits disabled upstream', weekly: 100, spendEnabled: false, tier: null, reason: 'quota', text: /Blocked\s+local switch threshold reached/ },
  { label: 'operator disabled', weekly: 98, extra: { disabled: true }, tier: null, reason: 'disabled', text: /Blocked\s+disabled by operator/ },
  { label: 'usage cap', weekly: 98, extra: { maxUsage: 0.98 }, tier: null, reason: 'capped', text: /Blocked\s+account usage cap reached/ },
  { label: 'spend cap', weekly: 100, extra: { maxSpend: 1 }, usedMinor: 100, tier: null, reason: 'spend-capped', text: /Blocked\s+extra-usage spend cap reached/ },
]) {
  test(`subscription fallback status: ${label}`, () => {
    const am = new AccountManager([
      { name: 'paid', type: 'oauth', accessToken: 't', allowExtraUsage: true, ...extra },
      { name: 'api', type: 'apikey', apiKey: 'k' },
    ], 0.98);
    am.applyUsageData(0, normalizeUsagePayload({
      seven_day: { utilization: weekly },
      extra_usage: { is_enabled: spendEnabled !== false },
      spend: {
        used: { amount_minor: usedMinor, currency: 'GBP', exponent: 2 },
        limit: { amount_minor: 15000, currency: 'GBP', exponent: 2 },
      },
    }));

    am.accounts[0].quota.unified7dFable = 0;
    const status = am.getStatus();
    const account = status.accounts[0];
    assert.deepEqual({ tier: account.fallbackTier, reason: account.unavailable, billing: account.onExtraUsage },
      { tier, reason, billing: false });
    const rendered = renderStatus(status, { color: false });
    assert.match(rendered, text);
    assert.match(rendered, /Plan\s+Opus/);
  });
}
