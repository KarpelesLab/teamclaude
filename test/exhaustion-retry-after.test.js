import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { candidateAccounts, computeRetryAfter } from '../src/server.js';

// Every account had spent its weekly window, three days from resetting, and the
// proxy answered `retry-after: 60`. Claude Code honours that to the letter: it
// waited a minute, retried, and went on doing so — a spinner and no error, for
// as long as the operator left it running.
//
// Sixty seconds is the default `computeRetryAfter` falls back to when it can see
// no reset at all, and it could see none because it read `quota.resetsAt` and
// nothing else. That field is set from the tokens/requests headers an API key
// returns; a subscription is metered by the unified windows, so on a
// subscription fleet it is null on every account.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra,
});
const chatgpt = (name) => oauth(name, { provider: 'codex', accountId: 'acct-' + name });

/** Merge quota fields into a named account. */
function quota(am, name, fields) {
  const account = am.accounts.find(a => a.name === name);
  Object.assign(account.quota, fields);
  return account;
}

/** Seconds, allowing for the clock moving while the test runs. */
function near(actual, expectedMs, what) {
  const expected = Math.ceil(expectedMs / 1000);
  assert.ok(Math.abs(actual - expected) <= 2, `${what}: expected about ${expected}s, got ${actual}s`);
}

// ── the live failure ──────────────────────────────────────────

test('a spent weekly window answers with its own reset, not the 60s default', () => {
  const am = new AccountManager([chatgpt('one'), chatgpt('two')], 0.98, {
    routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['one', 'two'] }],
  });
  // The shape read off both accounts: weekly spent, no `resetsAt` anywhere.
  for (const name of ['one', 'two']) {
    quota(am, name, { unified7d: 1, unified7dReset: Date.now() + 3 * DAY, resetsAt: null });
  }
  const candidates = candidateAccounts(am, 'gpt-5.6-sol', 'codex');
  near(computeRetryAfter(am, candidates, 'gpt-5.6-sol'), 3 * DAY, 'the real reset was invisible');
});

test('an account blocked by nothing the proxy can time still falls back to 60s', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.equal(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 60);
});

// ── only a blocking window may name the moment ────────────────

test('a healthy 5-hour bucket about to refresh does not shorten the answer', () => {
  // The optimistic read this fix exists to prevent: 12% of the session window
  // is not why the request was refused, so its imminent reset says nothing.
  const am = new AccountManager([oauth('a')], 0.98);
  quota(am, 'a', {
    unified5h: 0.12, unified5hReset: Date.now() + MINUTE,
    unified7d: 1, unified7dReset: Date.now() + 2 * DAY,
  });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 2 * DAY, 'a bucket with headroom answered');
});

test('a spent 5-hour bucket does name its reset', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  quota(am, 'a', { unified5h: 1, unified5hReset: Date.now() + 2 * HOUR });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 2 * HOUR, 'the session window was ignored');
});

test('the threshold that takes an account out of rotation is the one that applies here', () => {
  // Per-bucket `switchThreshold`: at 0.9 the weekly bucket is what stops the
  // account serving, so it is what the wait is measured from. One opinion about
  // "blocked", shared with `_isNearQuota`.
  const am = new AccountManager([oauth('a')], { default: 0.98, unified7d: 0.9 }, {});
  quota(am, 'a', { unified7d: 0.95, unified7dReset: Date.now() + DAY });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), DAY, 'the configured weekly threshold was not applied');

  const strict = new AccountManager([oauth('a')], 0.98);
  quota(strict, 'a', { unified7d: 0.95, unified7dReset: Date.now() + DAY });
  assert.equal(computeRetryAfter(strict, strict.accounts, 'claude-opus-5'), 60,
    'a bucket under its threshold is not blocking anything');
});

test('a family request is timed by the family bucket that governs it', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  quota(am, 'a', {
    unified7dFable: 1, unified7dFableReset: Date.now() + 2 * DAY,
    unified7d: 0.2, unified7dReset: Date.now() + 6 * DAY,
  });
  near(computeRetryAfter(am, am.accounts, 'claude-fable-5'), 2 * DAY, 'the shared weekly answered for Fable');
  assert.equal(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 60,
    'a spent Fable bucket does not block Opus, so it cannot time it either');
});

test('both weekly buckets spent means the wait is the later of the two', () => {
  // The gate is a maximum over the family bucket and the shared one, so the
  // family clearing first frees nothing: the shared weekly still bars every
  // request. `modelRoutingLine` reports recovery the same way.
  const am = new AccountManager([oauth('a')], 0.98);
  quota(am, 'a', {
    unified7dFable: 1, unified7dFableReset: Date.now() + DAY,
    unified7d: 1, unified7dReset: Date.now() + 5 * DAY,
  });
  near(computeRetryAfter(am, am.accounts, 'claude-fable-5'), 5 * DAY,
    'the family reset was advertised while the shared weekly still barred the request');
});

