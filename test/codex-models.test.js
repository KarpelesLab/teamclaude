import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  isCodexNativeModel,
  codexModelToAnthropic,
  fetchCodexModels,
  clearCodexModelCache,
  cloakModelId,
  uncloakModelId,
} from '../src/codex/models.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Captured from the live catalog endpoint.
const CATALOG_ENTRY = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  context_window: 272000,
  default_reasoning_level: 'low',
  supported_reasoning_levels: [
    { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
    { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
  ],
};

function codexAcct(extra = {}) {
  return {
    name: 'cx', type: 'oauth', protocol: 'codex', accountId: 'acct-1',
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra,
  };
}
const anthropicAcct = (extra = {}) => ({
  name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, ...extra,
});

// ── native model detection ──────────────────────────────────

test('codex-native model names are recognised', () => {
  for (const id of ['gpt-5.6-sol', 'gpt-5.4-mini', 'GPT-5.5', 'codex-auto-review', 'o3-mini']) {
    assert.equal(isCodexNativeModel(id), true, id);
  }
});

test('Claude model names are not treated as codex-native', () => {
  for (const id of ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5[1m]']) {
    assert.equal(isCodexNativeModel(id), false, id);
  }
});

test('isCodexNativeModel is safe on non-strings', () => {
  assert.equal(isCodexNativeModel(null), false);
  assert.equal(isCodexNativeModel(undefined), false);
  assert.equal(isCodexNativeModel(42), false);
});

// ── catalog translation ─────────────────────────────────────

test('a catalog entry becomes an Anthropic model entry', () => {
  const m = codexModelToAnthropic(CATALOG_ENTRY, '2026-08-02T00:00:00Z');
  assert.equal(m.type, 'model');
  assert.equal(m.id, 'gpt-5.6-sol');
  assert.equal(m.display_name, 'GPT-5.6-Sol');
  assert.equal(m.max_input_tokens, 272000);
  assert.equal(m._codex, true);
});

test('reported reasoning levels become effort capabilities', () => {
  const caps = codexModelToAnthropic(CATALOG_ENTRY, 'x').capabilities;
  assert.equal(caps.effort.supported, true);
  assert.equal(caps.effort.max.supported, true);
  // The catalog advertises `ultra`, which the API rejects — but this listing
  // reports what the catalog says; the request path is what clamps it.
  assert.equal(caps.effort.ultra.supported, true);
});

test('thinking is advertised as unsupported', () => {
  // Codex reasons internally but is never asked for summaries, so no thinking
  // blocks come back. Claiming support would be a lie the client acts on.
  assert.equal(codexModelToAnthropic(CATALOG_ENTRY, 'x').capabilities.thinking.supported, false);
});

test('an entry with no id is dropped rather than emitted half-formed', () => {
  assert.equal(codexModelToAnthropic({ display_name: 'Nameless' }, 'x'), null);
});

// ── catalog fetch ───────────────────────────────────────────

test('fetchCodexModels returns translated entries and caches them', async () => {
  clearCodexModelCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ models: [CATALOG_ENTRY] }) };
  };
  const acct = { ...codexAcct(), credential: 't' };

  const first = await fetchCodexModels(acct, { fetchImpl });
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'gpt-5.6-sol');

  await fetchCodexModels(acct, { fetchImpl });
  assert.equal(calls, 1, 'second call within the TTL must be served from cache');
});

test('the catalog request carries the required client_version', async () => {
  clearCodexModelCache();
  let url = '';
  const fetchImpl = async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ models: [] }) };
  };
  await fetchCodexModels({ ...codexAcct(), credential: 't' }, { fetchImpl });
  // The endpoint 400s without it.
  assert.match(url, /[?&]client_version=/);
});

test('a failed fetch yields an empty list rather than throwing', async () => {
  // This feeds a model listing; losing the Claude models because a ChatGPT
  // token expired would be worse than returning no GPT models.
  clearCodexModelCache();
  const acct = { ...codexAcct(), credential: 't' };
  assert.deepEqual(await fetchCodexModels(acct, { fetchImpl: async () => { throw new Error('down'); } }), []);
  clearCodexModelCache();
  assert.deepEqual(await fetchCodexModels(acct, {
    fetchImpl: async () => ({ ok: false, status: 401, body: null }),
  }), []);
});

test('a stale cache is preferred over an empty list when a refresh fails', async () => {
  clearCodexModelCache();
  const acct = { ...codexAcct(), credential: 't' };
  await fetchCodexModels(acct, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [CATALOG_ENTRY] }) }),
  });
  const stale = await fetchCodexModels(acct, {
    now: Date.now() + 10 * 3600_000, // past the TTL
    fetchImpl: async () => { throw new Error('down'); },
  });
  assert.equal(stale.length, 1);
});

// ── protocol-aware routing ──────────────────────────────────

test('a GPT model selects the codex account, not the Claude one', () => {
  const am = new AccountManager([anthropicAcct(), codexAcct()], 0.98);
  assert.equal(am._isAvailable(am.accounts[0], 'gpt-5.6-sol'), false);
  assert.equal(am._isAvailable(am.accounts[1], 'gpt-5.6-sol'), true);
  assert.equal(am.getActiveAccount(null, 'gpt-5.6-sol').name, 'cx');
});

test('a Claude model never selects a codex account without a modelMap', () => {
  // Otherwise the request reaches Codex under a name it rejects — the 400 loop
  // this replaced.
  const am = new AccountManager([anthropicAcct(), codexAcct()], 0.98);
  assert.equal(am._isAvailable(am.accounts[1], 'claude-opus-5'), false);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'claude');
});

