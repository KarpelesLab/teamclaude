import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { refreshAccessToken, parseRetryAfterMs } from '../src/oauth.js';

// A 429 from the token endpoint is the endpoint asking to be left alone. A forward
// with an expired token asks for a refresh, its 401 forces another, and the retry
// a third: measured at 3 token-endpoint calls per client request, Retry-After or
// not. The account holds its refreshes for the Retry-After, or a short default.

async function tokenServer(status, headers = {}) {
  let hits = 0;
  const srv = http.createServer((_req, res) => {
    hits++;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end('{"error":{"type":"rate_limit_error"}}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, endpoint: `http://127.0.0.1:${srv.address().port}/token`, hits: () => hits };
}

function mgr(refreshFn) {
  return new AccountManager([{
    name: 'a', type: 'oauth',
    accessToken: 'at-old', refreshToken: 'rt-a', expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn });
}

function rateLimited(retryAfterMs) {
  const e = new Error('Token refresh failed (429): {"error":{"type":"rate_limit_error"}}');
  e.status = 429;
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
  return e;
}

test('parseRetryAfterMs reads delta-seconds and an HTTP date, and nothing else', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  assert.strictEqual(parseRetryAfterMs('120', now), 120_000);
  assert.strictEqual(parseRetryAfterMs(' 7 ', now), 7_000);
  assert.strictEqual(parseRetryAfterMs('Tue, 13 Oct 2026 00:01:00 GMT', now), 60_000);
  assert.strictEqual(parseRetryAfterMs('Mon, 12 Oct 2026 23:00:00 GMT', now), 0, 'a date past is no wait');
  for (const v of [undefined, null, '', '  ', 'soon']) assert.strictEqual(parseRetryAfterMs(v, now), undefined, `${v}`);
});

test('refreshAccessToken reports a 429 with its Retry-After, in seconds or as a date, and is not retried', async () => {
  // The date is an hour out: what is left of it by the time it is parsed
  // depends on the clock, so only its bounds are checked.
  const inAnHour = new Date(Date.now() + 3600_000).toUTCString();
  for (const [header, check] of [
    ['120', (ms) => ms === 120_000],
    [inAnHour, (ms) => ms > 0 && ms <= 3600_000],
    [undefined, (ms) => ms === undefined],
    ['soon', (ms) => ms === undefined],
  ]) {
    const { srv, endpoint, hits } = await tokenServer(429, header === undefined ? {} : { 'retry-after': header });
    try {
      const err = await refreshAccessToken('r', endpoint).catch((e) => e);
      assert.strictEqual(err.status, 429);
      assert.ok(check(err.retryAfterMs), `${header} -> ${err.retryAfterMs}`);
      assert.strictEqual(hits(), 1, 'a 429 is not retried inside the call');
    } finally {
      srv.close();
    }
  }
});

test('after a 429 the account holds its refreshes for the Retry-After, forced or not', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw rateLimited(120_000); });
  await m.ensureTokenFresh(0);
  // What one client request does next: its 401 forces a refresh, and so does the retry.
  await m.ensureTokenFresh(0, true);
  await m.ensureTokenFresh(0, true);
  for (let i = 0; i < 10; i++) await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 1, 'one call to the token endpoint, not one per attempt');
  assert.notStrictEqual(m.accounts[0].status, 'error', 'a 429 is not an auth rejection');
  assert.strictEqual(m.accounts[0].credential, 'at-old', 'the account keeps its token');
});

test('a 429 without Retry-After still holds the refreshes for a while', async () => {
  let calls = 0;
  const m = mgr(async () => { calls++; throw rateLimited(undefined); });
  await m.ensureTokenFresh(0);
  await m.ensureTokenFresh(0, true);
  await m.ensureTokenFresh(0, true);
  assert.strictEqual(calls, 1);
});

test('the hold lifts once the Retry-After has passed, and a success clears it', async () => {
  let calls = 0;
  let fail = true;
  const m = mgr(async () => {
    calls++;
    if (fail) throw rateLimited(50);
    return { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 };
  });
  await m.ensureTokenFresh(0);
  await new Promise((r) => setTimeout(r, 80));
  fail = false;
  await m.ensureTokenFresh(0);
  assert.strictEqual(calls, 2);
  assert.strictEqual(m.accounts[0].credential, 'at-new');
});

// The Retry-After is upstream's number, and the hold above takes it as-is: one
// header of 99999999999 held an account's refreshes for about 3,169 years, past
// a re-login and a re-enable, until a restart. Taken at most as an hour.

test('parseRetryAfterMs takes an absurd Retry-After as an hour, in seconds or as a date', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  assert.strictEqual(parseRetryAfterMs('3599', now), 3_599_000, 'under the ceiling: as sent');
  assert.strictEqual(parseRetryAfterMs('3600', now), 3600_000, 'at the ceiling: as sent');
  for (const v of ['3601', '99999999999', '9'.repeat(400), 'Tue, 13 Oct 2026 01:00:01 GMT', 'Fri, 31 Dec 9999 23:59:59 GMT']) {
    assert.strictEqual(parseRetryAfterMs(v, now), 3600_000, v.slice(0, 32));
  }
});

test('an absurd Retry-After from the token endpoint holds the refreshes for an hour, not for millennia', async () => {
  for (const header of ['99999999999', 'Fri, 31 Dec 9999 23:59:59 GMT']) {
    const { srv, endpoint, hits } = await tokenServer(429, { 'retry-after': header });
    try {
      const m = mgr((rt, _endpoint, routing, opts) => refreshAccessToken(rt, endpoint, routing, opts));
      await m.ensureTokenFresh(0);
      const held = m.accounts[0]._refreshHeldUntil - Date.now();
      assert.ok(held > 0 && held <= 3600_000, `${header} -> held ${held} ms`);
      await m.ensureTokenFresh(0, true);
      assert.strictEqual(hits(), 1, 'held for that hour');
    } finally {
      srv.close();
    }
  }
});

test('a Retry-After too long for a Date does not throw out of ensureTokenFresh', async () => {
  // Past about 8.6 trillion seconds the hold is past the last moment a Date can
  // name, and the log line that prints it threw a RangeError out of the refresh.
  const { srv, endpoint } = await tokenServer(429, { 'retry-after': '9999999999999' });
  try {
    const m = mgr((rt, _endpoint, routing, opts) => refreshAccessToken(rt, endpoint, routing, opts));
    await assert.doesNotReject(m.ensureTokenFresh(0));
    assert.ok(Number.isFinite(new Date(m.accounts[0]._refreshHeldUntil).getTime()));
  } finally {
    srv.close();
  }
});
