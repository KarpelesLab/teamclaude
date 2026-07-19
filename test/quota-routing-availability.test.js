import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { Prober } from '../src/prober.js';

// White-box guards below read the CLI wiring straight from source so a future
// refactor cannot silently drop the enable/priority/reload revalidation path.
const INDEX_SOURCE_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));

function manager(accounts, options = {}) {
  return new AccountManager(accounts, 0.98, {
    ramp: { enabled: false },
    ...options,
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function postJson(port, path = '/v1/messages') {
  const body = JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('mixed auth and quota failures never claim fleet-wide quota exhaustion', async () => {
  const rejected = Object.assign(new Error('invalid grant'), { status: 400 });
  const am = manager([
    { name: 'target', type: 'oauth', accessToken: 'old-a', refreshToken: 'bad-a', expiresAt: 1, priority: -10 },
    { name: 'quota', type: 'apikey', apiKey: 'quota-key', priority: 0 },
    { name: 'auth2', type: 'oauth', accessToken: 'old-c', refreshToken: 'bad-c', expiresAt: 1, priority: 1 },
  ], { refreshFn: async () => { throw rejected; } });
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '120',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1',
    });
    res.end('{"type":"error"}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const port = await listen(proxy);
  try {
    const response = await postJson(port);
    assert.equal(response.status, 503);
    assert.match(response.body, /2 authentication-invalid, 1 quota-limited/);
    assert.doesNotMatch(response.body, /All 3 accounts exhausted/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('only a genuinely all-quota fleet emits a quota-exhausted response', async () => {
  const am = manager([
    { name: 'quota1', type: 'apikey', apiKey: 'a' },
    { name: 'quota2', type: 'apikey', apiKey: 'b' },
  ]);
  for (const account of am.accounts) account.quota.unified5h = 1;
  am._nextProbeAt = Infinity;
  const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:1', proxy: {} });
  const port = await listen(proxy);
  try {
    const response = await postJson(port);
    assert.equal(response.status, 429);
    assert.match(response.body, /all_quota_exhausted/);
    assert.match(response.body, /usage limits/);
  } finally { await close(proxy); }
});

test('transient server 429 without an alternative keeps same-account backoff semantics', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
    res.end('{"type":"error"}');
  });
  const upstreamPort = await listen(upstream);
  const am = manager([{ name: 'only', type: 'apikey', apiKey: 'only' }]);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const response = await postJson(proxyPort);
    assert.equal(response.status, 429);
    assert.match(response.body, /Rate limited/);
    assert.equal(response.headers['retry-after'], '120');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('lower numeric priority preempts a healthy current account', () => {
  const am = manager([
    { name: 'current', type: 'apikey', apiKey: 'a', priority: 0 },
    { name: 'preferred', type: 'apikey', apiKey: 'b', priority: -10 },
  ]);
  assert.equal(am.getActiveAccount().name, 'preferred');
});

test('an authentication-error priority target falls back to a healthy account', () => {
  const am = manager([
    { name: 'fallback', type: 'apikey', apiKey: 'a', priority: 0 },
    { name: 'preferred', type: 'apikey', apiKey: 'b', priority: -10 },
  ]);
  am.accounts[1].status = 'error';
  assert.equal(am.getActiveAccount().name, 'fallback');
});

test('explicit enable clears cached error, throttle, and legacy exhausted states', () => {
  for (const staleState of ['error', 'throttled', 'exhausted']) {
    const am = manager([{ name: staleState, type: 'apikey', apiKey: 'a' }]);
    am.accounts[0].disabled = true;
    am.accounts[0].status = staleState;
    am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
    am.setDisabled(0, false);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].rateLimitedUntil, null);
  }
});

test('forced credential revalidation reports rejected refresh and marks auth error', async () => {
  const rejected = Object.assign(new Error('invalid grant'), { status: 400 });
  const am = manager([{
    name: 'oauth', type: 'oauth', accessToken: 'old', refreshToken: 'bad', expiresAt: Date.now() + 60_000,
  }], { refreshFn: async () => { throw rejected; } });
  const result = await am.ensureTokenFresh(0, true);
  assert.deepEqual(result, { ok: false, classification: 'authentication' });
  assert.equal(am.accounts[0].status, 'error');
});

test('fresh credentials clear an authentication error without clearing quota evidence', () => {
  const am = manager([{ name: 'oauth', type: 'oauth', accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 }]);
  am.accounts[0].status = 'error';
  am.accounts[0].quota.unified7d = 0.7;
  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'new-r', expiresAt: Date.now() + 60_000 });
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].quota.unified7d, 0.7);
});

