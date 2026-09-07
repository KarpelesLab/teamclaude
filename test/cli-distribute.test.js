import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same shape as cli-threshold.test.js: the real CLI against a throwaway
// TEAMCLAUDE_CONFIG, on a port nothing listens on so the post-write reload
// notification is a no-op.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig(distributeSessions) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-distribute-'));
  const path = join(dir, 'config.json');
  const config = {
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  };
  if (distributeSessions !== undefined) config.distributeSessions = distributeSessions;
  await writeFile(path, JSON.stringify(config));
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

async function readDistribute(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8')).distributeSessions;
}

test('distribute with no argument reports the current state', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['distribute']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Session distribution: off/);
  assert.doesNotMatch(res.stdout + res.stderr, /ReferenceError/);
});

test('distribute on writes the setting', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['distribute', 'on']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readDistribute(configPath), true);
  assert.match(res.stdout, /Session distribution on/);
});

test('distribute off says the running sessions drain', async () => {
  const configPath = await writeConfig(true);
  const res = await runCli(configPath, ['distribute', 'off']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readDistribute(configPath), false);
  assert.match(res.stdout, /drain/);
});

test('setting what is already set does not rewrite the config', async () => {
  const configPath = await writeConfig(true);
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['distribute', 'on']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('an unknown argument is refused without touching the config', async () => {
  const configPath = await writeConfig();
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['distribute', 'maybe']);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /Usage: teamclaude distribute/);
  assert.equal(await readFile(configPath, 'utf8'), before);
});
