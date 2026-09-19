import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, forwardRequest } from '../src/server.js';
import { providerForPath } from '../src/provider.js';

// A 429 with no retry-after and no anthropic-ratelimit-* headers is upstream
// refusing the REQUEST (a model id it will not serve), not throttling the
// account. It used to be treated as a throttle: the account was paused for a
// fabricated 60s, so every other session on it waited, and the client was held
// for the same 60s per attempt (#288). Now nothing is paused.
//
// It is not always a refusal, though. Measured over a 32-minute window on one
// fleet: Fable requests drew one about every 8 minutes and no other model drew
// any; they arrived in 0.6-0.8s, started from four different accounts, and
// followed the request onto the account the hop moved it to — and the client's
// own retry usually succeeded. So the request now gets its one hop AND one
// short retry on the account it landed on, and only then does the 429 go back
// to the client, without a made-up retry-after.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

const DELAY_ENV = 'TEAMCLAUDE_HEADERLESS_429_RETRY_DELAY_MS';

// Shorten the retry's wait so these tests do not sit through the shipped 2s,
// and put it back afterwards — the no-sibling test below measures the default.
function withRetryDelay(ms) {
  const prev = process.env[DELAY_ENV];
  process.env[DELAY_ENV] = String(ms);
  return () => { if (prev == null) delete process.env[DELAY_ENV]; else process.env[DELAY_ENV] = prev; };
}

async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await delay(5); }
  assert.fail('condition did not settle within 2s');
}

async function post(port, model = 'claude-retired') {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [] }),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after'), ms: Date.now() - t0 };
}

// Refuses `claude-retired` with a headerless 429 (the shape observed upstream)
// and serves everything else.
function upstreamHandler(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const { model } = JSON.parse(raw || '{}');
    if (model === 'claude-retired') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This model is not available.' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

async function withFleet(names, fn, handler = upstreamHandler) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(names.map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const paused = (am, i) => am.accounts[i].pausedUntil != null && am.accounts[i].pausedUntil > Date.now();

test('a headerless 429 that survives the hop is retried exactly once, then goes back to the client', async () => {
  const restore = withRetryDelay(25);
  try {
    await withFleet(['a', 'b'], async ({ am, proxyPort, seen }) => {
      const r = await post(proxyPort);
      assert.equal(r.status, 429, 'the refusal belongs to the client');
      assert.deepEqual(seen, ['t-a', 't-b', 't-b'],
        'one hop, then ONE retry on the account it landed on — never a third account, never a ladder');
      assert.equal(r.retryAfter, null, 'no fabricated retry-after');
      assert.match(r.body.error.message, /not available/, 'the upstream reason reaches the client');
      assert.ok(r.ms < 5000, `answered in ${r.ms}ms, not a fabricated 60s`);
      assert.equal(paused(am, 0), false, 'the refused account is not paused');
      assert.equal(paused(am, 1), false, 'nor the sibling');
      // Other traffic on the same account is unaffected: the next request, for a
      // model upstream serves, goes to `a` and is answered at once. The retry
      // detours via ctx.hopTo precisely so it leaves the fleet cursor alone.
      const ok = await post(proxyPort, 'claude-fine');
      assert.equal(ok.status, 200);
      assert.equal(seen[3], 't-a', 'the hop and the retry left the fleet cursor on a');
      assert.ok(ok.ms < 2000, `served in ${ok.ms}ms`);
    });
  } finally { restore(); }
});

// What the retry exists for: the limit is a transient that belongs to neither
// account, so the same request on the same account succeeds a moment later and
// the client never learns anything went wrong. Without this the client showed
// "will retry in 2m 38s" and paused, with nothing in the session transcript.
test('a headerless 429 that clears on the retry is never shown to the client', async () => {
  const RETRY_DELAY_MS = 300;
  const restore = withRetryDelay(RETRY_DELAY_MS);
  let refused = 0;
  // Refuses the first attempt and the hop; serves the retry.
  const clearsOnThirdAttempt = (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (refused++ < 2) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  };
  try {
    await withFleet(['a', 'b'], async ({ proxyPort, seen }) => {
      const r = await post(proxyPort);
      assert.equal(r.status, 200, 'the retry succeeded, so the client gets the answer rather than the 429');
      assert.deepEqual(seen, ['t-a', 't-b', 't-b'], 'the retry stayed on the account the hop landed on');
      assert.ok(r.ms >= RETRY_DELAY_MS - 50,
        `the retry was sent after ${r.ms}ms — it must wait, and TEAMCLAUDE_HEADERLESS_429_RETRY_DELAY_MS must be what it waits`);
    }, clearsOnThirdAttempt);
  } finally { restore(); }
});

// The wait must not outlive the client. waitForRetry ends on the request's
// abort signal, and the attempt it was waiting to make is dropped rather than
// sent — a retry nobody is waiting for costs an account a request for nothing.
test('a client that leaves during the wait is never retried on', async () => {
  const restore = withRetryDelay(600);
  try {
    await withFleet(['a', 'b'], async ({ proxyPort, seen }) => {
      const ac = new AbortController();
      const inflight = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-retired', messages: [] }),
        signal: ac.signal,
      }).then(() => 'answered', () => 'aborted');
      // Leave once the hop has been refused — i.e. while the retry is waiting.
      await until(() => seen.length === 2);
      ac.abort();
      assert.equal(await inflight, 'aborted');
      await delay(800);   // well past the wait the retry would have served out
      assert.deepEqual(seen, ['t-a', 't-b'], 'a retry was sent for a client that had already gone');
    });
  } finally { restore(); }
});

