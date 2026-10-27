import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { normalizeUsagePayload } from '../src/oauth.js';
import { normalizeCodexUsagePayload } from '../src/codex-usage.js';

// The CLIProxyAPI-compatible usage API answers a dashboard's management calls
// from the quota already tracked. What matters is what it will NOT do: relay a
// request upstream, hand out a credential, or answer a URL it was not built
// for — and that it sits behind the same key gates as everything else.

const CLAUDE_TOKEN = 'sk-ant-oat01-claude-secret';
const CODEX_TOKEN = 'codex-access-secret';
const PROXY_KEY = 'tc-proxy-secret';
const CLIENT_KEY = 'tc-client-secret';
const KEYED = { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] };

const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';

const accounts = () => [
  { id: 'id-claude', name: 'alice@example.com (Acme)', type: 'oauth', accessToken: CLAUDE_TOKEN },
  { id: 'id-codex', name: 'bob@example.com', type: 'oauth', provider: 'codex', accessToken: CODEX_TOKEN, accountId: 'chatgpt-account', disabled: true },
  { id: 'id-apikey', name: 'api-fallback', type: 'apikey', apiKey: 'sk-ant-api03-secret' },
  { id: 'id-backend', name: 'relay', type: 'oauth', accessToken: 'relay-secret', upstream: 'https://relay.example' },
];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * A proxy over a counting upstream: every test asserts nothing reached it.
 * @param {Record<string, any>} proxy
 * @param {(ctx: { port: number, am: any, upstreamHits: () => number }) => Promise<void>} fn
 */
