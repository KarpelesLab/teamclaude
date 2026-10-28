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
// Deterministic: the clock is mocked (Date and the hold's setTimeout), so
// recovery is driven by ticking time, not by waiting. A hold is observed through
// its own log line, so no test polls or sleeps.

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

// Counts the hold's log line. console.log is swallowed for the test's duration
// so the output stays the test's own.
function holdLog(t) {
  let count = 0;
  const waiting = [];
  t.mock.method(console, 'log', (...args) => {
    if (!String(args[0]).includes('holding connection')) return;
    count++;
    for (const w of waiting.splice(0)) w();
  });
  return {
    next(n) {
      return new Promise(resolve => {
        const check = () => (count >= n ? resolve() : waiting.push(check));
        check();
      });
    },
  };
}

// Mocks the clock before the AccountManager reads it. respond(token, req, res)
// plays the upstream.
async function fleet(t, accounts, respond) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  const holds = holdLog(t);
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const token = bearer(req);
    seen.push(token);
    respond(token, req, res);
  });
  const upPort = await listen(upstream);
  let refreshes = 0;
  const am = new AccountManager(accounts, 0.98, { refreshFn: async () => { refreshes++; throw new Error('no refresh in this test'); } });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, holdSeconds: 300,
  });
  const port = await listen(proxy);
  return {
    port, seen, holds, refreshes: () => refreshes,
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
