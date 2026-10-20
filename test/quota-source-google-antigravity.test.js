import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGoogleAntigravityUsage, fetchQuotaFor } from '../src/quota-sources.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// Real retrieveUserQuotaSummary payload captured 2026-08-02 (yongbing account).
const SUMMARY_FIXTURE = {
  description: 'Within each group, models share a weekly limit and a 5-hour limit.',
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit', window: 'weekly',
          resetTime: '2026-08-05T18:42:51Z', remainingFraction: 0.9948 },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', window: '5h',
          resetTime: '2026-08-02T12:32:43Z', remainingFraction: 0.9814 },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit', window: 'weekly',
          resetTime: '2026-08-09T10:07:08Z', remainingFraction: 1 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit', window: '5h',
          resetTime: '2026-08-02T15:07:08Z', remainingFraction: 1 },
      ],
    },
  ],
};

// Minimal fetch() Response stand-in (the code only touches ok/status/json/text).
function fakeRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(body); },
    async text() { return String(body); },
  };
}

// CLIProxyAPI antigravity auth file shape.
function makeTokenFile() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-quota-src-'));
  const file = join(dir, 'antigravity-test.json');
  writeFileSync(file, JSON.stringify({
    access_token: 'test-antigravity-token',
    refresh_token: 'x'.repeat(100),
    expires_in: 3599,
  }));
  return { file, dir };
}

function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}

test('fetchGoogleAntigravityUsage parses the real summary payload', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(SUMMARY_FIXTURE), 200));
    const usage = await fetchGoogleAntigravityUsage({ type: 'google-antigravity', tokenFile: file });
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    // gemini-5h → unified5h; utilization = 1 - remainingFraction; reset ms epoch
    assert.equal(Math.round(usage.fiveHour.utilization * 10000) / 10000, 0.0186);
    assert.equal(usage.fiveHour.resetAt, Date.parse('2026-08-02T12:32:43Z'));
    // gemini-weekly → unified7d
    assert.equal(Math.round(usage.sevenDay.utilization * 10000) / 10000, 0.0052);
    assert.equal(usage.sevenDay.resetAt, Date.parse('2026-08-05T18:42:51Z'));
    // Legacy routing map is Gemini-only, but dashboard retains both families.
    assert.equal(usage.nativeWindows.length, 4);
    assert.deepEqual(usage.nativeWindows.map(w => w.bucketId),
      ['gemini-weekly', 'gemini-5h', '3p-weekly', '3p-5h']);
    assert.equal(usage.nativeWindows[2].group, 'Claude and GPT models');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom bucketMap can select the 3p group', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(SUMMARY_FIXTURE), 200));
    const usage = await fetchGoogleAntigravityUsage({
      type: 'google-antigravity', tokenFile: file,
      bucketMap: { '5h': '3p-5h', '7d': '3p-weekly' },
    });
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    assert.equal(usage.fiveHour.utilization, 0);
    assert.equal(usage.sevenDay.utilization, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing access_token in tokenFile → error, not crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-quota-src-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ refresh_token: 'x' }));   // no access_token
  try {
    const usage = await fetchGoogleAntigravityUsage({ type: 'google-antigravity', tokenFile: file });
    assert.match(usage.error, /no access_token/);
    assert.equal(usage.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 401 → error with status (fail-safe, no wrong quota)', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify({ error: { message: 'invalid auth' } }), 401));
    const usage = await fetchGoogleAntigravityUsage({ type: 'google-antigravity', tokenFile: file });
    assert.equal(usage.status, 401);
    assert.match(usage.error, /HTTP 401/);
    assert.match(usage.error, /invalid auth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no matching buckets → error (not silent zero)', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify({ groups: [{ buckets: [{ bucketId: 'other', remainingFraction: 0.5 }] }] }), 200));
    const usage = await fetchGoogleAntigravityUsage({ type: 'google-antigravity', tokenFile: file });
    assert.match(usage.error, /no buckets matched/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchQuotaFor dispatches google-antigravity; unknown type → error', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(SUMMARY_FIXTURE), 200));
    const ok = await fetchQuotaFor({ type: 'google-antigravity', tokenFile: file });
    assert.ok(!ok.error, `unexpected error: ${ok.error}`);
    assert.equal(ok.sevenDay.resetAt, Date.parse('2026-08-05T18:42:51Z'));

    const bad = await fetchQuotaFor({ type: 'does-not-exist' });
    assert.match(bad.error, /unknown type/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeAccount carries quotaSource at startup', () => {
  const am = new AccountManager(
    [apikey('agy', { quotaSource: { type: 'google-antigravity', tokenFile: '/x' } })],
    0.98);
  assert.deepEqual(am.accounts[0].quotaSource, { type: 'google-antigravity', tokenFile: '/x' });
});

test('updateQuota is skipped for quotaSource accounts (native probe is authority)', () => {
  const am = new AccountManager(
    [apikey('agy', { quotaSource: { type: 'google-antigravity', tokenFile: '/x' } })],
    0.98);
  const acct = am.accounts[0];
  // Native probe value.
  am.applyUsageData(0, { fiveHour: { utilization: 0.0186, resetAt: 111 }, sevenDay: { utilization: 0.0052, resetAt: 222 } });
  assert.equal(acct.quota.unified5h, 0.0186);
  // A stale adapter header must NOT overwrite it.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.99' });
  assert.equal(acct.quota.unified5h, 0.0186);
});

test('Prober.probeQuotaSourceAccount applies quota end-to-end', async (t) => {
  const { file, dir } = makeTokenFile();
  try {
    const am = new AccountManager(
      [apikey('agy', { quotaSource: { type: 'google-antigravity', tokenFile: file } })],
      0.98);
    const prober = new Prober(am, { intervalMs: 0, timeoutMs: 5000, log: () => {} });
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(SUMMARY_FIXTURE), 200));
    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(Math.round(am.accounts[0].quota.unified5h * 10000) / 10000, 0.0186);
    assert.equal(am.accounts[0].quota.unified7dReset, Date.parse('2026-08-05T18:42:51Z'));
    const status = prober.getStatus().accounts.find(a => a.name === 'agy');
    assert.equal(status.status, 'ok');
    assert.equal(status.type, 'quotaSource');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
