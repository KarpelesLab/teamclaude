import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real server, headless, driven over its MCP endpoint: what a write tool
// changes has to show up in the running fleet AND in the config file, in that
// order, because a headless server has no TUI to save for it.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function closedPort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(configPath) {
  // The child must not inherit a proxy from the shell: see test/README.md.
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const stop = async () => {
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.on('exit', resolve));
    }
    clearTimeout(killer);
  };
  return { stop, output: () => output };
}

async function waitForStatus(port, childOutput) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${childOutput()}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function rpc(port, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200, `${method}: ${res.status}`);
  return (await res.json());
}

async function call(port, name, args = {}) {
  const { result, error } = await rpc(port, 'tools/call', { name, arguments: args });
  assert.equal(error, undefined, `${name}: ${JSON.stringify(error)}`);
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

const status = port => fetch(`http://127.0.0.1:${port}/teamclaude/status`).then(r => r.json());

test('a headless server applies and saves what the write tools change', async () => {
  const deadPort = await closedPort();
  const proxyPort = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-mcp-e2e-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test', mcp: 'read' },
    upstream: `http://127.0.0.1:${deadPort}`,
    upstreamProxy: false,
    switchThreshold: 0.98,
    accounts: [
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
      { name: 'c@example.com', type: 'apikey', apiKey: 'k3' },
    ],
  }));
  const disk = async () => JSON.parse(await readFile(configPath, 'utf8'));

  const server = startServer(configPath);
  try {
    await waitForStatus(proxyPort, server.output);

    // The mode is a config field like any other: a reload picks it up.
    let list = await rpc(proxyPort, 'tools/list');
    assert.equal(list.result.tools.length, 3);
    const onDisk = await disk();
    onDisk.proxy.mcp = 'full';
    await writeFile(configPath, JSON.stringify(onDisk));
    const reload = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
    assert.equal(reload.status, 200);
    list = await rpc(proxyPort, 'tools/list');
    assert.ok(list.result.tools.length > 3, 'a reload must widen the tool list');

    // A setting: written to the file, then applied to the running manager.
    await call(proxyPort, 'set_threshold', { percent: 80 });
    assert.equal((await disk()).switchThreshold, 0.8);
    assert.equal((await status(proxyPort)).switchThreshold, 0.8);

    // Account changes: applied to the fleet, and the save keeps every other
    // account's row intact.
    await call(proxyPort, 'set_account_enabled', { account: 'b@example.com', enabled: false });
    let fleet = await status(proxyPort);
    assert.equal(fleet.accounts.find(a => a.name === 'b@example.com').disabled, true);
    assert.equal((await disk()).accounts.find(a => a.name === 'b@example.com').disabled, true);

    await call(proxyPort, 'set_account_priority', { account: 'c@example.com', priority: -1 });
    fleet = await status(proxyPort);
    assert.equal(fleet.accounts.find(a => a.name === 'c@example.com').priority, -1);
    assert.equal((await disk()).accounts.find(a => a.name === 'c@example.com').priority, -1);

    await call(proxyPort, 'remove_account', { account: 'b@example.com' });
    fleet = await status(proxyPort);
    assert.deepEqual(fleet.accounts.map(a => a.name), ['a@example.com', 'c@example.com']);
    const saved = await disk();
    assert.deepEqual(saved.accounts.map(a => a.name), ['a@example.com', 'c@example.com']);
    assert.equal(saved.accounts.find(a => a.name === 'a@example.com').apiKey, 'k1', 'credentials survive the save');
    assert.equal(saved.switchThreshold, 0.8, 'the settings written earlier survive the save');
    // An account change saves accounts. It must not also pin the server's
    // resolved defaults into a file that never spelled them out.
    assert.deepEqual(Object.keys(saved).sort(), ['accounts', 'proxy', 'switchThreshold', 'upstream', 'upstreamProxy']);

    // A reload after all that must not resurrect the removed account.
    await call(proxyPort, 'reload_config');
    fleet = await status(proxyPort);
    assert.deepEqual(fleet.accounts.map(a => a.name), ['a@example.com', 'c@example.com']);

    const summary = await call(proxyPort, 'get_status');
    assert.deepEqual(summary.accounts.map(a => a.name), ['a@example.com', 'c@example.com']);
    assert.equal(summary.server.port, proxyPort);

    // Deleting the whole proxy section takes `mcp` with it, and the reload has
    // to read that as off rather than keep serving the mode it last saw.
    const trimmed = await disk();
    delete trimmed.proxy;
    await writeFile(configPath, JSON.stringify(trimmed));
    const closing = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
    assert.equal(closing.status, 200);
    const closed = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(closed.status, 404, 'a reload without a proxy section must close the endpoint');
    await closed.arrayBuffer();
  } finally {
    await server.stop();
  }
});
