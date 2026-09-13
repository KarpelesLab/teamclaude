import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function runEnv(args = []) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-env-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 3456, apiKey: 'test' },
    upstream: 'https://api.anthropic.com',
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'secret' }],
  }));
  try {
    const child = spawn(process.execPath, [cliPath, 'env', ...args], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('env command did not exit')); }, 10_000);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('env defaults to base URL and does not export a process-wide proxy', async () => {
  const result = await runEnv();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export ANTHROPIC_BASE_URL=http:\/\/localhost:3456$/m);
  assert.doesNotMatch(result.stdout, /(?:HTTP|HTTPS|ALL)_PROXY|NODE_EXTRA_CA_CERTS/);
});

test('env --mitm is explicit and exports the whole-shell proxy', async () => {
  const result = await runEnv(['--mitm']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export HTTPS_PROXY=http:\/\/127\.0\.0\.1:3456$/m);
  assert.match(result.stderr, /teamclaude env --mitm/);
});

test('env rejects contradictory proxy mode flags', async () => {
  const result = await runEnv(['--mitm', '--no-mitm']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /choose either --mitm or --no-mitm/);
});