test('a modelMap re-opens a codex account to the models it maps', () => {
  const am = new AccountManager([
    anthropicAcct(),
    codexAcct({ modelMap: { 'claude-opus-5': 'gpt-5.6-sol' } }),
  ], 0.98);
  assert.equal(am._isAvailable(am.accounts[1], 'claude-opus-5'), true);
  assert.equal(am._isAvailable(am.accounts[1], 'claude-sonnet-5'), false);
});

test('a request naming no model stays eligible everywhere', () => {
  const am = new AccountManager([anthropicAcct(), codexAcct()], 0.98);
  assert.equal(am._isAvailable(am.accounts[0], null), true);
  assert.equal(am._isAvailable(am.accounts[1], null), true);
});

// ── /v1/models endpoint ─────────────────────────────────────

async function startUpstream(models) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: models, has_more: false }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function getModels(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/v1/models`,
      { method: 'GET', headers: { 'anthropic-version': '2023-06-01' } }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
    req.on('error', reject);
    req.end();
  });
}

async function startProxyWithCatalog(config = {}) {
  clearCodexModelCache();
  const upstream = await startUpstream([{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' }]);
  const am = new AccountManager([
    anthropicAcct({ upstream: upstream.url }),
    codexAcct({ upstream: upstream.url }),
  ], 0.98);
  // Stand in for the codex catalog fetch, which would otherwise hit the network.
  await fetchCodexModels(am.accounts[1], {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [CATALOG_ENTRY] }) }),
  });
  const proxy = createProxyServer(am, { proxy: { port: 0 }, upstream: upstream.url, ...config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return { proxy, upstream, am };
}

test('/v1/models lists codex models only by default', async () => {
  // Claude Code merges a gateway listing with its own built-in Claude models,
  // so echoing Anthropic's catalog back just duplicates every Claude entry in
  // the picker. The listing carries what teamclaude ADDS.
  const { proxy, upstream } = await startProxyWithCatalog();
  try {
    const { status, body } = await getModels(proxy.address().port);
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.ok(!body.data.some(m => m.id.includes('opus')), 'Claude models must not be echoed back');
  } finally {
    proxy.close();
    upstream.server.close();
  }
});

test('/v1/models includes the Claude catalog when asked to', async () => {
  const { proxy, upstream } = await startProxyWithCatalog({ modelDiscovery: { includeAnthropic: true } });
  try {
    const { body } = await getModels(proxy.address().port);
    assert.ok(body.data.some(m => m.id === 'claude-opus-5'));
    assert.equal(body.data.length, 2);
  } finally {
    proxy.close();
    upstream.server.close();
  }
});

test('/v1/models cloaks codex ids so the picker accepts them', async () => {
  // Claude Code drops any listed model whose id is not claude-prefixed.
  const { proxy, upstream } = await startProxyWithCatalog();
  try {
    const { body } = await getModels(proxy.address().port);
    const entry = body.data[0];
    assert.ok(entry.id.startsWith('claude-'), `id must be claude-prefixed, got ${entry.id}`);
    assert.equal(uncloakModelId(entry.id), 'gpt-5.6-sol');
    // The human-readable name is untouched, so the picker still reads "GPT-5.6-Sol".
    assert.equal(entry.display_name, 'GPT-5.6-Sol');
  } finally {
    proxy.close();
    upstream.server.close();
  }
});

test('/v1/models is left alone when no codex account is configured', async () => {
  const upstream = await startUpstream([{ type: 'model', id: 'claude-opus-5' }]);
  const am = new AccountManager([anthropicAcct({ upstream: upstream.url })], 0.98);
  const proxy = createProxyServer(am, { proxy: { port: 0 }, upstream: upstream.url });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const { body } = await getModels(proxy.address().port);
    // Forwarded, not synthesised — no _codex marker anywhere.
    assert.deepEqual(body.data.map(m => m.id), ['claude-opus-5']);
    assert.ok(!body.data.some(m => m._codex));
  } finally {
    proxy.close();
    upstream.server.close();
  }
});

// ── id cloaking ─────────────────────────────────────────────
//
// Claude Code drops any model from a gateway listing whose id does not start
// with `claude-`, so a GPT id offered as-is never reaches its picker. The
// encoding mirrors CLIProxyAPI's byte-for-byte (EnsureClaudeModelIDPrefix), so
// a setup written against one proxy behaves the same against the other.

test('a codex id is encoded into a claude-prefixed one', () => {
  const cloaked = cloakModelId('gpt-5.6-sol');
  assert.ok(cloaked.startsWith('claude-'));
  assert.equal(cloaked, 'claude-fable-5-dd-' + [...'gpt-5.6-sol'].reverse().join(''));
});

test('a Claude id is left alone', () => {
  assert.equal(cloakModelId('claude-opus-5'), 'claude-opus-5');
  assert.equal(uncloakModelId('claude-opus-5'), 'claude-opus-5');
});

test('cloaking round-trips every model the live catalog exposes', () => {
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
                    'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex-auto-review']) {
    assert.equal(uncloakModelId(cloakModelId(id)), id, id);
  }
});

test('an id that was never cloaked passes through untouched', () => {
  // Selecting a GPT model with --model sends the real name; it must not be
  // mangled on the way in.
  assert.equal(uncloakModelId('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(uncloakModelId(''), '');
  assert.equal(uncloakModelId(null), null);
});

test('a thinking suffix survives decoding', () => {
  // The suffix is not part of the encoded id, so it is split off and restored.
  assert.equal(uncloakModelId(cloakModelId('gpt-5.6-sol') + '(high)'), 'gpt-5.6-sol(high)');
});

test('a bare prefix with no payload is not treated as cloaked', () => {
  assert.equal(uncloakModelId('claude-fable-5-dd-'), 'claude-fable-5-dd-');
});
