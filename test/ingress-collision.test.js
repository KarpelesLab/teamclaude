import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  routabilityOf,
  collisionIdInSet,
  requestModelIds,
  configIdentityKey,
  invalidateNormalizedConfigView,
  normalizedConfigView,
} from '../src/model-namespace.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const advisorBody = (executor, advisor) => JSON.stringify({
  model: executor,
  max_tokens: 16,
  tools: [
    { name: 'Bash', description: 'x', input_schema: { type: 'object', properties: {} } },
    { type: 'advisor_20260301', name: 'advisor', model: advisor },
  ],
  messages: [{ role: 'user', content: 'hi' }],
});

/** kimi-k3 incident class: id is an account name, winning route excludes that
 * account, no eligible translator, first taker is Anthropic passthrough →
 * routabilityOf.accountNameCollision. */
function collisionConfig(upstreamPort) {
  return {
    accounts: [
      {
        name: 'primary@example.com', type: 'oauth', priority: 0,
        accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
      },
      {
        name: 'kimi-k3', type: 'apikey', priority: 60, apiKey: 'k3',
        upstream: `http://127.0.0.1:${upstreamPort}`,
      },
    ],
    routes: [
      // Matches *kimi* / *k3* but deliberately EXCLUDES the account of that name —
      // the live incident shape that makes the collision provable.
      { name: 'kimi', match: ['*kimi*', '*k3*'], accounts: ['primary@example.com'] },
      { name: 'default', match: ['*'], accounts: ['primary@example.com'] },
    ],
  };
}

async function setupCollisionProxy(mutateConfig = null) {
  let upstreamHits = 0;
  let lastBody = null;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const cfg = collisionConfig(upPort);
  if (mutateConfig) mutateConfig(cfg);
  const am = new AccountManager(cfg.accounts, 0.98, { routes: cfg.routes });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    accounts: cfg.accounts,
    routes: cfg.routes,
    blockedModels: cfg.blockedModels,
  });
  const port = await listen(proxy);
  return {
    am, cfg, port, proxy, upstream,
    get hits() { return upstreamHits; },
    get lastBody() { return lastBody; },
    async close() { await close(proxy); await close(upstream); },
  };
}

// ── oracle: collisionIdInSet mirrors routabilityOf ────────────

test('collisionIdInSet agrees with routabilityOf.accountNameCollision over the id set', () => {
  const config = {
    accounts: [
      { name: 'primary@example.com', type: 'oauth', priority: 0 },
      { name: 'kimi-k3', type: 'apikey', priority: 60, upstream: 'http://127.0.0.1:9' },
      { name: 'deepseek-v4-pro', type: 'apikey', priority: 80, upstream: 'http://127.0.0.1:8' },
    ],
    routes: [
      { name: 'kimi', match: ['*kimi*', '*k3*'], accounts: ['primary@example.com'] },
      { name: 'default', match: ['*'], accounts: ['primary@example.com'] },
    ],
  };
  const models = ['kimi-k3', 'deepseek-v4-pro', 'claude-opus-4-8', 'claude-nonexistent-9', 'primary@example.com'];
  for (const model of models) {
    const expected = !!routabilityOf(config, model).accountNameCollision;
    const hit = collisionIdInSet(config, [model], { executor: model });
    assert.equal(!!hit, expected, `collisionIdInSet vs oracle on ${model}`);
  }
  // Set quantification: executor collision wins over advisor.
  const dual = collisionIdInSet(config, requestModelIds({ model: 'kimi-k3', advisorModel: 'deepseek-v4-pro' }), {
    executor: 'kimi-k3',
  });
  assert.equal(dual?.role, 'executor');
  assert.equal(dual?.id, 'kimi-k3');
  // Advisor-only collision.
  const adv = collisionIdInSet(config, requestModelIds({ model: 'claude-opus-4-8', advisorModel: 'kimi-k3' }), {
    executor: 'claude-opus-4-8',
  });
  assert.equal(adv?.role, 'advisor');
  assert.equal(adv?.id, 'kimi-k3');
});

