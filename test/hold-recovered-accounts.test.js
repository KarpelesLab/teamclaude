import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A held request (holdSeconds) that failed over off every account used to
// sleep out its budget: forwardRequest recursed with ctx.tried still naming
// each account that had already failed, so an account that recovered during
// the hold was never selected again.
//
// Deterministic: the clock is mocked (Date and the proxy's setTimeout), so
// recovery is driven by ticking time, not by waiting. The proxy's own log lines
// announce each hold and each wait, so the test ticks exactly as far as the
// proxy asked and no test polls or sleeps.

const START = Date.UTC(2026, 9, 28, 12, 0, 0);
const SEC = 1000;
const HOUR = 3600 * SEC;

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const bearer = req => String(req.headers.authorization ?? '').replace(/^Bearer /, '');

const oauth = (name, token, expiresAt = START + HOUR) =>
  ({ name, type: 'oauth', accessToken: token, refreshToken: `r${token}`, expiresAt });

// A subscription 429 that names when its window resets, as upstream does.
function rateLimited(res, resetAt) {
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': String(Math.ceil((resetAt - Date.now()) / SEC)),
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(resetAt / 1000)),
    'anthropic-ratelimit-unified-5h-utilization': '1',
  });
  res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
}

function served(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
}

// Upstream refused the credential itself: a wait cannot fix this.
function refused(res) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
}

// The proxy's wait lines: a hold, an absorbed same-account 429, or the inline
// wait after exhaustion. Each carries the seconds it will sleep.
const WAIT_LINE = /holding connection, retry in (\d+)s|— waiting (\d+)s/;

// Counts the proxy's holds and reports each wait it announces. console.log is
// swallowed for the test's duration so the output stays the test's own.
function proxyLog(t) {
  let holds = 0;
  const holdWaiters = [];
  const waits = [];
  const waitWaiters = [];
  t.mock.method(console, 'log', (...args) => {
    const line = String(args[0]);
    if (line.includes('holding connection')) {
      holds++;
      for (const w of holdWaiters.splice(0)) w();
    }
    const m = WAIT_LINE.exec(line);
    if (!m) return;
    const wait = { wait: Number(m[1] ?? m[2]) * SEC };
    if (waitWaiters.length) waitWaiters.shift()(wait); else waits.push(wait);
  });
  return {
    holds: {
      next(n) {
        return new Promise(resolve => {
          const check = () => (holds >= n ? resolve() : holdWaiters.push(check));
          check();
        });
      },
    },
    waits: {
      next: () => new Promise(resolve => {
        if (waits.length) resolve(waits.shift()); else waitWaiters.push(resolve);
      }),
    },
  };
}

// Mocks the clock before the AccountManager reads it. respond(token, req, res)
// plays the upstream. holdSeconds defaults to a budget long enough to outlast
// every test that does not set its own.
async function fleet(t, accounts, respond, { holdSeconds = 300 } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  const log = proxyLog(t);
  const seen = [];
  const times = [];
  const upstream = http.createServer((req, res) => {
    const token = bearer(req);
    seen.push(token);
    times.push(Date.now() - START);
    respond(token, req, res);
  });
  const upPort = await listen(upstream);
  let refreshes = 0;
  const am = new AccountManager(accounts, 0.98, { refreshFn: async () => { refreshes++; throw new Error('no refresh in this test'); } });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, holdSeconds,
  });
  const port = await listen(proxy);
  return {
    port, seen, times, holds: log.holds, waits: log.waits, refreshes: () => refreshes,
    close() { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); },
  };
}

// Resolves with the request's status, or 'closed' if the proxy drops it.
function post(port) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', () => resolve('closed'));
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
}

// Plays the clock forward through each wait the proxy announces, ticking exactly
// as long as it asked, until the request settles. The next attempt can only
// follow a tick, so the upstream calls are paced by the proxy's own clock.
async function drive(t, f, outcome) {
  for (;;) {
    const r = await Promise.race([outcome, f.waits.next()]);
    if (r === null || typeof r !== 'object') return r;
    t.mock.timers.tick(r.wait);
  }
}

// The held request's outcome once the clock has moved: its reply, or a second
// hold, which is what a request that skipped the recovered account does.
const reply = (outcome, f) => Promise.race([outcome, f.holds.next(2).then(() => 'held again')]);

// Each test drains its own held request before it ends. One left open kept the
// next test's mocked clock from firing its hold timer, so the next test hung.
async function drain(f, outcome) {
  f.close();
  await outcome;
}

test('a held request retries an account that recovered after it failed over', async t => {
  let aRecovered = false;
  const f = await fleet(t, [oauth('a', 'ta'), oauth('b', 'tb')], (token, req, res) => {
    if (token === 'ta' && aRecovered) return served(res);
    rateLimited(res, token === 'ta' ? START + 90 * SEC : START + HOUR);
  });
  const outcome = post(f.port);
  try {
    await f.holds.next(1);                 // both accounts failed over; the request is held
    aRecovered = true;                     // a's window resets 90 s out
    t.mock.timers.tick(90 * SEC);          // fires the hold's timer; the retry runs after this
    const result = await reply(outcome, f);
    assert.equal(result, 200, `the held request was held again instead of retrying the account that recovered (got ${result})`);
    assert.equal(f.seen.length, 3, `expected two failed hops and one retry, saw ${f.seen.join(',')}`);
    assert.equal(f.seen[2], 'ta', 'the retry goes to the account that recovered');
  } finally { await drain(f, outcome); }
});

