import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { ClaudeResetRedeemer, fetchClaudeResetStatus } from '../src/claude-resets.js';
import { ResetCreditRedeemer, fetchResetCreditDetails } from '../src/codex-reset-credits.js';
import { fetchUsage } from '../src/oauth.js';
import { Prober } from '../src/prober.js';
import { createResetActions } from '../src/reset-actions.js';
import { resetReading } from '../src/reset-readings.js';
import { getStatePath, saveConfig, saveState } from '../src/config.js';

const GRANT_ID = 'probe-spend-handle';
const payload = () => ({
  seven_day: { utilization: 35, resets_at: new Date(Date.now() + 86400_000).toISOString() },
  cedar_ember: { eligible: true, at_limit: false, grants: [{ id: GRANT_ID, label: 'Probe gift',
    resets_left: 2, usable_now: true, clears: ['seven_day'] }] },
});

test('the probe caches raw reset details from its one usage fetch, outside the real persistence path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reset-cache-'));
  const previous = process.env.TEAMROUTER_CONFIG;
  process.env.TEAMROUTER_CONFIG = join(dir, 'config.json');
  try {
    const config = { accounts: [{ name: 'test', type: 'oauth', accessToken: 'fake', orgUuid: 'org',
      expiresAt: Date.now() + 3600_000 }] };
    const am = new AccountManager(config.accounts, 0.98);
    const account = am.accounts[0];
    let requests = 0;
    const probe = new Prober(am, { probeFn: (token, routing, opts) => fetchUsage(token, routing, {
      ...opts, fetchImpl: async () => { requests++; return { ok: true, json: async () => payload() }; },
    }) });
    await probe.probeAll();
    assert.equal(requests, 1);
    assert.equal(probe.getStatus().accounts[0].status, 'ok');
    assert.equal(resetReading(account).reset.grants[0].id, GRANT_ID);
    assert.equal(resetReading(account).seenAt > 0, true);
    const noFetch = () => { throw new Error('cached panel details must not fetch'); };
    const actions = createResetActions({ accountManager: am,
      claudeRedeemer: new ClaudeResetRedeemer(am, { statusFn: noFetch }),
      codexRedeemer: new ResetCreditRedeemer(am, { detailsFn: noFetch }),
    });
    assert.equal(actions.cached(account).grants[0].id, GRANT_ID);
    // Use the same export + save funnel as index.js, and actually write files.
    await saveState({ quota: am.exportQuotaState() });
    await saveConfig(config);
    const savedQuota = await readFile(getStatePath(), 'utf8');
    const savedConfig = await readFile(process.env.TEAMROUTER_CONFIG, 'utf8');
    assert.equal(JSON.parse(savedQuota).quota[0].quota.unified7d, 0.35);
    assert.equal(JSON.parse(savedQuota).quota[0].quota.resetCredits.available, 2);
    for (const written of [savedQuota, savedConfig]) {
      assert.doesNotMatch(written, /probe-spend-handle|Probe gift|cedar_ember|grants|"credits"|"retryAt"/);
    }
    const restarted = new AccountManager(config.accounts, 0.98);
    restarted.restoreQuotaState(JSON.parse(savedQuota).quota);
    assert.equal(resetReading(restarted.accounts[0]), null);
  } finally {
    if (previous === undefined) delete process.env.TEAMROUTER_CONFIG;
    else process.env.TEAMROUTER_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('both reset endpoints carry Retry-After seconds and dates into failed readings', async () => {
  const account = { credential: 'fake', accountId: 'acct' };
  for (const fetchRead of [fetchClaudeResetStatus, fetchResetCreditDetails]) {
    for (const retry of ['90', new Date(Date.now() + 180_000).toUTCString()]) {
      const before = Date.now();
      const reading = await fetchRead(account, { fetchImpl: async () => ({ ok: false, status: 429,
        headers: { get: name => name === 'retry-after' ? retry : null } }) });
      assert.equal(reading.error, 'HTTP 429');
      assert.equal(reading.status, 429);
      if (retry === '90') assert.ok(reading.retryAt >= before + 90_000 && reading.retryAt <= Date.now() + 90_000);
      else assert.equal(reading.retryAt, Date.parse(retry));
    }
  }
});
