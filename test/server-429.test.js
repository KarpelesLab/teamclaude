import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Drive one request through the proxy against an upstream that always 429s with
// the given Retry-After header, and report how the request terminated.
async function runAgainstThrottlingUpstream(retryAfterHeader) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': retryAfterHeader, 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    return { status: res.status, upstreamHits, accountStatus: am.accounts[0].status };
  } finally {
    proxy.close();
    upstream.close();
  }
}

// Regression: a persistently-throttled upstream must terminate (bounded retries),
// not loop forever tying up the client connection.
test('persistent upstream 429 terminates with a bounded number of retries', async () => {
  const { status, upstreamHits, accountStatus } = await runAgainstThrottlingUpstream('1');
  assert.equal(status, 429);                                   // returns 429 instead of hanging
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'throttled');                    // account throttled, not retried forever
});

// A negative (or otherwise out-of-range) Retry-After must not bypass the cap:
// it would make setTimeout return immediately and mark the account rate-limited
// in the past, reactivating it instantly.
test('negative Retry-After is clamped and still terminates', async () => {
  const { status, upstreamHits, accountStatus } = await runAgainstThrottlingUpstream('-1');
  assert.equal(status, 429);
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'throttled');
});

test('long upstream Retry-After is surfaced without sleeping in client request', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      assert.fail(`request should return 429 promptly, got ${err.name}`);
    }

    await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 1, 'long Retry-After should not be retried inline');
    assert.ok(Date.now() - started < 2000, 'request should not sleep for upstream retry window');
    assert.equal(am.accounts[0].status, 'throttled');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('temporarily exhausted fleet waits and retries instead of surfacing synthetic 429', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  am.markRateLimited(0, 1);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();

    assert.equal(res.status, 200, text);
    assert.equal(upstreamHits, 1, 'request should reach upstream after throttle expires');
    assert.ok(Date.now() - started >= 900, 'request should wait for retry window');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression for #46: a stale/poisoned cached quota (e.g. 0.98 from before a
// plan upgrade, with a reset still in the future) must NOT pin the proxy in a
// permanent synthetic 429. The next request should probe upstream, succeed, and
// refresh the cached quota — rather than refusing locally without any call.
test('stale over-threshold quota is re-probed, not refused forever', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, {
      'content-type': 'application/json',
      // Real headroom: the upgraded account is nowhere near its limit.
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
    });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  // Simulate restoring a poisoned snapshot from teamclaude.state.json.
  am.restoreQuotaState([
    { name: 'a', quota: { unified7d: 0.98, unified7dReset: Date.now() + 7 * 24 * 3600_000 } },
  ]);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'request should be proxied, not refused with a synthetic 429');
    assert.equal(upstreamHits, 1, 'a real upstream probe should have been made');
    assert.equal(am.accounts[0].quota.unified7d, 0.10, 'cached quota should be refreshed from the probe');
  } finally {
    proxy.close();
    upstream.close();
  }
});
