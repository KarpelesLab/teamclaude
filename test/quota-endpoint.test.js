import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('GET /teamclaude/quota returns the fleet quota without reaching upstream', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'team', type: 'oauth', accessToken: 'token',
    rateLimitTier: 'default_raven', seatTier: 'team_standard',
  }], 0.98);
  Object.assign(am.accounts[0].quota, { unified5h: 0.25, unified7d: 0.05 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  }, {
    getQuotaExtra: () => ({
      warmup: {
        enabled: true,
        mode: 'reset',
        timezone: 'Europe/Moscow',
        resetTime: '15:30',
        warmupTime: '10:30',
        windowSeconds: 18_000,
        nextWarmupAt: '2026-09-02T07:30:00.000Z',
        nextTargetResetAt: '2026-09-02T12:30:00.000Z',
        missedRunPolicy: 'skip',
      },
    }),
  });
  const port = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.accounts));
    assert.equal(body.accounts[0].name, 'team');
    assert.equal(body.accounts[0].tier.weight, 1);
    assert.equal(body.aggregate.fiveHour.remaining, 0.75);
    assert.equal(body.aggregate.weeklySonnet.remaining, 0.95);
    assert.deepEqual(body.warmup, {
      enabled: true,
      mode: 'reset',
      timezone: 'Europe/Moscow',
      resetTime: '15:30',
      warmupTime: '10:30',
      windowSeconds: 18_000,
      nextWarmupAt: '2026-09-02T07:30:00.000Z',
      nextTargetResetAt: '2026-09-02T12:30:00.000Z',
      missedRunPolicy: 'skip',
    });
    assert.equal(upstreamRequests, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('GET /teamclaude/quota returns 500 when its live metadata cannot be built', async () => {
  const am = new AccountManager([{
    name: 'team', type: 'oauth', accessToken: 'token',
  }], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
  }, {
    getQuotaExtra: () => { throw new Error('bad warm-up schedule'); },
  });
  const port = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.deepEqual(body, { error: 'internal server error' });
  } finally {
    proxy.close();
  }
});
