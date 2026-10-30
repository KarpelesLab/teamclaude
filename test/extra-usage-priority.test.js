import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

const OPUS = 'claude-opus-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 3600_000, ...extra });

function fleet({ allowed = true, weekly = 1, apiPriority = 100, ...accountOptions } = {}) {
  const am = new AccountManager([
    oauth('subscription', { priority: 0, allowExtraUsage: allowed, ...accountOptions }),
    { name: 'api', type: 'apikey', apiKey: 'api-key', priority: apiPriority },
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 1;
  return am;
}

for (const [label, options, expected, billing] of [
  ['included quota below threshold', { weekly: 0.2 }, 'subscription', false],
  ['included quota above threshold with extra usage allowed', { weekly: 0.98 }, 'subscription', false],
  ['credits with extra usage allowed', { weekly: 1 }, 'subscription', true],
  ['included quota above threshold without opt-in', { allowed: false, weekly: 0.98 }, 'api', false],
  ['spent subscription without opt-in', { allowed: false }, 'api', false],
  ['explicit API priority ahead of included quota', { weekly: 0.2, apiPriority: -1 }, 'api', false],
  ['explicit API priority ahead of remaining included quota', { weekly: 0.98, apiPriority: -1 }, 'api', false],
  ['explicit API priority ahead of credits', { apiPriority: -1 }, 'api', false],
]) {
  test(`extra-usage priority: ${label}`, () => {
    const am = fleet(options);
    const picked = am.getActiveAccount(null, OPUS);
    const status = am.getStatus();
    assert.deepEqual({ selected: picked?.name, current: status.currentAccount, billing: status.accounts[0].onExtraUsage },
      { selected: expected, current: expected, billing });
  });
}

for (const [label, change] of [
  ['disabled', a => { a.disabled = true; }],
  ['usage cap', a => { a.maxUsage = 1; }],
  ['spend cap', a => { a.maxSpend = 1; a.quota.spend.usedMinor = 100; }],
  ['upstream credits disabled', a => { a.quota.spend.enabled = false; }],
  ['billing cooldown', a => { a.billingRejectedUntil = Date.now() + 60_000; }],
  ['entitlement cooldown', a => { a.entitlementDeniedUntil = Date.now() + 60_000; }],
  ['rate limit', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; }],
]) {
  test(`extra usage before API respects ${label}`, () => {
    const am = fleet();
    change(am.accounts[0]);
    assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
  });
}

test('available included subscription quota is used before credits', () => {
  const am = fleet();
  am.addAccount(oauth('included', { priority: 10 }));
  am.accounts[2].quota.unified7d = 0.2;
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'included');
});

test('failover can use subscription credits before a lower-priority API without moving the cursor', () => {
  const am = fleet();
  const alternate = am.pickAlternate(new Set(), OPUS);
  assert.deepEqual({ account: alternate?.name, cursor: am.currentIndex }, { account: 'subscription', cursor: 1 });
  assert.equal(am.getStatus().accounts[0].onExtraUsage, true);
});

test('extra-usage eligibility preempts an API session affinity', () => {
  const am = fleet();
  am.setDistributeSessions(true);
  am.recordSession('conversation', 1, OPUS);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'conversation')?.name, 'subscription');
});

test('an exclusive model route still restricts extra usage', () => {
  const am = fleet();
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'], accounts: ['api'] }]);
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
});

test('an eligible route pin takes precedence over automatic extra usage', () => {
  const am = fleet();
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
  am.setRoutePin('opus', 1);
  am.setDistributeSessions(true);
  am.recordSession('conversation', 0, OPUS);

  const preview = am.previewRouteIndex(OPUS);
  const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
  assert.deepEqual({ preview, selected: picked?.name, paid: am.getStatus().accounts[0].onExtraUsage },
    { preview: 1, selected: 'api', paid: false });

  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'subscription');
});

test('the provider partition still restricts extra usage', () => {
  const am = fleet();
  am.addAccount(oauth('codex', { provider: 'codex' }));
  assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex')?.name, 'codex');
});

test('status and switch eligibility use the same extra-usage preference', () => {
  const am = fleet();
  assert.deepEqual(am.eligibility(0), { eligible: true });
  assert.equal(am.eligibility(1).eligible, false);
  assert.equal(am.getStatus().defaultTarget, 'subscription');
});

test('reloading allowExtraUsage changes routing without another policy setting', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers.authorization || req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'application/json',
      ...(req.headers.authorization ? { 'anthropic-ratelimit-unified-7d-utilization': '1' } : {}),
    });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let running;
  try {
    running = await spawnServer({ config: () => ({
      proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false,
      quotaProbeSeconds: 0,
      accounts: [oauth('subscription', { allowExtraUsage: true }), { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 }],
    }) });
    const post = async path => {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [] }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    await post('/v1/messages');
    await post('/v1/messages');
    const config = JSON.parse(await readFile(running.configPath, 'utf8'));
    delete config.accounts[0].allowExtraUsage;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    config.accounts[0].allowExtraUsage = true;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    assert.deepEqual(seen, ['Bearer t-subscription', 'Bearer t-subscription', 'api-key', 'Bearer t-subscription'], running.output());
  } finally {
    await running?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
