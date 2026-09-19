import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { codexSpentWindows, isAccountWideCodexWindow } from '../src/codex-quota.js';

// A Codex 429 whose subscription window is spent is durable exhaustion, not a
// transient throttle. Anthropic says so outright, as `…-status: rejected`; this
// backend publishes no status at all, only a used-percent at its limit. Reading
// the unified statuses alone filed that response as a throttle: the account was
// paused rather than held, the same spent subscription was asked again, and
// nothing recorded that it was out of service or until when.

// `retry-after` on every fixture. Chosen so the assertions can tell things
// apart: it is not the 60s the branch falls back to when the header is missing,
// and it is under RATE_LIMIT_ABSORB_MAX_SECONDS (60), so without the fix the
// throttle path absorbs it inline and asks the spent account a second time.
const RETRY_AFTER = 45;
// Six hours out, far past the hold, so a test can tell which of the two the
// hold was taken from.
const RESET_AT_MS = (Math.floor(Date.now() / 1000) + 6 * 3600) * 1000;

/** A 429 the way this backend states a spent account-wide weekly window. */
const spentWeekly = {
  'retry-after': String(RETRY_AFTER),
  'content-type': 'application/json',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '100',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': String(RESET_AT_MS / 1000),
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
};

// A spent SESSION window, which is the shape a subscription actually returns:
// the account-wide family carries only the weekly one — with headroom here —
// and the 5-hour window lives in a named, model-scoped family. Nothing in the
// account-wide percentages says this account is refusing.
const spentNamedFiveHour = {
  'retry-after': String(RETRY_AFTER),
  'content-type': 'application/json',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '42',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-gpt-5-limit-name': 'gpt-5',
  'x-codex-gpt-5-primary-used-percent': '100',
  'x-codex-gpt-5-primary-window-minutes': '300',
  'x-codex-gpt-5-secondary-used-percent': '42',
  'x-codex-gpt-5-secondary-window-minutes': '10080',
};

