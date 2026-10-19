import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUsageDocument,
  formatUsageReport,
  createUsageServer,
  readQuotaStateFiles,
  readBurnAndSoakHistory,
  readLatestModelRouteRun,
} from '../src/usage.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const FIXTURE_TIME = Date.parse('2026-08-14T10:00:00.000Z');

function createSampleFixture() {
  return {
    config: {
      proxy: { port: 3456, apiKey: 'SECRET_API_KEY_NEVER_LEAK' },
      accounts: [
        {
          name: 'user@example.com',
          type: 'oauth',
          orgName: 'Example Org',
          priority: 10,
          accessToken: 'SECRET_ACCESS_TOKEN_NEVER_LEAK',
          refreshToken: 'SECRET_REFRESH_TOKEN_NEVER_LEAK',
          quota: {
            unified5h: 0.25,
            unified7d: 0.10,
            unified7dFable: 0.05,
            unified5hReset: FIXTURE_TIME + 3600_000,
            unified7dReset: FIXTURE_TIME + 86400_000 * 3,
            unified7dFableReset: FIXTURE_TIME + 86400_000 * 3,
          },
          usage: {
            totalInputTokens: 500_000,
            totalOutputTokens: 50_000,
            totalRequests: 120,
            lastUsed: '2026-08-14T09:50:00.000Z',
          },
          health: {
            latencyEwmaMs: 420.5,
            consecutiveFailures: 0,
            lastSuccessAt: '2026-08-14T09:50:00.000Z',
          },
        },
        {
          name: 'deepseek-tier',
          type: 'apikey',
          apiKey: 'SECRET_DEEPSEEK_KEY_NEVER_LEAK',
          priority: 50,
          disabled: false,
          quota: {},
          usage: {
            totalInputTokens: 10_000,
            totalOutputTokens: 2_000,
            totalRequests: 5,
            lastUsed: '2026-08-14T08:00:00.000Z',
          },
          health: {
            latencyEwmaMs: 180.2,
            consecutiveFailures: 0,
          },
        },
      ],
    },
    status: {
      currentAccount: 'user@example.com',
      switchThreshold: 0.98,
      accounts: [
        {
          name: 'user@example.com',
          type: 'oauth',
          orgName: 'Example Org',
          priority: 10,
          status: 'active',
          quota: {
            unified5h: 0.25,
            unified7d: 0.10,
            unified7dFable: 0.05,
            unified5hReset: FIXTURE_TIME + 3600_000,
            unified7dReset: FIXTURE_TIME + 86400_000 * 3,
            unified7dFableReset: FIXTURE_TIME + 86400_000 * 3,
          },
          usage: {
            totalInputTokens: 500_000,
            totalOutputTokens: 50_000,
            totalRequests: 120,
            lastUsed: '2026-08-14T09:50:00.000Z',
          },
          health: {
            latencyEwmaMs: 420.5,
            consecutiveFailures: 0,
            lastSuccessAt: '2026-08-14T09:50:00.000Z',
          },
        },
        {
          name: 'deepseek-tier',
          type: 'apikey',
          priority: 50,
          disabled: false,
          status: 'active',
          quota: {},
          usage: {
            totalInputTokens: 10_000,
            totalOutputTokens: 2_000,
            totalRequests: 5,
            lastUsed: '2026-08-14T08:00:00.000Z',
          },
          health: {
            latencyEwmaMs: 180.2,
            consecutiveFailures: 0,
          },
        },
      ],
    },
  };
}

