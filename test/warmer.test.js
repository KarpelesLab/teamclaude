import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Warmer } from '../src/warmer.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// A fake spawner: records each spawn spec and resolves like a clean `claude` run
// (exit 0). Lets us assert the warmer's behavior without launching anything.
function fakeSpawner(result = 0) {
  const calls = [];
  const fn = async (spec) => {
    calls.push(spec);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

function makeWarmer(am, spawnFn, opts = {}) {
  return new Warmer(am, { intervalMs: 0, port: 3456, apiKey: 'tc-key', spawnFn, log: () => {}, ...opts });
}

// ── eligibility ──────────────────────────────────────────────────────────────

test('warms only healthy, idle Anthropic OAuth accounts with no live 5h window', async () => {
  const am = new AccountManager([
    oauth('idle'),                                   // ✓ target
    oauth('active'),                                 // ✗ 5h window already running
    oauth('third-party', { upstream: 'https://api.deepseek.com/anthropic' }), // ✗ not Anthropic
    oauth('disabled', { disabled: true }),           // ✗ disabled
    oauth('throttled'),                              // ✗ throttled
  ], 0.98);
  am.accounts[1].quota.unified5hReset = Date.now() + 3600_000; // 'active' has a live window
  am.accounts[4].status = 'throttled';

  const spawn = fakeSpawner();
  await makeWarmer(am, spawn).warmAll();

  assert.equal(spawn.calls.length, 1, 'exactly one account warmed');
  assert.ok(spawn.calls[0].env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/idle'), spawn.calls[0].env.ANTHROPIC_BASE_URL);
});

test('an expired 5h window is a warm target again (keeps the timer going)', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].quota.unified5hReset = Date.now() - 1000; // window already reset
  const spawn = fakeSpawner();
  await makeWarmer(am, spawn).warmAll();
  assert.equal(spawn.calls.length, 1);
});

test('errored and exhausted accounts are skipped', async () => {
  const am = new AccountManager([oauth('err'), oauth('spent')], 0.98);
  am.accounts[0].status = 'error';
  am.accounts[1].status = 'exhausted';
  const spawn = fakeSpawner();
  await makeWarmer(am, spawn).warmAll();
  assert.equal(spawn.calls.length, 0);
});

// ── spawn spec ───────────────────────────────────────────────────────────────

test('the spawn invocation is a minimal non-interactive claude pinned to the account', async () => {
  const am = new AccountManager([oauth('solo')], 0.98);
  const spawn = fakeSpawner();
  await makeWarmer(am, spawn, { port: 9999, apiKey: 'tc-secret', model: 'haiku' }).warmAll();

  const spec = spawn.calls[0];
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args, ['-p', '--bare', '--model', 'haiku', '--output-format', 'text', 'hi']);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999/tc-acct/solo');
  assert.equal(spec.env.ANTHROPIC_API_KEY, 'tc-secret');
});

// ── status ───────────────────────────────────────────────────────────────────

test('status reflects a successful warm and marks third-party accounts not-applicable', async () => {
  const am = new AccountManager([
    oauth('idle'),
    oauth('ds', { upstream: 'https://api.deepseek.com/anthropic' }),
  ], 0.98);
  const warmer = makeWarmer(am, fakeSpawner());
  await warmer.warmAll();

  const st = warmer.getStatus();
  const idle = st.accounts.find(a => a.name === 'idle');
  const ds = st.accounts.find(a => a.name === 'ds');
  assert.equal(idle.status, 'ok');
  assert.ok(idle.lastWarmedAt);
  assert.equal(ds.status, 'not-applicable');
});

test('a non-zero exit is recorded as an error', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const warmer = makeWarmer(am, fakeSpawner(1));
  await warmer.warmAll();
  const st = warmer.getStatus().accounts.find(a => a.name === 'a');
  assert.equal(st.status, 'error');
  assert.match(st.error, /exited 1/);
});

test('a spawn failure (e.g. claude not on PATH) is recorded as an error, not thrown', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const warmer = makeWarmer(am, fakeSpawner(new Error('spawn claude ENOENT')));
  await warmer.warmAll(); // must not reject
  const st = warmer.getStatus().accounts.find(a => a.name === 'a');
  assert.equal(st.status, 'error');
  assert.match(st.error, /ENOENT/);
});