test('live under-threshold usage evidence clears a legacy exhausted state', () => {
  const am = manager([{ name: 'quota', type: 'apikey', apiKey: 'a' }]);
  am.accounts[0].status = 'exhausted';
  am.accounts[0].quota.unified5h = 1;
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.2, resetAt: Date.now() + 60_000 },
    sevenDay: { utilization: 0.3, resetAt: Date.now() + 60_000 },
  });
  assert.equal(am.accounts[0].status, 'active');
});

test('availability summary separates requestable, auth, quota, throttle, disabled, and excluded', () => {
  const am = manager([
    { name: 'available', type: 'apikey', apiKey: 'a' },
    { name: 'auth', type: 'apikey', apiKey: 'b' },
    { name: 'quota', type: 'apikey', apiKey: 'c' },
    { name: 'throttle', type: 'apikey', apiKey: 'd' },
    { name: 'disabled', type: 'apikey', apiKey: 'e', disabled: true },
    { name: 'excluded', type: 'apikey', apiKey: 'f' },
  ]);
  am.accounts[1].status = 'error';
  am.accounts[2].quota.unified5h = 1;
  am.accounts[3].status = 'throttled';
  am.accounts[3].rateLimitedUntil = Date.now() + 60_000;
  const summary = am.getAvailabilitySummary(new Set([5]), 'claude-opus-4-8');
  assert.deepEqual(summary.counts, {
    available: 1, authentication: 1, quota: 1, temporary: 1,
    disabled: 1, route: 0, excluded: 1,
  });

  const routed = manager([
    { name: 'general', type: 'apikey', apiKey: 'g' },
    { name: 'fable-only', type: 'apikey', apiKey: 'f' },
  ], { routes: [{ name: 'fable', match: ['claude-fable-5'], accounts: ['fable-only'] }] });
  const routedSummary = routed.getAvailabilitySummary(null, 'claude-fable-5');
  assert.equal(routedSummary.counts.available, 1);
  assert.equal(routedSummary.counts.route, 1);
});

test('reload control forwards a bounded revalidation index and returns safe state', async () => {
  const am = manager([{ name: 'one', type: 'apikey', apiKey: 'a' }]);
  let observed = null;
  const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:1', proxy: {} }, {
    reload: async index => {
      observed = index;
      return { added: 0, revalidated: { requested: true, status: 'active' } };
    },
  });
  const port = await listen(proxy);
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/teamclaude/reload', method: 'POST',
        headers: { 'x-teamclaude-revalidate-index': '0' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('error', reject);
      req.end();
    });
    assert.equal(response.status, 200);
    assert.equal(observed, 0);
    assert.deepEqual(JSON.parse(response.body).revalidated, { requested: true, status: 'active' });
  } finally { await close(proxy); }

  const indexSource = await readFile(INDEX_SOURCE_PATH, 'utf8');
  assert.match(indexSource, /x-teamclaude-revalidate-index/);
  assert.match(indexSource, /sameIdentity\(account, diskAccount\)/);
});

test('a live upstream 401 is isolated and the request fails over to a healthy account', async () => {
  const calls = [];
  const emitted = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => emitted.push(args.join(' '));
  console.error = (...args) => emitted.push(args.join(' '));
  const upstream = http.createServer((req, res) => {
    const key = req.headers['x-api-key'];
    calls.push(key);
    if (key === 'secret-rejected-credential') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"authentication_error"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"sentinel":"ASCII_OK"}');
  });
  const upstreamPort = await listen(upstream);
  const am = manager([
    { name: 'account-a', type: 'apikey', apiKey: 'secret-rejected-credential', priority: -10 },
    { name: 'account-b', type: 'apikey', apiKey: 'secret-healthy-credential', priority: 0 },
  ]);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const response = await postJson(proxyPort);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['secret-rejected-credential', 'secret-healthy-credential']);
    assert.equal(am.accounts[0].status, 'error');
    assert.deepEqual(am.getAvailabilitySummary().counts, {
      available: 1, authentication: 1, quota: 0, temporary: 0,
      disabled: 0, route: 0, excluded: 0,
    });
    assert.doesNotMatch(emitted.join('\n'), /secret-(rejected|healthy)-credential/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await close(proxy);
    await close(upstream);
  }
});