test('a learned scoped weekly bucket is a blocking window like any other', () => {
  // A family with no dedicated field of its own can still be metered by a
  // bucket the usage endpoint reports, which is what `scopedWeekly` learns.
  const am = new AccountManager([oauth('a')], 0.98);
  quota(am, 'a', {
    unified7d: 0.3, unified7dReset: Date.now() + 6 * DAY,
    scopedWeekly: { opus: { utilization: 1, resetAt: Date.now() + 12 * HOUR } },
  });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 12 * HOUR, 'the scoped bucket was not consulted');
});

test('a tokens window answers only while it is the thing running out', () => {
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'k' }], 0.98);
  quota(am, 'k', { tokensLimit: 100, tokensRemaining: 90, resetsAt: Date.now() + 5 * MINUTE });
  am.accounts[0].rateLimitedUntil = Date.now() + MINUTE;
  near(computeRetryAfter(am, am.accounts, null), MINUTE, 'a full token bucket held the account past its throttle');

  quota(am, 'k', { tokensRemaining: 1 });
  near(computeRetryAfter(am, am.accounts, null), 5 * MINUTE, 'the tokens window never answered');
});

// ── max within an account, min across the fleet ───────────────

test('an account spent for the week is not freed by its hour-long throttle', () => {
  // A quota rejection throttles the account as well, for the hour the 429 path
  // clamps a relayed retry-after to. Reading the sooner of the two would
  // advertise an hour on a window with three days left.
  const am = new AccountManager([chatgpt('one')], 0.98);
  quota(am, 'one', { unified7d: 1, unified7dReset: Date.now() + 3 * DAY });
  am.accounts[0].rateLimitedUntil = Date.now() + HOUR;
  near(computeRetryAfter(am, am.accounts, 'gpt-5.6-sol'), 3 * DAY, 'the throttle masked the real window');
});

test('the fleet is back when the first account is', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  quota(am, 'a', { unified7d: 1, unified7dReset: Date.now() + 3 * DAY });
  quota(am, 'b', { unified5h: 1, unified5hReset: Date.now() + HOUR });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), HOUR, 'the soonest account to recover was not used');
});

test('a hold that has already expired is not a hold', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].rateLimitedUntil = Date.now() - MINUTE;
  am.accounts[0].entitlementDeniedUntil = Date.now() - HOUR;
  assert.equal(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 60,
    'a lapsed timestamp reported the fleet as instantly retryable');
});

test('an entitlement quarantine is a block with a clock, and counts', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].entitlementDeniedUntil = Date.now() + 10 * MINUTE;
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 10 * MINUTE, 'the quarantine was ignored');
});

// ── the pool the question is asked of ─────────────────────────

test('an Anthropic account resetting sooner does not time a Codex request', () => {
  const am = new AccountManager([chatgpt('one'), oauth('claude-1')], 0.98, {
    routes: [{ name: 'codex', match: ['gpt-*'], accounts: ['one'] }],
  });
  quota(am, 'one', { unified7d: 1, unified7dReset: Date.now() + 3 * DAY });
  quota(am, 'claude-1', { unified5h: 1, unified5hReset: Date.now() + MINUTE });
  const candidates = candidateAccounts(am, 'gpt-5.6-sol', 'codex');
  near(computeRetryAfter(am, candidates, 'gpt-5.6-sol'), 3 * DAY,
    'an account the request could never have used answered for it');
});

test('a disabled account keeps its windows to itself', () => {
  const am = new AccountManager([oauth('a'), oauth('b', { disabled: true })], 0.98);
  quota(am, 'a', { unified7d: 1, unified7dReset: Date.now() + 2 * DAY });
  quota(am, 'b', { unified5h: 1, unified5hReset: Date.now() + MINUTE });
  near(computeRetryAfter(am, am.accounts, 'claude-opus-5'), 2 * DAY,
    'an account out of rotation by operator decision was counted as capacity returning');
});

// ── the gate and the clock are one opinion, per bucket ────────
//
// `blockingResets` walks `_isNearQuota`'s gate rather than deriving a second
// one: same checks, same order, same per-bucket `switchThreshold`, with each
// check handing back the reset of the window it just tripped on. So the two owe
// each other an answer on EVERY bucket the gate can turn on — a bucket that
// blocks the request but names no clock puts that bucket alone back in the
// silent 60s loop, and the family and learned buckets are exactly where such a
// hole would hide: they are the ones the gate reaches through `_governingWeekly`
// rather than reading off the quota directly.
//
// One fixture per bucket, asserted both ways round: over its threshold it must
// both refuse the request and time it, and under its threshold it must do
// neither — a reset a bucket still carries is not allowed to shorten the answer
// once that bucket has headroom again.

