import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, codexUnsupportedModel } from '../src/server.js';
import { renderStatus } from '../src/status-renderer.js';

// A ChatGPT plan that lapsed to free stops serving some models, and the Codex
// backend says so with a 400 per model. Adaptive routing sent such a model to
// the lapsed account and the 400 reached the client, while the other account's
// plan would have served it. The 400 is about the account, so the request fails
// over and the account sits that model out; it still serves the others.

const MODEL = 'gpt-6.1-terra';
const OTHER = 'gpt-6-luna';
const DETAIL = `The '${MODEL}' model is not supported when using Codex with a ChatGPT account.`;
const START = Date.parse('2026-11-02T12:00:00Z');
const MIN = 60_000;

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const codexAccount = (name, upstreamPort = 1) => ({
  name, type: 'oauth', provider: 'codex',
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  accountId: 'acct-' + name,
  upstream: `http://127.0.0.1:${upstreamPort}`,
});

/**
 * A proxy over two Codex accounts and a recorder upstream. `answer` decides
 * each upstream reply from the account and the model; it returns null to serve.
 */
async function proxyWith(answer) {
  /** @type {{ account: string, model: string }[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const account = String(req.headers.authorization).replace('Bearer t-', '');
    const { model } = JSON.parse(raw);
    seen.push({ account, model });
    const refusal = answer(account, model);
    if (refusal) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(refusal);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ served: account }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([codexAccount('a', upstreamPort), codexAccount('b', upstreamPort)], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' } });
  const port = await listen(proxy);
  const send = async (model, path = '/backend-api/codex/responses') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: [] }),
    });
    return { status: res.status, body: await res.text() };
  };
  return { am, seen, send, close: () => { proxy.close(); upstream.close(); } };
}

const refuses = (model) => JSON.stringify({ detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.` });

// ── the predicate ────────────────────────────────────────────────────────────

test('the refusal is read from either body shape the Codex backend uses', () => {
  const read = (/** @type {unknown} */ json) => codexUnsupportedModel(Buffer.from(JSON.stringify(json)));
  assert.equal(read({ detail: DETAIL }), MODEL);
  // The shape upstream sent on 2026-11-02: both fields, and a code.
  assert.equal(read({ detail: DETAIL, error: { type: 'invalid_request_error', code: 'model_not_found', message: DETAIL } }), MODEL);
  assert.equal(read({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: DETAIL } }), MODEL);
  assert.equal(read({ error: { type: 'invalid_request_error', message: "Unsupported parameter: 'temperature'" } }), null);
  assert.equal(codexUnsupportedModel(Buffer.from('not json')), null);
  assert.equal(codexUnsupportedModel(null), null);
});

test('another 400 that echoes the sentence from the client body does not bar the model', async () => {
  const echo = JSON.stringify({ error: { type: 'invalid_request_error', message: `Invalid input: '${DETAIL}'` } });
  const ctx = await proxyWith((account, model) => (account === 'a' && model === MODEL ? echo : null));
  try {
    const res = await ctx.send(MODEL);
    assert.equal(res.status, 400);
    assert.equal(res.body, echo);
    assert.equal(ctx.am.modelDenial(ctx.am.accounts[0], MODEL), null);
  } finally {
    ctx.close();
  }
});

test('a refusal of a differently written model does not bar the real one', async () => {
  const shouted = MODEL.toUpperCase();
  const ctx = await proxyWith((_account, model) => (model === shouted ? refuses(model) : null));
  try {
    assert.equal((await ctx.send(shouted)).status, 400);
    for (const a of ctx.am.accounts) assert.equal(ctx.am.unavailableReason(a, MODEL), null);
    ctx.seen.length = 0;
    assert.equal((await ctx.send(MODEL)).status, 200);
  } finally {
    ctx.close();
  }
});

// ── end to end ───────────────────────────────────────────────────────────────

