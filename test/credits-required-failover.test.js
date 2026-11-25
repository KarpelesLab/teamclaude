import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { creditsRequiredRefusal } from '../src/account-refusal.js';
import { renderStatus } from '../src/status-renderer.js';
import { barredFamilies } from '../src/tui.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { withEnv } from '../test-helpers/env.js';

// A plan that does not include Fable refuses it with a 429 that names no spent
// window (captured from Claude Code 2.1.332, request id replaced). Another
// account serves the same request, and this one still serves other models.
const FABLE = 'claude-fable-5-2';
const OPUS = 'claude-opus-4-6';
const refusal = (details = {}, error = {}) => JSON.stringify({
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
    ...error,
  },
  request_id: 'req_test',
});
const fastModeBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage credits are required for fast mode.' } });

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const account = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

/**
 * A fake upstream: `refuses(token, model)` returns the refusal to send (headers
 * and body), a function to write the response, or null to answer 200.
 */
async function withProxy({ names = ['a', 'b'], headers = { 'x-should-retry': 'false', 'request-id': 'req_test' }, refuses }, fn) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const { model, tools = [] } = JSON.parse(body);
      const advisor = tools[0]?.model;
      const token = req.headers.authorization.replace('Bearer t-', '');
      seen.push(`${token}:${model}`);
      const refused = await refuses(token, model, advisor);
      if (typeof refused === 'function') {
        refused(res);
      } else if (refused) {
        res.writeHead(refused.status ?? 429, { 'content-type': 'application/json', ...headers, ...refused.headers });
        res.end(refused.body ?? refused);
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
  const post = (model, path = '/v1/messages', { advisor, sessionId } = {}) => {
    const controller = new AbortController();
    controllers.add(controller);
    return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}) },
      body: JSON.stringify({ model, messages: [], ...(advisor ? { tools: [{ type: 'advisor_20260301', name: 'advisor', model: advisor }] } : {}) }),
      signal: controller.signal,
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
  ['a bare unified rejection', { 'anthropic-ratelimit-unified-status': 'rejected' }],
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
      assert.equal(am.unavailableReason(am.accounts[0], OPUS), null, 'the same account still serves other models');
    });
  });
}

