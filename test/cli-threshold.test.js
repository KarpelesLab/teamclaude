import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude threshold` drives the real CLI as a subprocess against a throwaway
// TEAMCLAUDE_CONFIG, so the user's real config is never touched. The port here
// is one nothing listens on: the command notifies a running server after a
// write, and that notification has to be a no-op for the test to be about the
// config file.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig(switchThreshold) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-threshold-'));
  const path = join(dir, 'config.json');
  const config = {
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
  };
  if (switchThreshold !== undefined) config.switchThreshold = switchThreshold;
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

async function readThreshold(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8')).switchThreshold;
}

test('threshold with no argument prints the effective value', async () => {
  const configPath = await writeConfig(0.98);
  const res = await runCli(configPath, ['threshold']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Switch threshold: 98%/);
  assert.doesNotMatch(res.stdout + res.stderr, /ReferenceError/);
});

test('threshold with no argument lists the per-bucket table', async () => {
  const configPath = await writeConfig({ default: 0.98, unified7d: 0.9 });
  const res = await runCli(configPath, ['threshold']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Switch threshold: 98%/);
  assert.match(res.stdout, /unified7d: 90%/);
});

test('threshold <pct> stores the ratio, tenths kept', async () => {
  const configPath = await writeConfig(0.98);
  const res = await runCli(configPath, ['threshold', '99.5']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readThreshold(configPath), 0.995);
});

test('threshold <bucket>=<pct> turns a bare number into a table, keeping it as the default', async () => {
  const configPath = await writeConfig(0.95);
  const res = await runCli(configPath, ['threshold', 'unified7d=90']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(await readThreshold(configPath), { default: 0.95, unified7d: 0.9 });
});

test('threshold <bucket>=default drops the override and collapses back to a number', async () => {
  const configPath = await writeConfig({ default: 0.98, unified7d: 0.9 });
  const res = await runCli(configPath, ['threshold', 'unified7d=default']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readThreshold(configPath), 0.98);
});

test('a bare number replaces a table and says which buckets it dropped', async () => {
  const configPath = await writeConfig({ default: 0.98, unified7d: 0.9 });
  const res = await runCli(configPath, ['threshold', '90']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Dropped the per-bucket thresholds \(unified7d\)/);
  assert.equal(await readThreshold(configPath), 0.9);
});

test('an out-of-range percentage is refused without touching the config', async () => {
  const configPath = await writeConfig(0.98);
  const before = await readFile(configPath, 'utf8');
  for (const bad of ['0', '101', 'abc']) {
    const res = await runCli(configPath, ['threshold', bad]);
    assert.equal(res.code, 1, `${bad}: ${res.stderr}`);
    assert.match(res.stderr, /Usage: teamclaude threshold/);
  }
  assert.equal(await readFile(configPath, 'utf8'), before, 'a refused set must not write the config');
});

test('an unknown bucket is refused with the list of known ones', async () => {
  const configPath = await writeConfig(0.98);
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['threshold', 'weekly=90']);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /Unknown quota bucket "weekly"/);
  assert.match(res.stderr, /unified7d/);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('mixing a bare number with a bucket assignment is refused', async () => {
  const configPath = await writeConfig(0.98);
  const before = await readFile(configPath, 'utf8');
  const res = await runCli(configPath, ['threshold', '90', 'unified7d=80']);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /Usage: teamclaude threshold/);
  assert.equal(await readFile(configPath, 'utf8'), before);
});
