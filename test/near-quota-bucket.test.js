import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fleet() {
  return new AccountManager([oauth('a'), oauth('b')], 0.98);
}

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// ── _isNearQuota names the bucket that fired ─────────────────

test('the 5-hour bucket fires first and is named, even when the weekly is known too', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  assert.equal(am._nearQuotaBucket(a), 'unified5h');
});

test('a governing weekly bucket fires and is named when the 5-hour is fresh', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.10, unified7d: 0.99 });
  assert.equal(am._nearQuotaBucket(a), 'unified7d');
  assert.equal(am._isNearQuota(a), true);
});

test('a family weekly bucket is named for the model it governs', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.10, unified7dFable: 0.99, unified7d: 0.20 });
  assert.equal(am._nearQuotaBucket(a, 'claude-fable-5-1'), 'unified7dFable');
});

test('a tokens bucket fires and is named on an API-key account', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: null, tokensLimit: 1000, tokensRemaining: 10 });
  assert.equal(am._nearQuotaBucket(a), 'tokens');
});

test('nothing over threshold returns null', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.40, unified7d: 0.52 });
  assert.equal(am._nearQuotaBucket(a), null);
  assert.equal(am._isNearQuota(a), false);
});

// ── _bucketPct reads the fired bucket, not a fixed one ───────

test('the percent shown is the fired bucket own number', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  assert.equal(am._bucketPct(a, 'unified5h'), 99);
  setQuota(a, { unified5h: 0.10, unified7d: 0.99 });
  assert.equal(am._bucketPct(a, 'unified7d'), 99);
});

// ── the log line names the bucket that fired ─────────────────

test('updateQuota logs the fired bucket with its own percent', () => {
  const am = fleet();
  const a = am.accounts[0];
  setQuota(a, { unified5h: 0.99, unified7d: 0.52 });
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    am.updateQuota(0, {}, null, null);
  } finally {
    console.log = realLog;
  }
  const line = lines.find((l) => l.includes('will switch on next request'));
  assert.ok(line, 'the switch line was logged');
  assert.match(line, /at 99% unified5h usage/);
  assert.doesNotMatch(line, /52/);
});

// ── a rate-limit limit that is not a positive number ─────────

// Every standard-quota reader takes utilization as 1 - remaining / limit, so a
// limit of 0 from upstream made it NaN (0/0) or -Infinity, and every comparison
// against NaN is false. A response whose limit is refused is no reading for
// that dimension: neither its limit, nor its remaining, nor its reset is stored.

const soon = () => new Date(Date.now() + 60_000).toISOString();
const standard = (bucket, limit, remaining, reset = soon()) => ({
  [`anthropic-ratelimit-${bucket}-limit`]: limit,
  [`anthropic-ratelimit-${bucket}-remaining`]: remaining,
  [`anthropic-ratelimit-${bucket}-reset`]: reset,
});

test('a rate-limit limit of 0 is no reading, so no reader divides by it', () => {
  const am = fleet();
  const a = am.accounts[0];
  am.updateQuota(0, { ...standard('tokens', '0', '0'), ...standard('requests', '0', '0') });
  // NaN entered probe ranking (_maxUtilization) and the percent (_bucketPct).
  assert.equal(am._maxUtilization(a), 0);
  assert.equal(am._bucketPct(a, 'tokens'), null);
  assert.equal(am._bucketPct(a, 'requests'), null);
  assert.equal(a.quota.tokensLimit, null);
  assert.equal(a.quota.requestsLimit, null);
  // Nor is the remaining sent with a refused limit.
  assert.equal(a.quota.tokensRemaining, null);
  assert.equal(a.quota.requestsRemaining, null);
});

