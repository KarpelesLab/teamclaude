import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const acct = (name, extra = {}) => ({ name, type: 'apikey', apiKey: 'test', ...extra });

test('rounded usage does not exclude an opted-in account; other accounts retain quota limits', () => {
  const am = new AccountManager([acct('preferred', { quotaAdmission: 'upstream' }), acct('ordinary')], 0.99);
  for (const a of am.accounts) {
    a.quota.unified7d = 1;
    a.quota.unified7dReset = Date.now() + 3600000;
  }
  assert.equal(am._unavailableReason(am.accounts[0], 'claude-sonnet-5'), null);
  assert.equal(am._unavailableReason(am.accounts[1], 'claude-sonnet-5'), 'quota-exhausted');
  am.updateAccountPolicy(0, acct('preferred'));
  assert.equal(am._unavailableReason(am.accounts[0], 'claude-sonnet-5'), 'quota-exhausted');
});

test('upstream admission still enforces hard holds, disabled accounts, auth errors and token budgets', () => {
  const am = new AccountManager([acct('preferred', { quotaAdmission: 'upstream', tokenBudget: { windowSec: 60, maxTokens: 1 } })]);
  const a = am.accounts[0];
  am.markRateLimited(0, 60);
  assert.equal(am._unavailableReason(a), 'quota-exhausted');
  am.clearRateLimited(0);
  a.disabled = true;
  assert.equal(am._unavailableReason(a), 'disabled');
  a.disabled = false;
  a.status = 'error';
  assert.equal(am._unavailableReason(a), 'token-expired');
  a.status = 'active';
  am._isTokenBudgetTripped = () => true;
  assert.equal(am._unavailableReason(a), 'token-budget');
});

test('real upstream quota rejection holds the preferred account and serves the fallback', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(req.headers['x-api-key']);
      if (req.headers['x-api-key'] === 'primary') {
        res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-7d-status': 'rejected', 'retry-after': '60' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Quota spent' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }] }));
      }
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const accounts = [acct('preferred', { apiKey: 'primary', quotaAdmission: 'upstream', priority: 0 }), acct('fallback', { apiKey: 'fallback', priority: 20 })];
  const am = new AccountManager(accounts, 0.99);
  am.accounts[0].quota.unified7d = 1;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstream.address().port}`, accounts });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }) });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(hits, ['primary', 'fallback']);
    assert.equal(am._unavailableReason(am.accounts[0]), 'quota-exhausted');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});
