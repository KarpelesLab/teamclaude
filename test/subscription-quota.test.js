import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subscriptionAdmission, subscriptionSummary } from '../src/subscription-quota.js';
import { Prober } from '../src/prober.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const cursorData = now => ({
  enabled: true, billingCycleStart: String(now - 1000), billingCycleEnd: String(now + 1000000),
  autoBucketModels: ['composer-2.5'],
  planUsage: { remaining: 1000, limit: 2000, autoPercentUsed: 10, apiPercentUsed: 100, totalPercentUsed: 20 },
});
function cursorSnapshot(data, now = Date.now()) {
  return { provider: 'cursor', observedAt: now, includedRemaining: data.planUsage.remaining,
    autoBucketModels: data.autoBucketModels,
    windows: ['auto', 'api', 'total'].map(pool => ({ pool, period: 'monthly',
      usedPercent: data.planUsage[`${pool}PercentUsed`], resetAt: Number(data.billingCycleEnd) })) };
}
const account = () => ({ name: 'cursor', type: 'apikey', apiKey: 'test', quotaAdmission: 'upstream',
  quotaSource: { type: 'cursor-subscription' }, modelMap: { probe: 'cursor/composer-2.5' }, quota: {} });

test('Cursor uses actual monthly pools and rejects stale, missing and failed observations', () => {
  const now = 100000, a = account();
  assert.equal(subscriptionAdmission(a, 'probe', now).reason, 'subscription-quota-unknown');
  a.quota.subscription = cursorSnapshot(cursorData(now), now);
  assert.equal(subscriptionAdmission(a, 'probe', now).allowed, true);
  assert.equal(subscriptionAdmission(a, 'claude-sonnet', now).reason, 'subscription-quota-exhausted');
  assert.equal(subscriptionAdmission(a, null, now).allowed, true);
  assert.match(subscriptionSummary(a, now), /auto monthly 10.0%/);
  assert.doesNotMatch(subscriptionSummary(a, now), /weekly|7d/);
  assert.equal(subscriptionAdmission(a, 'probe', now + 90001).reason, 'subscription-quota-unknown');
  a.subscriptionError = 'unavailable';
  assert.equal(subscriptionAdmission(a, 'probe', now).reason, 'subscription-quota-unknown');
  a.subscriptionError = null;
  a.quota.subscription.windows.pop();
  assert.equal(subscriptionAdmission(a, 'probe', now).reason, 'subscription-quota-unknown');
});

test('routing excludes unknown subscription even with upstream admission override', () => {
  const am = new AccountManager([account(), { name: 'fallback', type: 'apikey', apiKey: 'test' }]);
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), false);
  assert.equal(am._isAvailable(am.accounts[1], 'probe'), true);
  am.applyUsageData(0, { subscription: cursorSnapshot(cursorData(Date.now())) });
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), true);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-sonnet'), false);
});

