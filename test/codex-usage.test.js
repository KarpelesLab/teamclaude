import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCodexUsage, normalizeCodexUsagePayload } from '../src/codex-usage.js';

const payload = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1700000000 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1700604800 },
  },
  additional_rate_limits: {
    code_review: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1700604800 } },
  },
};

test('normalizes Codex wham usage windows and model buckets', () => {
  const usage = normalizeCodexUsagePayload(payload);
  assert.deepEqual(usage.fiveHour, { utilization: 0.25, resetAt: 1700000000000 });
  assert.deepEqual(usage.sevenDay, { utilization: 0.4, resetAt: 1700604800000 });
  assert.deepEqual(usage.modelBuckets, [{ slug: 'code_review', name: 'code_review', utilization: 0.1, resetAt: 1700604800000 }]);
  assert.equal(usage.planType, 'pro');
});

// The shape a live subscription actually sends: a LIST whose entries name
// themselves. `Object.entries` over it yields array indices, so before this was
// handled every bucket was filed as "0" and "1" — names that identify nothing,
// collide across accounts, and sit beside the header path's name for the same
// bucket instead of replacing it. `metered_feature` is the header's own slug
// with a `codex_` prefix, so stripping it makes the two paths agree on one key.
test('a list of extra limits is named from its entries, not their indices', () => {
  const usage = normalizeCodexUsagePayload({
    plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1700018000 },
          secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1700604800 },
        },
      },
      {
        limit_name: 'gpt-reserve',
        metered_feature: 'base_model_inference',
        rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1700604800 } },
      },
    ],
  });
  assert.deepEqual(usage.modelBuckets, [
    { slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0.03, resetAt: 1700604800000 },
    { slug: 'base_model_inference', name: 'gpt-reserve', utilization: 0.01, resetAt: 1700604800000 },
  ]);
});

// An entry that names itself no way at all is dropped rather than filed under a
// number, which would be indistinguishable from the bug this replaced.
test('an unnamed extra limit is dropped rather than filed under its index', () => {
  const usage = normalizeCodexUsagePayload({
    additional_rate_limits: [
      { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1700604800 } } },
    ],
  });
  assert.deepEqual(usage.modelBuckets, []);
});

test('fetchCodexUsage sends the account-scoped read-only request', async () => {
  let request;
  const usage = await fetchCodexUsage({ credential: 'secret', accountId: 'acct-1' }, {
    url: 'https://example.test/wham/usage',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(request.url, 'https://example.test/wham/usage');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(usage.sevenDay.utilization, 0.4);
});

test('fetchCodexUsage preserves HTTP status for refresh-on-401', async () => {
  const result = await fetchCodexUsage({ credential: 'secret', accountId: 'acct-1' }, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.deepEqual(result, { error: 'HTTP 401', status: 401 });
});
