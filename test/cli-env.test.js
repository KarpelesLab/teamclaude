import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `teamclaude env` as a subprocess against a throwaway config: the mode it
// emits is decided by `defaultClientMode` unless a flag says otherwise. The
// harness is adapted from #384.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function runEnv(args = [], { config = {}, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-env-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 3456, apiKey: 'test' },
    upstream: 'https://api.anthropic.com',
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'secret' }],
    ...config,
  }));
  try {
    const child = spawn(process.execPath, [cliPath, 'env', ...args], {
      env: { ...process.env, ...env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('env command did not exit')); }, 15_000);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('env defaults to MITM and exports the forward proxy', async () => {
  const result = await runEnv();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export HTTPS_PROXY=http:\/\/127\.0\.0\.1:3456$/m);
  assert.match(result.stderr, /default mode is MITM/);
});

test('defaultClientMode: base-url makes env emit the base URL only', async () => {
  const result = await runEnv([], { config: { defaultClientMode: 'base-url' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export ANTHROPIC_BASE_URL=http:\/\/localhost:3456$/m);
  assert.doesNotMatch(result.stdout, /^export (?:HTTP|HTTPS|ALL)_PROXY|NODE_EXTRA_CA_CERTS/m);
  assert.match(result.stderr, /default mode is base-URL/);
});

test('in base-URL mode a stale MITM export pointing at this proxy is unset, a foreign proxy is kept', async () => {
  const result = await runEnv([], {
    config: { defaultClientMode: 'base-url' },
    env: { HTTPS_PROXY: 'http://127.0.0.1:3456', https_proxy: 'http://127.0.0.1:3456', HTTP_PROXY: 'http://proxy.corp.example:8080' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^unset HTTPS_PROXY$/m);
  assert.match(result.stdout, /^unset https_proxy$/m);
  assert.doesNotMatch(result.stdout, /unset HTTP_PROXY/);
});

test('--mitm overrides a base-url default, and the hint names the flag', async () => {
  const result = await runEnv(['--mitm'], { config: { defaultClientMode: 'base-url' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export HTTPS_PROXY=http:\/\/127\.0\.0\.1:3456$/m);
  assert.match(result.stderr, /teamclaude env --mitm/);
});

test('env rejects contradictory mode flags without writing to stdout', async () => {
  const result = await runEnv(['--mitm', '--no-mitm']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /either --mitm or --no-mitm/);
});