test('one healthy account remains selectable beside two exhausted accounts', () => {
  const am = manager([
    { name: 'spent-a', type: 'apikey', apiKey: 'a', priority: -20 },
    { name: 'healthy', type: 'apikey', apiKey: 'b', priority: 0 },
    { name: 'spent-b', type: 'apikey', apiKey: 'c', priority: -10 },
  ]);
  am.accounts[0].quota.unified5h = 1;
  am.accounts[2].quota.unified7d = 1;
  assert.equal(am.getActiveAccount().name, 'healthy');
});

test('healthy selection survives one authentication failure and one exhausted account', () => {
  const am = manager([
    { name: 'auth', type: 'apikey', apiKey: 'a', priority: -20 },
    { name: 'quota', type: 'apikey', apiKey: 'b', priority: -10 },
    { name: 'healthy', type: 'apikey', apiKey: 'c', priority: 0 },
  ]);
  am.markAuthenticationFailed(0);
  am.accounts[1].quota.unified5h = 1;
  assert.equal(am.getActiveAccount().name, 'healthy');
});

test('a real usage rejection fails over and preserves quota classification', async () => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    const key = req.headers['x-api-key'];
    calls.push(key);
    if (key === 'spent') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '120',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 120_000) / 1000)),
      });
      res.end('{"type":"error"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = manager([
    { name: 'spent', type: 'apikey', apiKey: 'spent', priority: -10 },
    { name: 'healthy', type: 'apikey', apiKey: 'healthy', priority: 0 },
  ]);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const response = await postJson(proxyPort);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['spent', 'healthy']);
    assert.equal(am.getAvailabilitySummary().counts.quota, 1);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('an all-quota pool returns explicit quota code and reset timing', async () => {
  const resetAt = Date.now() + 120_000;
  const am = manager([
    { name: 'spent-a', type: 'apikey', apiKey: 'a' },
    { name: 'spent-b', type: 'apikey', apiKey: 'b' },
  ]);
  for (const account of am.accounts) {
    account.quota.unified5h = 1;
    account.quota.unified5hReset = resetAt;
  }
  am._nextProbeAt = Infinity;
  const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:1', proxy: {} });
  const port = await listen(proxy);
  try {
    const response = await postJson(port);
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 429);
    assert.equal(payload.error.code, 'all_quota_exhausted');
    assert.ok(Number(response.headers['retry-after']) > 0);
  } finally { await close(proxy); }
});

test('an all-temporary pool is not reported as quota exhausted', async () => {
  const am = manager([
    { name: 'temp-a', type: 'apikey', apiKey: 'a' },
    { name: 'temp-b', type: 'apikey', apiKey: 'b' },
  ]);
  for (const account of am.accounts) {
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + 120_000;
    account.throttledAt = Date.now();
  }
  am._nextProbeAt = Infinity;
  const proxy = createProxyServer(am, { upstream: 'http://127.0.0.1:1', proxy: {} });
  const port = await listen(proxy);
  try {
    const response = await postJson(port);
    const payload = JSON.parse(response.body);
    assert.equal(response.status, 429);
    assert.equal(payload.error.code, 'temporary_rate_limited');
    assert.doesNotMatch(response.body, /quota|exhausted/i);
  } finally { await close(proxy); }
});

