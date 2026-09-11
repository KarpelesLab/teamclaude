import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `GET /teamclaude/status` reports the version of the process that answers
// under `server.version`. Clients (the remote TUI, a menu bar app) used to
// infer it from the CLI they were installed with, which is the wrong answer
// right after `teamclaude update` and before the restart — and the gate for
// "does this proxy hot-apply key X on reload" needs the running version, not
// the installed one. This drives the real server as a subprocess against a
// throwaway TEAMCLAUDE_CONFIG and compares against the package.json it runs.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));

// A port nothing is listening on: bind one, learn its number, give it back.
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
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  return { child, stop, output: () => output };
}

async function waitForStatus(port, childOutput) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${childOutput()}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

test('GET /teamclaude/status reports the running package version under server.version', async () => {
  const deadPort = await closedPort();
  const proxyPort = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-status-version-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${deadPort}`,
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));

  const server = startServer(configPath);
  try {
    const status = await waitForStatus(proxyPort, server.output);
    const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    assert.match(version, /^\d+\.\d+\.\d+/, 'package.json carries a version to compare against');
    assert.equal(status.server.version, version);
    assert.equal(typeof status.server.startedAt, 'string', 'the rest of the server block is untouched');
  } finally {
    await server.stop();
  }
});
