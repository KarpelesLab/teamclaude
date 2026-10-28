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
    return {
      status: res.status, upstreamHits,
      accountStatus: am.accounts[0].status,
      paused: am.accounts[0].pausedUntil != null && am.accounts[0].pausedUntil > Date.now(),
    };
  } finally {
    proxy.close();
    upstream.close();
  }
}

// Regression: a persistently rate-limited upstream must terminate (bounded
// retries), not loop forever tying up the client connection. A rate-limit 429
// does NOT rotate/throttle the account (#84) — it pauses it (so concurrent
// requests wait) and retries the same account, then surfaces a 429.
test('persistent upstream 429 terminates with a bounded number of retries', async () => {
  const { status, upstreamHits, accountStatus, paused } = await runAgainstThrottlingUpstream('1');
  assert.equal(status, 429);                                   // returns 429 instead of hanging
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'active');                       // NOT throttled — no rotation on a rate-limit 429
  assert.ok(paused, 'account should be paused, so concurrent requests wait');
});

// A negative (or otherwise out-of-range) Retry-After must not bypass the cap:
// it would make setTimeout return immediately (and previously mark the account
// rate-limited in the past, reactivating it instantly).
test('negative Retry-After is clamped and still terminates', async () => {
  const { status, upstreamHits, accountStatus, paused } = await runAgainstThrottlingUpstream('-1');
  assert.equal(status, 429);
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'active');
  assert.ok(paused);
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
    // The bound is the 300 s retry window the proxy must NOT sleep through,
    // not a measure of speed: a signal at a fraction of that window fails a
    // proxy that absorbed it and nothing that merely ran on a busy machine.
    const started = Date.now();
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      assert.fail(`request should return 429 without waiting out the retry window, got ${err.name}`);
    }

    await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 1, 'long Retry-After should not be retried inline');
    assert.ok(Date.now() - started < 150_000, 'request should not sleep for upstream retry window');
    assert.equal(am.accounts[0].status, 'active', 'rate-limit 429 must not throttle/rotate the account');
    assert.ok(am.accounts[0].pausedUntil > Date.now(), 'account should be paused so concurrent requests wait');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A rate-limit 429 (no quota-rejected status) must NOT rotate to another
