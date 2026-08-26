import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude route` shares the module-level dispatch with every other command:
// the switch awaits the command body, so anything the body references must be
// initialized by the time the await suspends. These drive the real CLI as a
// subprocess against a throwaway TEAMCLAUDE_CONFIG — the user's real config is
// never touched, and the exercised paths are read-only (they exit 1 before any
// saveConfig).

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-route-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port: 3456, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  }));
  return path;
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('route with an unknown subcommand prints usage and exits 1', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['route', 'bogus-subcommand']);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /Usage: teamclaude route/);
  assert.doesNotMatch(res.stdout + res.stderr, /ReferenceError/);
});

test('route add with an unknown color rejects it without touching the config', async () => {
  const configPath = await writeConfig();
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['route', 'add', 'testname', '--match', 'foo-*', '--color', 'notacolor']);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /Unknown color "notacolor"/);
  assert.doesNotMatch(res.stdout + res.stderr, /ReferenceError/);
  assert.equal(await readFile(configPath, 'utf8'), before, 'a refused add must not write the config');
});