for (const bucket of ['tokens', 'requests']) {
  const capped = () => {
    const am = new AccountManager([oauth('a'), oauth('capped', { maxUsage: 0.6 })], 0.98);
    am.updateQuota(1, standard(bucket, '1000', '100'));
    assert.equal(am.capExceeded(am.accounts[1]), bucket, 'control: 90% used trips a 60% cap');
    return am;
  };

  test(`a reading whose ${bucket} limit is 0 does not lift a tripped ${bucket} cap`, () => {
    const am = capped();
    am.updateQuota(1, standard(bucket, '0', '0'));
    // On 0/0 the cap let go and the percent was NaN.
    assert.equal(am.capExceeded(am.accounts[1]), bucket);
    assert.equal(am._bucketPct(am.accounts[1], bucket), 90);
    // A limit header that is there but does not parse is refused the same way:
    // its remaining is not read against the limit already held.
    am.updateQuota(1, standard(bucket, 'abc', '0'));
    assert.equal(am.capExceeded(am.accounts[1]), bucket, 'abc/0');
    assert.equal(am._bucketPct(am.accounts[1], bucket), 90, 'abc/0');
  });

  test(`a ${bucket} reading refused for its limit leaves the pair held whole, whatever it says is left`, () => {
    const am = capped();
    const c = am.accounts[1];
    // Read against the limit already held, 950 left of 1,000 is 5% used and
    // lifts the cap; 5,000 left is -400%.
    for (const remaining of ['950', '5000']) {
      am.updateQuota(1, standard(bucket, '0', remaining));
      assert.equal(am.capExceeded(c), bucket, `0/${remaining}`);
      assert.equal(am._bucketPct(c, bucket), 90, `0/${remaining}`);
      assert.equal(c.quota[`${bucket}Remaining`], 100, `0/${remaining}`);
    }
    // A response with no limit header still updates its remaining, as before.
    am.updateQuota(1, { [`anthropic-ratelimit-${bucket}-remaining`]: '50' });
    assert.equal(am._bucketPct(c, bucket), 95, 'a remaining with no limit header');
  });

  test(`a ${bucket} reading refused for its limit does not end the held pair early`, () => {
    const am = capped();
    const c = am.accounts[1];
    const held = c.quota.resetsAt;
    // Its reset, a second past, cleared the held pair, and the cap with it.
    am.updateQuota(1, standard(bucket, '0', '950', new Date(Date.now() - 1000).toISOString()));
    assert.equal(c.quota.resetsAt, held);
    assert.equal(am.capExceeded(c), bucket);
  });

  test(`a ${bucket} reading refused for its limit does not keep the held pair past its window`, () => {
    const am = capped();
    const c = am.accounts[1];
    const held = c.quota.resetsAt;
    // Its reset, the year 9999, held the pair (and was persisted) far past its own window.
    am.updateQuota(1, standard(bucket, '0', '950', '9999-12-31T23:59:59Z'));
    assert.equal(c.quota.resetsAt, held);
    assert.equal(am.capExceeded(c), bucket);
  });
}

test('a refused tokens reading leaves the shared reset to a valid requests reading in the same response', () => {
  const am = new AccountManager([oauth('a'), oauth('capped', { maxUsage: 0.6 })], 0.98);
  const c = am.accounts[1];
  am.updateQuota(1, standard('tokens', '1000', '100'));
  // resetsAt is one clock for both dimensions: the requests reading, valid,
  // sets it, as a response with no tokens headers at all would. The refused
  // tokens reading takes no part, its year 9999 neither.
  const requestsReset = new Date(Date.now() + 120_000).toISOString();
  am.updateQuota(1, { ...standard('tokens', '0', '950', '9999-12-31T23:59:59Z'), ...standard('requests', '50', '49', requestsReset) });
  assert.equal(c.quota.resetsAt, requestsReset);
  assert.equal(c.quota.tokensLimit, 1000);
  assert.equal(c.quota.tokensRemaining, 100);
  assert.equal(am.capExceeded(c), 'tokens');
});

test('a negative limit is no reading either', () => {
  const am = new AccountManager([oauth('a'), oauth('capped', { maxUsage: 0.6 })], 0.98);
  const c = am.accounts[1];
  am.updateQuota(1, standard('tokens', '-10', '5'));
  // 1 - 5 / -10 is 1.5: 150% used, and a tripped cap.
  assert.equal(am._bucketPct(c, 'tokens'), null);
  assert.equal(am.capExceeded(c), null);
  assert.equal(c.quota.tokensLimit, null);
  assert.equal(c.quota.tokensRemaining, null);
});

test('a limit header too long for a double is no reading either', () => {
  const am = fleet();
  const a = am.accounts[0];
  am.updateQuota(0, standard('tokens', '9'.repeat(400), '500'));
  // parseInt gives Infinity, which no limit can be, and 1 - 500 / Infinity read as 1: fully used.
  assert.equal(am._nearQuotaBucket(a), null);
  assert.equal(a.quota.tokensLimit, null);
});
