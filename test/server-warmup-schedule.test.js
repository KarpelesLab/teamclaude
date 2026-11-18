import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { createRollingWarmupSchedule } from '../src/warmup-schedule.js';

// The warm-up schedule, end to end through the real server: restored from the
// config at startup, exposed through /teamclaude/quota, and replaced live by the
// `warmup` CLI's reload. The server is spawned through test-helpers/spawn-server.js
// (pid-verified port, respawn on a lost port race): this file carried its own
// bind-a-port-then-spawn harness, which lost the race to a neighbouring test on
// a loaded runner ("Port 39521 is already in use", #499's node 20 run).

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const base = {
  upstream: 'https://api.anthropic.com',
  upstreamProxy: false,
  autoUpdate: false,
  switchThreshold: 0.98,
  accounts: [{ name: 'test', type: 'apikey', apiKey: 'sk-test' }],
};

async function serverWith(extra, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const server = await spawnServer({ dir, config: () => ({ proxy: { apiKey: 'tc-test' }, ...base, ...extra }) });
  return {
    ...server,
    quota: async () => { const res = await fetch(`http://127.0.0.1:${server.port}/teamclaude/quota`); return { res, body: await res.json() }; },
    // The `warmup` CLI against this server's config: it saves, then tells the server.
    warmup: (...args) => spawnSync(process.execPath, [cliPath, 'warmup', ...args], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: server.configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    }),
    cleanup: async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('server restores the persisted reset schedule and exposes it through quota', async () => {
  const s = await serverWith({ warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' } }, 'teamclaude-schedule-server-');
  try {
    const { res, body } = await s.quota();
    assert.equal(res.status, 200);
    assert.equal(body.warmup.mode, 'reset');
    assert.equal(body.warmup.timezone, 'Europe/Moscow');
    assert.equal(body.warmup.resetTime, '15:30');
    assert.equal(body.warmup.missedRunPolicy, 'skip');
    assert.ok(Date.parse(body.warmup.nextWarmupAt) > Date.now());
  } finally {
    await s.cleanup();
  }
});

test('server restores a persisted rolling schedule and exposes its cadence through quota', async () => {
  const s = await serverWith({
    warmupSchedule: { mode: 'rolling', resetTime: '15:30', timezone: 'Europe/Moscow', anchorResetAt: '2030-09-01T12:30:00.000Z' },
  }, 'teamclaude-rolling-server-');
  try {
    const { res, body } = await s.quota();
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
    await s.cleanup();
  }
});

test('warmup reset reloads a running server with the persisted schedule', async () => {
  const s = await serverWith({}, 'teamclaude-schedule-reload-');
  try {
    const cli = s.warmup('reset', '15:30', '--timezone', 'Europe/Moscow');
    assert.equal(cli.status, 0, cli.stderr);
    const { body } = await s.quota();
    assert.equal(body.warmup.mode, 'reset');
    assert.equal(body.warmup.resetTime, '15:30');
  } finally {
    await s.cleanup();
  }
});

test('warmup rolling reloads a running server without losing its saved anchor', async () => {
  const s = await serverWith({}, 'teamclaude-rolling-reload-');
  try {
    const cli = s.warmup('rolling', '15:30', '--timezone', 'Europe/Moscow');
    assert.equal(cli.status, 0, cli.stderr);
    const saved = JSON.parse(await readFile(s.configPath, 'utf8'));
    const { body } = await s.quota();
    assert.equal(body.warmup.mode, 'rolling');
    assert.equal(body.warmup.anchorResetAt, saved.warmupSchedule.anchorResetAt);
    assert.equal(body.warmup.cadenceSeconds, 18_000);
    assert.equal(Date.parse(body.warmup.nextTargetResetAt) - Date.parse(body.warmup.nextWarmupAt), 18_000_000);
  } finally {
    await s.cleanup();
  }
});

test('an invalid schedule reload preserves the live schedule and quota endpoint', async () => {
  const s = await serverWith({ warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' } }, 'teamclaude-schedule-invalid-');
  try {
    await writeFile(s.configPath, JSON.stringify({ ...s.config, warmupSchedule: { resetTime: '15:30', timezone: 'Moscow' } }));
    const reload = await fetch(`http://127.0.0.1:${s.port}/teamclaude/reload`, { method: 'POST', headers: { 'x-api-key': 'tc-test' } });
    assert.equal(reload.status, 500);
    // A refused reload must leave the endpoint answering with the schedule it had.
    // No deadline of its own: a wedged endpoint is what the runner's timeout is for.
    const { res, body } = await s.quota();
    assert.equal(res.status, 200);
    assert.equal(body.warmup.timezone, 'Europe/Moscow');
    assert.equal(body.warmup.resetTime, '15:30');
  } finally {
    await s.cleanup();
  }
});

// Every reload re-reads the whole file, whatever changed in it. One that leaves
// the schedule as it is must not reschedule it: that would cut a warm-up sweep
// short and drop the warm-ups it delayed. The warmer logs "Keep-warm scheduled
// for" each time it arms a schedule, so after a reload of the file as it was and
// one that moves the anchor, the line is there twice: at startup and for the
// change. The second reload's own line, read off the warmer's status, is what
// the test waits for; the output is one ordered stream, so a line from the
// first reload would already be in it. The anchor is the one `warmup rolling`
// would save six hours from now: no slot comes due during the test, and the
// next warm-up stays well under the longest delay setTimeout takes (about 24.8
// days), past which the timer fires at once and re-arms, logging the line
// each time. The wait for that line, and the requests, end with the test
// (t.signal): a line that never comes then fails the test at its timeout and
// the finally still stops the server, where an unending wait would keep the
// file from exiting (test/README.md, "Clean up in finally").
test('a reload that leaves the schedule as it is does not reschedule it', async (t) => {
  const schedule = createRollingWarmupSchedule({ resetTime: '15:30', timezone: 'Europe/Moscow' }, Date.now() + 6 * 60 * 60 * 1000);
  const moved = new Date(Date.parse(schedule.anchorResetAt) + 24 * 60 * 60 * 1000).toISOString();
  const s = await serverWith({ warmupSchedule: schedule }, 'teamclaude-schedule-same-');
  try {
    const headers = { 'x-api-key': 'tc-test' };
    const reload = () => fetch(`http://127.0.0.1:${s.port}/teamclaude/reload`, { method: 'POST', headers, signal: t.signal });
    assert.equal((await reload()).status, 200);
    await writeFile(s.configPath, JSON.stringify({ ...s.config, warmupSchedule: { ...schedule, anchorResetAt: moved } }));
    assert.equal((await reload()).status, 200);
    const status = await (await fetch(`http://127.0.0.1:${s.port}/teamclaude/status`, { headers, signal: t.signal })).json();
    const changed = `Keep-warm scheduled for ${status.warm.nextWarmupAt}`;
    await new Promise((resolve, reject) => {
      const stop = () => { s.child.stdout.off('data', check); t.signal.removeEventListener('abort', abort); };
      const check = () => { if (s.output().includes(changed)) { stop(); resolve(undefined); } };
      const abort = () => { stop(); reject(t.signal.reason); };
      s.child.stdout.on('data', check);
      t.signal.addEventListener('abort', abort, { once: true });
      check();
    });
    assert.equal(s.output().split('Keep-warm scheduled for').length - 1, 2, s.output());
  } finally {
    await s.cleanup();
  }
});
