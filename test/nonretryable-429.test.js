import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
const errorBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for fast mode.' } });

async function withProxy(rejectionHeaders, fn, succeedsOnAttempt = 0) {
  const seen = [];
  let rejected;
  const firstRejection = new Promise(resolve => { rejected = resolve; });
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const model = JSON.parse(body).model;
      seen.push({ token: req.headers.authorization, model });
      if (model === 'claude-fast' && seen.length !== succeedsOnAttempt) {
        res.writeHead(429, { 'content-type': 'application/json', ...rejectionHeaders });
        res.end(errorBody);
        rejected();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(['a', 'b'].map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const pending = new Set();
  const post = (model) => {
    const controller = new AbortController();
    pending.add(controller);
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }), signal: controller.signal,
    }).finally(() => { pending.delete(controller); });
  };
  try { await fn({ am, seen, post, firstRejection }); } finally {
    for (const controller of pending) controller.abort();
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  }
}

test('an explicit no-retry 429 relays untouched and does not pause unrelated traffic', async () => {
  await withProxy({
    'x-should-retry': 'false',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
    'anthropic-ratelimit-unified-reset': '1793491200',
    'request-id': 'req_fast_mode',
  }, async ({ am, seen, post, firstRejection }) => {
    const fast = post('claude-fast');
    await firstRejection;
    const healthy = post('claude-healthy');
    const [refused, ok] = await Promise.all([fast, healthy]);
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), errorBody);
    assert.equal(refused.headers.get('x-should-retry'), 'false');
    assert.equal(refused.headers.get('request-id'), 'req_fast_mode');
    assert.equal(refused.headers.get('anthropic-ratelimit-unified-overage-disabled-reason'), 'org_level_disabled');
    assert.equal(refused.headers.get('anthropic-ratelimit-unified-reset'), '1793491200');
    assert.equal(refused.headers.get('retry-after'), null);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.deepEqual(seen, [
      { token: 'Bearer t-a', model: 'claude-fast' },
      { token: 'Bearer t-a', model: 'claude-healthy' },
    ], 'the error is not retried or failed over, and the same account remains usable');
    assert.equal(am.isPaused(0), false);
    assert.equal(am.accounts[0].rampStartedAt, null);
    assert.equal(am.accounts[0].status, 'active');
  });
});

test('explicit no-retry takes precedence over retry-after', async () => {
  await withProxy({
    'x-should-retry': ' FALSE ', 'retry-after': '300',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
  }, async ({ am, seen, post }) => {
    am.accounts[0].quota.unified5h = 0.35;
    const refused = await post('claude-fast');
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), errorBody);
    assert.equal(refused.headers.get('retry-after'), '300');
    assert.equal(refused.headers.get('x-should-retry'), 'FALSE');
    assert.deepEqual(seen, [{ token: 'Bearer t-a', model: 'claude-fast' }]);
    assert.equal(am.accounts[0].quota.unified5h, 0.35);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.isPaused(0), false);
    assert.equal((await post('claude-healthy')).status, 200);
  });
});

// A spent quota window is what rotation is for: upstream marking that 429
// non-retryable is about retrying the SAME account, so it must not keep the
// request off the next one.
test('a quota rejection still switches accounts when it says x-should-retry: false', async () => {
  await withProxy({
    'x-should-retry': 'false', 'retry-after': '300',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
  }, async ({ seen, post }) => {
    const answer = await post('claude-fast');
    assert.equal(answer.status, 200);
    assert.deepEqual(seen.map(s => s.token), ['Bearer t-a', 'Bearer t-b']);
  }, 2);
});

test('an explicitly retryable throttle still pauses and retries', async () => {
  await withProxy({ 'x-should-retry': 'true', 'retry-after': '1' }, async ({ am, seen, post }) => {
    const answer = await post('claude-fast');
    assert.equal(answer.status, 200);
    assert.deepEqual(seen, [
      { token: 'Bearer t-a', model: 'claude-fast' },
      { token: 'Bearer t-b', model: 'claude-fast' },
      { token: 'Bearer t-b', model: 'claude-fast' },
    ], 'the retryable throttle takes one hop, then waits and retries that account');
    assert.notEqual(am.accounts[0].rampStartedAt, null, 'retryable throttles still arm the admission ramp');
  }, 3);
});
