import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The shared 5-hour and weekly readings carry the time upstream last stated
// them: `unified5hSeenAt` and `unified7dSeenAt`. A consumer of
// /teamclaude/status needs that to tell a reading taken a minute ago from one
// restored off disk after a week idle; the value alone looks the same either
// way. The stamp moves only with its own window's value, so anything that did
// not state that window — an empty payload, a failed probe, a reset-only
// bucket, a model-scoped bucket — leaves it where it was.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra };
}
const codex = (name, extra = {}) => oauth(name, { provider: 'codex', accountId: `${name}-id`, ...extra });

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('an Anthropic response stamps only the shared windows it stated', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  assert.equal(q.unified5hSeenAt, null);
  assert.equal(q.unified7dSeenAt, null);

  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
  });
  assert.equal(q.unified5hSeenAt, start);
  assert.equal(q.unified7dSeenAt, start);

  t.mock.timers.tick(60_000);
  // Nothing stated, a reset with no utilization, an unparseable value, and a
  // Fable-only (`7d_oi`) reading: none of them is a new 5h or 7d observation.
  am.updateQuota(0, {});
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-reset': String(Math.floor((start + DAY) / 1000)) });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': 'oops', 'anthropic-ratelimit-unified-7d-utilization': '' });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d_oi-utilization': '0.9' });
  assert.equal(q.unified5hSeenAt, start);
  assert.equal(q.unified7dSeenAt, start);
  assert.equal(q.unified7dFableSeenAt, start + 60_000, 'the Fable bucket keeps its own stamp');

  t.mock.timers.tick(60_000);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0' });
  assert.equal(q.unified7dSeenAt, start + 120_000, 'a real 0% is an observation');
  assert.equal(q.unified5hSeenAt, start, 'the window it did not state keeps its old time');
});

test('the usage probe stamps only the shared windows it stated', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;

  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: start + HOUR },
    sevenDay: { utilization: 0.4, resetAt: start + DAY },
  });
  assert.equal(q.unified5hSeenAt, start);
  assert.equal(q.unified7dSeenAt, start);

  t.mock.timers.tick(60_000);
  am.applyUsageData(0, { error: 'HTTP 500' });
  am.applyUsageData(0, {});
  am.applyUsageData(0, { fiveHour: { utilization: null, resetAt: start + 2 * HOUR } });
  am.applyUsageData(0, { sevenDay: { utilization: null, resetAt: start + 2 * DAY } });
  am.applyUsageData(0, { sevenDayFable: { utilization: 0.5, resetAt: start + DAY } });
  assert.equal(q.unified5hSeenAt, start);
  assert.equal(q.unified7dSeenAt, start);

  am.applyUsageData(0, { fiveHour: { utilization: 0.3, resetAt: start + HOUR } });
  assert.equal(q.unified5hSeenAt, start + 60_000);
  assert.equal(q.unified7dSeenAt, start, 'a partial payload leaves the other window alone');
});

test('a Codex response stamps only the shared windows it stated', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am = new AccountManager([codex('c')], 0.98);
  const q = am.accounts[0].quota;

  am.updateQuota(0, { 'x-codex-primary-used-percent': '35', 'x-codex-primary-window-minutes': '10080' });
  assert.equal(q.unified7dSeenAt, start);
  assert.equal(q.unified5hSeenAt, null, 'the response stated no 5-hour window');

  t.mock.timers.tick(60_000);
  // No quota at all (the `/models` catalog), a zeroed window (this API's "not
  // applicable"), and a model-scoped weekly bucket alone.
  am.updateQuota(0, {});
  am.updateQuota(0, { 'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0' });
  am.updateQuota(0, {
    'x-codex-bengalfox-primary-used-percent': '12',
    'x-codex-bengalfox-primary-window-minutes': '10080',
  });
  // A reset with no percentage, and a percentage that does not parse.
  am.updateQuota(0, { 'x-codex-primary-reset-at': String(Math.floor((start + DAY) / 1000)), 'x-codex-primary-window-minutes': '10080' });
  am.updateQuota(0, { 'x-codex-primary-used-percent': 'oops', 'x-codex-primary-window-minutes': '10080' });
  assert.equal(q.unified7dSeenAt, start);
  assert.equal(q.unified5hSeenAt, null);
  assert.equal(q.codexModelBuckets.bengalfox.seenAt, start + 60_000, 'the model bucket keeps its own stamp');

  am.updateQuota(0, { 'x-codex-secondary-used-percent': '5', 'x-codex-secondary-window-minutes': '300' });
  assert.equal(q.unified5hSeenAt, start + 60_000);
  assert.equal(q.unified7dSeenAt, start, 'the window it did not state keeps its old time');

  // A subscription states its only 5-hour window inside a model-named family,
  // and parseCodexQuota takes it as the account's 5-hour reading: a real
  // observation of that window, so it moves the stamp with the value.
  t.mock.timers.tick(60_000);
  am.updateQuota(0, {
    'x-codex-bengalfox-secondary-used-percent': '9',
    'x-codex-bengalfox-secondary-window-minutes': '300',
  });
  assert.equal(q.unified5h, 0.09);
  assert.equal(q.unified5hSeenAt, start + 120_000);
  assert.equal(q.unified7dSeenAt, start);
});