// ── scheduling ───────────────────────────────────────────────────────────────

test('getStatus reports enabled/interval and reschedule(0) turns it off', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const warmer = makeWarmer(am, fakeSpawner(), { intervalMs: 600_000 });
  assert.equal(warmer.getStatus().enabled, true);
  assert.equal(warmer.getStatus().intervalSeconds, 600);
  warmer.reschedule(0);
  assert.equal(warmer.getStatus().enabled, false);
  assert.equal(warmer.timer, null);
});

test('overlapping warm cycles are skipped while one is running', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const warmer = makeWarmer(am, fakeSpawner());
  warmer._running = true;              // pretend a cycle is in flight
  await warmer.warmAll();              // must be a no-op
  assert.equal(warmer.lastRunStartedAt, null);
});

test('stop() aborts an in-flight sweep (kills the warm child, skips the rest)', async () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  let aborts = 0;
  let started = 0;
  // A spawner that hangs until its abort signal fires (models a live `claude`).
  const spawnFn = (spec) => new Promise((_resolve, reject) => {
    started += 1;
    spec.signal.addEventListener('abort', () => { aborts += 1; reject(new Error('aborted')); }, { once: true });
  });
  const warmer = makeWarmer(am, spawnFn);

  const sweep = warmer.warmAll();          // don't await — it's mid-flight
  await new Promise(r => setTimeout(r, 10));
  warmer.stop();                           // must abort the hanging child
  await sweep;

  assert.equal(aborts, 1, 'the in-flight child was aborted');
  assert.equal(started, 1, 'the second account was not started after stop()');
});

test('reschedule to a new interval does NOT trigger an extra (quota-spending) sweep', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  const warmer = makeWarmer(am, spawn, { intervalMs: 600_000 });
  warmer.start();                          // off→on: one immediate sweep
  await new Promise(r => setTimeout(r, 5));
  const afterStart = spawn.calls.length;
  warmer.reschedule(300_000);              // interval CHANGE, already on
  await new Promise(r => setTimeout(r, 5));
  assert.equal(spawn.calls.length, afterStart, 'no extra sweep on an interval change');
});

test('reset schedule waits for the next wall-clock warm-up without running immediately', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  let now = Date.parse('2026-09-01T06:00:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });

  warmer.start();

  assert.equal(spawn.calls.length, 0, 'a scheduled warm-up must not run at startup');
  assert.equal(timers[0].delay, 90 * 60 * 1000);
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-01T07:30:00.000Z');

  now = Date.parse('2026-09-01T07:30:00.001Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 1);
  assert.equal(timers[1].delay, 24 * 60 * 60 * 1000 - 1);
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-02T07:30:00.000Z');
});

test('a reset timer that fires after its cron minute skips the missed warm-up', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  let now = Date.parse('2026-09-01T06:00:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();

  now = Date.parse('2026-09-01T07:31:00.000Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 0);
  assert.equal(timers.length, 2);
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-02T07:30:00.000Z');
});

test('a rolling schedule rearms exactly five hours after each warm-up', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  let now = Date.parse('2026-09-01T06:00:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2026-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });

  warmer.start();
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-01T07:30:00.000Z');

  now = Date.parse('2026-09-01T07:30:00.001Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 1);
  assert.equal(timers[1].delay, 5 * 60 * 60 * 1000 - 1);
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-01T12:30:00.000Z');
  assert.equal(warmer.getStatus().nextTargetResetAt, '2026-09-01T17:30:00.000Z');
});

test('a rolling slot defers an account until just after its near-future reset', async () => {
  const am = new AccountManager([oauth('near'), oauth('idle')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();

  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 1, 'the idle account warms at the rolling slot');
  assert.match(spawn.calls[0].env.ANTHROPIC_BASE_URL, /\/idle$/);
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred, 'the near-reset account is deferred until reset + 10s');

  now = Date.parse('2030-09-01T07:31:10.001Z');
  await deferred.fn();

  assert.equal(spawn.calls.length, 2);
  assert.match(spawn.calls[1].env.ANTHROPIC_BASE_URL, /\/near$/);
  assert.equal(warmer.getStatus().nextWarmupAt, '2030-09-01T12:30:00.000Z');
});

test('a rolling slot does not defer an account beyond the two-minute tolerance', async () => {
  const am = new AccountManager([oauth('outside')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:32:00.002Z');
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();

  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 0);
  assert.equal(timers.length, 2, 'only the next five-hour schedule timer is armed');
  assert.equal(timers[1].delay, 5 * 60 * 60 * 1000 - 1);
});

test('a deferred rolling warm-up rechecks the account after reset', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  am.accounts[0].quota.unified5hReset = now + 5 * 60 * 60 * 1000;
  await deferred.fn();

  assert.equal(spawn.calls.length, 0, 'normal use started a new window before the retry');
});

test('a deferred rolling warm-up skips a callback that fires after its minute', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T13:31:10.001Z');
  await deferred.fn();

  assert.equal(spawn.calls.length, 0, 'an old deferred slot must not be replayed after the next cadence point');
});

test('a deferred rolling warm-up does not outlive its minute during token refresh', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  let finishRefresh;
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = resolve; });
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retry = deferred.fn();
  await new Promise(resolve => setImmediate(resolve));
  now = Date.parse('2030-09-01T07:32:10.001Z');
  finishRefresh();
  await retry;

  assert.equal(spawn.calls.length, 0, 'token refresh must not turn a stale retry into a catch-up request');
});

