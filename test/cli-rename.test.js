import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude rename` driven as a subprocess against a throwaway
// TEAMCLAUDE_CONFIG, so the user's real config is never touched. The port here
// is one nothing listens on: the command notifies a running server after a
// write, and that notification has to be a no-op for the test to be about the
// config file.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-rename-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [
      { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
      { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
    ],
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['a@example.com', 'b@example.com'] }],
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

test('rename writes the new name into the account and its routes', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['rename', 'a@example.com', 'A1']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Renamed "a@example\.com" to "A1" \(updated route: fable\)/);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.accounts.map(a => a.name), ['A1', 'b@example.com']);
  assert.deepEqual(saved.routes[0].accounts, ['A1', 'b@example.com']);
});

test('rename refuses a name another account answers to, without touching the config', async () => {
  const configPath = await writeConfig();
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['rename', 'a@example.com', 'b@example.com']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already names another account/);
  assert.equal(await readFile(configPath, 'utf8'), before, 'a refused rename must not write the config');
});

test('rename without a new name prints usage and fails', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['rename', 'a@example.com']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: teamclaude rename/);
});
