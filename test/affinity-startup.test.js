import { test } from 'node:test';
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
const seeded = () => ({ quota: {}, affinity: { version: 1, sessions: [{ key: 'seed', sessionId: null, conversation: null, lastSeen: Date.now(), pins: [{ bucket: 'unified7d', account: { id: 'b', provider: 'anthropic' }, at: Date.now() - 1 }], threads: [] }] } });

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
      srv = await spawnServer({ dir, env: envFor(dir), config: () => ({ proxy: { apiKey: 'test-key' }, upstreamProxy: false, accounts, persistSessionAffinity: flag }) });
      const status = await (await fetch(`http://127.0.0.1:${srv.port}/teamclaude/status`)).json();
      assert.equal(status.sessions.known, 0);
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