test('a Codex usage read stamps only the shared windows it stated', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am = new AccountManager([codex('c')], 0.98);
  const q = am.accounts[0].quota;

  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.5, resetAt: start + DAY } });
  assert.equal(q.unified7dSeenAt, start);
  assert.equal(q.unified5hSeenAt, null);

  t.mock.timers.tick(60_000);
  am.applyCodexUsageData(0, { error: 'HTTP 401' });
  am.applyCodexUsageData(0, {});
  am.applyCodexUsageData(0, { resetCredits: { available: 1, applicable: 1 } });
  am.applyCodexUsageData(0, { modelBuckets: [{ slug: 'bengalfox', name: 'GPT-5.6-Sol', utilization: 0.1, resetAt: null }] });
  assert.equal(q.unified7dSeenAt, start);
  assert.equal(q.unified5hSeenAt, null);

  am.applyCodexUsageData(0, { fiveHour: { utilization: 0.1, resetAt: start + HOUR } });
  assert.equal(q.unified5hSeenAt, start + 60_000);
  assert.equal(q.unified7dSeenAt, start);
});

test('a window that resets drops its stamp with its value', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: start + HOUR },
    sevenDay: { utilization: 0.4, resetAt: start + DAY },
  });

  t.mock.timers.tick(HOUR);
  am.sweepExpiredQuotas();
  assert.equal(q.unified5h, null);
  assert.equal(q.unified5hSeenAt, null, 'a stamp outliving its value would vouch for nothing');
  assert.equal(q.unified7dSeenAt, start);

  t.mock.timers.tick(DAY);
  am.sweepExpiredQuotas();
  assert.equal(q.unified7d, null);
  assert.equal(q.unified7dSeenAt, null);
});

test('a real stamp survives a restart, and a missing one is not invented', (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const am1 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am1.applyUsageData(0, { sevenDay: { utilization: 0.4, resetAt: start + DAY } });

  t.mock.timers.tick(10 * 60_000);
  const am2 = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  am2.getStatus();
  assert.equal(am2.accounts[0].quota.unified7d, 0.4);
  assert.equal(am2.accounts[0].quota.unified7dSeenAt, start, 'the restart kept the time upstream stated it');

  // A row written before the stamp existed: the value comes back, its age
  // stays unknown until upstream states the window again.
  const old = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  old.restoreQuotaState([{ accountUuid: 'p1', name: 'a', quota: { unified5h: 0.1, unified7d: 0.5, unified7dReset: start + DAY } }]);
  old.getStatus();
  assert.equal(old.accounts[0].quota.unified7d, 0.5);
  assert.equal(old.accounts[0].quota.unified5hSeenAt, null);
  assert.equal(old.accounts[0].quota.unified7dSeenAt, null);
  const again = new AccountManager([oauth('a', { accountUuid: 'p1' })], 0.98);
  again.restoreQuotaState(old.exportQuotaState());
  assert.equal(again.accounts[0].quota.unified7dSeenAt, null, 'a second restart does not start the clock either');
});

test('/teamclaude/status carries each stamp beside its value, for both providers', async () => {
  const upstream = http.createServer((req, res) => {
    const headers = req.url.startsWith('/backend-api/codex')
      ? { 'x-codex-primary-used-percent': '35', 'x-codex-primary-window-minutes': '10080' }
      : { 'anthropic-ratelimit-unified-5h-utilization': '0.2', 'anthropic-ratelimit-unified-7d-utilization': '0.4' };
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  const am = new AccountManager([
    oauth('claude', { accountUuid: 'p1' }),
    oauth('idle', { accountUuid: 'p2' }),
    codex('codex', { upstream: upstreamUrl }),
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: upstreamUrl });
  const port = await listen(proxy);

  try {
    const before = Date.now();
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    })).text();
    await (await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true }),
    })).text();
    const after = Date.now();

    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    const quota = name => status.accounts.find(a => a.name === name).quota;
    const within = (at, label) => assert.ok(at >= before && at <= after, `${label} ${at} not within [${before}, ${after}]`);

    assert.equal(quota('claude').unified5h, 0.2);
    within(quota('claude').unified5hSeenAt, 'claude 5h');
    assert.equal(quota('claude').unified7d, 0.4);
    within(quota('claude').unified7dSeenAt, 'claude 7d');

    assert.equal(quota('codex').unified7d, 0.35);
    within(quota('codex').unified7dSeenAt, 'codex 7d');
    assert.equal(quota('codex').unified5h, null);
    assert.equal(quota('codex').unified5hSeenAt, null);

    assert.equal(quota('idle').unified7d, null);
    assert.equal(quota('idle').unified5hSeenAt, null);
    assert.equal(quota('idle').unified7dSeenAt, null);
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