test('a model the plan does not serve fails over, and only that model sits out', async () => {
  const ctx = await proxyWith((account, model) => (account === 'a' && model === MODEL ? refuses(model) : null));
  try {
    const first = await ctx.send(MODEL);
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body), { served: 'b' });
    assert.deepEqual(ctx.seen, [{ account: 'a', model: MODEL }, { account: 'b', model: MODEL }]);

    const [a] = ctx.am.getStatus().accounts;
    assert.equal(a.modelDenials.length, 1);
    assert.equal(a.modelDenials[0].model, MODEL);
    assert.equal(a.modelDenials[0].detail, DETAIL);
    assert.equal(a.modelDenials[0].count, 1);
    assert.ok(Date.parse(a.modelDenials[0].until) > Date.now());
    assert.equal(a.status, 'active', 'the account itself stays in service');

    // Pointed back at `a`: the denied model still skips it, another model does not.
    ctx.am.currentIndex = 0;
    ctx.am.providerCursors.set('codex', 0);
    ctx.seen.length = 0;
    assert.equal((await ctx.send(MODEL)).status, 200);
    assert.deepEqual(ctx.seen, [{ account: 'b', model: MODEL }]);

    ctx.am.currentIndex = 0;
    ctx.am.providerCursors.set('codex', 0);
    ctx.seen.length = 0;
    const other = await ctx.send(OTHER);
    assert.equal(other.status, 200);
    assert.deepEqual(ctx.seen, [{ account: 'a', model: OTHER }]);
  } finally {
    ctx.close();
  }
});

test('when every plan refuses the model, the client gets upstream\'s 400', async () => {
  const ctx = await proxyWith((_account, model) => (model === MODEL ? refuses(model) : null));
  try {
    const res = await ctx.send(MODEL);
    assert.equal(res.status, 400);
    assert.equal(res.body, refuses(MODEL));
    assert.deepEqual(ctx.seen.map(s => s.account).sort(), ['a', 'b'], 'each account is asked once');

    // While both sit the model out nothing is sent, and the answer is still a
    // 400 that names the refusal rather than a rate limit to wait out.
    ctx.seen.length = 0;
    const again = await ctx.send(MODEL);
    assert.equal(again.status, 400);
    assert.deepEqual(ctx.seen, []);
    assert.equal(JSON.parse(again.body).error.message, DETAIL);

    // A pin to one of them gets the same answer.
    const pinned = await ctx.send(MODEL, '/tc-acct/a/backend-api/codex/responses');
    assert.equal(pinned.status, 400);
    assert.deepEqual(ctx.seen, []);
  } finally {
    ctx.close();
  }
});

test('another 400 is relayed without failing over', async () => {
  const unrelated = JSON.stringify({ error: { type: 'invalid_request_error', message: "Unsupported parameter: 'temperature'" } });
  const ctx = await proxyWith(() => unrelated);
  try {
    const res = await ctx.send(MODEL);
    assert.equal(res.status, 400);
    assert.equal(res.body, unrelated);
    assert.equal(ctx.seen.length, 1, 'a 400 about the request is not retried on another account');
    assert.deepEqual(ctx.am.getStatus().accounts[ctx.seen[0].account === 'a' ? 0 : 1].modelDenials, []);
  } finally {
    ctx.close();
  }
});

test('a completion of the model on the account clears its denial', async () => {
  let refusing = true;
  const ctx = await proxyWith((account, model) => (refusing && account === 'a' && model === MODEL ? refuses(model) : null));
  try {
    await ctx.send(MODEL);
    assert.equal(ctx.am.getStatus().accounts[0].modelDenials.length, 1);

    // The plan is renewed, and the cooldown lapses: `a` is asked again and serves.
    refusing = false;
    ctx.am.accounts[0].modelDenials.get(MODEL).until = Date.now() - 1;
    ctx.am.accounts[1].disabled = true;
    ctx.seen.length = 0;
    assert.equal((await ctx.send(MODEL)).status, 200);
    assert.deepEqual(ctx.seen, [{ account: 'a', model: MODEL }]);
    assert.deepEqual(ctx.am.getStatus().accounts[0].modelDenials, []);
  } finally {
    ctx.close();
  }
});