// `headersSent` cannot be arranged through the proxy — nothing writes to the
// client before the 429 branch — so this drives forwardRequest against a real
// request/response pair whose head is already flushed. A reply on the wire must
// not be retried under: there is no status left to send.
test('with the reply already on the wire, the retry is skipped', async () => {
  const restore = withRetryDelay(25);
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); upstreamHandler(req, res); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(['a', 'b'].map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  // The bytes the client sends are the bytes forwardRequest forwards, so the
  // request it builds upstream is well-formed (a body that disagreed with the
  // inherited content-length is refused upstream, and tests the fake, not this).
  const REQUEST_BODY = JSON.stringify({ model: 'claude-retired', messages: [] });
  const host = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });   // the head is gone
    const ctx = {
      account: null, status: null, tried: new Set(), reauthed: new Set(),
      model: 'claude-retired', advisorModel: null, pinnedIndex: null,
      provider: providerForPath(req.url), holdBudgetMs: 0, sessionId: null, client: null,
      delivered: false, abandoned: false, onUsage: () => {}, stripHeaders: null, logLevel: 'off',
    };
    await forwardRequest(req, res, Buffer.from(REQUEST_BODY), am, `http://127.0.0.1:${upstreamPort}`, 0, {}, 'req-1', ctx, null, null, undefined);
    res.end('{"served":"before the 429"}');
  });
  const hostPort = await listen(host);
  try {
    const res = await fetch(`http://127.0.0.1:${hostPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: REQUEST_BODY,
    });
    assert.equal(res.status, 200, 'the reply already on the wire stands');
    assert.equal((await res.json()).served, 'before the 429');
    assert.deepEqual(seen, ['t-a', 't-b'], 'the hop still ran, but the retry after it must not');
  } finally { restore(); host.close(); upstream.close(); }
});

// The two retries sit on different branches — one runs only before the failover
// hop, the other only after it — but one request can reach both: it finds no
// idle sibling, retries, and by then a sibling has come back, so it hops and
// lands on the post-hop branch with its wait apparently unspent. Two flags would
// have let that request wait twice. They share one.
test('a request that reaches both retry sites still waits only once', async () => {
  const RETRY_DELAY_MS = 400;
  const restore = withRetryDelay(RETRY_DELAY_MS);
  try {
    await withFleet(['a', 'b', 'c'], async ({ am, proxyPort, seen }) => {
      // No idle sibling at the first refusal, and one by the second. Set
      // directly rather than through pauseAccount, which also teaches the
      // concurrency learner and arms a ramp — neither is what this is about.
      am.accounts[1].pausedUntil = Date.now() + RETRY_DELAY_MS / 2;
      am.accounts[2].pausedUntil = Date.now() + RETRY_DELAY_MS / 2;
      const r = await post(proxyPort);
      assert.equal(r.status, 429);
      assert.equal(seen.length, 3,
        `upstream saw ${seen.length} attempts: the first refusal, the retry, and the hop after it. `
        + 'A fourth means the post-hop branch spent a second wait the request had already used');
      assert.ok(r.ms < RETRY_DELAY_MS * 2,
        `answered in ${r.ms}ms — one wait of ${RETRY_DELAY_MS}ms, not two`);
    });
  } finally { restore(); }
});

test('with no sibling, a headerless 429 gets one short retry and then reaches the client', async () => {
  await withFleet(['a'], async ({ am, proxyPort, seen }) => {
    const r = await post(proxyPort);
    assert.equal(r.status, 429);
    assert.equal(seen.length, 2, 'one retry, not a walk');
    assert.ok(r.ms >= 1900 && r.ms < 10_000, `one 2s retry, got ${r.ms}ms`);
    assert.equal(paused(am, 0), false);
  });
});

// A delay of 0 is the operator saying "do not retry": they would rather have
// the 429 at once than have the transient absorbed. It has to switch off BOTH
// retry sites, since one env var moves both — the hop still runs, because it
// costs no wait, and nothing follows it.
test('a retry delay of 0 disables the retry at both sites', async () => {
  const restore = withRetryDelay(0);
  try {
    await withFleet(['a', 'b'], async ({ am, proxyPort, seen }) => {
      const r = await post(proxyPort);
      assert.equal(r.status, 429);
      assert.deepEqual(seen, ['t-a', 't-b'], 'the hop, and no retry after it');
      assert.equal(r.retryAfter, null, 'no fabricated retry-after');
      assert.equal(paused(am, 0), false);
      assert.equal(paused(am, 1), false);
    });
    await withFleet(['a'], async ({ proxyPort, seen }) => {
      const r = await post(proxyPort);
      assert.equal(r.status, 429);
      assert.deepEqual(seen, ['t-a'], 'no sibling and no retry: asked once');
      assert.ok(r.ms < 1500, `answered in ${r.ms}ms; the default would have waited 2s first`);
    });
  } finally { restore(); }
});

// The control: a 429 that carries rate-limit headers is still a throttle and
// still pauses the account (the existing server-429 tests pin the rest).
test('a 429 with a retry-after header is still treated as a throttle', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([account('a')], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const p = post(proxyPort);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(paused(am, 0), true, 'a throttle pauses the account');
    await p;
  } finally { proxy.close(); upstream.close(); }
});
