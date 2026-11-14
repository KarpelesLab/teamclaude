import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { createDefaultConfig } from '../src/config.js';

// Real startup/shutdown, explicit synthetic configuration and native-agent homes.
const envFor = dir => ({ HOME: dir, XDG_CONFIG_HOME: dir, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, PI_CODING_AGENT_DIR: undefined, OMP_CONFIG_DIR: undefined, TEAMROUTER_CONFIG: join(dir, 'config.json'), TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' });
const accounts = ['a', 'b', 'c'].map(id => ({ id, name: id, type: 'apikey', apiKey: `synthetic-${id}` }));
const statePath = dir => join(dir, 'config.state.json');
const seeded = () => {
  const now = Date.now();
  return { quota: {}, affinity: { version: 1, sessions: [{ key: 'seed', sessionId: null, conversation: null, lastSeen: now, pins: [{ bucket: 'unified7d', account: { id: 'b', provider: 'anthropic' }, at: now - 1 }], threads: [] }] } };
};

async function post(port, opening, path = '/v1/messages', thread = null) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json', 'x-claude-code-session-id': 'client' },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: opening }], max_tokens: 1, ...(thread ? { thread } : {}) }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('opt-in real restart retains placement; operator and launch pins still win', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-affinity-'));
  let hold = null, arrived = null;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      arrived?.();
      if (hold) await hold;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_synthetic', type: 'message', role: 'assistant', content: [], key: req.headers['x-api-key'] }));
    });
  });
  let srv;
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const config = { proxy: { apiKey: 'test-key', drainTimeoutSeconds: 30 }, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false, messageThreads: true, persistSessionAffinity: true, distributeSessions: true, quotaProbeSeconds: 0, accounts };
    const start = () => spawnServer({ dir, env: envFor(dir), config: () => config });
    srv = await start();
    assert.equal((await post(srv.port, 'beta')).key, 'synthetic-a');
    assert.equal((await post(srv.port, 'alpha')).key, 'synthetic-b');
    await srv.stop();
    const saved = JSON.parse(await readFile(statePath(dir), 'utf8'));
    assert.equal(saved.affinity.sessions.length, 2);
    config.accounts = [accounts[0], accounts[2], accounts[1]];
    srv = await start();
    assert.equal((await post(srv.port, 'alpha')).key, 'synthetic-b');
    const pin = await fetch(`http://127.0.0.1:${srv.port}/teamclaude/session-pin`, { method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'client', account: 'a' }) });
    assert.equal(pin.status, 200);
    await pin.arrayBuffer();
    assert.equal((await post(srv.port, 'alpha')).key, 'synthetic-a');
    assert.equal((await post(srv.port, 'alpha', '/tc-acct/c/v1/messages')).key, 'synthetic-c');
    // Reload cannot toggle the startup-only opt-in. The late thread reply is
    // learned after shutdown's first save, so only the post-drain save has it.
    await writeFile(srv.configPath, JSON.stringify({ ...config, persistSessionAffinity: false }));
    const reload = await fetch(`http://127.0.0.1:${srv.port}/teamclaude/reload`, { method: 'POST', headers: { 'x-api-key': 'test-key' } });
    assert.equal(reload.status, 200);
    await reload.arrayBuffer();
    let finish;
    hold = new Promise(resolve => { finish = resolve; });
    const received = new Promise(resolve => { arrived = resolve; });
    const reply = post(srv.port, 'late-thread', '/v1/messages', { type: 'create' });
    try {
      await received;
      const exited = new Promise(resolve => srv.child.once('exit', resolve));
      let output = '';
      const draining = new Promise(resolve => srv.child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('[TeamClaude] Draining:')) resolve();
      }));
      srv.child.kill('SIGTERM');
      await Promise.race([draining, exited.then(() => { throw new Error('exited before drain'); })]);
      const early = JSON.parse(await readFile(statePath(dir), 'utf8'));
      assert.ok(early.affinity.sessions.every(s => s.threads.length === 0));
      finish();
      await reply;
      await exited;
      const final = JSON.parse(await readFile(statePath(dir), 'utf8'));
      assert.ok(final.affinity.sessions.some(s => s.threads.includes('msg_synthetic')));
    } finally {
      finish();
      await reply.catch(() => {});
    }
  } finally {
    await srv?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('default/off/nonliteral flags ignore disk affinity and ordinary shutdown removes it', async () => {
  assert.equal(createDefaultConfig().persistSessionAffinity, false);
  for (const flag of [undefined, false, 'true']) {
    const dir = await mkdtemp(join(tmpdir(), 'tc-affinity-off-'));
    let srv;
    try {
      await writeFile(statePath(dir), JSON.stringify(seeded()));
      srv = await spawnServer({ dir, env: envFor(dir), config: () => ({ proxy: { apiKey: 'test-key' }, upstreamProxy: false, accounts: [{ ...accounts[0], id: 'b' }, accounts[1]], persistSessionAffinity: flag }) });
      const status = await (await fetch(`http://127.0.0.1:${srv.port}/teamclaude/status`)).json();
      assert.equal(status.sessions.known, 0);
      const repaired = JSON.parse(await readFile(srv.configPath, 'utf8')).accounts;
      assert.equal(repaired[0].id, 'b', 'off/nonliteral keeps the first claimant as before');
      assert.notEqual(repaired[1].id, 'b');
      await srv.stop();
      assert.equal(Object.hasOwn(JSON.parse(await readFile(statePath(dir), 'utf8')), 'affinity'), false);
    } finally {
      await srv?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('missing, corrupt and unknown-version state are nonfatal with opt-in enabled', async () => {
  for (const contents of [null, '{broken', JSON.stringify({ affinity: { version: 9, sessions: [] } })]) {
    const dir = await mkdtemp(join(tmpdir(), 'tc-affinity-bad-'));
    let srv;
    try {
      if (contents !== null) await writeFile(statePath(dir), contents);
      srv = await spawnServer({ dir, env: envFor(dir), config: () => ({ proxy: { apiKey: 'test-key' }, upstreamProxy: false, accounts, persistSessionAffinity: true }) });
      await srv.stop();
      assert.deepEqual(JSON.parse(await readFile(statePath(dir), 'utf8')).affinity, { version: 1, sessions: [] });
    } finally {
      await srv?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// Load/save/update all normalize IDs before a manager sees account filtering.
for (const mode of ['raw', 'filtered', 'save', 'atomic']) {
  test(`startup excludes ambiguous disk IDs (${mode}) without losing threads or stable pins`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tc-affinity-duplicate-'));
    let srv;
    try {
      const original = { id: 'b', name: 'original', type: 'apikey', apiKey: 'synthetic-original' };
      const copy = { id: 'b', name: 'copy', type: 'apikey', ...(mode === 'filtered' ? {} : { apiKey: 'synthetic-copy' }) };
      let config = { proxy: { apiKey: 'test-key' }, upstreamProxy: false, autoUpdate: false,
        persistSessionAffinity: true, accounts: mode === 'filtered' ? [original, copy, accounts[0]] : [copy, original, accounts[0]] };
      const saved = seeded();
      Object.assign(saved.affinity.sessions[0], { sessionId: 'client', conversation: 'opening', threads: ['msg_original'] });
      saved.affinity.sessions.push({ ...saved.affinity.sessions[0], key: 'stable', threads: [],
        pins: [{ ...saved.affinity.sessions[0].pins[0], account: { id: 'a', provider: 'anthropic' } }] });
      await writeFile(statePath(dir), JSON.stringify(saved));
      if (mode === 'save' || mode === 'atomic') {
        const path = join(dir, 'config.json');
        await writeFile(path, JSON.stringify(mode === 'atomic' ? { ...config, accounts: [original, accounts[0]] } : config));
        // A real config-writing child: no parent environment mutation. In the
        // atomic case the duplicate is introduced by the updater, after load.
        const code = mode === 'save'
          ? "await saveConfig(JSON.parse(await readFile(process.env.TEAMROUTER_CONFIG, 'utf8')));"
          : `await atomicConfigUpdate(c => c.accounts.unshift(${JSON.stringify(copy)}));`;
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
          "import { readFile } from 'node:fs/promises'; import { saveConfig, atomicConfigUpdate } from './src/config.js'; " + code],
        { cwd: new URL('..', import.meta.url), env: { ...process.env, ...envFor(dir) } });
        config = JSON.parse(await readFile(path, 'utf8'));
      }
      srv = await spawnServer({ dir, env: envFor(dir), config: () => config });
      const repaired = JSON.parse(await readFile(srv.configPath, 'utf8')).accounts;
      assert.ok(repaired.every(a => a.id !== 'b'), 'no claimant retains the ambiguous persisted ID');
      await srv.stop();
      const restored = JSON.parse(await readFile(statePath(dir), 'utf8')).affinity.sessions;
      assert.deepEqual(restored.find(s => s.key === 'seed').pins, []);
      assert.deepEqual(restored.find(s => s.key === 'seed').threads, ['msg_original']);
      assert.equal(restored.find(s => s.key === 'stable').pins[0].account.id, 'a');
    } finally {
      await srv?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// Exercise the three live consumers through the real CLI before any restart.
for (const mode of ['reload', 'token', 'account']) {
  test(`live ID repair during ${mode} preserves pairing and fresh affinity`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tc-affinity-live-'));
    let srv;
    const upstream = http.createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ key: req.headers.authorization || req.headers['x-api-key'] })); });
    try {
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const original = { id: 'b', name: 'original', type: 'oauth', accessToken: 'synthetic-original', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000 };
      const config = { proxy: { apiKey: 'test-key', mcp: 'full' }, upstreamProxy: false, autoUpdate: false, persistSessionAffinity: true,
        upstream: `http://127.0.0.1:${upstream.address().port}`, distributeSessions: true,
        accounts: [{ id: 'empty', name: 'tokenless', type: 'oauth' }, accounts[0], original] };
      const saved = seeded();
      Object.assign(saved.affinity.sessions[0], { sessionId: 'client', conversation: 'opening', threads: ['msg_original'] });
      saved.affinity.sessions.push({ ...saved.affinity.sessions[0], key: 'stable', pins: [{ bucket: 'unified7d', account: { id: 'a', provider: 'anthropic' }, at: saved.affinity.sessions[0].lastSeen }], threads: [] });
      await writeFile(statePath(dir), JSON.stringify(saved));
      // Only synthetic input is injected; index.js owns the actual token-save callback.
      const preload = join(dir, 'refresh.mjs');
      await writeFile(preload, `import { AccountManager } from ${JSON.stringify(new URL('../src/account-manager.js', import.meta.url).href)};
import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename; fs.rename = async (...args) => { await rename(...args); if (args[1] === process.env.TEAMROUTER_CONFIG) console.log('fixture-token-written'); }; syncBuiltinESMExports();
const onRefresh = AccountManager.prototype.onTokenRefresh;
AccountManager.prototype.onTokenRefresh = function(cb) { onRefresh.call(this, cb); process.on('SIGUSR2', () => this.updateAccountTokens(this.accounts.findIndex(a => a.name === 'original'), { accessToken: 'synthetic-fresh', refreshToken: 'synthetic-fresh-refresh', expiresAt: Date.now() + 7_200_000 })); };`);
      srv = await spawnServer({ dir, env: { ...envFor(dir), NODE_OPTIONS: `--import=${preload}` }, config: () => config });
      const disk = JSON.parse(await readFile(srv.configPath, 'utf8'));
      disk.accounts.unshift({ ...original, name: 'copy', accessToken: 'synthetic-copy' });
      await writeFile(srv.configPath, JSON.stringify(disk));
      if (mode === 'token') {
        const written = new Promise(resolve => srv.child.stdout.on('data', chunk => { if (chunk.includes('fixture-token-written')) resolve(); }));
        srv.child.kill('SIGUSR2');
        await written;
      } else {
        const res = await fetch(`http://127.0.0.1:${srv.port}/teamclaude/${mode === 'reload' ? 'reload' : 'mcp'}`, {
          method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
          ...(mode === 'account' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_account_priority', arguments: { account: 'original', priority: 0 } } }) } : {}),
        });
        assert.equal(res.status, 200);
        assert.notEqual((await res.json()).result?.isError, true);
      }
      const repaired = JSON.parse(await readFile(srv.configPath, 'utf8')).accounts;
      assert.ok(repaired.every(a => a.id !== 'b'), 'live save must not reintroduce a retired ID');
      const owner = repaired.find(a => a.name === 'original');
      assert.equal(owner.accessToken, mode === 'token' ? 'synthetic-fresh' : 'synthetic-original');
      assert.equal(repaired.find(a => a.name === 'copy').accessToken, 'synthetic-copy');
      assert.equal(repaired.find(a => a.id === 'empty').accessToken, undefined);
      const expected = mode === 'token' ? 'Bearer synthetic-fresh' : 'Bearer synthetic-original';
      assert.equal((await post(srv.port, 'fresh-after-repair', '/tc-acct/original/v1/messages')).key, expected);
      await srv.stop();
      const final = JSON.parse(await readFile(statePath(dir), 'utf8')).affinity.sessions;
      assert.deepEqual(final.find(s => s.key === 'seed').pins, []);
      assert.deepEqual(final.find(s => s.key === 'seed').threads, ['msg_original']);
      assert.equal(final.find(s => s.key === 'stable').pins[0].account.id, 'a');
      srv = await spawnServer({ dir, env: envFor(dir), config: () => ({ ...config, accounts: repaired }) });
      assert.equal((await post(srv.port, 'fresh-after-repair')).key, expected);
    } finally {
      await srv?.stop();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