// ── the cooldown ─────────────────────────────────────────────────────────────

test('consecutive denials of a model lengthen its cooldown up to an hour', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([codexAccount('a')]);
  const a = am.accounts[0];
  for (const [n, wait] of [[1, 5], [2, 15], [3, 60], [4, 60]]) {
    assert.equal(am.markModelDenied(0, MODEL, { detail: DETAIL }), Date.now() + wait * MIN);
    assert.equal(am.modelDenial(a, MODEL).count, n);
    assert.equal(am.unavailableReason(a, MODEL), 'model-unsupported');
    assert.equal(am.unavailableReason(a, OTHER), null, 'other models are served');
    t.mock.timers.tick(wait * MIN);
    assert.equal(am.unavailableReason(a, MODEL), null);
  }
  assert.equal(am.modelDenial(a, MODEL).since, START);
});

test('a denial for a request sent before the last one was counted does not count again', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([codexAccount('a')]);
  const a = am.accounts[0];
  const sent = a.modelDenialEpoch;
  const until = am.markModelDenied(0, MODEL);

  assert.equal(am.markModelDenied(0, MODEL, { epoch: sent }), until);
  assert.equal(am.modelDenial(a, MODEL).count, 1);

  // A different model's denial from the same moment is its own news.
  am.markModelDenied(0, OTHER, { epoch: sent });
  assert.equal(am.modelDenial(a, OTHER).count, 1);

  // Nor does a completion sent before the denial clear it.
  am.clearModelDenied(a, MODEL, sent);
  assert.equal(am.modelDenial(a, MODEL).count, 1);
  am.clearModelDenied(a, MODEL, a.modelDenialEpoch);
  assert.equal(am.modelDenial(a, MODEL), null);
  assert.equal(am.modelDenial(a, OTHER).count, 1, 'clearing one model leaves the others');
});

test('the paths that skip unavailableReason see the denial through capBars', () => {
  const am = new AccountManager([codexAccount('a')]);
  am.markModelDenied(0, MODEL);
  // capBars is what those paths ask in place of unavailableReason.
  assert.equal(am.capBars(am.accounts[0], MODEL), 'model-unsupported');
  assert.equal(am.capBars(am.accounts[0], OTHER), null);
});

test('a change of plan re-admits every model it refused', () => {
  const am = new AccountManager([codexAccount('a')]);
  const a = am.accounts[0];
  am.applyCodexUsageData(0, { planType: 'free' });
  am.markModelDenied(0, MODEL);
  am.markModelDenied(0, OTHER);

  // The same plan read again changes nothing.
  am.updateQuota(0, { 'x-codex-plan-type': 'free' }, OTHER, 200);
  assert.equal(a.modelDenials.size, 2);

  am.updateQuota(0, { 'x-codex-plan-type': 'pro' }, OTHER, 200);
  assert.equal(a.modelDenials.size, 0);
  assert.equal(am.unavailableReason(a, MODEL), null);

  // The usage probe's reading counts the same.
  am.markModelDenied(0, MODEL);
  am.applyCodexUsageData(0, { planType: 'free' });
  assert.equal(a.modelDenials.size, 0);
});

test('status names each refused model and how long it sits out', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const am = new AccountManager([codexAccount('a')]);
  am.markModelDenied(0, MODEL, { detail: DETAIL });
  am.markModelDenied(0, MODEL, { detail: DETAIL });
  const text = renderStatus(am.getStatus(), { color: false, now: Date.now() });
  assert.match(text, new RegExp(`plan does not serve ${MODEL.replace(/\./g, '\\.')} \\(retry in 15m, 2 in a row\\)`));
});