test('a 402 with credits_required beats billing and shared quota headers', async () => {
  await withProxy({ refuses: (token, model) => (token === 'a' && model === FABLE ? {
    status: 402, body: refusal({}, { type: 'billing_error' }),
    headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1' },
  } : null) }, async ({ am, seen, post }) => {
    assert.deepEqual(await (await post(FABLE)).json(), { served: 'b' });
    assert.equal(am.unavailableReason(am.accounts[0], FABLE), 'credits-required');
    am.currentIndex = 0;
    assert.deepEqual(await (await post(OPUS)).json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${FABLE}`, `b:${FABLE}`, `a:${OPUS}`]);
  });
});

test('a credits 429 with a rejected shared window still takes the quota path', async () => {
  const headers = {
    'x-should-retry': 'false', 'retry-after': '300',
    'anthropic-ratelimit-unified-7d-status': 'rejected', 'anthropic-ratelimit-unified-7d-utilization': '1',
  };
  await withProxy({ headers, refuses: fableOnA }, async ({ am, seen, post }) => {
    assert.deepEqual(await (await post(FABLE)).json(), { served: 'b' });
    assert.equal(am.unavailableReason(am.accounts[0], OPUS), 'throttled');
    assert.deepEqual(seen, [`a:${FABLE}`, `b:${FABLE}`]);
  });
});

for (const [label, body, status] of [
  ['the exact sentence without the code', refusal({ error_code: undefined }), 429],
  ['a different sentence without a model', refusal({ model: undefined }, { message: 'You must buy usage credits.' }), 429],
  ['a fast-mode option with a named model', refusal({}, { message: 'Usage credits are required for fast mode.' }), 429],
  ['a long-context option with a named model', refusal({}, { message: 'Usage credits are required for long context.' }), 403],
]) {
  test(`only the requesting client gets ${label}`, async () => {
    let first = true;
    await withProxy({ headers: { 'anthropic-ratelimit-unified-status': 'rejected' }, refuses: () => {
      if (!first) return null;
      first = false;
      return { status, body };
    } }, async ({ am, seen, post }) => {
      const answer = await post(FABLE);
      assert.equal(answer.status, status);
      assert.equal(await answer.text(), body);
      am.currentIndex = 0;
      assert.deepEqual(await (await post(FABLE)).json(), { served: 'a' });
      assert.deepEqual(seen, [`a:${FABLE}`, `a:${FABLE}`]);
    });
  });
}

test('a later Fable request skips the refusing account, and Opus still uses it', async () => {
  await withProxy({ refuses: fableOnA }, async ({ am, seen, post }) => {
    assert.equal((await post(FABLE)).status, 200);
    seen.length = 0;
    am.currentIndex = 0;
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

test('all-held requests re-check just the oldest hold and receive a fresh answer', async () => {
  let call = 0;
  const answerBody = n => refusal({}, { message: `Fable needs usage credits (call ${n}).` });
  await withProxy({ refuses: () => {
    const n = ++call;
    return n > 3 ? null : { status: n === 3 ? 403 : 429, body: answerBody(n), headers: { 'request-id': `req_${n}` } };
  } }, async ({ am, seen, post }) => {
    const first = await post(FABLE);
    assert.equal(first.status, 429);
    assert.equal(await first.text(), answerBody(2));
    assert.equal(first.headers.get('request-id'), 'req_2');
    assert.equal(first.headers.get('x-should-retry'), 'false');
    assert.deepEqual(seen, [`a:${FABLE}`, `b:${FABLE}`]);

    const again = await post(FABLE);
    assert.equal(again.status, 403);
    assert.equal(await again.text(), answerBody(3));
    assert.equal(again.headers.get('request-id'), 'req_3');
    assert.deepEqual(seen.slice(2), [`a:${FABLE}`]);

    assert.deepEqual(await (await post(FABLE)).json(), { served: 'b' }, 'the refusal moved a to the back of the re-check order');
    assert.equal(am.unavailableReason(am.accounts[1], FABLE), null, 'a successful re-check clears the hold');
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

test('a completion dispatched before the refusal does not clear its hold', async () => {
  const sent = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let first = true;
  await withProxy({ refuses: async (token, model) => {
    if (token !== 'a' || model !== FABLE) return null;
    if (!first) return refusal();
    first = false;
    sent.resolve();
    await finish.promise;
    return null;
  } }, async ({ am, seen, post }) => {
    const pending = post(FABLE);
    try {
      await sent.promise;
      assert.deepEqual(await (await post(FABLE, '/tc-acct/a/v1/messages')).json(), JSON.parse(refusal()));
    } finally { finish.resolve(); }
    assert.deepEqual(await (await pending).json(), { served: 'a' });
    am.currentIndex = 0;
    assert.deepEqual(await (await post(FABLE)).json(), { served: 'b' });
    assert.deepEqual(seen, [`a:${FABLE}`, `a:${FABLE}`, `b:${FABLE}`]);
  });
});

test('a Fable advisor refusal fails over without barring the executor model', async () => {
  await withProxy({ refuses: (token, _model, advisor) => (token === 'a' && advisor === FABLE ? refusal() : null) }, async ({ am, seen, post }) => {
    am.setAdvisorEligibility('prefer');
    const ask = () => post(OPUS, '/v1/messages', { advisor: FABLE });
    assert.deepEqual(await (await ask()).json(), { served: 'b' });
    am.currentIndex = 0;
    assert.deepEqual(await (await ask()).json(), { served: 'b' });
    am.currentIndex = 0;
    assert.deepEqual(await (await post(OPUS)).json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${OPUS}`, `b:${OPUS}`, `b:${OPUS}`, `a:${OPUS}`]);
  });
});

test('a pinned refusal comes from upstream even when its only account is disabled and cordoned', async () => {
  await withProxy({ names: ['a'], refuses: fableOnA }, async ({ am, seen, post }) => {
    am.setCordoned(0, true);
    am.accounts[0].disabled = true;
    const answer = await post(FABLE, '/tc-acct/a/v1/messages');
    assert.equal(answer.status, 429);
    assert.equal(await answer.text(), refusal());
    assert.equal(answer.headers.get('request-id'), 'req_test');
    assert.deepEqual(seen, [`a:${FABLE}`]);
    assert.equal(am.familyRefusal(am.accounts[0], FABLE)?.reason, 'not-in-plan');
  });
});

