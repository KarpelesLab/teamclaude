import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Drive one Codex request through the proxy against an upstream that states its
// quota the way the ChatGPT backend does, and report what reached the account.
async function runAgainstCodexUpstream(headers) {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{
      name: 'codex', type: 'oauth', provider: 'codex',
      accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
      upstream: `http://127.0.0.1:${upstreamPort}`,
    }],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true }),
    });
    await res.text();
    return am.accounts[0].quota;
  } finally {
    proxy.close();
    upstream.close();
  }
}

// The regression. The header sweep kept only `anthropic-ratelimit-*`, so a Codex
// account's `x-codex-*` reached `updateQuota` as an empty object. The parser and
// its call site were both in place, so nothing errored — the account simply read
// `unknown` for its whole life, however many requests it served.
test('a Codex response\'s x-codex-* quota headers reach the account', async () => {
  const quota = await runAgainstCodexUpstream({
    'x-codex-primary-used-percent': '35',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1789453626',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-plan-type': 'pro',
  });

  assert.equal(quota.unified7d, 0.35);
  assert.equal(quota.unified7dReset, 1789453626 * 1000);
  assert.equal(quota.planType, 'pro');
});

// The account-wide family can put a 5-hour window in `primary`, so the sweep
// must carry every `x-codex-*` key rather than a hand-picked few.
test('a five-hour Codex window lands in the session bucket', async () => {
  const quota = await runAgainstCodexUpstream({
    'x-codex-primary-used-percent': '12',
    'x-codex-primary-window-minutes': '300',
  });

  assert.equal(quota.unified5h, 0.12);
});
