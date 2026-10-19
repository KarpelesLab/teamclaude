import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { Prober } from '../src/prober.js';
import { fetchDeepSeekBalance } from '../src/quota-sources.js';
import { renderStatus } from '../src/status-renderer.js';
import { balanceSummary } from '../src/usage-display.js';

const sample = () => ({ available: true, updatedAt: Date.now(), balances: [
  { currency: 'USD', total: '-0.11', granted: '0', toppedUp: '-0.11' },
  { currency: 'CNY', total: '997.78', granted: '0', toppedUp: '997.78' },
] });
function setup(save = async () => {}) {
  const config = { accounts: [
    { name: 'DeepSeek', type: 'apikey', apiKey: 'test', usageDisplay: 'balance' },
    { name: 'Antigravity', type: 'apikey', apiKey: 'test', usageDisplay: 'session' },
  ] };
  const am = new AccountManager(config.accounts);
  am.accounts[0].quota.balance = sample();
  am.accounts[0].quota.unified5h = 0.25;
  am.accounts[1].quota.unified5h = 0.2;
  am.accounts[1].quota.unified7d = 0.3;
  const tui = new TUI({ accountManager: am, config, saveConfig: save });
  tui.render = () => {};
  return { am, config, tui };
}

test('balance and session displays coexist without changing either account quota or eligibility', () => {
  const { am, tui } = setup();
  const before = am.getStatus().accounts.map(a => ({ quota: a.quota, eligible: a.serveableNow }));
  assert.match(tui._renderAcct(0, 10, true, [], []), /Balance CNY 997\.78 \/ USD -0\.11/);
  assert.match(tui._renderAcct(1, 10, true, [], []), /Ses/);
  assert.doesNotMatch(tui._renderAcct(1, 10, true, [], []), /Balance/);
  assert.deepEqual(am.getStatus().accounts.map(a => ({ quota: a.quota, eligible: a.serveableNow })), before);
  const text = renderStatus(am.getStatus(), { color: false });
  assert.match(text, /Balance CNY 997\.78 \/ USD -0\.11/);
  assert.match(text, /Session/);
});

test('keyboard switch saves only the selected endpoint and survives rebuilding the manager', async () => {
  let saves = 0;
  const { am, tui, config } = setup(async () => { saves++; });
  tui._key('u');
  assert.equal(tui.mode, 'usage');
  tui._key('left'); // balance -> session
  await new Promise(r => setImmediate(r));
  assert.equal(saves, 1);
  assert.equal(am.accounts[0].usageDisplay, 'session');
  assert.equal(am.accounts[1].usageDisplay, 'session');
  assert.match(tui._renderAcct(0, 10, true, [], []), /Ses/);
  assert.doesNotMatch(tui._renderAcct(0, 10, true, [], []), /Balance/);
  const restored = new AccountManager(config.accounts);
  assert.equal(restored.accounts[0].usageDisplay, 'session');
  assert.equal(restored.accounts[1].usageDisplay, 'session');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
});

test('a failed save restores the previous display setting', async () => {
  const { am, config, tui } = setup(async () => { throw new Error('read-only'); });
  tui._key('u'); tui._key('left');
  await new Promise(r => setImmediate(r));
  assert.equal(am.accounts[0].usageDisplay, 'balance');
  assert.equal(config.accounts[0].usageDisplay, 'balance');
});

test('unsupported balance displays unknown; failed or old readings are labelled', () => {
  assert.equal(balanceSummary({ quota: {} }), 'Balance unavailable');
  const a = { quota: { balance: sample() } };
  assert.doesNotMatch(balanceSummary(a), /last reading/);
  a.balanceError = 'refresh failed';
  assert.match(balanceSummary(a), /last reading/);
  delete a.balanceError;
  assert.match(balanceSummary(a, Date.now() + 16 * 60_000), /last reading/);
});

test('balance policy hot reload leaves session telemetry intact', () => {
  const { am, config } = setup();
  const old = structuredClone(am.accounts[0].quota);
  am.updateAccountPolicy(0, { ...config.accounts[0], usageDisplay: 'session', balanceSource: { type: 'deepseek-balance', tokenFile: '/test' } });
  assert.equal(am.accounts[0].usageDisplay, 'session');
  assert.deepEqual(am.accounts[0].quota, old);
  assert.equal(am.getStatus().accounts[0].usageDisplay, 'session');
});

test('balance API preserves separate currencies and never exposes upstream error bodies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-balance-test-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'unit-test-only');
  t.after(() => rm(dir, { recursive: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, 'Bearer unit-test-only');
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [
      { currency: 'USD', total_balance: '-0.11', granted_balance: '0', topped_up_balance: '-0.11' },
      { currency: 'CNY', total_balance: '997.78', granted_balance: '0', topped_up_balance: '997.78' },
    ] }) };
  };
  const result = await fetchDeepSeekBalance({ tokenFile });
  assert.equal(result.balance.balances.length, 2);
  assert.equal(result.balance.available, true);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => { throw new Error('error body must not be read'); } });
  assert.deepEqual(await fetchDeepSeekBalance({ tokenFile }), { error: 'DeepSeek balance: HTTP 401', status: 401 });
});

test('a balance probe refreshes money without replacing session quota; errors retain the last reading', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deepseek-prober-test-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'unit-test-only');
  t.after(() => rm(dir, { recursive: true }));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const { am } = setup();
  am.accounts[0].balanceSource = { type: 'deepseek-balance', tokenFile };
  const source = am.accounts[0].balanceSource;
  const prober = new Prober(am, { log: () => {} });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '25.00', granted_balance: '0', topped_up_balance: '25.00' },
  ] }) });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.balance.balances[0].total, '25.00');
  assert.equal(am.accounts[0].quota.unified5h, 0.25);
  assert.equal(am.accounts[1].quota.unified5h, 0.2);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await prober.probeQuotaSourceAccount(am.accounts[0], source);
  assert.match(am.accounts[0].balanceError, /503/);
  assert.equal(am.accounts[0].quota.balance.balances[0].total, '25.00');
});
