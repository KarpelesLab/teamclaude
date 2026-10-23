// D4: hot-reload contract — operator intent over ranking inputs must apply
// without restart (tokenBudget, routingPolicy preserve-current, account prune,
// systemd health state dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk, applyTopLevelReload } from '../src/config-reload.js';
import { createProxyServer, resolveAccountPin } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

// ── (a) tokenBudget reload-updatable ───────────────────────────────────────

test('D4a: reload with tighter tokenBudget governs admission; window not cleared', async () => {
  const mem = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 10_000 },
    })],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  // Ephemeral window already has spend under the old budget.
  am.accounts[0].tokenWindow.push({ ts: Date.now(), tokens: 500 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), false);

  const disk = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 400 },
    })],
  };
  await syncAccountsFromDisk(disk, mem, am);

  assert.deepEqual(am.accounts[0].tokenBudget, { windowSec: 3600, maxTokens: 400 },
    'reload must update tokenBudget config without restart');
  assert.equal(am.accounts[0].tokenWindow.length, 1, 'window counters stay ephemeral in-memory');
  assert.equal(am.accounts[0].tokenWindow[0].tokens, 500, 'reload must NOT persist/reset window');
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true,
    'new budget must govern admission against existing window sum');
  assert.equal(am._isAvailable(am.accounts[0], 'm'), false);
  assert.equal(am.getServeable('m').accounts[0].reason, 'token-budget');

  // exportQuotaState still omits the ephemeral window (R2 discipline).
  const exported = am.exportQuotaState();
  assert.equal(exported[0].tokenWindow, undefined);
  assert.equal(exported[0].tokenBudget, undefined);
});

test('D4a: reload removing tokenBudget restores zero-config-inert', async () => {
  const mem = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 100 },
    })],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  am.accounts[0].tokenWindow.push({ ts: Date.now(), tokens: 100 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true);

  await syncAccountsFromDisk({ accounts: [apikey('budgeted')] }, mem, am);
  assert.equal(am.accounts[0].tokenBudget, null);
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), false,
    'absent budget is inert even if a stale window array remains');
  assert.equal(am._isAvailable(am.accounts[0], 'm'), true);
});

// ── (b) routingPolicy preserve-current on reload ───────────────────────────

test('D4b: routingPolicy ABSENT on reload preserves running mode/affinity/reevaluateMs', () => {
  const mem = {
    accounts: [apikey('a')],
    routes: [{ name: 'all', match: ['*'], accounts: ['a'] }],
    routingPolicy: {
      mode: 'dynamic',
      preserveSessionAffinity: false,
      reevaluateMs: 12_345,
    },
    rotationGate: { mode: 'shadow' },
  };
  const am = new AccountManager(mem.accounts, 0.98, {
    routes: mem.routes,
    routingPolicy: mem.routingPolicy,
    rotationGate: mem.rotationGate,
  });
  const before = JSON.parse(JSON.stringify(am.routingPolicy));
  const beforeGate = JSON.parse(JSON.stringify(am.rotationGate));
  const beforeRoutes = JSON.parse(JSON.stringify(am.getRoutes()));

  // Disk omits routingPolicy / rotationGate / routes entirely (partial reload).
  applyTopLevelReload({ accounts: [apikey('a')] }, mem, am);

  assert.deepEqual(am.routingPolicy, before, 'byte-identical running policy');
  assert.deepEqual(mem.routingPolicy, before);
  assert.deepEqual(am.rotationGate, beforeGate, 'co-located rotationGate also preserve-current');
  assert.deepEqual(am.getRoutes(), beforeRoutes, 'co-located routes also preserve-current');
});

test('D4b: routingPolicy PRESENT with different mode applies; absent sibling keys preserved', () => {
  const mem = {
    accounts: [apikey('a')],
    routingPolicy: {
      mode: 'dynamic',
      preserveSessionAffinity: false,
      reevaluateMs: 12_345,
    },
  };
  const am = new AccountManager(mem.accounts, 0.98, { routingPolicy: mem.routingPolicy });

  applyTopLevelReload({
    accounts: [apikey('a')],
    routingPolicy: { mode: 'shadow' }, // explicit mode; affinity/reevaluateMs omitted
  }, mem, am);

  assert.equal(am.routingPolicy.mode, 'shadow', 'explicit present mode is operator intent');
  assert.equal(am.routingPolicy.preserveSessionAffinity, false, 'absent key preserves running');
  assert.equal(am.routingPolicy.reevaluateMs, 12_345, 'absent key preserves running');
});

test('D4b: distributeSessions PRESENT applies; ABSENT preserves running', () => {
  const mem = {
    accounts: [apikey('a')],
    distributeSessions: false,
  };
  const am = new AccountManager(mem.accounts, 0.98, { distributeSessions: false });
  assert.equal(am.distributeSessions, false);

  applyTopLevelReload({ accounts: [apikey('a')] }, mem, am);
  assert.equal(am.distributeSessions, false, 'absent key preserves running');
  assert.equal(mem.distributeSessions, false);

  applyTopLevelReload({ accounts: [apikey('a')], distributeSessions: true }, mem, am);
  assert.equal(am.distributeSessions, true, 'explicit true is operator intent');
  assert.equal(mem.distributeSessions, true);

  applyTopLevelReload({ accounts: [apikey('a')], distributeSessions: false }, mem, am);
  assert.equal(am.distributeSessions, false, 'explicit false is operator intent');
  assert.equal(mem.distributeSessions, false);
});

// ── (c) syncAccountsFromDisk prunes removed accounts ───────────────────────

