// Exercise cooldowns and downstream reset headers through real HTTP responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const HOUR = 3600_000;
const RESET = 'anthropic-ratelimit-reset-requests';
const UNIFIED_STATUS = 'anthropic-ratelimit-unified-status';
const UNIFIED_RESET = 'anthropic-ratelimit-unified-reset';
// T3 Code's own pattern for a reset inside a Claude Code "API Error:" result.
const T3_RESET_AFTER = /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;

/** The seconds a T3-style reader takes from the message, or null when it finds none. */
function resetAfterSeconds(message) {
  const m = T3_RESET_AFTER.exec(message);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

/** A 429 that names no reset to wait for must not look like one that does. */
function assertNoResetSignal(res, message) {
  assert.equal(res.headers.get(UNIFIED_STATUS), null);
  assert.equal(res.headers.get(UNIFIED_RESET), null);
  assert.equal(resetAfterSeconds(message), null, message);
}

/** Bind an isolated listener without choosing a potentially occupied port. */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Run requests against disposable accounts; never load or persist real config. */
async function withFleet(handler, run, options = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const name = req.headers['x-api-key'];
    seen.push(name);
    handler(name, req, res);
  });
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    const am = new AccountManager(['a', 'b', 'c'].map(name => ({ name, type: 'apikey', apiKey: name })), 0.98, options);
    proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, upstreamProxy: false });
    const port = await listen(proxy);
    const post = (path = '/v1/messages') => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
    });
    await run({ am, post, seen });
  } finally {
    proxy?.closeAllConnections();
    proxy?.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

/** A session proxy's usage rejection can arrive without any limit headers. */
function reject(res, headers = {}, message = 'You have reached your usage limit.') {
  res.writeHead(429, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }));
}

/** Assert the client's cooldown and its absolute reset agree with pool state. */
async function assertExhausted(res, am, diagnostic) {
  assert.equal(res.status, 429);
  const reset = res.headers.get(RESET);
  const retry = Number(res.headers.get('retry-after'));
  assert.equal(new Date(reset).toISOString(), reset);
  const earliest = Math.min(...am.accounts.filter(a => !a.disabled).map(a => a.rateLimitedUntil));
  assert.ok(Math.abs(Date.parse(reset) - earliest) < 10, 'the earliest account reset is advertised');
  assert.ok(Number.isInteger(retry) && retry >= 1);
  assert.ok(Math.abs(retry - Math.ceil((Date.parse(reset) - Date.now()) / 1000)) <= 1);
  assert.equal(res.headers.get(UNIFIED_STATUS), 'rejected');
  assert.equal(Number(res.headers.get(UNIFIED_RESET)), Math.ceil(Date.parse(reset) / 1000));
  const body = await res.json();
  const wait = resetAfterSeconds(body.error.message);
  assert.ok(Math.abs(wait - retry) <= 1, `${body.error.message} names the retry-after wait`);
  assert.deepEqual(body, {
    type: 'error',
    error: { type: 'rate_limit_error', message: `All accounts reached usage limits. Next account resets at ${reset}. (reset after ${body.error.message.match(/\(reset after (\S+)\)/)?.[1]})`, details: body.error?.details },
  });
  assert.equal(body.error.details.error_code, 'pool_exhausted');
  assert.equal(body.error.details.resets_at, reset, 'the details name the reset the header advertises');
  diagnostic?.(`HTTP 429; retry-after: ${retry}; ${RESET}: ${reset}`);
}

test('headerless usage limits fail over through the pool and preserve a successful stream', async () => {
  const stream = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  await withFleet((name, _req, res) => {
    if (name !== 'c') return reject(res);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-success': 'preserved' });
    res.end(stream);
  }, async ({ am, post, seen }) => {
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-success'), 'preserved');
    assert.equal(res.headers.get(RESET), null);
    assert.equal(await res.text(), stream);
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(am.accounts[1].status, 'throttled');
    assert.equal(am.accounts[2].status, 'active');
  });
});

test('a headerless 429 without a message defaults to one hour and later requests skip cooled accounts', async t => {
  await withFleet((_name, _req, res) => reject(res, {}, ''), async ({ am, post, seen }) => {
    const before = Date.now();
    await assertExhausted(await post(), am, t.diagnostic.bind(t));
    for (const a of am.accounts) assert.ok(a.rateLimitedUntil >= before + HOUR);
    assert.deepEqual(seen, ['a', 'b', 'c']);
    await assertExhausted(await post(), am);
    assert.deepEqual(seen, ['a', 'b', 'c'], 'no request is sent during cooldown');
  });
});

for (const message of ['rate limit of 50 requests per minute', 'usage limit of 100 tokens per second', 'rate limit: 50 RPM']) {
  test(`headerless ${message} uses transient failover without an hour-long cooldown`, async () => {
    await withFleet((name, _req, res) => {
      if (name === 'a') return reject(res, {}, message);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, async ({ am, post, seen }) => {
      const res = await post();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(seen, ['a', 'b']);
      assert.equal(am.accounts[0].status, 'active');
      assert.equal(am.accounts[0].rateLimitedUntil, null);
      assert.ok(am.isPaused(0), 'the transient admission pause is still armed');
      assert.equal(am.accounts[1].status, 'active');
      assert.equal(res.headers.get(RESET), null);
    });
  });
}

test('disabled accounts do not suppress the standard pool-exhaustion message', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post, seen }) => {
    am.accounts[2].disabled = true;
    await assertExhausted(await post(), am);
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(am.accounts[2].rateLimitedUntil, null);
  });
});

