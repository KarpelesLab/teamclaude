import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexUsage, fetchQuotaFor } from '../src/quota-sources.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// Real /wham/usage payload captured 2026-08-03 (yongbing codex account).
const WHAM_FIXTURE = {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 26,
      limit_window_seconds: 604800,
      reset_after_seconds: 428108,
      reset_at: 1786160027,
    },
    secondary_window: null,
  },
  plan_type: 'pro',
  additional_rate_limits: [],
};

function fakeRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(body); },
    async text() { return String(body); },
  };
}

// CLIProxyAPI codex auth file shape (real: top-level access_token + account_id).
function makeCodexTokenFile() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-codex-src-'));
  const file = join(dir, 'codex-test.json');
  writeFileSync(file, JSON.stringify({ access_token: 'test-codex-token', account_id: 'acc-123' }));
  return { file, dir };
}

function wham(usedPercent, { with5h = false } = {}) {
  const rl = {
    primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1786160027 },
    secondary_window: null,
  };
  if (with5h) rl.secondary_window = { used_percent: 40, limit_window_seconds: 18000, reset_at: 1786168000 };
  return { rate_limit: rl, plan_type: 'pro', additional_rate_limits: [] };
}

test('fetchCodexUsage parses the real wham/usage weekly window', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(JSON.stringify(WHAM_FIXTURE), 200));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    assert.equal(Math.round(usage.sevenDay.utilization * 100) / 100, 0.26);   // 26%
    assert.equal(usage.sevenDay.resetAt, 1786160027 * 1000);                  // seconds → ms
    assert.equal(usage.fiveHour, null);    // provider reports no short window
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('weekly-only Codex never invents a short window as usage increases', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let percent = 26;
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(JSON.stringify(wham(percent))));
    const source = { type: 'openai-codex', tokenFile: file };
    await fetchCodexUsage(source);
    percent = 30;
    const usage = await fetchCodexUsage(source);
    assert.equal(usage.fiveHour, null);
    assert.equal(usage.nativeWindows.length, 1);
    assert.equal(usage.nativeWindows[0].windowSeconds, 604800);
    assert.equal(usage.nativeWindows[0].usedPercent, 30);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real secondary_window is retained when actually returned', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(26, { with5h: true })), 200));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.equal(usage.fiveHour.utilization, 0.40);
    assert.equal(usage.fiveHour.resetAt, 1786168000 * 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe sends Bearer + chatgpt-account-id headers', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let captured = null;
  try {
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      captured = { url, headers: opts?.headers };
      return fakeRes(JSON.stringify(WHAM_FIXTURE), 200);
    });
    await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(captured.headers['Authorization'], 'Bearer test-codex-token');
    assert.equal(captured.headers['chatgpt-account-id'], 'acc-123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe fails safe on missing token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-codex-src-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ refresh_token: 'x' }));   // no access_token
  try {
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.match(usage.error, /no access_token/);
    assert.equal(usage.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe fails safe on HTTP 401', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify({ error: { message: 'unauthorized' } }), 401));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.equal(usage.status, 401);
    assert.match(usage.error, /HTTP 401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchQuotaFor dispatches openai-codex', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(JSON.stringify(WHAM_FIXTURE), 200));
    const ok = await fetchQuotaFor({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.ok(!ok.error, `unexpected error: ${ok.error}`);
    assert.equal(Math.round(ok.sevenDay.utilization * 100) / 100, 0.26);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex refresh clears legacy synthetic 5h values', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  let call = 0;
  const pct = [26, 30];
  try {
    const am = new AccountManager(
      [{ name: 'codex-gpt56', type: 'apikey', apiKey: 'k', quotaSource: { type: 'openai-codex', tokenFile: file } }],
      0.50);
    const prober = new Prober(am, { intervalMs: 0, timeoutMs: 5000, log: () => {} });
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(pct[Math.min(call++, pct.length - 1)])), 200));

    am.accounts[0].quota.unified5h = 0.48;
    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(Math.round(am.accounts[0].quota.unified7d * 100) / 100, 0.26);

    nowMs += 20 * 60 * 1000;
    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(am.accounts[0].quota.unified5h, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
