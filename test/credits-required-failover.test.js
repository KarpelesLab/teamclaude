import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { creditsRequiredRefusal } from '../src/account-refusal.js';
import { renderStatus } from '../src/status-renderer.js';
import { barredFamilies } from '../src/tui.js';

// A plan that does not include Fable refuses it with a 429 that names no spent
// window (captured from Claude Code 2.1.332, request id replaced). Another
// account serves the same request, and this one still serves other models.
const FABLE = 'claude-fable-5-2';
const OPUS = 'claude-opus-4-6';
const refusal = (details = {}) => JSON.stringify({
  type: 'error',
  error: {
    type: 'rate_limit_error',
    message: 'Usage credits are required for this model.',
    details: {
      error_code: 'credits_required', can_user_purchase_credits: true, has_chargeable_saved_payment_method: true,
      disabled_reason: 'org_level_disabled', exhausted_included_allowance: false, model: FABLE, model_display_name: 'Fable',
      notice: {
        title: 'Fable requires usage credits',
        text: 'Buy usage credits to keep using Fable or switch models to continue this chat.',
        cta: { copy: 'Buy credits', intent: 'buy_credit', redirect_hint: null }, is_dismissible: true,
      },
      ...details,
    },
  },
  request_id: 'req_test',
});
const fastModeBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for fast mode.' } });

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

/**
 * A fake upstream: `refuses(token, model)` returns the refusal to send (headers
 * and body) or null to answer 200.
 */
async function withProxy({ names = ['a', 'b'], headers = { 'x-should-retry': 'false', 'request-id': 'req_test' }, refuses }, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const model = JSON.parse(body).model;
      const token = req.headers.authorization.replace('Bearer t-', '');
      seen.push(`${token}:${model}`);
      const refused = refuses(token, model);
      if (refused) {
        res.writeHead(429, { 'content-type': 'application/json', ...headers });
        res.end(refused);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served: token }));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(names.map(account), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const controllers = new Set();
  const post = (model, path = '/v1/messages') => {
    const controller = new AbortController();
    controllers.add(controller);
    return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }), signal: controller.signal,
    }).finally(() => { controllers.delete(controller); });
  };
  try { await fn({ am, seen, post }); } finally {
    for (const controller of controllers) controller.abort();
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  }
}

const fableOnA = (token, model) => (token === 'a' && model === FABLE ? refusal() : null);

test('creditsRequiredRefusal reads the plan refusal, and not the fast-mode one', () => {
  const body = (s) => Buffer.from(s);
  assert.deepEqual(creditsRequiredRefusal(429, body(refusal())),
    { model: FABLE, reason: 'not-in-plan', detail: 'Usage credits are required for this model.' });
  assert.equal(creditsRequiredRefusal(429, body(refusal({ exhausted_included_allowance: true })))?.reason, 'allowance-spent');
  assert.equal(creditsRequiredRefusal(403, body(refusal()))?.model, FABLE);
  assert.equal(creditsRequiredRefusal(429, body(fastModeBody)), null);
  assert.equal(creditsRequiredRefusal(500, body(refusal())), null);
});

// Each header set the refusal could carry took a different path before: relayed
// as a no-retry 429, paused and hopped once, or retried on the same account.
for (const [label, headers] of [
  ['x-should-retry: false', { 'x-should-retry': 'false', 'request-id': 'req_test' }],
  ['no retry or rate-limit headers', {}],
  ['rate-limit headers that reject nothing', {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.1',
  }],
  ['x-should-retry: false with rate-limit headers', {
    'x-should-retry': 'false', 'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.2',
  }],
]) {
  test(`Fable refused for usage credits (${label}) is served by another account`, async () => {
    await withProxy({ headers, refuses: fableOnA }, async ({ am, seen, post }) => {
      const answer = await post(FABLE);
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), { served: 'b' });
      assert.deepEqual(seen, [`a:${FABLE}`, `b:${FABLE}`]);
      const held = am.familyRefusal(am.accounts[0], FABLE);
      assert.equal(held?.reason, 'not-in-plan');
      assert.ok(held.until > Date.now() + 23 * 3600_000, 'a plan without the family is held for a day');
      assert.equal(am.isPaused(0), false, 'a plan refusal does not pause the account');
      assert.equal(am.unavailableReason(am.accounts[0], FABLE), 'credits-required');
    });
  });
}

