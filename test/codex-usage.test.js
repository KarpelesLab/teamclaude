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

// On a live subscription the shared `rate_limit` states a 7-day window and a
// null secondary, so it yields no 5-hour reading at all. The only one the
// payload states sits in an extra limit. Without this fallback the probe could
// never learn a session window, and every rule keyed on it — preemptive
// rotation, expiry clearing, the session-reset switch — stayed unreachable on
// an account the probe was the only reader of.
test("a shared reading with no five-hour window falls back to an extra limit's", () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 },
      secondary_window: null,
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1700018000 },
          secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1700604800 },
        },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.4, resetAt: 1700018000000 });
  assert.deepEqual(usage.sevenDay, { utilization: 0.07, resetAt: 1700604800000 });
});

// The shared window is the account-wide authority. An extra limit meters the
// models it names, so letting a spent one replace the shared reading would bar
// models it never metered — the one-way ratchet the weekly buckets avoid.
test('an extra limit never replaces a shared five-hour reading', () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1700018000 },
      secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 },
    },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000, reset_at: 1700099000 } },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.1, resetAt: 1700018000000 });
});

// The weekly guard builds the model bucket; it must not also decide whether the
// 5-hour reading survives, or an extra limit that states only a session window
// is thrown away along with it.
test('an extra limit stating only a five-hour window still contributes it', () => {
  const usage = normalizeCodexUsagePayload({
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1700604800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1700018000 } },
      },
    ],
  });
  assert.deepEqual(usage.fiveHour, { utilization: 0.55, resetAt: 1700018000000 });
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
