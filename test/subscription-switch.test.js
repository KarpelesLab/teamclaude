import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { normalizeUsagePayload } from '../src/oauth.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

for (const weekly of [98, 100]) {
  test(`an explicit subscription switch serves at ${weekly}% usage with credits enabled`, async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      req.resume();
      seen.push(req.headers.authorization || req.headers['x-api-key']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const am = new AccountManager([
      { name: 'subscriber@example.com', type: 'oauth', accessToken: 'subscription-token',
        expiresAt: Date.now() + 3600_000, allowExtraUsage: true },
      { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 },
    ], 0.98);
    am.currentIndex = 1;
    am.applyUsageData(0, normalizeUsagePayload({
      five_hour: { utilization: 0 }, seven_day: { utilization: weekly },
      extra_usage: { is_enabled: true, user_disabled: false },
      spend: {
        used: { amount_minor: 0, currency: 'GBP', exponent: 2 },
        limit: { amount_minor: 15000, currency: 'GBP', exponent: 2 },
      },
    }));
    const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const port = await listen(proxy);
    try {
      const switched = await fetch(`http://127.0.0.1:${port}/teamclaude/switch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'subscriber@example.com' }),
      });
      assert.deepEqual(await switched.json(), { ok: true, account: 'subscriber@example.com', eligible: true });
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1, messages: [] }),
        });
        assert.deepEqual({ status: response.status, body: await response.json() }, { status: 200, body: { ok: true } });
        const status = am.getStatus();
        assert.equal(status.currentAccount, 'subscriber@example.com');
        assert.equal(status.accounts[0].onExtraUsage, weekly === 100);
      }
      assert.deepEqual(seen, ['Bearer subscription-token', 'Bearer subscription-token']);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    }
  });
}

for (const [label, change] of [
  ['disabled', a => { a.disabled = true; }],
  ['usage cap', a => { a.maxUsage = 1; }],
  ['spend cap', a => { a.maxSpend = 1; a.quota.spend.usedMinor = 100; }],
  ['upstream credits disabled', a => { a.quota.spend.enabled = false; }],
  ['extra usage not authorised', a => { a.allowExtraUsage = false; }],
  ['rate limit', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; }],
  ['billing refusal', a => { a.billingRejectedUntil = Date.now() + 60_000; }],
]) {
  test(`an explicit subscription switch respects ${label}`, () => {
    const am = new AccountManager([
      { name: 'subscription', type: 'oauth', accessToken: 't', allowExtraUsage: true },
      { name: 'api', type: 'apikey', apiKey: 'k', priority: 100 },
    ]);
    Object.assign(am.accounts[0].quota, { unified7d: 1, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
    change(am.accounts[0]);
    am.setCurrentAccount(0);

    assert.equal(am.eligibility(0).eligible, false);
    assert.equal(am.getActiveAccount()?.name, 'api');
  });
}

test('an explicit subscription switch remains subject to automatic account priority', () => {
  const am = new AccountManager([
    { name: 'subscription', type: 'oauth', accessToken: 't', allowExtraUsage: true },
    { name: 'api', type: 'apikey', apiKey: 'k', priority: 100 },
  ]);
  Object.assign(am.accounts[0].quota, { unified7d: 1, spend: { enabled: true } });
  am.setCurrentAccount(0);
  assert.equal(am.getActiveAccount()?.name, 'subscription');

  am.accounts[1].priority = -1;
  const preview = am.previewRouteIndex(null);
  const eligible = am.eligibility(0).eligible;
  const picked = am.getActiveAccount();
  const status = am.getStatus();
  assert.deepEqual({ preview, eligible, selected: picked?.name, current: status.currentAccount, paid: status.accounts[0].onExtraUsage },
    { preview: 1, eligible: false, selected: 'api', current: 'api', paid: false });
});