test('a later Fable request skips the refusing account, and Opus still uses it', async () => {
  await withProxy({ refuses: fableOnA }, async ({ am, seen, post }) => {
    assert.equal((await post(FABLE)).status, 200);
    seen.length = 0;
    const again = await post(FABLE);
    assert.equal(again.status, 200);
    assert.deepEqual(seen, [`b:${FABLE}`], 'no upstream call to the refusing account');
    // With b out of rotation for every model, Opus has only a left.
    am.markRateLimited(1, 600);
    seen.length = 0;
    const opus = await post(OPUS);
    assert.equal(opus.status, 200);
    assert.deepEqual(await opus.json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${OPUS}`]);
  });
});

test('when every account refuses, the client gets the original refusal', async () => {
  await withProxy({ refuses: (_token, model) => (model === FABLE ? refusal() : null) }, async ({ seen, post }) => {
    const refused = await post(FABLE);
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), refusal());
    assert.equal(refused.headers.get('x-should-retry'), 'false');
    assert.equal(refused.headers.get('request-id'), 'req_test');
    assert.deepEqual(seen, [`a:${FABLE}`, `b:${FABLE}`]);
    // Both accounts are now held: the next request is answered from the
    // refusals they kept, without an upstream call.
    seen.length = 0;
    const again = await post(FABLE);
    assert.equal(again.status, 429);
    assert.equal(await again.text(), refusal());
    assert.deepEqual(seen, []);
  });
});

test('a served Fable request on the account clears its refusal', async () => {
  let refusing = true;
  await withProxy({ refuses: (token, model) => (refusing ? fableOnA(token, model) : null) }, async ({ am, seen, post }) => {
    assert.equal((await post(FABLE)).status, 200);
    // The hold runs out; the plan meanwhile includes Fable.
    am.familyRefusal(am.accounts[0], FABLE).until = Date.now() - 1;
    refusing = false;
    am.markRateLimited(1, 600);
    seen.length = 0;
    const answer = await post(FABLE);
    assert.deepEqual(await answer.json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${FABLE}`]);
    assert.equal(am.familyRefusal(am.accounts[0], FABLE), null);
  });
});

test('a pin to the refusing account still reaches upstream, which answers for it', async () => {
  let refusing = true;
  await withProxy({ refuses: (token, model) => (refusing ? fableOnA(token, model) : null) }, async ({ am, seen, post }) => {
    const refused = await post(FABLE, '/tc-acct/a/v1/messages');
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), refusal());
    assert.deepEqual(seen, [`a:${FABLE}`], 'a pin does not fail over');
    assert.equal(am.familyRefusal(am.accounts[0], FABLE)?.count, 1);
    refusing = false;
    const served = await post(FABLE, '/tc-acct/a/v1/messages');
    assert.deepEqual(await served.json(), { served: 'a' });
    assert.equal(am.familyRefusal(am.accounts[0], FABLE), null);
  });
});

test('the fast-mode refusal is relayed as before and holds no family', async () => {
  await withProxy({ refuses: (token, model) => (model === 'claude-fast' ? fastModeBody : null) }, async ({ am, seen, post }) => {
    const refused = await post('claude-fast');
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), fastModeBody);
    assert.deepEqual(seen, ['a:claude-fast']);
    assert.equal(am.familyRefusal(am.accounts[0], 'claude-fast'), null);
  });
});

test('a refusal survives a restart, and status and the TUI say why', () => {
  const am = new AccountManager([{ ...account('a'), accountUuid: 'u-a' }], 0.98);
  am.markFamilyRefused(0, FABLE, { reason: 'not-in-plan', detail: 'Usage credits are required for this model.' });
  const restarted = new AccountManager([{ ...account('a'), accountUuid: 'u-a' }], 0.98);
  restarted.restoreQuotaState(JSON.parse(JSON.stringify(am.exportQuotaState())));
  const a = restarted.accounts[0];
  assert.equal(restarted.unavailableReason(a, FABLE), 'credits-required');
  assert.equal(restarted.unavailableReason(a, OPUS), null);

  const status = restarted.getStatus();
  const row = status.accounts[0];
  assert.equal(row.familyRefusals[0].family, 'fable');
  assert.equal(row.familyRefusals[0].reason, 'not-in-plan');
  assert.match(renderStatus(status, { color: false }), /Fable not in plan \(usage credits required; re-check in /);
  assert.deepEqual(barredFamilies(row, 1), ['Fable']);
  assert.deepEqual(barredFamilies(a, 1), ['Fable']);
});