test('an unpinned conversation can re-check its own cordoned account', async () => {
  let refusing = false;
  await withProxy({ names: ['a'], refuses: () => (refusing ? refusal() : null) }, async ({ am, seen, post }) => {
    const ask = () => post(FABLE, '/v1/messages', { sessionId: 'existing-conversation' });
    assert.deepEqual(await (await ask()).json(), { served: 'a' });
    am.setCordoned(0, true);
    refusing = true;
    const refused = await ask();
    assert.equal(refused.status, 429);
    assert.equal(await refused.text(), refusal());
    refusing = false;
    assert.deepEqual(await (await ask()).json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${FABLE}`, `a:${FABLE}`, `a:${FABLE}`]);
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

test('retry-after uses the quota reset when the other account needs advisor credits', async () => {
  await withProxy({ refuses: fableOnA }, async ({ am, seen, post }) => {
    assert.deepEqual(await (await post(FABLE)).json(), { served: 'b' });
    am.markRateLimited(1, 600);
    seen.length = 0;
    const answer = await post(OPUS, '/v1/messages', { advisor: FABLE });
    assert.equal(answer.status, 429);
    const retryAfter = Number(answer.headers.get('retry-after'));
    assert.ok(retryAfter >= 590 && retryAfter <= 600, `expected the 10-minute reset, got ${retryAfter}s`);
    assert.deepEqual(seen, []);
  });
});

test('a stalled credits error body is cancelled at the body-idle deadline', { timeout: 5000 }, async () => {
  const closed = Promise.withResolvers();
  let stall = true;
  await withEnv({ TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: 100 }, () => withProxy({
    names: ['a'], refuses: () => stall ? res => {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected' });
      // Send a complete JSON value but leave the HTTP body open.
      res.write(refusal());
      const fallback = setTimeout(() => res.end(), 2000);
      res.once('close', () => { clearTimeout(fallback); closed.resolve(!res.writableEnded); });
    } : null,
  }, async ({ am, seen, post }) => {
    await assert.rejects(post(FABLE), /fetch failed/);
    assert.equal(await closed.promise, true, 'the proxy cancelled the upstream body');
    assert.equal(am.unavailableReason(am.accounts[0], FABLE), null);
    stall = false;
    assert.deepEqual(await (await post(FABLE)).json(), { served: 'a' });
    assert.deepEqual(seen, [`a:${FABLE}`, `a:${FABLE}`]);
  }));
});

test('a refusal for an unknown model holds only that exact model after restart', () => {
  const rows = [{ ...account('a'), accountUuid: 'u-a' }];
  const am = new AccountManager(rows, 0.98);
  am.markFamilyRefused(0, 'claude-new-family-1');
  const restarted = new AccountManager(rows, 0.98);
  restarted.restoreQuotaState(JSON.parse(JSON.stringify(am.exportQuotaState())));
  assert.equal(restarted.unavailableReason(restarted.accounts[0], 'claude-new-family-1'), 'credits-required');
  assert.equal(restarted.unavailableReason(restarted.accounts[0], 'claude-new-family-2'), null);
});

test('plan metadata from a profile and a config reload clears family holds', async () => {
  const row = { ...account('a'), id: 'id-a', accountUuid: 'u-a', hasClaudeMax: true, seatTier: 'old' };
  const am = new AccountManager([row], 0.98);
  const a = am.accounts[0];
  am.markFamilyRefused(0, FABLE);
  am.applyProfileData(0, { seatTier: 'new' });
  assert.equal(am.unavailableReason(a, FABLE), null);

  am.markFamilyRefused(0, FABLE);
  await syncAccountsFromDisk({ accounts: [{ ...row, rateLimitTier: 'new' }] }, { accounts: [row] }, am);
  assert.equal(am.unavailableReason(a, FABLE), null);

  am.applyProfileData(0, { hasClaudeMax: false, hasClaudePro: false });
  am.markFamilyRefused(0, FABLE);
  am.applyProfileData(0, { hasClaudeMax: true });
  assert.equal(am.unavailableReason(a, FABLE), null);
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