// account — every retry stays on the same one (#84: rotating just moves the
// burst and drops the KV cache).
test('a rate-limit 429 rotates at most once, never into a carousel', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    // The invariant changed deliberately. #84 argued that rotating on a
    // rate-limit 429 moves the burst and discards the KV cache, and this test
    // used to assert no rotation at all. That was too strong: it also stalled a
    // fleet whose sibling was idle, which is what #137, #165 and #156 reported.
    //
    // What has to hold now is the bounded version — ONE hop, not a walk of the
    // fleet. When the second account is throttled too the limit is scoped to
    // the egress IP, not the accounts, so continuing would pay a cold cache per
    // attempt to learn nothing.
    // One hop means two DISTINCT accounts. The attempt count is higher than two
    // on purpose: this upstream answers `retry-after: 1`, inside the inline
    // absorb cap, so after the hop the same-account wait-and-retry still runs —
    // pre-existing behaviour that the hop does not replace. What must not happen
    // is a third account being drawn in.
    const accounts = new Set(seen);
    assert.equal(accounts.size, 2, `expected one hop, saw ${accounts.size} accounts`);
    // Still no throttling: a rate-limit 429 is not quota exhaustion, so neither
    // account is marked, and both stay selectable once their pause lapses.
    assert.equal(am.accounts[0].status, 'active', 'a rate limit must not throttle the account');
    assert.equal(am.accounts[1].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A quota-rejection 429 (unified status "rejected") is durable exhaustion, so it
// DOES rotate — account a is throttled and the request succeeds on account b.
test('a quota-rejection 429 rotates to the next account', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'should succeed on the second account');
    assert.equal(am.accounts[0].status, 'throttled', 'exhausted account is throttled (rotated away)');
    assert.ok(seen.includes('Bearer t-b'), 'request rotated to account b');
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

// ── the all-exhausted refusal says it is pool exhaustion ──────
//
// Both the synthetic refusal and an upstream rate limit reach the client as
// `rate_limit_error`, so a client that wants to tell them apart has to read the
// message. `details.error_code` is the machine-readable answer: `pool_exhausted`
// on the proxy's own refusal, with the retry-after it sent and `resets_at` set
// only to a real reset clock. A fleet with nothing eligible at all is
// `no_eligible_account`, a configuration problem rather than exhaustion. The
// upstream's 429 is relayed without details.

/**
 * Drive one request through a proxy whose upstream counts its hits and answers
 * `upstreamStatus`. Returns the response, the account manager, and the bracket
 * of local time the request was made in.
 */
async function requestThroughProxy({ setup, upstreamStatus = 200, upstreamRetryAfter = null }) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    const headers = { 'content-type': 'application/json' };
    if (upstreamRetryAfter != null) headers['retry-after'] = upstreamRetryAfter;
    res.writeHead(upstreamStatus, headers);
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  setup(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const before = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    const body = await res.json();
    const after = Date.now();
    return { res, body, am, before, after, upstreamHits };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('an all-exhausted refusal carries error_code pool_exhausted, the retry-after it sent, and the real reset', async () => {
  const { res, body, am, upstreamHits } = await requestThroughProxy({
    // Throttled for five minutes: nothing is servable and the proxy refuses
    // locally, so the upstream must never be reached.
    setup: m => m.markRateLimited(0, 300),
  });

  assert.equal(res.status, 429);
  assert.equal(upstreamHits, 0, 'the refusal is synthetic: no upstream attempt');
  const details = body.error.details;
  assert.equal(details.error_code, 'pool_exhausted');
  assert.ok(Number.isInteger(details.retry_after_seconds) && details.retry_after_seconds > 0);
  assert.equal(res.headers.get('retry-after'), String(details.retry_after_seconds),
    'the header and the body name the same wait');

  // resets_at is the account's own reset clock, not a figure derived from the
  // retry-after: the two match to the millisecond, with no clock tolerance.
  assert.equal(details.resets_at, new Date(am.accounts[0].rateLimitedUntil).toISOString());
});

test('the all-exhausted refusal keeps its type and message', async () => {
  const { body } = await requestThroughProxy({ setup: m => m.markRateLimited(0, 300) });

  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error', 'Claude Code keys its retry behaviour on this');
  assert.match(body.error.message, /^No account can serve this request for claude-opus-5: all 1 account/);
  assert.match(body.error.message, /at their quota or rate limit\./);
});

test('an eligible account with no reset clock is pool_exhausted with resets_at null', async () => {
  // A dead credential: the wait falls back to the untimed interval, and no
  // reset exists to name. A downstream system must not read that 60s as a reset.
  const { res, body, upstreamHits } = await requestThroughProxy({
    setup: m => { m.accounts[0].status = 'error'; },
  });

  assert.equal(res.status, 429);
  assert.equal(upstreamHits, 0);
  const details = body.error.details;
  assert.equal(details.error_code, 'pool_exhausted');
  assert.equal(details.resets_at, null, 'an untimed wait is not a reset');
  assert.equal(details.retry_after_seconds, Number(res.headers.get('retry-after')));
});

test('no eligible account is no_eligible_account with resets_at null, since it is a configuration problem', async () => {
  const { res, body, upstreamHits } = await requestThroughProxy({
    setup: m => { m.accounts[0].disabled = true; },
  });

  assert.equal(res.status, 429);
  assert.equal(upstreamHits, 0);
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /every account eligible for it is disabled/);
  const details = body.error.details;
  assert.equal(details.error_code, 'no_eligible_account');
  assert.equal(details.resets_at, null, 'nothing will reset');
  assert.equal(details.retry_after_seconds, Number(res.headers.get('retry-after')));
});

test('an upstream 429 relayed to the client does not claim pool exhaustion', async () => {
  const { res, body, upstreamHits } = await requestThroughProxy({
    setup: () => {},
    upstreamStatus: 429,
    upstreamRetryAfter: '300',
  });

  assert.equal(res.status, 429);
  assert.equal(upstreamHits, 1, 'a long upstream retry-after is relayed, not retried inline');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.details, undefined, 'only the proxy\'s own refusal carries details');
});