test('global 429 chooses the first account to recover, using the last blocking clock per account', async t => {
  const now = Date.now();
  const resets = { a: now + 900_000, b: now + 600_000, c: now + 1200_000 };
  await withFleet((name, _req, res) => reject(res, {
    [RESET]: new Date(resets[name]).toISOString(), 'retry-after': '120',
  }), async ({ am, post, seen }) => {
    const res = await post();
    assert.ok(Math.abs(Date.parse(res.headers.get(RESET)) - resets.b) < 10);
    await assertExhausted(res, am, t.diagnostic.bind(t));
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });
});

for (const clock of ['retry-after', 'anthropic-ratelimit-requests-reset', 'unified']) {
  test(`usage cooldown honors upstream ${clock} clocks beyond one hour`, async () => {
    const resetAt = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
    const headers = clock === 'unified' ? {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(resetAt / 1000),
    } : { [clock]: clock === 'retry-after' ? new Date(resetAt).toUTCString() : new Date(resetAt).toISOString() };
    await withFleet((_name, _req, res) => reject(res, headers), async ({ am, post }) => {
      const res = await post();
      assert.ok(Math.abs(Date.parse(res.headers.get(RESET)) - resetAt) < 10);
      await assertExhausted(res, am);
    });
  });
}

test('invalid and past clocks fall back to a finite cooldown', async () => {
  await withFleet((_name, _req, res) => reject(res, {
    'retry-after': 'invalid', [RESET]: new Date(Date.now() - HOUR).toISOString(),
  }), async ({ am, post }) => {
    const before = Date.now();
    await assertExhausted(await post(), am);
    for (const a of am.accounts) assert.ok(a.rateLimitedUntil >= before + HOUR);
  });
});

test('expired cooldowns recover on the next request without a restart', async () => {
  let limited = true;
  await withFleet((_name, _req, res) => {
    if (limited) return reject(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, async ({ am, post, seen }) => {
    await assertExhausted(await post(), am);
    limited = false;
    am.accounts[1].rateLimitedUntil = Date.now() - 1;
    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(seen, ['a', 'b', 'c', 'b']);
    assert.equal(am.accounts[1].status, 'active');
    assert.equal(am.accounts[1].rateLimitedUntil, null);
  });
});

test('manual account pins do not leak to another account', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post, seen }) => {
    const res = await post('/tc-acct/a/v1/messages');
    assert.equal(res.status, 429);
    assert.ok(Math.abs(Date.parse(res.headers.get(RESET)) - am.accounts[0].rateLimitedUntil) < 10,
      JSON.stringify({ headers: Object.fromEntries(res.headers), accounts: am.accounts.map(a => ({ index: a.index, until: a.rateLimitedUntil })) }));
    assert.match((await res.json()).error.message, /Next account resets at/);
    assert.deepEqual(seen, ['a']);
  });
});

test('a pinned account held back by its usage cap answers 429 without a reset to wait for', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post, seen }) => {
    am.accounts[0].maxUsage = 0.5;
    Object.assign(am.accounts[0].quota, { unified7d: 0.9, unified7dReset: Date.now() + 86_400_000 });
    const res = await post('/tc-acct/a/v1/messages');
    assert.equal(res.status, 429);
    const { message } = (await res.json()).error;
    assert.match(message, /Pinned account is unavailable/);
    assertNoResetSignal(res, message);
    assert.deepEqual(seen, []);
  });
});

test('a pinned throttled account names its real reset to a T3-style reader', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post }) => {
    const res = await post('/tc-acct/a/v1/messages');
    assert.equal(res.status, 429);
    const until = am.accounts[0].rateLimitedUntil;
    assert.equal(res.headers.get(UNIFIED_STATUS), 'rejected');
    assert.equal(Number(res.headers.get(UNIFIED_RESET)), Math.ceil(until / 1000));
    const wait = resetAfterSeconds((await res.json()).error.message);
    assert.ok(Math.abs(wait - Math.ceil((until - Date.now()) / 1000)) <= 1, String(wait));
  });
});

test('a pool with no eligible account answers 429 without a reset to wait for', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post, seen }) => {
    for (const a of am.accounts) a.disabled = true;
    const res = await post();
    assert.equal(res.status, 429);
    const { message, details } = (await res.json()).error;
    assert.equal(details.resets_at, null);
    assertNoResetSignal(res, message);
    assert.deepEqual(seen, []);
  });
});

test('model routes exclude healthy siblings from failover and reset calculation', async () => {
  await withFleet((_name, _req, res) => reject(res), async ({ am, post, seen }) => {
    const res = await post();
    assert.equal(res.status, 429);
    assert.ok(Math.abs(Date.parse(res.headers.get(RESET)) - am.accounts[0].rateLimitedUntil) < 10);
    await res.json();
    assert.deepEqual(seen, ['a']);
  }, { routes: [{ match: ['claude-*'], accounts: ['a'] }] });
});

test('ordinary successful JSON responses remain untouched', async () => {
  await withFleet((_name, _req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'x-success': 'preserved' });
    res.end('{"ok":true}');
  }, async ({ post, seen }) => {
    const res = await post();
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-success'), 'preserved');
    assert.equal(res.headers.get(RESET), null);
    assert.equal(res.headers.get('retry-after'), null);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(seen, ['a']);
  });
});
