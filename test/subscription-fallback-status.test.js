import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { normalizeUsagePayload } from '../src/oauth.js';
import { renderStatus } from '../src/status-renderer.js';

for (const { label, weekly, extra, spendEnabled, usedMinor = 0, tier, reason, text } of [
  { label: 'included quota', weekly: 98, tier: 'free', reason: 'quota', text: /Fallback\s+included quota available past switch threshold/ },
  { label: 'usage credits', weekly: 100, tier: 'paid', reason: 'quota', text: /Fallback\s+subscription usage credits available/ },
  { label: 'credits disabled upstream', weekly: 100, spendEnabled: false, tier: null, reason: 'quota', text: /Blocked\s+local switch threshold reached/ },
  { label: 'cordoned', weekly: 98, extra: { cordoned: true }, tier: null, reason: 'quota', text: /Blocked\s+local switch threshold reached/ },
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
    assert.match(rendered, /Models\s+Opus/);
  });
}

// fallbackTier answers 'paid' when nothing says overage is off, which includes
// an account whose usage was never probed. Status claims credits only on a
// spend reading that says overage is on.
test('subscription fallback status: no usage credits line without spend data', () => {
  const am = new AccountManager([
    { name: 'paid', type: 'oauth', accessToken: 't', allowExtraUsage: true },
    { name: 'api', type: 'apikey', apiKey: 'k' },
  ], 0.98);
  am.accounts[0].quota.unified7d = 1;
  const status = am.getStatus();
  assert.deepEqual({ tier: status.accounts[0].fallbackTier, spend: status.accounts[0].quota.spend ?? null },
    { tier: 'paid', spend: null });
  const rendered = renderStatus(status, { color: false });
  assert.match(rendered, /Blocked\s+local switch threshold reached/);
  assert.doesNotMatch(rendered, /usage credits available/);
});

// The billing line of an account without `preferExtraUsage` is the one it has
// always been; the shorter `Usage` form belongs to the preference.
for (const [label, preferExtraUsage, text] of [
  ['without the preference', false, /Blocked\s+local switch threshold reached \u2014 serving on extra usage \(paid overage\), billing/],
  ['with the preference', true, /Usage\s+serving on extra usage \(paid overage\), billing/],
]) {
  test(`subscription fallback status: billing line ${label}`, t => {
    t.mock.method(console, 'log', () => {});
    const am = new AccountManager([
      { name: 'paid', type: 'oauth', accessToken: 't', allowExtraUsage: true, preferExtraUsage },
    ], 0.98);
    Object.assign(am.accounts[0].quota, { unified7d: 1, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
    am._nextProbeAt = Date.now() + 60_000;
    assert.equal(am.getActiveAccount(null, 'claude-opus-5')?.name, 'paid');
    const status = am.getStatus();
    assert.equal(status.accounts[0].onExtraUsage, true);
    assert.match(renderStatus(status, { color: false }), text);
  });
}
