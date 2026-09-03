import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function availablePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    const onData = chunk => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${output}`));
    });
  });
}

test('server restores the persisted reset schedule and exposes it through quota', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-schedule-server-'));
  const configPath = join(dir, 'config.json');
  const port = await availablePort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    switchThreshold: 0.98,
    warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));

  try {
    await waitForOutput(child, new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}`));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.warmup.mode, 'reset');
    assert.equal(body.warmup.timezone, 'Europe/Moscow');
    assert.equal(body.warmup.resetTime, '15:30');
    assert.equal(body.warmup.missedRunPolicy, 'skip');
    assert.ok(Date.parse(body.warmup.nextWarmupAt) > Date.now());
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('server restores a persisted rolling schedule and exposes its cadence through quota', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-rolling-server-'));
  const configPath = join(dir, 'config.json');
  const port = await availablePort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    switchThreshold: 0.98,
    warmupSchedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));

  try {
    await waitForOutput(child, new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}`));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.warmup.mode, 'rolling');
    assert.equal(body.warmup.anchorResetAt, '2030-09-01T12:30:00.000Z');
    assert.equal(body.warmup.cadenceSeconds, 18_000);
    assert.equal(body.warmup.windowSeconds, 18_000);
    assert.equal(body.warmup.nearResetToleranceSeconds, 120);
    assert.equal(body.warmup.postResetBufferSeconds, 10);
    assert.equal(body.warmup.missedRunPolicy, 'skip');
    assert.equal(Date.parse(body.warmup.nextTargetResetAt) - Date.parse(body.warmup.nextWarmupAt), 18_000_000);
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('warmup reset reloads a running server with the persisted schedule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-schedule-reload-'));
  const configPath = join(dir, 'config.json');
  const port = await availablePort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    switchThreshold: 0.98,
    accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));

  try {
    await waitForOutput(child, new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}`));
    const cli = spawnSync(process.execPath, [
      cliPath, 'warmup', 'reset', '15:30', '--timezone', 'Europe/Moscow',
    ], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);

    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`);
    const body = await res.json();
    assert.equal(body.warmup.mode, 'reset');
    assert.equal(body.warmup.resetTime, '15:30');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('warmup rolling reloads a running server without losing its saved anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-rolling-reload-'));
  const configPath = join(dir, 'config.json');
  const port = await availablePort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    switchThreshold: 0.98,
    accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));

  try {
    await waitForOutput(child, new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}`));
    const cli = spawnSync(process.execPath, [
      cliPath, 'warmup', 'rolling', '15:30', '--timezone', 'Europe/Moscow',
    ], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`);
    const body = await res.json();
    assert.equal(body.warmup.mode, 'rolling');
    assert.equal(body.warmup.anchorResetAt, saved.warmupSchedule.anchorResetAt);
    assert.equal(body.warmup.cadenceSeconds, 18_000);
    assert.equal(Date.parse(body.warmup.nextTargetResetAt) - Date.parse(body.warmup.nextWarmupAt), 18_000_000);
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid schedule reload preserves the live schedule and quota endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-schedule-invalid-'));
  const configPath = join(dir, 'config.json');
  const port = await availablePort();
  const baseConfig = {
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    switchThreshold: 0.98,
    warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
  };
  await writeFile(configPath, JSON.stringify(baseConfig));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));

  try {
    await waitForOutput(child, new RegExp(`Bind:\\s+127\\.0\\.0\\.1:${port}`));
    await writeFile(configPath, JSON.stringify({
      ...baseConfig,
      warmupSchedule: { resetTime: '15:30', timezone: 'Moscow' },
    }));
    const reload = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, {
      method: 'POST',
      headers: { 'x-api-key': 'tc-test' },
    });
    assert.equal(reload.status, 500);

    const quota = await fetch(`http://127.0.0.1:${port}/teamclaude/quota`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = await quota.json();
    assert.equal(quota.status, 200);
    assert.equal(body.warmup.timezone, 'Europe/Moscow');
    assert.equal(body.warmup.resetTime, '15:30');
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
