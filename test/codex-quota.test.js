import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexQuota, parseCodexPlanType } from '../src/codex-quota.js';

// The exact header SET from a live Codex response, with the values replaced by
// synthetic ones. The shape is what matters here and is not invented: the
// account-wide family really does carry a 7-day window in `primary`, and the
// named family really does carry a 5-hour one.
const LIVE = {
  'x-codex-active-limit': 'premium',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '42',
  'x-codex-secondary-used-percent': '0',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-over-secondary-limit-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-primary-reset-after-seconds': '300000',
  'x-codex-secondary-reset-after-seconds': '0',
  'x-codex-primary-reset-at': '1900000000',
  'x-codex-secondary-reset-at': '',
  'x-codex-credits-has-credits': 'False',
  'x-codex-credits-balance': '0',
  'x-codex-credits-unlimited': 'False',
  'x-codex-bengalfox-primary-used-percent': '0',
  'x-codex-bengalfox-secondary-used-percent': '0',
  'x-codex-bengalfox-primary-window-minutes': '300',
  'x-codex-bengalfox-primary-over-secondary-limit-percent': '0',
  'x-codex-bengalfox-secondary-window-minutes': '10080',
  'x-codex-bengalfox-primary-reset-at': '1900001111',
  'x-codex-bengalfox-secondary-reset-at': '1900002222',
  'x-codex-bengalfox-limit-name': 'GPT-5.3-Codex-Spark',
};

// The account-wide family puts its SEVEN-DAY window in `primary`. Reading
// position instead of duration would file this as a 5h reading.
test('the account-wide weekly window is read from its duration, not its position', () => {
  const q = parseCodexQuota(LIVE);
  assert.equal(q.unified7d, 0.42);
  assert.equal(q.unified7dReset, 1900000000 * 1000);
  // 31% weekly used must never appear as a 5h reading.
  assert.equal(q.unified5h, undefined);
  assert.equal(q.unified5hReset, undefined);
});

// A zero-length window is how this API says "not applicable"; treating it as
// 0% used would read as full headroom.
test('a zero-length window is dropped rather than read as empty', () => {
  const q = parseCodexQuota(LIVE);
  assert.ok(!('unified5h' in q), 'secondary window-minutes=0 must not produce a bucket');
});

test('a named family becomes a model-scoped weekly bucket', () => {
  const q = parseCodexQuota(LIVE);
  assert.equal(q.modelBuckets.length, 1);
  const [bucket] = q.modelBuckets;
  assert.equal(bucket.slug, 'bengalfox');
  assert.equal(bucket.name, 'GPT-5.3-Codex-Spark');
  assert.equal(bucket.utilization, 0);
  // Its WEEKLY window (10080) is carried, not its 5h one (300).
  assert.equal(bucket.resetAt, 1900002222 * 1000);
});

test('percentages become 0-1 utilization, matching the Anthropic path', () => {
  const q = parseCodexQuota({
    'x-codex-primary-used-percent': '98',
    'x-codex-primary-window-minutes': '10080',
  });
  assert.equal(q.unified7d, 0.98);
});

test('a 5-hour account window lands in the 5h bucket', () => {
  const q = parseCodexQuota({
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': '1900001111',
  });
  assert.equal(q.unified5h, 0.5);
  assert.equal(q.unified5hReset, 1900001111 * 1000);
  assert.equal(q.unified7d, undefined);
});

test('an unrecognised window duration is ignored rather than guessed at', () => {
  const q = parseCodexQuota({
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-window-minutes': '42',
  });
  assert.deepEqual(q, {});
});

// The catalog fetch carries no quota; that must not look like 0% used.
test('a response with no quota headers yields nothing', () => {
  assert.deepEqual(parseCodexQuota({}), {});
  assert.deepEqual(parseCodexQuota(undefined), {});
  assert.deepEqual(parseCodexQuota({ 'content-type': 'application/json' }), {});
});

test('an empty reset value is treated as absent, not as epoch zero', () => {
  const q = parseCodexQuota({
    'x-codex-primary-used-percent': '10',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '',
  });
  assert.equal(q.unified7d, 0.1);
  assert.ok(!('unified7dReset' in q));
});

test('header casing does not matter', () => {
  const q = parseCodexQuota({
    'X-Codex-Primary-Used-Percent': '20',
    'X-Codex-Primary-Window-Minutes': '10080',
  });
  assert.equal(q.unified7d, 0.2);
});

test('the plan type is surfaced when present', () => {
  assert.equal(parseCodexPlanType(LIVE), 'pro');
  assert.equal(parseCodexPlanType({}), null);
});