test('unknown quota returns 503 and pinned exhausted quota cannot reach inference', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => { hits++; res.end('unexpected'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const accounts = [account()];
  const am = new AccountManager(accounts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test' },
    upstream: `http://127.0.0.1:${upstream.address().port}`, accounts });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const send = path => fetch(`http://127.0.0.1:${proxy.address().port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
    body: JSON.stringify({ model: 'probe', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  try {
    let response = await send('/v1/messages');
    assert.equal(response.status, 503); await response.text();
    const data = cursorData(Date.now()); data.planUsage.remaining = 0;
    am.applyUsageData(0, { subscription: cursorSnapshot(data) });
    response = await send('/tc-acct/cursor/v1/messages');
    assert.equal(response.status, 429); await response.text();
    assert.equal(hits, 0);
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});


test('quota source reload invalidates the previous subscription observation', () => {
  const config = account();
  const am = new AccountManager([config]);
  am.applyUsageData(0, { subscription: cursorSnapshot(cursorData(Date.now())) });
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), true);
  const changed = am.updateAccountPolicy(0, { ...config, quotaSource: { ...config.quotaSource, tokenFile: '/new-account' } });
  assert.ok(changed.includes('quotaSource'));
  assert.equal(am.accounts[0].quota.subscription, undefined);
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), false);
});

test('failed refresh blocks a previously healthy subscription until a successful refresh', async () => {
  const config = account();
  config.quotaSource.tokenFile = '/nonexistent-teamclaude-test-token';
  const am = new AccountManager([config]);
  const usage = { subscription: cursorSnapshot(cursorData(Date.now())) };
  am.applyUsageData(0, usage);
  const prober = new Prober(am, { log: () => {} });
  await prober.probeQuotaSourceAccount(am.accounts[0]);
  assert.ok(am.accounts[0].subscriptionError);
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), false);
  am.applyUsageData(0, usage);
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), true);
});

test('a failed probe for a replaced source cannot poison the new account observation', async () => {
  const config = account();
  config.quotaSource.tokenFile = '/nonexistent-teamclaude-test-token';
  const am = new AccountManager([config]);
  const prober = new Prober(am, { log: () => {} });
  const pending = prober.probeQuotaSourceAccount(am.accounts[0]);
  am.updateAccountPolicy(0, { ...config, quotaSource: { ...config.quotaSource, tokenFile: '/replacement-account' } });
  am.applyUsageData(0, { subscription: cursorSnapshot(cursorData(Date.now())) });
  await pending;
  assert.equal(am.accounts[0].subscriptionError, null);
  assert.equal(am._isAvailable(am.accounts[0], 'probe'), true);
});

test('quota reader consumes only the authenticated canonical proxy observation', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fetchSubscriptionQuota } = await import('../src/subscription-quota.js');
  const dir = await mkdtemp(join(tmpdir(), 'tc-proxy-quota-'));
  const keyFile = join(dir, 'key'); await writeFile(keyFile, 'test-management-key');
  const now = Date.now();
  const snapshot = cursorSnapshot(cursorData(now), now);
  snapshot.observedAt = new Date(now).toISOString();
  for (const w of snapshot.windows) w.resetAt = new Date(w.resetAt).toISOString();
  let requested;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requested = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ schema: 'cliproxy.subscription.v1', snapshot }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const usage = await fetchSubscriptionQuota({ type: 'cursor-subscription',
      baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeyFile: keyFile, authIndex: 'selected-auth' });
    assert.equal(usage.error, undefined);
    assert.equal(usage.subscription.observedAt, now);
    assert.deepEqual(requested, { path: '/v0/management/quota/subscription',
      authorization: 'Bearer test-management-key', body: { auth_index: 'selected-auth' } });
    assert.equal(usage.subscription.windows.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Antigravity routes by mapped model family without sharing quota', async () => {
  const now = Date.now();
  const config = { name: 'agy', type: 'apikey', apiKey: 'test', quotaAdmission: 'upstream',
    quotaSource: { type: 'antigravity-subscription' },
    modelMap: { sonnet: 'antigravity/claude-sonnet-4-6', fast: 'antigravity/gemini-flash' } };
  const q = { provider: 'antigravity', observedAt: now, windows: [
    { pool: 'gemini', period: '5h', usedPercent: 10, resetAt: now + 60000 },
    { pool: 'gemini', period: 'weekly', usedPercent: 30, resetAt: now + 120000 },
    { pool: '3p', period: '5h', usedPercent: 0, resetAt: now + 80000 },
    { pool: '3p', period: 'weekly', usedPercent: 100, resetAt: now + 150000 },
  ] };
  const am = new AccountManager([config]);
  am.applyUsageData(0, { subscription: q });
  const a = am.accounts[0];
  assert.equal(am._isAvailable(a, 'fast'), true);
  assert.equal(am._isAvailable(a, 'sonnet'), false);
  assert.equal(subscriptionAdmission(a, 'sonnet', now).reason, 'subscription-quota-exhausted');
  assert.equal(subscriptionAdmission(a, null, now).allowed, true);
  assert.equal(subscriptionAdmission(a, 'unknown-model', now).reason, 'subscription-quota-unknown');
  const { nativeQuotaWindows, quotaWindowDisplay } = await import('../src/usage-display.js');
  assert.equal(quotaWindowDisplay(a), 'antigravity');
  assert.equal(nativeQuotaWindows(a).length, 4);
  assert.equal(subscriptionAdmission(a, 'fast', now + 90001).allowed, false);
  a.quota.subscription.windows = q.windows.filter(w => w.pool === '3p');
  assert.equal(subscriptionAdmission(a, 'fast', now).reason, 'subscription-quota-unknown');
  assert.equal(nativeQuotaWindows(a).length, 2);
});

test('Antigravity explicit family mapping and malformed observations fail closed', () => {
  const now = 1000;
  const a = { quotaSource: { type: 'antigravity-subscription', modelFamilies: { custom: '3p' } },
    quota: { subscription: { provider: 'antigravity', observedAt: now, windows: [
      { pool: '3p', period: '5h', usedPercent: 0, resetAt: 10000 },
      { pool: '3p', period: 'weekly', usedPercent: 10, resetAt: 20000 },
    ] } } };
  assert.equal(subscriptionAdmission(a, 'custom', now).allowed, true);
  assert.equal(subscriptionAdmission(a, 'gemini-pro', now).allowed, false);
  a.quota.subscription.windows.push({ ...a.quota.subscription.windows[0] });
  assert.equal(subscriptionAdmission(a, 'custom', now).reason, 'subscription-quota-unknown');
  a.quota.subscription.windows.pop();
  a.quota.subscription.windows[1].usedPercent = 101;
  assert.equal(subscriptionAdmission(a, 'custom', now).reason, 'subscription-quota-unknown');
});

test('fault injection: Cursor exhausted or unknown quotas select fallback before inference', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      hits.push(req.headers['x-api-key']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    for (const provider of ['cursor']) {
      for (const fault of ['unknown', 'exhausted']) {
        const accounts = [{ name: 'subscription', type: 'apikey', apiKey: 'subscription', priority: 0,
          quotaAdmission: 'upstream', quotaSource: { type: `${provider}-subscription` } },
        { name: 'fallback', type: 'apikey', apiKey: 'fallback', priority: 20 }];
        const am = new AccountManager(accounts);
        if (fault === 'exhausted') {
          const now = Date.now();
          const data = cursorData(now); data.planUsage.remaining = 0;
          const snapshot = cursorSnapshot(data, now);
          am.applyUsageData(0, { subscription: snapshot });
        }
        const proxy = createProxyServer(am, { proxy: { apiKey: 'test' },
          upstream: `http://127.0.0.1:${upstream.address().port}`, accounts });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        try {
          const before = hits.length;
          const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
            body: JSON.stringify({ model: 'probe', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }),
          });
          assert.equal(response.status, 200, `${provider} ${fault}`); await response.json();
          assert.deepEqual(hits.slice(before), ['fallback'], `${provider} ${fault} reached subscription`);
        } finally {
          proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
        }
      }
    }
  } finally {
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('canonical Codex weekly-only source clears legacy synthetic windows and respects provider denial', async () => {
  const now = Date.now();
  const am = new AccountManager([{ name: 'codex', type: 'apikey', apiKey: 'test',
    quotaSource: { type: 'codex-subscription' } }]);
  const a = am.accounts[0];
  a.quota.unified5h = 1; a.quota.unified5hReset = now + 100000;
  a.quota.unified7d = 1; a.quota.unified7dReset = now + 100000;
  const snapshot = { provider: 'codex', observedAt: now, admissionAllowed: true,
    windows: [{ pool: 'primary', period: 'weekly', windowSeconds: 604800, usedPercent: 30, resetAt: now + 100000 }] };
  am.applyUsageData(0, { subscription: snapshot });
  assert.equal(a.quota.unified5h, null);
  assert.equal(am._isAvailable(a, 'gpt-5.6'), true);
  const { nativeQuotaWindows, quotaWindowDisplay } = await import('../src/usage-display.js');
  assert.equal(quotaWindowDisplay(a), 'codex');
  assert.deepEqual(nativeQuotaWindows(a).map(w => w.period), ['weekly']);
  a.quota.subscription.admissionAllowed = false;
  assert.equal(subscriptionAdmission(a, 'gpt-5.6', now).reason, 'subscription-quota-exhausted');
  a.quota.subscription.admissionAllowed = true;
  a.quota.subscription.windows[0].usedPercent = null;
  assert.equal(subscriptionAdmission(a, 'gpt-5.6', now).reason, 'subscription-quota-unknown');
});

test('Antigravity disabled short window is inactive, not available quota', async () => {
  const now = Date.now();
  const a = { quotaSource: { type: 'antigravity-subscription' }, quota: { subscription: {
    provider: 'antigravity', observedAt: now, windows: [
      { pool: '3p', period: '5h', usedPercent: 0, disabled: true, resetAt: now + 100000 },
      { pool: '3p', period: 'weekly', usedPercent: 100, resetAt: now + 100000 },
    ],
  } } };
  assert.equal(subscriptionAdmission(a, 'claude-sonnet', now).reason, 'subscription-quota-exhausted');
  assert.match(subscriptionSummary(a, now), /3p 5h inactive/);
  const { nativeQuotaSummary } = await import('../src/usage-display.js');
  assert.match(nativeQuotaSummary(a), /3p 5h inactive/);
  a.quota.subscription.windows[1].usedPercent = 10;
  assert.equal(subscriptionAdmission(a, 'claude-sonnet', now).reason, 'subscription-quota-unknown');
});

test('canonical quota accounts still record request counts without reading adapter quota headers', () => {
  const am = new AccountManager([account()]);
  const a = am.accounts[0];
  am.applyUsageData(0, { subscription: cursorSnapshot(cursorData(Date.now())) });
  const snapshot = structuredClone(a.quota.subscription);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.99' });
  am.updateQuota(0, {});
  assert.equal(a.usage.totalRequests, 2);
  assert.ok(Number.isFinite(Date.parse(a.usage.lastUsed)));
  assert.equal(a.quota.unified5h, null);
  assert.deepEqual(a.quota.subscription, snapshot);
});

test('quota model resolution ignores prototype names and rejects non-string mappings', () => {
  const now = Date.now(), a = account();
  a.quota.subscription = cursorSnapshot(cursorData(now), now);
  for (const model of ['constructor', 'toString', '__proto__']) {
    assert.doesNotThrow(() => subscriptionAdmission(a, model, now));
  }
  a.modelMap.broken = {};
  assert.equal(subscriptionAdmission(a, 'broken', now).reason, 'subscription-quota-unknown');
  const ag = { quotaSource: { type: 'antigravity-subscription', modelFamilies: {} }, modelMap: {},
    quota: { subscription: { provider: 'antigravity', observedAt: now, windows: ['5h', 'weekly']
      .map(period => ({ pool: 'gemini', period, usedPercent: 10, resetAt: now + 100000 })) } } };
  for (const model of ['constructor', 'toString', '__proto__']) {
    assert.equal(subscriptionAdmission(ag, model, now).reason, 'subscription-quota-unknown');
  }
  ag.modelMap.broken = 5;
  assert.equal(subscriptionAdmission(ag, 'broken', now).reason, 'subscription-quota-unknown');
});

test('subscription probing rejects disabled or stale schedules before creating a timer', async () => {
  const { Prober } = await import('../src/prober.js');
  const am = new AccountManager([account()]);
  for (const intervalMs of [0, -1, 60000, 90000, NaN]) {
    const prober = new Prober(am, { intervalMs, log: () => {} });
    assert.throws(() => prober.start(), /positive quotaProbeSeconds/);
    assert.equal(prober.timer, null);
  }
  const prober = new Prober(am, { intervalMs: 30000, log: () => {} });
  let probes = 0;
  prober.probeAll = async () => { probes++; };
  try {
    prober.start();
    assert.equal(probes, 1);
    assert.ok(prober.timer);
    const timer = prober.timer;
    assert.throws(() => prober.reschedule(0), /positive quotaProbeSeconds/);
    assert.equal(prober.timer, timer);
  } finally { prober.stop(); }
});
