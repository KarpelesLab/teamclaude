import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { renderStatus } from '../src/status-renderer.js';

const LOW_CREDIT = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  },
};
const apikey = name => ({ name, type: 'apikey', apiKey: `key-${name}`, priority: 100 });
const subscription = {
  name: 'subscription', type: 'oauth', accessToken: 'subscription-token',
  expiresAt: Date.now() + 3600_000, allowExtraUsage: true,
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withProxy(accounts, reply, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers['x-api-key'] || req.headers.authorization);
    reply(req, res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  am._nextProbeAt = Date.now() + 60_000;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const post = async (headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1, messages: [] }),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await run({ am, seen, post, port });
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

for (const [status, body, weekly] of [
  [400, LOW_CREDIT, 0.98],
  [400, LOW_CREDIT, 1],
  [402, { type: 'error', error: { type: 'billing_error', message: 'Billing is unavailable.' } }, 1],
]) {
  test(`HTTP ${status} billing refusal fails over at ${weekly * 100}% subscription usage across requests`, async () => {
    await withProxy([subscription, apikey('empty')], (req, res) => {
      const empty = !!req.headers['x-api-key'];
      res.writeHead(empty ? status : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(empty ? body : { ok: true }));
    }, async ({ am, seen, post }) => {
      Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true } });

      assert.deepEqual(await post(), { status: 200, body: { ok: true } });
      assert.deepEqual(await post(), { status: 200, body: { ok: true } });
      assert.deepEqual(seen, ['key-empty', 'Bearer subscription-token', 'Bearer subscription-token']);
      assert.deepEqual({ reason: am.unavailableReason(am.accounts[1]), probeable: am._isProbeable(am.accounts[1]) },
        { reason: 'billing', probeable: false });
      assert.match(renderStatus(am.getStatus(), { color: false }), /billing.*purchase credits/i);
    });
  });
}

for (const disabled of [false, true]) {
  test(`a depleted account reports billing failure across requests (disabled subscription: ${disabled})`, async () => {
    const accounts = disabled ? [apikey('empty'), { ...subscription, disabled: true }] : [apikey('empty')];
    await withProxy(accounts, (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(LOW_CREDIT));
    }, async ({ post, seen }) => {
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(await post(), { status: 402, body: { type: 'error', error: {
          type: 'billing_error',
          message: 'Upstream billing refused every eligible account. Check billing or purchase credits; TeamClaude retries after the billing cooldown.',
        } } });
      }
      assert.deepEqual(seen, ['key-empty']);
    });
  });
}

test('billing cooldown expires and a replenished API account can serve again', async () => {
  let depleted = true;
  await withProxy([apikey('empty')], (_req, res) => {
    res.writeHead(depleted ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(depleted ? LOW_CREDIT : { ok: true }));
  }, async ({ am, post, seen }) => {
    await post();
    assert.ok(am.accounts[0].billingRejectedUntil > Date.now());
    am.accounts[0].billingRejectedUntil = Date.now() - 1;
    depleted = false;

    assert.deepEqual(await post(), { status: 200, body: { ok: true } });
    assert.deepEqual({ reason: am.unavailableReason(am.accounts[0]), until: am.getStatus().accounts[0].billingRejectedUntil },
      { reason: null, until: null });
    assert.deepEqual(seen, ['key-empty', 'key-empty']);
  });
});

for (const body of [
  JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }),
  'not JSON',
  JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'x'.repeat(100_000) } }),
]) {
  test(`an unrelated HTTP 400 is relayed unchanged (${body.length} bytes)`, async () => {
    await withProxy([apikey('valid')], (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'x-diagnostic': 'preserved' });
      res.end(body);
    }, async ({ am, seen, port }) => {
      const result = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      assert.deepEqual({ status: result.status, body: await result.text(), diagnostic: result.headers.get('x-diagnostic') },
        { status: 400, body, diagnostic: 'preserved' });
      assert.equal(am.unavailableReason(am.accounts[0]), null);
      assert.deepEqual(seen, ['key-valid']);
    });
  });
}