const apikey = (name) => ({ name, type: 'apikey', apiKey: 'k-' + name });

const BUCKETS = [
  {
    what: 'the shared 5-hour window',
    model: 'claude-opus-5',
    blocks: at => ({ unified5h: 1, unified5hReset: at(2 * HOUR) }),
    spare: () => ({ unified5h: 0.2 }),
    until: 2 * HOUR,
  },
  {
    what: 'the shared weekly window',
    model: 'claude-opus-5',
    blocks: at => ({ unified7d: 1, unified7dReset: at(3 * DAY) }),
    spare: () => ({ unified7d: 0.2 }),
    until: 3 * DAY,
  },
  {
    // The `7d_oi` headers land here: updateQuota stores that bucket as
    // `unified7dFable`, so this is the gate a Fable-cap 429 arms.
    what: "Fable's own weekly bucket",
    model: 'claude-fable-5',
    blocks: at => ({ unified7dFable: 1.01, unified7dFableReset: at(4 * DAY) }),
    spare: () => ({ unified7dFable: 0.2 }),
    until: 4 * DAY,
  },
  {
    what: "Sonnet's own weekly bucket",
    model: 'claude-sonnet-4-5',
    blocks: at => ({ unified7dSonnet: 1, unified7dSonnetReset: at(5 * DAY) }),
    spare: () => ({ unified7dSonnet: 0.2 }),
    until: 5 * DAY,
  },
  {
    // The gate is a maximum over the family bucket and the shared one, so the
    // shared window can be the whole reason a family request is refused. Its
    // clock is then the answer, and the family bucket's — an hour out, with
    // headroom to spare — must not be.
    what: 'the shared weekly window behind a family request',
    model: 'claude-fable-5',
    blocks: at => ({
      unified7d: 1, unified7dReset: at(5 * DAY),
      unified7dFable: 0.2, unified7dFableReset: at(HOUR),
    }),
    spare: () => ({ unified7d: 0.2 }),
    until: 5 * DAY,
  },
  {
    // A family with no dedicated field of its own, metered by a bucket the
    // usage endpoint reports and `scopedWeekly` remembers.
    what: 'a learned scoped weekly bucket',
    model: 'claude-opus-5',
    blocks: at => ({
      unified7d: 0.3, unified7dReset: at(6 * DAY),
      scopedWeekly: { opus: { utilization: 1, resetAt: at(12 * HOUR) } },
    }),
    spare: at => ({ scopedWeekly: { opus: { utilization: 0.2, resetAt: at(12 * HOUR) } } }),
    until: 12 * HOUR,
  },
  {
    what: 'the tokens window',
    key: true,
    blocks: at => ({ tokensLimit: 100, tokensRemaining: 1, resetsAt: at(5 * MINUTE) }),
    spare: () => ({ tokensRemaining: 90 }),
    until: 5 * MINUTE,
  },
  {
    what: 'the requests window',
    key: true,
    blocks: at => ({ requestsLimit: 100, requestsRemaining: 1, resetsAt: at(20 * MINUTE) }),
    spare: () => ({ requestsRemaining: 90 }),
    until: 20 * MINUTE,
  },
];

for (const { what, model = null, key = false, blocks, spare, until } of BUCKETS) {
  test(`${what} both gates the request and times it`, () => {
    const at = ms => Date.now() + ms;

    const am = new AccountManager([key ? apikey('k') : oauth('a')], 0.98);
    Object.assign(am.accounts[0].quota, blocks(at));
    // The fixture has to be a real refusal, or the number below pins nothing.
    assert.equal(am.unavailableReason(am.accounts[0], model), 'quota',
      `${what}: the fixture does not take the account out of rotation`);
    near(computeRetryAfter(am, am.accounts, model), until,
      `${what} refused the request without saying when it would be servable again`);

    const ok = new AccountManager([key ? apikey('k') : oauth('a')], 0.98);
    Object.assign(ok.accounts[0].quota, blocks(at), spare(at));
    assert.equal(ok.unavailableReason(ok.accounts[0], model), null,
      `${what}: the relieved fixture still blocks, so the pin below proves nothing`);
    assert.equal(computeRetryAfter(ok, ok.accounts, model), 60,
      `${what} named a reset while it had headroom — an optimistic wait is the 60s loop again`);
  });
}