// ── ingress: kimi-k3 class ────────────────────────────────────

test('ingress rejects a provable executor account-name collision with remedy text and never hits upstream', async () => {
  const t = await setupCollisionProxy();
  try {
    assert.equal(routabilityOf(t.cfg, 'kimi-k3').accountNameCollision, true, 'fixture must be a provable collision');
    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error?.type, 'invalid_request_error');
    assert.match(body.error.message, /kimi-k3/);
    assert.match(body.error.message, /account/i);
    assert.match(body.error.message, /\/tc-acct|teamclaude run --account/);
    assert.equal(t.hits, 0, 'must not egress the colliding id');
  } finally {
    await t.close();
  }
});

test('ingress strips a provable advisor-id collision and still forwards the executor (G9)', async () => {
  const t = await setupCollisionProxy();
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-opus-4-8', 'kimi-k3'),
    });
    assert.equal(res.status, 200, 'advisor collision must NOT 400 the executor turn');
    await res.text();
    assert.equal(t.hits, 1);
    const forwarded = JSON.parse(t.lastBody);
    assert.equal(forwarded.model, 'claude-opus-4-8');
    // The winning account inherits the custom top-level upstream, so drop
    // supersedes the collision strip: the whole advisor tool is gone.
    assert.equal(forwarded.tools.length, 1, 'colliding advisor must never egress — whole tool dropped on custom upstream');
    assert.equal(forwarded.tools[0].name, 'Bash');
    assert.ok(t.am.getStatus().advisorDegrades >= 1);
  } finally {
    await t.close();
  }
});

test('plausible unknown id passes through untouched (namespace is un-enumerable)', async () => {
  const t = await setupCollisionProxy();
  try {
    assert.equal(routabilityOf(t.cfg, 'claude-nonexistent-9').accountNameCollision, false);
    assert.equal(routabilityOf(t.cfg, 'claude-nonexistent-9').routable, true);
    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-nonexistent-9', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
    assert.equal(JSON.parse(t.lastBody).model, 'claude-nonexistent-9');
  } finally {
    await t.close();
  }
});

test('config identity cache: renaming an account flips which id the ingress gate rejects', async () => {
  const t = await setupCollisionProxy();
  try {
    // Warm the normalized view on the original name.
    assert.equal(collisionIdInSet(t.cfg, ['kimi-k3'])?.id, 'kimi-k3');
    const keyBefore = configIdentityKey(t.cfg);
    const viewBefore = normalizedConfigView(t.cfg);

    // Rename in place (reload / TUI shape): same config object, new identity.
    t.cfg.accounts[1].name = 'kimi-k3-renamed';
    // Proxy config is the same object reference createProxyServer closed over.
    assert.notEqual(configIdentityKey(t.cfg), keyBefore, 'identity key must change with the rename');
    invalidateNormalizedConfigView(); // reload-path explicit invalidate
    assert.notEqual(normalizedConfigView(t.cfg), viewBefore);

    const oldName = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await oldName.text();
    assert.equal(oldName.status, 200, 'old account name is no longer a collision');
    assert.equal(t.hits, 1);

    const newName = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3-renamed', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await newName.json();
    assert.equal(newName.status, 400, 'new account name is now the collision');
    assert.equal(body.error?.type, 'invalid_request_error');
    assert.match(body.error.message, /kimi-k3-renamed/);
    assert.equal(t.hits, 1, 'rejected rename must not add an upstream hit');
  } finally {
    await t.close();
  }
});

test('status reads stay healthy and unaffected by the collision gate', async () => {
  const t = await setupCollisionProxy();
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/teamclaude/status`);
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.ok(Array.isArray(status.accounts));
    assert.equal(typeof status.advisorDegrades, 'number');
  } finally {
    await t.close();
  }
});
