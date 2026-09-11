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
