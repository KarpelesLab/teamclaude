import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function runEnvCommand(credentials, extraEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), 'teamclaude-client-auth-'));
  const configPath = join(home, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    autoUpdate: false,
    proxy: { port: 3456 },
    accounts: [],
  }));

  if (credentials) {
    const claudeDir = join(home, '.claude');
    await mkdir(claudeDir);
    await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: credentials,
    }));
  }

  try {
    return spawnSync(process.execPath, [cli, 'env', '--no-mitm'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TEAMCLAUDE_CONFIG: configPath,
        ...extraEnv,
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('env emits proxy client auth when local Claude OAuth is absent', async () => {
  const result = await runEnvCommand(null);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unset ANTHROPIC_AUTH_TOKEN/);
  assert.match(result.stdout, /export ANTHROPIC_API_KEY='teamclaude-local'/);
});

test('env preserves subscription mode for valid local Claude OAuth', async () => {
  const result = await runEnvCommand({
    accessToken: 'local-test-token',
    refreshToken: 'local-test-refresh',
    expiresAt: Date.now() + 60_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(result.stdout, /ANTHROPIC_AUTH_TOKEN/);
});

test('env preserves an existing client auth token without local OAuth', async () => {
  const result = await runEnvCommand(null, { ANTHROPIC_AUTH_TOKEN: 'existing-client-token' });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(result.stdout, /ANTHROPIC_AUTH_TOKEN/);
});