test('D4c: removed account leaves rotation; pin refuses; sibling indices stable', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;

  const mem = {
    accounts: [
      apikey('keep', { upstream: url, priority: 0 }),
      apikey('drop', { upstream: url, priority: 1 }),
      apikey('tail', { upstream: url, priority: 2 }),
    ],
    routes: [{ name: 'all', match: ['*'], accounts: ['keep', 'drop', 'tail'] }],
  };
  const am = new AccountManager(mem.accounts, 0.98, { routes: mem.routes });
  assert.equal(am.accounts[2].name, 'tail');
  assert.equal(am.accounts[2].index, 2);

  const disk = {
    accounts: [
      apikey('keep', { upstream: url, priority: 0 }),
      apikey('tail', { upstream: url, priority: 2 }),
    ],
    routes: [{ name: 'all', match: ['*'], accounts: ['keep', 'tail'] }],
  };
  await syncAccountsFromDisk(disk, mem, am);
  applyTopLevelReload(disk, mem, am);

  const drop = am.accounts.find(a => a.name === 'drop');
  assert.ok(drop, 'tombstone keeps the slot for index stability');
  assert.equal(drop.retired, true);
  assert.equal(drop.index, 1, 'retired account keeps its process-lifetime index');
  assert.equal(am.accounts[2].name, 'tail');
  assert.equal(am.accounts[2].index, 2, 'tail must NOT slide into drop\'s index');
  assert.equal(am._isAvailable(drop, 'm'), false, 'retired not serveable');
  assert.equal(mem.accounts.some(a => a.name === 'drop'), false,
    'mem config must not resurrect the removed account on save');

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const pinRes = await fetch(`http://127.0.0.1:${port}/tc-acct/drop/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const pinBody = await pinRes.text();
    assert.equal(pinRes.status, 404, pinBody);
    assert.match(pinBody, /removed from config|retired|Unknown account pin/i);
    assert.equal(upstreamHits, 0, 'pin must not silently serve on a retired account');

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.ok(upstreamHits >= 1);
    const active = am.getActiveAccount(new Set(), 'm');
    assert.ok(active && active.name !== 'drop');
    assert.equal(am.accounts[2].name, 'tail');
    assert.equal(am.accounts[2].index, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('D4c: in-flight request on an account finishes after that account is retired', async () => {
  let releaseUpstream;
  const upstreamGate = new Promise(r => { releaseUpstream = r; });
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      await upstreamGate;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'message', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;

  const mem = {
    accounts: [
      apikey('inflight', { upstream: url, priority: 0 }),
      apikey('other', { upstream: url, priority: 1 }),
    ],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const pending = fetch(`http://127.0.0.1:${port}/tc-acct/inflight/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    for (let i = 0; i < 50 && upstreamHits === 0; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(upstreamHits, 1, 'request must be in-flight before retire');

    await syncAccountsFromDisk({
      accounts: [apikey('other', { upstream: url, priority: 1 })],
    }, mem, am);

    assert.equal(am.accounts[0].retired, true);
    releaseUpstream();
    const res = await pending;
    assert.equal(res.status, 200, 'in-flight must finish; no mid-request rug-pull');
    await res.text();
  } finally {
    releaseUpstream?.();
    await close(proxy);
    await close(upstream);
  }
});

test('D4c: resolveAccountPin skips retired accounts', () => {
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98);
  am.retireAccount(0);
  assert.equal(resolveAccountPin(am, 'a'), null);
  assert.equal(resolveAccountPin(am, 'b'), 1);
});

// ── (d) systemd health-service state dir ───────────────────────────────────

test('D4d: health unit declares StateDirectory for failure counter', () => {
  const unit = readFileSync(join(ROOT, 'systemd/teamclaude-health.service.in'), 'utf8');
  assert.match(unit, /^\s*StateDirectory\s*=\s*\S+/m,
    'packaged installs need StateDirectory= so the state dir exists on a fresh system');
  assert.match(unit, /STATE_DIRECTORY|%S\//,
    'failure counter must live under the managed state directory');
});

// ── (D4e-1) health probe port follows the rendered unit, not 3456 ──────────

test('D4e: health unit probes Environment=TEAMCLAUDE_PORT, not hardcoded 3456', () => {
  const unit = readFileSync(join(ROOT, 'systemd/teamclaude-health.service.in'), 'utf8');
  assert.match(unit, /^\s*Environment\s*=\s*TEAMCLAUDE_PORT=__TEAMCLAUDE_PORT__\s*$/m,
    'port must be an Environment= template var, same install-time substitution as __TEAMCLAUDE_BIN__');
  assert.match(unit, /\$\{TEAMCLAUDE_PORT\}/,
    'ExecStart must expand the env var, not embed a literal port');
  assert.doesNotMatch(unit, /127\.0\.0\.1:3456/,
    'default 3456 must not be hardcoded in the probe URL');

  // Install-time render: a non-default port must land on the actionable lines.
  // (Comments may still mention 3456 as the documented default — that is fine.)
  const rendered = unit.replaceAll('__TEAMCLAUDE_PORT__', '9999');
  const envLine = rendered.split('\n').find(l => /^\s*Environment\s*=/.test(l)) || '';
  const execLine = rendered.split('\n').find(l => /^\s*ExecStart\s*=/.test(l)) || '';
  assert.equal(envLine.trim(), 'Environment=TEAMCLAUDE_PORT=9999');
  assert.match(execLine, /\$\{TEAMCLAUDE_PORT\}/);
  assert.doesNotMatch(envLine, /3456|__TEAMCLAUDE_PORT__/);
  assert.doesNotMatch(execLine, /3456|__TEAMCLAUDE_PORT__/);
});
