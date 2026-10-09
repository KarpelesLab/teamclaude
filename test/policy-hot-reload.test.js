import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/config-reload.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

function account(port, extra = {}) {
  return {
    name: 'deepseek', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${port}`,
    priority: 80, modelMap: { old: 'deepseek-v4-flash' }, ...extra,
  };
}

test('reload updates modelMap/upstream/capability/tier in manager AND mem config', async () => {
  const mem = {
    accounts: [account(8000)],
    routes: [{ name: 'default', match: ['*'], accounts: ['deepseek'] }],
    routingPolicy: { mode: 'priority-first' },
  };
  const am = new AccountManager(mem.accounts, 0.98, { routes: mem.routes });
  const disk = {
    accounts: [account(9000, {
      priority: 90,
      costTier: 10,
      modelMap: { new: 'deepseek-v4-pro' },
      acceptsModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      strictModelMap: true,
      supportsAdvisorTools: true,
    })],
    routes: [{ name: 'default', match: ['*'], tiers: [
      { name: 'paid', accounts: ['deepseek'] },
    ] }],
    routingPolicy: { mode: 'shadow', reevaluateMs: 1234 },
  };
  const added = await syncAccountsFromDisk(disk, mem, am);
  assert.equal(added, 0);
  const a = am.accounts[0];
  assert.equal(a.upstream, 'http://127.0.0.1:9000');
  assert.equal(a.priority, 90);
  assert.equal(a.costTier, 10);
  assert.deepEqual(a.modelMap, { new: 'deepseek-v4-pro' });
  assert.deepEqual(a.acceptsModels, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(a.strictModelMap, true);
  assert.equal(a.supportsAdvisorTools, true);
  assert.deepEqual(mem.accounts[0].modelMap, { new: 'deepseek-v4-pro' },
    'later TUI save cannot clobber disk with startup map');

  // The server reload closure owns routes/policy immediately after this helper;
  // exercise the same calls to prove both objects accept the new data live.
  am.setRoutes(disk.routes);
  am.setRoutingPolicy(disk.routingPolicy);
  assert.equal(am.routes[0].tiers[0].name, 'paid');
  assert.equal(am.routingPolicy.mode, 'shadow');
  assert.equal(am.routingPolicy.reevaluateMs, 1234);
});

test('a live request uses a reloaded modelMap without rebuilding AccountManager', async () => {
  let receivedModel = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: receivedModel }));
    });
  });
  const upstreamPort = await listen(upstream);
  const mem = {
    accounts: [account(upstreamPort, { modelMap: { wire: 'deepseek-v4-flash' } })],
    routes: [{ name: 'default', match: ['*'], accounts: ['deepseek'] }],
  };
  const am = new AccountManager(mem.accounts, 0.98, { routes: mem.routes });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    await syncAccountsFromDisk({
      ...mem,
      accounts: [account(upstreamPort, {
        modelMap: { wire: 'deepseek-v4-pro' },
        acceptsModels: ['deepseek-v4-pro'], strictModelMap: true,
      })],
    }, mem, am);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'wire', max_tokens: 16, messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(receivedModel, 'deepseek-v4-pro',
      'this is the exact feature the old Reload silently ignored');
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('reload deletions win: removed modelMap and blockedModels stay gone after a simulated save', async () => {
  const mem = {
    accounts: [account(8000, { modelMap: { keep: 'x', drop: 'y' }, acceptsModels: ['x'] })],
    blockedModels: ['*fable*', '*preview*'],
    routes: [],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  // Disk deletes the whole modelMap, acceptsModels, and blockedModels.
  const disk = {
    accounts: [{
      name: 'deepseek', type: 'apikey', apiKey: 'k',
      upstream: 'http://127.0.0.1:8000', priority: 80,
    }],
    routes: [],
  };
  await syncAccountsFromDisk(disk, mem, am);

  assert.equal(am.accounts[0].modelMap, null, 'manager must drop deleted modelMap');
  assert.equal(am.accounts[0].acceptsModels, null);
  assert.equal('modelMap' in mem.accounts[0], false, 'mem config must not resurrect modelMap');
  assert.equal('acceptsModels' in mem.accounts[0], false);
  assert.equal('blockedModels' in mem, false, 'top-level blockedModels deletion must win');

  // Simulated TUI save: serialize mem back. Deleted keys must stay absent.
  const saved = JSON.parse(JSON.stringify(mem));
  assert.equal('modelMap' in saved.accounts[0], false);
  assert.equal('blockedModels' in saved, false);
});

test('reload deletes a single modelMap entry without resurrecting it on save', async () => {
  const mem = {
    accounts: [account(8000, { modelMap: { a: '1', b: '2' } })],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  await syncAccountsFromDisk({
    accounts: [account(8000, { modelMap: { a: '1' } })],
  }, mem, am);
  assert.deepEqual(am.accounts[0].modelMap, { a: '1' });
  assert.deepEqual(mem.accounts[0].modelMap, { a: '1' });
  assert.equal('b' in mem.accounts[0].modelMap, false);
});