test('buildUsageDocument emits versioned schema and aggregates status, state files, history, and route runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-usage-test-'));
  try {
    const quotaDir = join(dir, 'quota');
    const routeDir = join(dir, 'model_route_runs');
    await mkdir(quotaDir, { recursive: true });
    await mkdir(routeDir, { recursive: true });

    // 1. Quota state file for an external tier (codex-gpt56)
    await writeFile(
      join(quotaDir, 'codex-gpt56.json'),
      JSON.stringify({
        unified_5h_utilization: 0.65,
        unified_5h_reset: null,
        unified_7d_utilization: 0.30,
        unified_7d_reset: 1787196619,
        plan_type: 'pro',
        reset_credits: 2,
        additional: [{ name: 'GPT-5.3-Codex-Spark', used_percent: 5 }],
        source: 'wham-usage',
      })
    );

    // 2. Burn history for codex-gpt56
    await writeFile(
      join(quotaDir, 'codex-gpt56.burn.jsonl'),
      [
        JSON.stringify({ t: 1786674000, u: 0.20 }),
        JSON.stringify({ t: 1786677600, u: 0.25 }),
      ].join('\n')
    );

    // 3. Soak log
    await writeFile(
      join(quotaDir, 'soak.jsonl'),
      JSON.stringify({
        t: '2026-08-14T09:30:00Z',
        accounts: [{ name: 'user@example.com', u5h: 0.20, u7d: 0.08, req: 100 }],
      }) + '\n'
    );

    // 4. Model route run latest.json
    await writeFile(
      join(routeDir, 'latest.json'),
      JSON.stringify({
        schema: 'model-route-status/v1',
        run_id: '20260814T100000Z-1234',
        state: 'served',
        class: 'orchestrate',
        tier: 'codex-gpt56',
        rc: 0,
        updated_at: '2026-08-14T09:59:00Z',
        chain: ['gpt-5.6-sol', 'codex-gpt56'],
      })
    );

    // Test readers directly
    const directStateFiles = await readQuotaStateFiles(quotaDir);
    assert.ok(directStateFiles['codex-gpt56']);
    assert.equal(directStateFiles['codex-gpt56'].planType, 'pro');

    const directBurnHistory = await readBurnAndSoakHistory(quotaDir);
    assert.ok(directBurnHistory.tiers['codex-gpt56']);
    assert.equal(directBurnHistory.soak.length, 1);

    const directRouteRun = await readLatestModelRouteRun({ modelRouteDir: routeDir });
    assert.ok(directRouteRun);
    assert.equal(directRouteRun.tier, 'codex-gpt56');

    const fixture = createSampleFixture();
    const doc = await buildUsageDocument({
      status: fixture.status,
      config: fixture.config,
      quotaDir,
      modelRouteDir: routeDir,
      now: FIXTURE_TIME,
      staleAfterSeconds: 180,
    });

    // Verify top-level structure
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.staleAfterSeconds, 180);
    assert.equal(doc.summary.activeAccount, 'user@example.com');
    assert.equal(doc.summary.lastServedTier, 'codex-gpt56');
    assert.equal(doc.summary.totalAccounts, 3); // 2 from status + 1 standalone tier
    assert.equal(doc.lastServedRun.tier, 'codex-gpt56');
    assert.equal(doc.lastServedRun.state, 'served');

    // Verify provider accounts
    const userProvider = doc.providers.find(p => p.id === 'user@example.com');
    assert.ok(userProvider);
    assert.equal(userProvider.type, 'oauth');
    assert.equal(userProvider.current, true);
    assert.equal(userProvider.status, 'active');

    // Windows
    const w5h = userProvider.windows.find(w => w.kind === '5h');
    assert.ok(w5h);
    assert.equal(w5h.usedPercent, 25);
    assert.equal(w5h.remainingPercent, 75);
    assert.equal(w5h.resetCountdownSeconds, 3600);

    const w7d = userProvider.windows.find(w => w.kind === '7d');
    assert.ok(w7d);
    assert.equal(w7d.usedPercent, 10);
    assert.equal(w7d.remainingPercent, 90);

    const wFable = userProvider.windows.find(w => w.kind === '7d-fable');
    assert.ok(wFable);
    assert.equal(wFable.usedPercent, 5);

    // Generic details contract
    assert.equal(userProvider.details.title, 'user@example.com');
    assert.ok(Array.isArray(userProvider.details.rows));
    assert.ok(userProvider.details.rows.some(r => r.label === '5-Hour Quota' && r.value === '25% used'));
    assert.ok(Array.isArray(userProvider.details.bars));
    assert.equal(userProvider.details.bars.length, 3);

    // Standalone tier provider (codex-gpt56)
    const codexProvider = doc.providers.find(p => p.id === 'codex-gpt56');
    assert.ok(codexProvider);
    assert.equal(codexProvider.type, 'tier-quota');
    assert.equal(codexProvider.isLastServed, true);
    assert.equal(codexProvider.credits.planType, 'pro');
    assert.equal(codexProvider.credits.resetCredits, 2);

    const codex5h = codexProvider.windows.find(w => w.kind === '5h');
    assert.equal(codex5h.usedPercent, 65);
    const codexSpark = codexProvider.windows.find(w => w.name === 'GPT-5.3-Codex-Spark');
    assert.ok(codexSpark);
    assert.equal(codexSpark.usedPercent, 5);

    // Burn rate derived from burn.jsonl
    assert.ok(codexProvider.burn);
    assert.equal(codexProvider.burn.dataPoints, 2);
    assert.ok(typeof codexProvider.burn.burnRatePerHour === 'number');

    // SECRETS DISCIPLINE: Ensure NO secret token/key values appear anywhere in the document
    const serialized = JSON.stringify(doc);
    assert.doesNotMatch(serialized, /SECRET_API_KEY_NEVER_LEAK/);
    assert.doesNotMatch(serialized, /SECRET_ACCESS_TOKEN_NEVER_LEAK/);
    assert.doesNotMatch(serialized, /SECRET_REFRESH_TOKEN_NEVER_LEAK/);
    assert.doesNotMatch(serialized, /SECRET_DEEPSEEK_KEY_NEVER_LEAK/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatUsageReport renders human-readable output and ANSI colors correctly', () => {
  const doc = {
    schemaVersion: 1,
    generatedAt: '2026-08-14T10:00:00.000Z',
    staleAfterSeconds: 300,
    summary: {
      activeAccount: 'user@example.com',
      totalAccounts: 1,
      activeAccounts: 1,
      lastServedTier: 'gpt-5.6-sol',
      serverRunning: true,
    },
    lastServedRun: { tier: 'gpt-5.6-sol', state: 'served' },
    providers: [
      {
        id: 'user@example.com',
        name: 'user@example.com',
        type: 'oauth',
        priority: 10,
        status: 'active',
        current: true,
        isLastServed: false,
        windows: [
          { kind: '5h', name: '5-Hour Quota', usedPercent: 45, remainingPercent: 55, resetCountdownSeconds: 1800 },
        ],
        usage: { requests: 50, totalTokens: 125000, lastUsed: '2026-08-14T09:50:00.000Z' },
        health: { latencyEwmaMs: 350 },
        burn: { burnRatePerHour: 0.05, dataPoints: 10 },
      },
    ],
  };

  const plain = formatUsageReport(doc, { color: false });
  assert.match(plain, /TeamClaude Usage/);
  assert.match(plain, /Active:\s+user@example.com/);
  assert.match(plain, /Last served:\s+gpt-5.6-sol \(served\)/);
  assert.match(plain, />\s+user@example.com \(oauth, prio 10\) \[active\]/);
  assert.match(plain, /5-Hour Quota\s+\[███████░░░░░░░░░\]\s+45% used ·\s+55% left · reset 30m/);
  assert.match(plain, /Usage\s+50 req · 125.0k tok/);
  assert.match(plain, /Latency EWMA\s+350ms/);
  assert.match(plain, /Burn Rate\s+5.0%\/hr \(10 pts\)/);

  const colored = formatUsageReport(doc, { color: true });
  assert.match(colored, /\x1b\[32mactive/); // green status
  assert.match(colored, /\x1b\[36m>/);     // cyan marker
});

test('createUsageServer serves /health and /usage over loopback HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-usage-server-'));
  try {
    const fixture = createSampleFixture();
    const server = createUsageServer({
      port: 0, // ephemeral port
      host: '127.0.0.1',
      usageOptions: {
        status: fixture.status,
        config: fixture.config,
        quotaDir: join(dir, 'empty-quota'),
        modelRouteDir: join(dir, 'empty-routes'),
        now: FIXTURE_TIME,
      },
    });

    const bound = await server.listen();
    assert.ok(bound.port > 0);

    try {
      // Test GET /health
      const healthRes = await fetch(`http://127.0.0.1:${bound.port}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get('cache-control'), 'no-store');
      const healthData = await healthRes.json();
      assert.equal(healthData.status, 'ok');
      assert.ok(healthData.timestamp);
      assert.ok(healthData.version);

      // Test GET /usage - by default no wildcard CORS header
      const usageRes = await fetch(`http://127.0.0.1:${bound.port}/usage`);
      assert.equal(usageRes.status, 200);
      assert.equal(usageRes.headers.get('cache-control'), 'no-store');
      assert.equal(usageRes.headers.get('access-control-allow-origin'), null);
      const usageData = await usageRes.json();
      assert.equal(usageData.schemaVersion, 1);
      assert.equal(usageData.summary.activeAccount, 'user@example.com');
      assert.equal(usageData.providers.length, 2);

      // Test GET / (root aliases to /usage)
      const rootRes = await fetch(`http://127.0.0.1:${bound.port}/`);
      assert.equal(rootRes.status, 200);
      const rootData = await rootRes.json();
      assert.equal(rootData.schemaVersion, 1);

      // Test 404 for unknown endpoint
      const unknownRes = await fetch(`http://127.0.0.1:${bound.port}/nonexistent`);
      assert.equal(unknownRes.status, 404);
      await unknownRes.text();
    } finally {
      await server.close();
    }

    // Test with explicit allowOrigin
    const corsServer = createUsageServer({
      port: 0,
      host: '127.0.0.1',
      allowOrigin: 'https://example.com',
      usageOptions: {
        status: fixture.status,
        config: fixture.config,
        quotaDir: join(dir, 'empty-quota'),
      },
    });
    const corsBound = await corsServer.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${corsBound.port}/usage`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
      await res.json();
    } finally {
      await corsServer.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createUsageServer enforces bearer token on non-loopback bind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-usage-auth-'));
  try {
    const fixture = createSampleFixture();
    const server = createUsageServer({
      port: 0,
      host: '127.0.0.1', // test loopback behavior or non-loopback gate
      token: 'secret-token-123',
      usageOptions: {
        status: fixture.status,
        config: fixture.config,
        quotaDir: join(dir, 'empty-quota'),
      },
    });

    const bound = await server.listen();
    try {
      // Loopback without token succeeds
      const loopbackRes = await fetch(`http://127.0.0.1:${bound.port}/usage`);
      assert.equal(loopbackRes.status, 200);
      await loopbackRes.json();
    } finally {
      await server.close();
    }

    // Test non-loopback server with NO token configured (fails closed)
    const savedUsageToken = process.env.TEAMCLAUDE_USAGE_TOKEN;
    const savedLegacyToken = process.env.USAGE_TOKEN;
    delete process.env.TEAMCLAUDE_USAGE_TOKEN;
    delete process.env.USAGE_TOKEN;

    const noTokenServer = createUsageServer({
      port: 0,
      host: '0.0.0.0',
      token: null,
      usageOptions: {
        status: fixture.status,
        config: fixture.config,
        quotaDir: join(dir, 'empty-quota'),
      },
    });
    const noTokenBound = await noTokenServer.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${noTokenBound.port}/usage`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /bearer token required/);
    } finally {
      await noTokenServer.close();
      if (savedUsageToken !== undefined) process.env.TEAMCLAUDE_USAGE_TOKEN = savedUsageToken;
      else delete process.env.TEAMCLAUDE_USAGE_TOKEN;
      if (savedLegacyToken !== undefined) process.env.USAGE_TOKEN = savedLegacyToken;
      else delete process.env.USAGE_TOKEN;
    }

    // Now test server with non-loopback host and configured token
    const nonLoopServer = createUsageServer({
      port: 0,
      host: '0.0.0.0',
      token: 'secret-token-123',
      usageOptions: {
        status: fixture.status,
        config: fixture.config,
        quotaDir: join(dir, 'empty-quota'),
      },
    });

    const nonLoopBound = await nonLoopServer.listen();
    try {
      // Request without auth header should be rejected (401)
      const unauthRes = await fetch(`http://127.0.0.1:${nonLoopBound.port}/usage`);
      assert.equal(unauthRes.status, 401);
      await unauthRes.text();

      // Request with bad token should be rejected (401)
      const badAuthRes = await fetch(`http://127.0.0.1:${nonLoopBound.port}/usage`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(badAuthRes.status, 401);
      await badAuthRes.text();

      // Request with valid bearer token should succeed (200)
      const goodAuthRes = await fetch(`http://127.0.0.1:${nonLoopBound.port}/usage`, {
        headers: { Authorization: 'Bearer secret-token-123' },
      });
      assert.equal(goodAuthRes.status, 200);
      const goodData = await goodAuthRes.json();
      assert.equal(goodData.schemaVersion, 1);
    } finally {
      await nonLoopServer.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: `teamclaude usage --json` emits one-shot JSON document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-usage-'));
  try {
    const configPath = join(dir, 'teamclaude.json');
    const fixture = createSampleFixture();
    await writeFile(configPath, JSON.stringify(fixture.config, null, 2));

    const res = spawnSync(process.execPath, [CLI, 'usage', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCLAUDE_QUOTA_STATE_DIR: join(dir, 'empty-quota'),
      },
    });

    assert.equal(res.status, 0, `CLI exited ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.providers));
    assert.ok(parsed.providers.length >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: `teamclaude usage serve` starts server and responds over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-serve-'));
  try {
    const configPath = join(dir, 'teamclaude.json');
    const fixture = createSampleFixture();
    await writeFile(configPath, JSON.stringify(fixture.config, null, 2));

    // Choose a port
    const testPort = 39876;
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [CLI, 'usage', 'serve', '--port', String(testPort)], {
      cwd: dir,
      env: {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCLAUDE_QUOTA_STATE_DIR: join(dir, 'empty-quota'),
      },
    });

    let stdout = '';
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.includes('listening on')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Server exited early with code ${code}: ${stdout}`));
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'ok');

      const usageRes = await fetch(`http://127.0.0.1:${testPort}/usage`);
      assert.equal(usageRes.status, 200);
      const usageData = await usageRes.json();
      assert.equal(usageData.schemaVersion, 1);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => child.on('close', resolve));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: `teamclaude usage serve` fails fast on non-loopback host without token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-serve-fail-'));
  try {
    const configPath = join(dir, 'teamclaude.json');
    const fixture = createSampleFixture();
    await writeFile(configPath, JSON.stringify(fixture.config, null, 2));

    const res = spawnSync(process.execPath, [CLI, 'usage', 'serve', '--host', '0.0.0.0'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCLAUDE_USAGE_TOKEN: '',
        USAGE_TOKEN: '',
      },
    });

    assert.equal(res.status, 1, `CLI exited ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.match(res.stderr, /Non-loopback usage serve requires/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


