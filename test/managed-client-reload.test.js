import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueManagedCredential } from '../src/managed-client-auth.js';

async function harness(t) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    await once(req, 'end');
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'tc-managed-reload-'));
  const configPath = join(dir, 'config.json');
  const config = {
    proxy: { port, apiKey: 'test-reload-proxy-key', managedClientAuth: true },
    upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false,
    quotaProbeSeconds: 0, warmupSeconds: 0,
    accounts: ['a', 'b'].map(name => ({ id: `identity-${name}`, name,
      type: 'oauth', accessToken: `test-access-${name}`,
      accountUuid: `user-${name}`, orgUuid: `org-${name}`, expiresAt: Date.now() + 3600_000 })),
  };
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url)), 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await once(child, 'exit');
    clearTimeout(timer);
  });
  // After the child, never before: hooks run in registration order, and the
  // server writes its state file next to the config, so removing the directory
  // while it is still alive races that write into an ENOTEMPTY rmdir.
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${port}`;
  const token = issueManagedCredential(config, 'identity-a');
  const request = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  };
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await request('/teamclaude/status')).status === 200) break; } catch { /* starting */ }
    assert.ok(Date.now() < deadline, `server startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const managed = () => request('/api/oauth/profile', { headers: { authorization: `Bearer ${token}` } });
  const reload = async () => {
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await request('/teamclaude/reload', { method: 'POST' })).status, 200);
  };
  const normal = () => request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 1, messages: [] }) });
  return { config, request, managed, normal, reload, seen };
}

for (const change of ['disable mode', 'remove identity', 'disable identity']) {
  test(`live CLI disk reload revokes managed token on ${change} while normal inference continues`, { timeout: 20_000 }, async t => {
    const { config, managed, normal, reload, seen } = await harness(t);
    assert.equal((await managed()).status, 200);
    if (change === 'disable mode') config.proxy.managedClientAuth = false;
    if (change === 'remove identity') config.accounts.shift();
    if (change === 'disable identity') config.accounts[0].disabled = true;
    await reload();
    const hitsBefore = seen.length;
    assert.equal((await managed()).status, 403);
    assert.equal(seen.length, hitsBefore, 'revoked credential never reaches upstream');
    assert.equal((await normal()).status, 200);
    assert.equal(seen.at(-1).path, '/v1/messages');
    assert.equal(seen.some(hit => hit.auth?.includes('tc-managed-v1')), false);
  });
}