test('a deferred rolling warm-up rechecks eligibility after token refresh', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  let finishRefresh;
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = resolve; });
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retry = deferred.fn();
  await new Promise(resolve => setImmediate(resolve));
  am.accounts[0].quota.unified5hReset = now + 5 * 60 * 60 * 1000;
  finishRefresh();
  await retry;

  assert.equal(spawn.calls.length, 0, 'normal use during refresh must suppress the deferred request');
});

test('replacing a rolling schedule aborts a deferred retry during token refresh', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  let finishRefresh;
  am.ensureTokenFresh = () => new Promise(resolve => { finishRefresh = resolve; });
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retry = deferred.fn();
  await new Promise(resolve => setImmediate(resolve));
  warmer.rescheduleSchedule(null);
  finishRefresh();
  await retry;

  assert.equal(spawn.calls.length, 0, 'the obsolete retry must not spend quota after warm-up is disabled');
  assert.equal(warmer.getStatus().mode, 'off');
});

test('replacing a rolling schedule aborts a deferred retry after its child starts', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  let spawnedSignal;
  let finishSpawn;
  const spawnFn = spec => {
    spawnedSignal = spec.signal;
    return new Promise(resolve => { finishSpawn = resolve; });
  };
  const timers = [];
  const warmer = makeWarmer(am, spawnFn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retry = deferred.fn();
  await new Promise(resolve => setImmediate(resolve));
  warmer.rescheduleSchedule(null);
  const wasAborted = spawnedSignal.aborted;
  finishSpawn(0);
  await retry;

  assert.equal(wasAborted, true, 'reconfiguration must cancel an already spawned obsolete retry');
});