test('concurrent admission serializes a live lease without poisoning availability', async () => {
  const am = manager([{ name: 'healthy', type: 'apikey', apiKey: 'a' }], {
    ramp: { enabled: true, startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 30_000, pollMs: 1 },
  });
  am._beginRamp(am.accounts[0]);
  assert.equal(await am.admit(0), true);
  let secondAdmitted = false;
  const second = am.admit(0).then(value => { secondAdmitted = value; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(secondAdmitted, false);
  assert.equal(am.getAvailabilitySummary().counts.available, 1);
  am.release(0);
  assert.equal(await second, true);
  am.release(0);
  assert.equal(am.accounts[0].inFlight, 0);
});

test('OAuth 401 refreshes once, then isolates and fails over without credential logs', async () => {
  const calls = [];
  const emitted = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => emitted.push(args.join(' '));
  console.error = (...args) => emitted.push(args.join(' '));
  const upstream = http.createServer((req, res) => {
    calls.push(req.headers.authorization || req.headers['x-api-key']);
    if (req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"type":"error"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  let refreshes = 0;
  const am = manager([
    {
      name: 'oauth-a', type: 'oauth', accessToken: 'secret-old-token',
      refreshToken: 'secret-refresh-token', expiresAt: Date.now() + 3_600_000, priority: -10,
    },
    { name: 'fallback', type: 'apikey', apiKey: 'secret-fallback-key', priority: 0 },
  ], {
    refreshFn: async () => {
      refreshes++;
      return {
        accessToken: 'secret-new-token', refreshToken: 'secret-new-refresh',
        expiresAt: Date.now() + 3_600_000,
      };
    },
  });
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const response = await postJson(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 3);
    assert.equal(am.accounts[0].status, 'error');
    assert.doesNotMatch(emitted.join('\n'), /secret-(old|new|refresh|fallback)/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await close(proxy);
    await close(upstream);
  }
});

test('all authentication failures terminate as mixed pool unavailable, not a leaked 401', async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error"}');
  });
  const upstreamPort = await listen(upstream);
  const am = manager([
    { name: 'a', type: 'apikey', apiKey: 'a' },
    { name: 'b', type: 'apikey', apiKey: 'b' },
    { name: 'c', type: 'apikey', apiKey: 'c' },
  ]);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const response = await postJson(proxyPort);
    assert.equal(calls, 3);
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'mixed_pool_unavailable');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('enable plus live revalidation retires stale quota before priority selection', async () => {
  const am = manager([
    { name: 'fallback', type: 'apikey', apiKey: 'fallback', priority: 0 },
    {
      name: 'target', type: 'oauth', accessToken: 'target-token', refreshToken: 'target-refresh',
      expiresAt: Date.now() + 3_600_000, priority: -100, disabled: true,
    },
  ]);
  am.accounts[1].status = 'exhausted';
  am.accounts[1].quota.unified5h = 1;
  am.setDisabled(1, false);
  assert.equal(am.getActiveAccount().name, 'fallback');

  const prober = new Prober(am, {
    probeFn: async () => ({
      fiveHour: { utilization: 0.1, resetAt: Date.now() + 60_000 },
      sevenDay: { utilization: 0.2, resetAt: Date.now() + 60_000 },
    }),
  });
  const validation = await prober.probeAccount(am.accounts[1]);
  assert.deepEqual(validation, { ok: true, classification: 'active' });
  assert.equal(am.selectActiveAccount().name, 'target');

  const indexSource = await readFile(INDEX_SOURCE_PATH, 'utf8');
  assert.match(indexSource, /await prober\.probeAccount\(account\)/);
  assert.match(indexSource, /accountManager\._isAvailable\(account\) \? 'active' : 'quota'/);
});

test('usage revalidation retries one 401 then quarantines the account', async () => {
  let probes = 0;
  let refreshes = 0;
  const am = manager([{
    name: 'oauth', type: 'oauth', accessToken: 'old', refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
  }], {
    refreshFn: async () => {
      refreshes++;
      return { accessToken: 'new', refreshToken: 'new-refresh', expiresAt: Date.now() + 3_600_000 };
    },
  });
  const prober = new Prober(am, {
    probeFn: async () => {
      probes++;
      return { error: 'HTTP 401', status: 401 };
    },
  });
  const result = await prober.probeAccount(am.accounts[0]);
  assert.deepEqual(result, { ok: false, classification: 'authentication' });
  assert.equal(probes, 2);
  assert.equal(refreshes, 1);
  assert.equal(am.accounts[0].status, 'error');
});

test('concurrent 401 recovery coalesces refresh and releases every lease', async () => {
  let refreshes = 0;
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer refreshed-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error"}');
  });
  const upstreamPort = await listen(upstream);
  const am = manager([{
    name: 'oauth', type: 'oauth', accessToken: 'stale-token', refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
  }], {
    refreshFn: async () => {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        accessToken: 'refreshed-token', refreshToken: 'next-refresh-token',
        expiresAt: Date.now() + 3_600_000,
      };
    },
  });
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, proxy: {} });
  const proxyPort = await listen(proxy);
  try {
    const responses = await Promise.all([postJson(proxyPort), postJson(proxyPort)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(refreshes, 1);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].inFlight, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
