import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A Codex response names the limit that metered it in `x-codex-active-limit`.
// Seen live on 2026-09-22: `premium` for every model on a Pro account, and
// `base_model_inference` for `gpt-reserve` on a Pro Lite account, the key the
// usage probe files that account's `gpt-reserve` bucket under. That header is
// the only place upstream says which model draws on which limit, so a consumer
// reading `codexModelBuckets` knows each bucket's name and reading but not which
// of its own models spends it.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const codexAccount = (upstreamPort) => ({
  name: 'codex', type: 'oauth', provider: 'codex',
  accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  upstream: `http://127.0.0.1:${upstreamPort}`,
});
const claudeAccount = { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };

// Serve each Codex request with the headers `headersFor(model)` returns, send
// the given models through the proxy in order, then read `/teamclaude/status`.
async function runModels(models, headersFor) {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const { model } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.writeHead(200, { 'content-type': 'application/json', ...headersFor(model) });
      res.end('{}');
    });
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([claudeAccount, codexAccount(upstreamPort)], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    for (const model of models) {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/backend-api/codex/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: [], stream: true }),
      });
      await res.text();
    }
    const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, { headers: { 'x-api-key': 'k' } });
    return await res.json();
  } finally {
    proxy.close();
    upstream.close();
  }
}

// The rate-limit headers a live response carries beside the active limit.
// Resets derived from now, so the weekly reading is not swept as expired
// before it is read.
const reset = () => String(Math.floor(Date.now() / 1000) + 3 * 86400);
const accountWide = () => ({
  'x-codex-primary-used-percent': '8',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': reset(),
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-plan-type': 'pro',
});

test('x-codex-active-limit records which limit served the model', async () => {
  const status = await runModels(['gpt-reserve', 'gpt-5.6-luna'], model => ({
    ...accountWide(),
    'x-codex-active-limit': model === 'gpt-reserve' ? 'base_model_inference' : 'premium',
  }));
  const quota = status.accounts.find(a => a.name === 'codex').quota;

  assert.deepEqual(quota.codexModelLimits, { 'gpt-reserve': 'base_model_inference', 'gpt-5.6-luna': 'premium' });
});

test('the mapping lands on the account that served the response only', () => {
  const am = new AccountManager([{ ...codexAccount(1), name: 'a' }, { ...codexAccount(1), name: 'b' }], 0.98);
  am.updateQuota(1, { 'x-codex-active-limit': 'base_model_inference' }, 'gpt-reserve');
  const [a, b] = am.getStatus().accounts;
  assert.equal('codexModelLimits' in a.quota, false);
  assert.deepEqual(b.quota.codexModelLimits, { 'gpt-reserve': 'base_model_inference' });
});

test('a response without the header leaves the map as it was', async () => {
  const status = await runModels(['gpt-5.5', 'gpt-5.5'], (() => {
    let n = 0;
    return () => (n++ === 0 ? { ...accountWide(), 'x-codex-active-limit': 'codex' } : accountWide());
  })());
  assert.deepEqual(status.accounts.find(a => a.name === 'codex').quota.codexModelLimits, { 'gpt-5.5': 'codex' });
});

test('a Claude account in the same status carries no model map', async () => {
  const status = await runModels(['gpt-5.5'], () => ({ ...accountWide(), 'x-codex-active-limit': 'codex' }));
  assert.equal('codexModelLimits' in status.accounts.find(a => a.name === 'claude').quota, false);

  // The header sweep keeps `x-codex-*` whatever the provider, so a stray one on
  // an Anthropic response reaches updateQuota too; it must not start a map there.
  const am = new AccountManager([claudeAccount], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.2', 'x-codex-active-limit': 'codex' }, 'claude-opus-5-5');
  assert.equal('codexModelLimits' in am.getStatus().accounts[0].quota, false);
});

test('the map is bounded, keeping the models seen most recently', () => {
  // Model names come from the client's request body, so an unbounded table
  // would grow with whatever a client chose to send.
  const am = new AccountManager([codexAccount(1)], 0.98);
  for (let i = 0; i < 100; i++) am.updateQuota(0, { 'x-codex-active-limit': 'codex' }, `m${i}`);
  // m68..m99 remain. Seeing m80 again makes it the newest, so the twenty models
  // that follow evict the twenty oldest around it and leave it in place.
  am.updateQuota(0, { 'x-codex-active-limit': 'premium' }, 'm80');
  for (let i = 0; i < 20; i++) am.updateQuota(0, { 'x-codex-active-limit': 'codex' }, `new${i}`);
  const limits = am.accounts[0].quota.codexModelLimits;

  assert.equal(Object.keys(limits).length, 32);
  assert.equal(limits.m80, 'premium');
  assert.equal(limits.new19, 'codex');
  assert.equal(limits.m88, undefined);
  assert.equal(limits.m89, 'codex');
});