// Only a NAMED family's weekly bucket is spent: one model family is refused and
// every account-wide window has headroom, so the account still serves the rest.
const spentNamedWeekly = {
  'retry-after': String(RETRY_AFTER),
  'content-type': 'application/json',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '50',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-gpt-5-limit-name': 'gpt-5',
  'x-codex-gpt-5-secondary-used-percent': '100',
  'x-codex-gpt-5-secondary-window-minutes': '10080',
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const codexAccount = (name, upstreamPort) => ({
  name, type: 'oauth', provider: 'codex',
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  accountId: 'acct-' + name,
  // A Codex account's default upstream is chatgpt.com; the per-account override
  // points it at the local recorder.
  upstream: `http://127.0.0.1:${upstreamPort}`,
});

function codexRequest(proxyPort) {
  return fetch(`http://127.0.0.1:${proxyPort}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true }),
  });
}

// ── which windows the headers report as spent ────────────────────────────────

test('an account-wide window at its limit is spent', () => {
  assert.deepEqual(codexSpentWindows(spentWeekly), ['weekly']);
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '300',
  }), ['5h']);
  // Upstream keeps counting once a window is past its limit.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '104.2',
    'x-codex-primary-window-minutes': '10080',
  }), ['weekly']);
});

test('a named family at its limit is spent, account-wide headroom or not', () => {
  // The case the account-wide percentages cannot state: a subscription's only
  // 5-hour window sits in a named family, and the flat pair reads 42% / 0%.
  assert.deepEqual(codexSpentWindows(spentNamedFiveHour), ['5h']);
  // A model-scoped weekly bucket is spent on its own terms.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-gpt-5-limit-name': 'gpt-5',
    'x-codex-gpt-5-secondary-used-percent': '100',
    'x-codex-gpt-5-secondary-window-minutes': '10080',
  }), ['gpt-5 weekly']);
});

test('only the bare labels are account-wide', () => {
  assert.equal(isAccountWideCodexWindow('5h'), true);
  assert.equal(isAccountWideCodexWindow('weekly'), true);
  // A model bucket always carries its family name, so it cannot pass for one.
  assert.equal(isAccountWideCodexWindow('gpt-5 weekly'), false);
  assert.deepEqual(codexSpentWindows(spentNamedWeekly), ['gpt-5 weekly']);
});

test('headroom, and headers that state nothing, are not spent', () => {
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': '99.4',
    'x-codex-primary-window-minutes': '10080',
  }), []);
  // A 429 with no Codex headers at all — the throttle case, which must stay a
  // throttle: pausing and retrying the same account is the right answer to it.
  assert.deepEqual(codexSpentWindows({}), []);
  // Anthropic's own spelling is classified by the unified statuses, not here.
  assert.deepEqual(codexSpentWindows({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }), []);
  // A zeroed window is how this API says "not applicable"; a percentage beside
  // it means nothing, and reading it as spent would hold a healthy account.
  assert.deepEqual(codexSpentWindows({
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-window-minutes': '0',
  }), []);
  // Unparseable or unstated readings are dropped rather than guessed at.
  assert.deepEqual(codexSpentWindows({
    'x-codex-primary-used-percent': 'n/a',
    'x-codex-primary-window-minutes': '10080',
  }), []);
  assert.deepEqual(codexSpentWindows({ 'x-codex-primary-used-percent': '100' }), []);
});

// ── end to end ───────────────────────────────────────────────────────────────

test('a spent Codex subscription is held for retry-after and the request rotates', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t-codex-1') {
      res.writeHead(429, spentWeekly);
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [codexAccount('codex-1', upstreamPort), codexAccount('codex-2', upstreamPort)],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    const before = Date.now();
    const res = await codexRequest(proxyPort);
    await res.text();
    const after = Date.now();
    assert.equal(res.status, 200, 'should succeed on the second subscription');
    assert.ok(seen.includes('Bearer t-codex-2'), 'request rotated to the second subscription');

    // The hold is what separates a rejection from a throttle. A throttle only
    // pauses — the account stays `active` and selectable, and the pause also
    // teaches the concurrency learner it was refused at that load, which a
    // spent quota is no evidence of. A rejection marks it throttled.
    const spentAccount = am.accounts[0];
    assert.equal(spentAccount.status, 'throttled');
    assert.equal(am.isPaused(0), false, 'a rejection holds the account, it does not pause it');

    // The branch holds for `Math.min(Math.max(retryAfter, 1), 3600)` — neither
    // clamp binds at 45s, so the hold is retry-after verbatim.
    const hold = spentAccount.rateLimitedUntil;
    assert.ok(hold >= before + RETRY_AFTER * 1000 && hold <= after + RETRY_AFTER * 1000,
      `hold should be ${RETRY_AFTER}s from the refusal, was ${(hold - before) / 1000}s`);

    // Not the window's own reset, though the headers stated it and it was
    // recorded: the hold is how long upstream asked to be left alone, and the
    // utilization above the switch threshold is what keeps selection off the
    // account for the rest of the window. That holds for an account-wide
    // window only — selection reads unified5h/unified7d, not the model buckets.
    assert.equal(spentAccount.quota.unified7dReset, RESET_AT_MS);
    assert.ok(hold < RESET_AT_MS, 'the hold is retry-after, not the window reset');
    assert.equal(spentAccount.quota.unified7d, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a lone spent Codex subscription is not asked a second time', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, spentWeekly);
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([codexAccount('codex-1', upstreamPort)], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    const res = await codexRequest(proxyPort);
    await res.text();
    assert.equal(res.status, 429);
    // The regression, and the one case with no sibling to fail over to: read as
    // a throttle, retry-after is under the inline-absorb cap, so the proxy slept
    // it out and re-sent the request to the same spent subscription.
    assert.equal(upstreamHits, 1, 'the spent subscription must not be retried');
    assert.equal(am.isPaused(0), false, 'the throttle path must not have run');
    assert.equal(am.accounts[0].status, 'throttled');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a spent session window is a rejection even though it is model-scoped', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, spentNamedFiveHour);
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([codexAccount('codex-1', upstreamPort)], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    const res = await codexRequest(proxyPort);
    await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 1, 'the spent session window must not be retried');
    assert.equal(am.isPaused(0), false, 'the throttle path must not have run');
    assert.equal(am.accounts[0].status, 'throttled');
    // The account-wide weekly window has headroom; only the named family is
    // spent, and it is the one the account is actually refusing on.
    assert.equal(am.accounts[0].quota.unified7d, 0.42);
    assert.equal(am.accounts[0].quota.unified5h, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a spent named-family weekly bucket rotates the request without holding the account', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t-codex-1') {
      res.writeHead(429, spentNamedWeekly);
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [codexAccount('codex-1', upstreamPort), codexAccount('codex-2', upstreamPort)],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    const res = await codexRequest(proxyPort);
    await res.text();
    assert.equal(res.status, 200, 'should succeed on the second subscription');
    // Asked once and not again: the bucket is spent, so waiting out retry-after
    // on the same account would only buy a second refusal.
    assert.deepEqual(seen, ['Bearer t-codex-1', 'Bearer t-codex-2']);

    // The account is left in rotation. Only one model family is refused, and
    // nothing in selection reads the model buckets — so a hold would lapse, the
    // account would be picked again, refuse again and be parked again: a healthy
    // subscription out of service for every model over one family's bucket.
    const account = am.accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null, 'a model-scoped rejection must not hold the account');
    assert.equal(am.isPaused(0), false, 'nor pause it: the throttle path must not have run');
    assert.equal(account.quota.unified7d, 0.5);
  } finally {
    proxy.close();
    upstream.close();
  }
});
