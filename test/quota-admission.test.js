import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// Prefer apikey accounts in admission tests: soft-exhausted OAuth fleets still
// probe today, and ensureTokenFresh would dial a real token endpoint and hang
// the suite. Apikey accounts exercise the same quota/_isAvailable path.
function acct(name, extra = {}) {
  return {
    name,
    type: 'apikey',
    apiKey: 'k',
    ...extra,
  };
}

async function setupProxy(accounts, { routes } = {}) {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    // Drain the request body — pooled HTTP/1.1 agents hang if the server
    // answers without consuming the POST body.
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      // A live forward that "succeeds" with a refusal-shaped body — the hazard
      // T4 must prevent for known-exhausted fleets (200-with-refusal grades
      // COMPLETED / EFFECT_UNKNOWN in the dispatch machine).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'I cannot help with that right now due to capacity.' }],
      }));
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98, routes ? { routes } : undefined);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    accounts,
    routes,
  });
  const port = await listen(proxy);
  return {
    am,
    port,
    upstreamHits: () => upstreamHits,
    async close() { await close(proxy); await close(upstream); },
  };
}

test('all-accounts-exhausted → typed 429 with retry-after matching soonest reset, zero upstream hits', async () => {
  const resetA = Date.now() + 2_000_000;
  const resetB = Date.now() + 900_000;
  const t = await setupProxy([acct('a'), acct('b')]);
  try {
    t.am.accounts[0].quota.unified7d = 0.99;
    t.am.accounts[0].quota.unified7dReset = resetA;
    t.am.accounts[1].quota.unified7d = 0.99;
    t.am.accounts[1].quota.unified7dReset = resetB;

    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    });
    const text = await res.text();
    assert.equal(res.status, 429);
    assert.equal(t.upstreamHits(), 0, 'must not forward a known-exhausted fleet');

    const expectedRetry = Math.min(3600, Math.max(1, Math.ceil((resetB - Date.now()) / 1000)));
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isFinite(retryAfter), 'retry-after present');
    // Allow a few seconds of clock skew between computing expected and header.
    assert.ok(Math.abs(retryAfter - expectedRetry) <= 5,
      `retry-after ${retryAfter} should match soonest reset (~${expectedRetry}s)`);

    const body = JSON.parse(text);
    assert.equal(body.type, 'error');
    assert.equal(body.error?.type, 'rate_limit_error');
    assert.equal(typeof body.error?.message, 'string');
    assert.match(body.error.message, /a.*quota-exhausted/i);
    assert.match(body.error.message, /b.*quota-exhausted/i);
  } finally {
    await t.close();
  }
});

test('one-account-serveable → normal forward (no false 429)', async () => {
  const t = await setupProxy([acct('a'), acct('b')]);
  try {
    t.am.accounts[0].quota.unified7d = 0.99;
    t.am.accounts[0].quota.unified7dReset = Date.now() + 3_600_000;
    // b is healthy

    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    });
    assert.equal(res.status, 200, 'healthy sibling must still forward');
    assert.ok(t.upstreamHits() >= 1);
    const body = await res.json();
    assert.equal(body.type, 'message');
  } finally {
    await t.close();
  }
});

test('GPT circuit-open retry-after ignores Claude OAuth 5h window (route-excluded)', async () => {
  const fiveHour = Date.now() + 2_801_000;
  const circuitUntil = Date.now() + 4_000;
  const t = await setupProxy(
    [
      acct('codex-gpt56', { upstream: 'http://127.0.0.1:9' }),
      acct('yongbing', { quotaAdmission: 'usage' }),
    ],
    {
      routes: [
        { name: 'gpt', match: ['*gpt*', '*astra*'], accounts: ['codex-gpt56'] },
        { name: 'default', match: ['*'], accounts: ['yongbing'] },
      ],
    },
  );
  try {
    t.am.accounts[0].upstream = `http://127.0.0.1:9`;
    t.am.accounts[0].circuitOpenUntil = circuitUntil;
    t.am.accounts[1].quota.unified5h = 0.99;
    t.am.accounts[1].quota.unified5hReset = fiveHour;

    const snap = t.am.getServeable('gpt-6-astra');
    assert.equal(snap.serveable, false);
    const remaining = Date.parse(snap.soonestResetAt) - Date.now();
    assert.ok(remaining > 0 && remaining < 15_000,
      `soonestResetAt must be the GPT circuit (~4s), not Claude 5h; got ${remaining}ms`);

    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [] }),
    });
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 15,
      `retry-after ${retryAfter}s should be circuit remaining, not ~2801s`);
    const body = await res.json();
    assert.match(body.error.message, /circuit-open/);
    assert.doesNotMatch(body.error.message, /Retry in 28\d\ds/);
  } finally {
    await t.close();
  }
});

test('config-with-no-matching-account (not quota) keeps existing behavior', async () => {
  // Closed adapter that cannot translate the id → not-accepted for every
  // account. That is a config/capability miss, not quota exhaustion: fall
  // through to the pre-T4 null-selection path (still a local 429, but not the
  // admission-gate quota message / soonest-reset retry-after).
  const accounts = [{
    name: 'ds',
    type: 'apikey',
    apiKey: 'k',
    upstream: 'http://127.0.0.1:9',
    acceptsModels: ['deepseek-chat'],
    strictModelMap: true,
    modelMap: { 'claude-sonnet-4-6': 'deepseek-chat' },
  }];
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200); res.end('{}'); });
  });
  const upPort = await listen(upstream);
  // Point the account upstream at the real test server so a mistaken forward
  // would be visible — but selection should refuse without contacting it.
  accounts[0].upstream = `http://127.0.0.1:${upPort}`;
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    accounts,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fugu-ultra', messages: [] }),
    });
    const text = await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 0);
    const body = JSON.parse(text);
    assert.equal(body.type, 'error');
    assert.equal(body.error?.type, 'rate_limit_error');
    // Existing null-selection shape: "All N accounts exhausted. Retry in Xs."
    // — not the admission-gate "quota-exhausted" reason listing.
    assert.match(body.error.message, /All 1 accounts exhausted/);
    assert.doesNotMatch(body.error.message, /not-accepted/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('typed admission 429 parses as Anthropic-style error', async () => {
  const t = await setupProxy([acct('solo')]);
  try {
    t.am.accounts[0].quota.unified7d = 0.99;
    t.am.accounts[0].quota.unified7dReset = Date.now() + 1_800_000;

    const res = await fetch(`http://127.0.0.1:${t.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    // Anthropic error envelope: { type:'error', error:{ type, message } }
    assert.equal(body.type, 'error');
    assert.ok(body.error && typeof body.error === 'object');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
  } finally {
    await t.close();
  }
});