async function withServer(proxy, fn) {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"upstream":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98);
  const server = createProxyServer(am, { proxy, upstream: `http://127.0.0.1:${upstreamPort}`, accounts: accounts() });
  const port = await listen(server);
  try {
    await fn({ port, am, upstreamHits: () => hits });
  } finally {
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

const bearer = (key = PROXY_KEY) => ({ Authorization: `Bearer ${key}` });

function authFiles(port, headers = bearer()) {
  return fetch(`http://127.0.0.1:${port}/v0/management/auth-files`, { headers });
}

function apiCall(port, body, headers = bearer()) {
  return fetch(`http://127.0.0.1:${port}/v0/management/api-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('the API answers 404 itself until proxy.cliproxyApi turns it on, and never forwards', async () => {
  for (const cliproxyApi of [undefined, 'off', true, 'full', 'READ']) {
    await withServer({ ...KEYED, cliproxyApi }, async ({ port, upstreamHits }) => {
      for (const res of [await authFiles(port), await apiCall(port, { auth_index: 'id-claude', method: 'GET', url: CLAUDE_USAGE })]) {
        assert.equal(res.status, 404, `proxy.cliproxyApi = ${JSON.stringify(cliproxyApi)}`);
        assert.match((await res.json()).error, /proxy\.cliproxyApi/);
      }
      assert.equal(upstreamHits(), 0);
    });
  }
});

test('the management key is checked against the proxy keys, and only on this API', async () => {
  // trustLoopback off, so the test's own loopback connection is not exempt.
  await withServer({ ...KEYED, trustLoopback: false, cliproxyApi: 'read' }, async ({ port, upstreamHits }) => {
    assert.equal((await authFiles(port, {})).status, 401, 'no key');
    assert.equal((await authFiles(port, bearer('tc-wrong'))).status, 401, 'wrong key');
    assert.equal((await apiCall(port, { auth_index: 'id-claude', method: 'GET', url: CLAUDE_USAGE }, bearer('tc-wrong'))).status, 401, 'wrong key on api-call');

    assert.equal((await authFiles(port)).status, 200, 'shared key as a bearer');
    assert.equal((await authFiles(port, bearer(CLIENT_KEY))).status, 200, 'client key as a bearer');
    assert.equal((await authFiles(port, { 'X-Management-Key': PROXY_KEY })).status, 200, 'X-Management-Key');
    assert.equal((await authFiles(port, { 'x-api-key': PROXY_KEY })).status, 200, 'x-api-key');

    // Elsewhere a bearer is the client's provider credential, not a proxy key.
    const status = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: bearer() });
    assert.equal(status.status, 401);
    assert.equal(upstreamHits(), 0);
  });
});

test('with no proxy key configured only this machine is served', async () => {
  await withServer({ cliproxyApi: 'read' }, async ({ port }) => {
    assert.equal((await authFiles(port, bearer('anything'))).status, 200);
    const forwarded = await authFiles(port, { ...bearer('anything'), 'X-Forwarded-For': '203.0.113.7' });
    assert.equal(forwarded.status, 403);
    assert.match((await forwarded.json()).error, /CLIProxyAPI-compatible usage API serves only this machine/);
  });
  await withServer({ trustLoopback: false, cliproxyApi: 'read' }, async ({ port }) => {
    assert.equal((await authFiles(port, bearer('anything'))).status, 403);
  });
});

test('auth-files lists the subscription accounts without a credential or account id', async () => {
  await withServer({ ...KEYED, cliproxyApi: 'read' }, async ({ port, am }) => {
    am.accounts[1].quota.planType = 'pro';
    const res = await authFiles(port);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const secret of [CLAUDE_TOKEN, CODEX_TOKEN, 'chatgpt-account', 'relay-secret', 'sk-ant-api03-secret']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.deepEqual(JSON.parse(text), {
      files: [
        {
          id: 'id-claude', auth_index: 'id-claude', name: 'alice@example.com (Acme)', type: 'claude', provider: 'claude',
          label: 'alice@example.com (Acme)', email: 'alice@example.com', status: 'active', disabled: false,
        },
        {
          id: 'id-codex', auth_index: 'id-codex', name: 'bob@example.com', type: 'codex', provider: 'codex',
          label: 'bob@example.com', email: 'bob@example.com', status: 'disabled', disabled: true,
          id_token: { plan_type: 'pro' },
        },
      ],
    });
  });
});

test('a Claude usage call is answered in the endpoint\'s own shape, from the tracked quota', async () => {
  await withServer({ ...KEYED, cliproxyApi: 'read' }, async ({ port, am, upstreamHits }) => {
    const fiveHourReset = Date.now() + 3600_000;
    const weekReset = Date.now() + 3 * 24 * 3600_000;
    Object.assign(am.accounts[0].quota, {
      unified5h: 0.44, unified5hReset: fiveHourReset,
      unified7d: 0.18, unified7dReset: weekReset,
      // Fable from the probe's enumeration, Sonnet only from response headers.
      scopedWeekly: { fable: { utilization: 0.95, resetAt: weekReset } },
      unified7dSonnet: 0.3, unified7dSonnetReset: weekReset,
    });

    const res = await apiCall(port, {
      auth_index: 'id-claude', method: 'GET', url: `${CLAUDE_USAGE}?cedar_ember=1`,
      header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' },
    });
    assert.equal(res.status, 200);
    const envelope = await res.json();
    assert.equal(envelope.status_code, 200);
    assert.equal(typeof envelope.body, 'string');
    assert.ok(!envelope.body.includes(CLAUDE_TOKEN));
    const usage = JSON.parse(envelope.body);
    assert.deepEqual(usage.five_hour, { utilization: 44, resets_at: new Date(fiveHourReset).toISOString() });
    assert.deepEqual(usage.seven_day, { utilization: 18, resets_at: new Date(weekReset).toISOString() });
    assert.deepEqual(usage.limits.map(l => [l.kind, l.scope.model.display_name, l.percent]), [
      ['weekly_scoped', 'Fable', 95],
      ['weekly_scoped', 'Sonnet', 30],
    ]);

    // The real test of the shape: TeamClaude's own parser for that endpoint
    // reads the reply back into the quota it was built from.
    const parsed = normalizeUsagePayload(usage);
    assert.deepEqual(parsed.fiveHour, { utilization: 0.44, resetAt: fiveHourReset });
    assert.deepEqual(parsed.sevenDay, { utilization: 0.18, resetAt: weekReset });
    assert.deepEqual(parsed.scopedWeekly.fable, { utilization: 0.95, resetAt: weekReset });
    assert.deepEqual(parsed.sevenDaySonnet, { utilization: 0.3, resetAt: weekReset });
    assert.equal(upstreamHits(), 0);
  });
});

test('a Codex usage call is answered in /wham/usage shape, from the tracked quota', async () => {
  await withServer({ ...KEYED, cliproxyApi: 'read' }, async ({ port, am }) => {
    // Whole seconds: the endpoint states reset_at in epoch seconds.
    const fiveHourReset = (Math.floor(Date.now() / 1000) + 3600) * 1000;
    const weekReset = (Math.floor(Date.now() / 1000) + 3 * 24 * 3600) * 1000;
    Object.assign(am.accounts[1].quota, {
      unified5h: 0.25, unified5hReset: fiveHourReset,
      unified7d: 0.6, unified7dReset: weekReset,
      planType: 'plus',
    });

    const res = await apiCall(port, { auth_index: 'id-codex', method: 'GET', url: CODEX_USAGE });
    assert.equal(res.status, 200);
    const usage = JSON.parse((await res.json()).body);
    assert.deepEqual(usage, {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: fiveHourReset / 1000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 60, reset_at: weekReset / 1000, limit_window_seconds: 604_800 },
      },
    });
    const parsed = normalizeCodexUsagePayload(usage);
    assert.equal(parsed.fiveHour.utilization, 0.25);
    assert.equal(parsed.fiveHour.resetAt, fiveHourReset);
    assert.equal(parsed.sevenDay.utilization, 0.6);
    assert.equal(parsed.sevenDay.resetAt, weekReset);
  });
});

test('a window whose reset has passed is not reported, and an unread account answers null', async () => {
  await withServer({ ...KEYED, cliproxyApi: 'read' }, async ({ port, am }) => {
    Object.assign(am.accounts[0].quota, { unified5h: 0.9, unified5hReset: Date.now() - 1000 });
    const usage = JSON.parse((await (await apiCall(port, { auth_index: 'id-claude', method: 'GET', url: CLAUDE_USAGE })).json()).body);
    assert.equal(usage.five_hour, null);
    assert.equal(usage.seven_day, null);
    assert.deepEqual(usage.limits, []);

    const codex = JSON.parse((await (await apiCall(port, { auth_index: 'id-codex', method: 'GET', url: CODEX_USAGE })).json()).body);
    assert.deepEqual(codex.rate_limit, { primary_window: null, secondary_window: null });
  });
});

test('api-call answers only the usage URLs, and relays nothing', async () => {
  await withServer({ ...KEYED, cliproxyApi: 'read' }, async ({ port, upstreamHits }) => {
    const refused = [
      // Anything else, however close: the point of the route is that a caller
      // cannot name a destination for an account's credential.
      [{ auth_index: 'id-claude', method: 'GET', url: 'https://api.anthropic.com/v1/messages' }, 403],
      [{ auth_index: 'id-claude', method: 'GET', url: 'https://attacker.example/api/oauth/usage' }, 403],
      [{ auth_index: 'id-claude', method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage/../profile' }, 403],
      [{ auth_index: 'id-claude', method: 'POST', url: CLAUDE_USAGE, data: '{}' }, 403],
      [{ auth_index: 'id-claude', method: 'GET', url: 'http://api.anthropic.com/api/oauth/usage' }, 400],
      [{ auth_index: 'id-claude', method: 'GET', url: 'https://user:pw@api.anthropic.com/api/oauth/usage' }, 400],
      // A usage URL of the other provider.
      [{ auth_index: 'id-codex', method: 'GET', url: CLAUDE_USAGE }, 403],
      [{ auth_index: 'id-claude', method: 'GET', url: CODEX_USAGE }, 403],
      // Accounts this API does not list.
      [{ auth_index: 'id-apikey', method: 'GET', url: CLAUDE_USAGE }, 404],
      [{ auth_index: 'id-backend', method: 'GET', url: CLAUDE_USAGE }, 404],
      [{ auth_index: 'nope', method: 'GET', url: CLAUDE_USAGE }, 404],
      [{ method: 'GET', url: CLAUDE_USAGE }, 404],
      // Reset credits: listing and spending them are not offered.
      [{ auth_index: 'id-codex', method: 'GET', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits' }, 501],
      [{ auth_index: 'id-codex', method: 'POST', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume', data: '{"credit_id":"c1"}' }, 501],
      [{ auth_index: 'id-claude', url: CLAUDE_USAGE }, 400],
    ];
    for (const [body, status] of refused) {
      const res = await apiCall(port, body);
      assert.equal(res.status, status, JSON.stringify(body));
      const reply = await res.json();
      assert.equal(typeof reply.error, 'string', JSON.stringify(body));
      assert.equal(reply.status_code, undefined, JSON.stringify(body));
    }

    const malformed = await fetch(`http://127.0.0.1:${port}/v0/management/api-call`, { method: 'POST', headers: bearer(), body: '{not json' });
    assert.equal(malformed.status, 400);

    const reset = await fetch(`http://127.0.0.1:${port}/v0/management/reset-quota`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer() }, body: JSON.stringify({ auth_index: 'id-codex' }),
    });
    assert.equal(reset.status, 501);

    for (const path of ['/v0/management/config', '/v0/management', '/v0/management/auth-files/../config']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: bearer() });
      assert.equal(res.status, 404, path);
    }
    // The wrong verb on a served route is ours too, never the forwarder's.
    assert.equal((await fetch(`http://127.0.0.1:${port}/v0/management/auth-files`, { method: 'POST', headers: bearer() })).status, 404);
    assert.equal(upstreamHits(), 0);
  });
});