test('deferred rolling warm-ups serialize accounts sharing the same reset', async () => {
  const am = new AccountManager([oauth('first'), oauth('second')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  const resetAt = Date.parse('2030-09-01T07:31:00.001Z');
  am.accounts[0].quota.unified5hReset = resetAt;
  am.accounts[1].quota.unified5hReset = resetAt;
  let finishFirstSpawn;
  let activeSpawns = 0;
  let maxActiveSpawns = 0;
  const spawn = async spec => {
    spawn.calls.push(spec);
    activeSpawns += 1;
    maxActiveSpawns = Math.max(maxActiveSpawns, activeSpawns);
    if (spawn.calls.length === 1) await new Promise(resolve => { finishFirstSpawn = resolve; });
    activeSpawns -= 1;
    return 0;
  };
  spawn.calls = [];
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.filter(timer => timer.delay === 70_000);
  assert.equal(deferred.length, 2);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retries = deferred.map(timer => timer.fn());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawn.calls.length, 1, 'the second retry waits for the first child');
  finishFirstSpawn();
  await Promise.all(retries);

  assert.equal(spawn.calls.length, 2, 'both accounts must warm even when their deferred callbacks coincide');
  assert.equal(maxActiveSpawns, 1);
});

test('a queued deferred rolling warm-up rechecks eligibility after waiting', async () => {
  const am = new AccountManager([oauth('first'), oauth('second')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  const resetAt = Date.parse('2030-09-01T07:31:00.001Z');
  am.accounts[0].quota.unified5hReset = resetAt;
  am.accounts[1].quota.unified5hReset = resetAt;
  let finishFirstSpawn;
  const spawn = async spec => {
    spawn.calls.push(spec);
    if (spawn.calls.length === 1) await new Promise(resolve => { finishFirstSpawn = resolve; });
    return 0;
  };
  spawn.calls = [];
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.filter(timer => timer.delay === 70_000);
  assert.equal(deferred.length, 2);

  now = Date.parse('2030-09-01T07:31:10.001Z');
  const retries = deferred.map(timer => timer.fn());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawn.calls.length, 1);
  am.accounts[1].quota.unified5hReset = now + 5 * 60 * 60 * 1000;
  finishFirstSpawn();
  await Promise.all(retries);

  assert.equal(spawn.calls.length, 1, 'normal use while queued must suppress the second deferred request');
});

test('stop cancels a deferred rolling warm-up', async () => {
  const am = new AccountManager([oauth('near')], 0.98);
  let now = Date.parse('2030-09-01T07:29:00.000Z');
  am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2030-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.find(timer => timer.delay === 70_000);
  assert.ok(deferred);

  warmer.stop();
  now = Date.parse('2030-09-01T07:31:10.001Z');
  await deferred.fn();

  assert.equal(spawn.calls.length, 0);
});

test('a late rolling timer skips to the next five-hour lattice point', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  let now = Date.parse('2026-09-01T06:00:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2026-09-01T12:30:00.000Z',
    },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();

  now = Date.parse('2026-09-01T07:31:00.000Z');
  await timers[0].fn();

  assert.equal(spawn.calls.length, 0);
  assert.equal(timers.length, 2);
  assert.equal(warmer.getStatus().nextWarmupAt, '2026-09-01T12:30:00.000Z');
});

test('restoring a rolling schedule preserves its original phase', () => {
  const schedule = {
    mode: 'rolling',
    resetTime: '15:30',
    timezone: 'Europe/Moscow',
    anchorResetAt: '2026-09-01T12:30:00.000Z',
  };
  const firstTimers = [];
  const first = makeWarmer(new AccountManager([oauth('a')], 0.98), fakeSpawner(), {
    schedule,
    nowFn: () => Date.parse('2026-09-01T06:00:00.000Z'),
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      firstTimers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  first.start();
  first.stop();

  const restoredTimers = [];
  const restored = makeWarmer(new AccountManager([oauth('a')], 0.98), fakeSpawner(), {
    schedule,
    nowFn: () => Date.parse('2026-09-01T08:00:00.000Z'),
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      restoredTimers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  restored.start();

  assert.equal(restored.getStatus().nextWarmupAt, '2026-09-01T12:30:00.000Z');
  assert.equal(restoredTimers[0].delay, 4.5 * 60 * 60 * 1000);
});

test('a timer from a replaced reset schedule cannot warm or rearm', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const spawn = fakeSpawner();
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    nowFn: () => Date.parse('2026-09-01T06:00:00.000Z'),
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  warmer.rescheduleSchedule({ resetTime: '16:30', timezone: 'Europe/Moscow' });

  await timers[0].fn();

  assert.equal(spawn.calls.length, 0);
  assert.equal(timers.length, 2);
  assert.equal(warmer.getStatus().resetTime, '16:30');
});

test('a schedule replaced during warm-up cannot create an orphan timer', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  let finishSpawn;
  const spawnFn = spec => {
    spawnFn.calls.push(spec);
    return new Promise(resolve => { finishSpawn = resolve; });
  };
  spawnFn.calls = [];
  let now = Date.parse('2026-09-01T06:00:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, spawnFn, {
    schedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  now = Date.parse('2026-09-01T07:30:00.001Z');
  const oldRun = timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  warmer.rescheduleSchedule({ resetTime: '16:30', timezone: 'Europe/Moscow' });
  finishSpawn(0);
  await oldRun;

  assert.equal(spawnFn.calls.length, 1);
  assert.equal(timers.length, 2, 'only the replacement schedule owns a timer');
  assert.equal(warmer.getStatus().resetTime, '16:30');
});