// b comes first in the rotation, so the request fails over onto a. The walk
// resumes from a when the hold ends, which is what makes a's exclusion bite.
test('a held request never retries an account upstream refused, even once another has recovered', async t => {
  let bRecovered = false;
  const f = await fleet(t, [oauth('b', 'tb'), oauth('a', 'ta')], (token, req, res) => {
    if (token === 'ta') return refused(res);
    if (bRecovered) return served(res);
    rateLimited(res, START + 90 * SEC);
  });
  const outcome = post(f.port);
  try {
    await f.holds.next(1);
    bRecovered = true;
    t.mock.timers.tick(90 * SEC);
    const result = await reply(outcome, f);
    assert.equal(result, 200, `the held request was held again instead of retrying the account that recovered (got ${result})`);
    assert.equal(f.seen.filter(x => x === 'ta').length, 1, 'the refused credential was sent again');
    assert.equal(f.seen.at(-1), 'tb', 'the retry goes to the account that recovered');
  } finally { await drain(f, outcome); }
});

test('a held request never sends a token it could not renew, even once another has recovered', async t => {
  let bRecovered = false;
  // a's token expired an hour before the clock started and its refresh fails.
  // b comes first in the rotation, as in the refusal test above.
  const f = await fleet(t, [oauth('b', 'tb'), oauth('a', 'ta', START - HOUR)], (token, req, res) => {
    if (bRecovered) return served(res);
    rateLimited(res, token === 'tb' ? START + 90 * SEC : START + HOUR);
  });
  const outcome = post(f.port);
  try {
    await f.holds.next(1);
    bRecovered = true;
    t.mock.timers.tick(90 * SEC);
    const result = await reply(outcome, f);
    assert.equal(result, 200, `the held request was held again instead of retrying the account that recovered (got ${result})`);
    assert.ok(!f.seen.includes('ta'), 'a token that could not be renewed was sent upstream');
    assert.equal(f.refreshes(), 1, 'the account whose token could not be renewed was selected again, and renewal retried');
  } finally { await drain(f, outcome); }
});

// The retry after a hold is answered 429 again, although the account's own state
// says it has recovered (upstream's window runs a little longer, as in the
// field). The held request must keep waiting on the proxy's clock and succeed
// once upstream recovers, not return that 429 with budget left.
test('a held request whose retry is still limited waits again and succeeds once upstream recovers', async t => {
  const f = await fleet(t, [oauth('a', 'ta'), oauth('b', 'tb')], (token, req, res) => {
    if (Date.now() < START + 3 * SEC) return rateLimited(res, Date.now() + SEC);
    served(res);
  }, { holdSeconds: 6 });
  const outcome = post(f.port);
  try {
    const result = await drive(t, f, outcome);
    assert.equal(result, 200, `the held request returned ${result} with budget left, instead of waiting for upstream to recover`);
    // Attempts are paced by the proxy's clock. One failover chain may reach both
    // accounts at a single instant, and no instant may carry more than that; each
    // new instant comes only after a tick, at least a second on.
    const perInstant = new Map();
    for (const at of f.times) perInstant.set(at, (perInstant.get(at) ?? 0) + 1);
    for (const [at, n] of perInstant) {
      assert.ok(n <= 2, `${n} upstream calls at ${at}ms: a retry was sent without a wait (${f.seen.join(',')})`);
    }
    const instants = [...perInstant.keys()].sort((x, y) => x - y);
    for (let i = 1; i < instants.length; i++) {
      assert.ok(instants[i] - instants[i - 1] >= SEC, `attempts at ${instants[i - 1]}ms and ${instants[i]}ms were back-to-back`);
    }
  } finally { await drain(f, outcome); }
});

// Upstream never recovers. The held request spends its budget and is answered
// with the 429 it always was: the budget is what ends the hold.
test('a held request whose hold budget runs out is answered 429', async t => {
  const f = await fleet(t, [oauth('a', 'ta'), oauth('b', 'tb')], (token, req, res) => {
    rateLimited(res, Date.now() + SEC);
  }, { holdSeconds: 6 });
  const outcome = post(f.port);
  try {
    const result = await drive(t, f, outcome);
    assert.equal(result, 429, `expected the budget to run out with a 429, got ${result}`);
    assert.ok(f.seen.length <= 20, `expected a bounded number of upstream calls, saw ${f.seen.length}`);
  } finally { await drain(f, outcome); }
});

// No hold configured: the exhausted request takes the inline wait, one short
// wait sized by the accounts' own reset, then retries. That retry must reach the
// account that recovered during the wait.
test('an inline exhausted wait retries an account that recovered during it', async t => {
  const f = await fleet(t, [oauth('a', 'ta'), oauth('b', 'tb')], (token, req, res) => {
    if (Date.now() < START + 5 * SEC) return rateLimited(res, START + 5 * SEC);
    served(res);
  }, { holdSeconds: 0 });
  const outcome = post(f.port);
  try {
    const result = await drive(t, f, outcome);
    assert.equal(result, 200, `the inline retry was not sent to the recovered account (got ${result})`);
    assert.equal(f.seen.length, 3, `expected two failed hops and one retry, saw ${f.seen.join(',')}`);
  } finally { await drain(f, outcome); }
});
