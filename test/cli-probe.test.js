import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude probe <seconds>` drives the real CLI as a subprocess against a
// throwaway TEAMCLAUDE_CONFIG. The interval it stores becomes a setInterval
// delay, which is a 32-bit signed millisecond count: past ~2,147,483 s it
// overflows to 1 ms and the probe fires in a tight loop against the usage
// endpoint. The command has a floor already; this pins the ceiling.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function writeConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-probe-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port: 3, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    quotaProbeSeconds: 300,
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

const readSeconds = async (p) => JSON.parse(await readFile(p, 'utf8')).quotaProbeSeconds;

test('probe refuses an interval past seven days and leaves the config alone', async () => {
  const configPath = await writeConfig();
  for (const arg of ['604801', '2147484', '99999999999']) {
    const res = await runCli(configPath, ['probe', arg]);
    assert.equal(res.code, 1, arg);
    assert.match(res.stderr, /Maximum probe interval is 604800s/);
    assert.equal(await readSeconds(configPath), 300);
  }
});

test('probe accepts the seven-day ceiling itself', async () => {
  const configPath = await writeConfig();
  const res = await runCli(configPath, ['probe', '604800']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(await readSeconds(configPath), 604800);
});
