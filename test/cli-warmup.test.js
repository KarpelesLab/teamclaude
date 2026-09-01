import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function withConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-warmup-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 0, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    accounts: [],
  }));
  try {
    await fn(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(configPath, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('warmup reset saves a timezone-aware schedule and confirms derived times', async () => {
  await withConfig(async configPath => {
    const result = runCli(configPath, ['warmup', 'reset', '15:30', '--timezone', 'Europe/Moscow']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Target reset:\s+daily at 15:30 Europe\/Moscow \(UTC\+03:00\)/);
    assert.match(result.stdout, /Warm-up:\s+daily at 10:30 Europe\/Moscow \(07:30 UTC\)/);
    assert.match(result.stdout, /Quota window:\s+5 hours \(Anthropic-defined\)/);
    assert.match(result.stdout, /Missed runs:\s+skipped/);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.warmupSchedule, {
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
    });
    assert.equal(config.warmupSeconds, 0);
  });
});

test('warmup reset rejects an invalid timezone without changing config', async () => {
  await withConfig(async configPath => {
    const result = runCli(configPath, ['warmup', 'reset', '15:30', '--timezone', 'Moscow']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid IANA timezone/);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.warmupSchedule, undefined);
  });
});

test('warmup off clears both reset and interval modes', async () => {
  await withConfig(async configPath => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.warmupSchedule = { resetTime: '15:30', timezone: 'Europe/Moscow' };
    config.warmupSeconds = 300;
    await writeFile(configPath, JSON.stringify(config));

    const result = runCli(configPath, ['warmup', 'off']);

    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.warmupSchedule, undefined);
    assert.equal(saved.warmupSeconds, 0);
  });
});
