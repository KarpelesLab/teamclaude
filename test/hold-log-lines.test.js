import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// #641: a 429 hold is capped at an hour, so it can end while the spent window
// still bars the account. The two log lines around the hold now say so instead
// of reading as an account back in rotation.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

function captureLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.log = real; }).then(() => lines);
}

test('"marking active" names the quota that still bars the account after its hold', async () => {
  const am = new AccountManager(accounts(), 0.98);
  const a = am.accounts[0];
  const reset = Date.now() + 2 * HOUR;
  Object.assign(a.quota, { unified5h: 1, unified5hReset: reset, unified7d: 0.17 });
  a.status = 'throttled';
  a.rateLimitedUntil = Date.now() - 1;
  let reason;
  const lines = await captureLog(() => { reason = am.unavailableReason(a); });
  assert.equal(reason, 'quota');
  const line = lines.find(l => l.includes('rate limit expired'));
  assert.ok(line, 'the expiry line is still printed');
  assert.ok(line.includes(`(still barred by its unified5h quota until ${new Date(reset).toISOString()})`), line);
});

test('"marking active" stays plain when nothing bars the account', async () => {
  const am = new AccountManager(accounts(), 0.98);
  const a = am.accounts[0];
  Object.assign(a.quota, { unified5h: 0.2, unified7d: 0.17 });
  a.status = 'throttled';
  a.rateLimitedUntil = Date.now() - 1;
  const lines = await captureLog(() => am.unavailableReason(a));
  const line = lines.find(l => l.includes('rate limit expired'));
  assert.match(line ?? '', /marking active$/);
});

test('the 429 hold line names a spent window that resets after the hold', async () => {
  const reset5h = Math.floor((Date.now() + 2.5 * HOUR) / 1000);
  const upstream = http.createServer((req, res) => {
    if ((req.headers.authorization || '') === 'Bearer t-a') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3600',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-5h-reset': String(reset5h),
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.17',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-x', messages: [] }),
      });
      await res.text();
      assert.equal(res.status, 200, 'the sibling served it');
    });
    const line = lines.find(l => l.includes('Quota rejection (429)'));
    assert.ok(line, `no rejection line in: ${lines.join('\n')}`);
    assert.match(line, /throttling 3600s \(5h window resets in 2h \d+m\) and switching account/);
    assert.doesNotMatch(line, /weekly window/, 'a window that was not rejected is not named');
  } finally {
    proxy.close();
    upstream.close();
  }
});
