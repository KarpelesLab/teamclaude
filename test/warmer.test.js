import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { resolveAccountPin } from '../src/server.js';
import { Warmer, resolveClaudeCommand, claudeSpawnShell } from '../src/warmer.js';

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

// The warm-up is a `claude` run, which the server refuses on a Codex account,
// and a Codex plan may have no 5-hour window to start at all: with no reset
// ever recorded it would be a target on every cycle, forever.
test('a Codex subscription is never a warm target', async () => {
  const am = new AccountManager([
    oauth('codex', { provider: 'codex', accountId: 'acct-1' }),
  ], 0.98);
  const spawn = fakeSpawner();
  const warmer = makeWarmer(am, spawn);
  await warmer.warmAll();

  assert.equal(spawn.calls.length, 0);
  assert.equal(warmer.getStatus().accounts[0].status, 'not-applicable');
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

// A warm-up is pinned to its account, so nothing downstream holds it back, and an
// account sitting out an entitlement cooldown would be refused again - a refusal
// that counts as a new denial and lengthens the cooldown.
test('an account in its entitlement cooldown is not warmed', async () => {
  const am = new AccountManager([oauth('denied'), oauth('ok')], 0.98);
  am.markEntitlementDenied(0, { seconds: 300 });
  const spawn = fakeSpawner();
  await makeWarmer(am, spawn).warmAll();
  assert.equal(spawn.calls.length, 1, 'only the account with no cooldown is warmed');
  assert.match(spawn.calls[0].env.ANTHROPIC_BASE_URL, /\/tc-acct\/ok$/);
});

// Control: the cooldown over, the account is warmed again.
test('an account whose entitlement cooldown has ended is warmed again', async () => {
  const am = new AccountManager([oauth('denied')], 0.98);
  am.markEntitlementDenied(0, { seconds: 300 });
  am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
  const spawn = fakeSpawner();
  const log = console.log;
  console.log = () => {};
  try { await makeWarmer(am, spawn).warmAll(); } finally { console.log = log; }
  assert.equal(spawn.calls.length, 1);
});

// The account manager writes the cooldown on its own clock (Date.now) and reads
// it on that clock too, clearing it once it reads it as over. The warmer's clock
// is its own (injected here, as the schedule tests do), and asking the cooldown
// on it cleared a cooldown rotation still held, or kept one rotation had ended.
for (const [what, skewMs, ended, warmed] of [
  ['ahead of', 10 * 60_000, false, 0],
  ['behind', -10 * 60_000, true, 1],
]) {
  test(`a warmer whose clock runs ${what} the account manager's reads the entitlement cooldown on the manager's clock`, async () => {
    const am = new AccountManager([oauth('denied')], 0.98);
    const until = am.markEntitlementDenied(0, { seconds: 300 });
    if (ended) am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
    const spawn = fakeSpawner();
    const log = console.log;
    console.log = () => {};
    try { await makeWarmer(am, spawn, { nowFn: () => Date.now() + skewMs }).warmAll(); } finally { console.log = log; }
    assert.equal(spawn.calls.length, warmed);
    if (!ended) {
      assert.equal(am.accounts[0].entitlementDeniedUntil, until, 'the cooldown rotation holds is left in place');
      assert.equal(am.isEntitlementDenied(0), true);
    }
  });
}

// ── spawn spec ───────────────────────────────────────────────────────────────

test('the spawn invocation is a minimal non-interactive claude pinned to the account', async () => {
  const am = new AccountManager([oauth('solo')], 0.98);
  const spawn = fakeSpawner();
  await makeWarmer(am, spawn, {
    port: 9999, apiKey: 'tc-secret', model: 'haiku', commandFn: () => 'claude',
  }).warmAll();

  const spec = spawn.calls[0];
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args, ['-p', '--bare', '--model', 'haiku', '--output-format', 'text', 'hi']);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999/tc-acct/solo');
  assert.equal(spec.env.ANTHROPIC_API_KEY, 'tc-secret');
});

test('warm-up pins distinguish one user across multiple organizations', async () => {
  const am = new AccountManager([
    oauth('person@example.com (Personal)', { accountUuid: 'account-1', orgUuid: 'org-personal' }),
    oauth('person@example.com (Work)', { accountUuid: 'account-1', orgUuid: 'org-work' }),
  ], 0.98);
  const spawn = fakeSpawner();

  await makeWarmer(am, spawn).warmAll();

  const resolved = spawn.calls.map(({ env }) => {
    const encodedPin = new URL(env.ANTHROPIC_BASE_URL).pathname.split('/').at(-1);
    return resolveAccountPin(am, decodeURIComponent(encodedPin));
  });
  assert.deepEqual(resolved, [0, 1]);
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

test('resolveClaudeCommand keeps the bare name when claude is already on PATH', () => {
  assert.equal(resolveClaudeCommand({
    pathEnv: '/usr/bin:/bin',
    home: '/Users/x',
    platform: 'darwin',
    exists: (p) => p === '/usr/bin/claude',
  }), 'claude');
});

test('resolveClaudeCommand uses the native binary when PATH has no claude', () => {
  assert.equal(resolveClaudeCommand({
    pathEnv: '/usr/bin:/bin',
    home: '/Users/x',
    platform: 'darwin',
    exists: (p) => p === '/Users/x/.local/bin/claude',
  }), '/Users/x/.local/bin/claude');
});

test('resolveClaudeCommand stays the bare name when claude is nowhere', () => {
  assert.equal(resolveClaudeCommand({
    pathEnv: '/usr/bin',
    home: '/Users/x',
    platform: 'linux',
    exists: () => false,
  }), 'claude');
});

test('resolveClaudeCommand finds a Windows native exe that is off PATH', () => {
  const native = 'C:\\Users\\x\\.local\\bin\\claude.exe';
  assert.equal(resolveClaudeCommand({
    pathEnv: 'C:\\Windows\\System32',
    home: 'C:\\Users\\x',
    platform: 'win32',
    exists: (p) => p === native,
  }), native);
});

test('a bare claude on Windows still goes through the shell, an absolute path does not', () => {
  assert.equal(claudeSpawnShell('claude', 'win32'), true);
  assert.equal(claudeSpawnShell('C:\\Users\\x\\.local\\bin\\claude.exe', 'win32'), false);
  assert.equal(claudeSpawnShell('/Users/x/.local/bin/claude', 'darwin'), false);
  assert.equal(claudeSpawnShell('claude', 'darwin'), false);
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

// The cooldown is asked about when the warm-up would be sent, not when the slot
// is scheduled: a rolling slot still defers an account in a cooldown, and the
// deferred warm-up asks again when it fires.
for (const [what, ended, warmed] of [
  ['has ended', true, true],
  ['is still running', false, false],
]) {
  test(`a rolling slot defers an account in its entitlement cooldown, and warms it only if the cooldown ${what}`, async () => {
    const am = new AccountManager([oauth('near'), oauth('idle')], 0.98);
    let now = Date.parse('2030-09-01T07:29:00.000Z');
    am.accounts[0].quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
    const spawn = fakeSpawner();
    const timers = [];
    const warmer = makeWarmer(am, spawn, {
      schedule: { mode: 'rolling', resetTime: '15:30', timezone: 'Europe/Moscow', anchorResetAt: '2030-09-01T12:30:00.000Z' },
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
    // On the account manager's clock, as a refused request writes it, not on the
    // warmer's injected one: the cooldown is the manager's to time.
    am.markEntitlementDenied(0, { seconds: 600 });
    await timers[0].fn();
    const deferred = timers.find(timer => timer.delay === 70_000);
    assert.ok(deferred, 'the near-reset account is still deferred until reset + 10s');

    now = Date.parse('2030-09-01T07:31:10.001Z');
    if (ended) am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
    const log = console.log;
    console.log = () => {};
    try { await deferred.fn(); } finally { console.log = log; }
    assert.equal(spawn.calls.some(call => /\/near$/.test(call.env.ANTHROPIC_BASE_URL)), warmed);
  });
}

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

// The "delaying" line promises a warm-up, so each way a delayed one ends unsent
// says why. The fixture is the deferral tests' above, logging into `lines`: each
// account resets within two minutes of the 07:30 slot, is delayed to
// 07:31:10.001, and has until 07:32:10.001 to go out; the clock is left at
// 07:31:10.001. With `holdRefresh` the token refresh, and with `holdFirstSpawn`
// the first spawn, waits for `release()`; `reached` resolves once it waits.
async function delayedWarmups(names, { holdRefresh = false, holdFirstSpawn = false, failSpawn = false } = {}) {
  const am = new AccountManager(names.map(name => oauth(name)), 0.98);
  const clock = { now: Date.parse('2030-09-01T07:29:00.000Z') };
  for (const account of am.accounts) account.quota.unified5hReset = Date.parse('2030-09-01T07:31:00.001Z');
  let release = () => {};
  const held = new Promise(resolve => { release = resolve; });
  let reach = () => {};
  const reached = new Promise(resolve => { reach = resolve; });
  if (holdRefresh) am.ensureTokenFresh = () => { reach(); return held; };
  const spawn = async (spec) => {
    spawn.calls.push(spec);
    if (holdFirstSpawn && spawn.calls.length === 1) { reach(); await held; }
    if (failSpawn) throw new Error('spawn claude ENOENT');
    return 0;
  };
  spawn.calls = [];
  const timers = [];
  const lines = [];
  const schedule = { mode: 'rolling', resetTime: '15:30', timezone: 'Europe/Moscow', anchorResetAt: '2030-09-01T12:30:00.000Z' };
  const warmer = makeWarmer(am, spawn, {
    schedule,
    nowFn: () => clock.now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
    log: line => lines.push(line),
  });
  warmer.start();
  clock.now = Date.parse('2030-09-01T07:30:00.001Z');
  await timers[0].fn();
  const deferred = timers.filter(timer => timer.delay === 70_000);
  assert.equal(deferred.length, names.length, 'each account is delayed until reset + 10s');
  clock.now = Date.parse('2030-09-01T07:31:10.001Z');
  const dropped = () => lines.filter(line => line.includes('Keep-warm dropped'));
  const sent = () => spawn.calls.map(call => call.env.ANTHROPIC_BASE_URL.split('/').at(-1));
  return { am, warmer, schedule, clock, deferred, release, reached, dropped, sent };
}

const dropLine = (name, why) => `[TeamClaude] Keep-warm dropped the delayed warm-up of "${name}" (${why})`;
const LATE = 'not sent by 2030-09-01T07:32:10.001Z';
const AFTER_ITS_MINUTE = Date.parse('2030-09-01T07:32:10.001Z');

for (const [what, names, opts, act, expected] of [
  ['its account started a new 5h window', ['near'], {}, async (w) => {
    w.am.accounts[0].quota.unified5hReset = w.clock.now + 5 * 60 * 60 * 1000;
    await w.deferred[0].fn();
  }, dropLine('near', '5h window already running')],
  ['its account is in an entitlement cooldown', ['near'], {}, async (w) => {
    w.am.markEntitlementDenied(0, { seconds: 600 });
    await w.deferred[0].fn();
  }, dropLine('near', 'entitlement cooldown')],
  ['its account was disabled', ['near'], {}, async (w) => {
    w.am.accounts[0].disabled = true;
    await w.deferred[0].fn();
  }, dropLine('near', 'no longer eligible')],
  // Removed in-process (the MCP remove_account does no reload, so nothing
  // cancels the delayed warm-up): its pin could resolve to another account.
  ['its account was removed', ['near'], {}, async (w) => {
    const log = console.log;
    console.log = () => {};
    try { w.am.removeAccount(0); } finally { console.log = log; }
    await w.deferred[0].fn();
  }, dropLine('near', 'account removed')],
  ['its timer fired a minute late', ['near'], {}, async (w) => {
    w.clock.now = AFTER_ITS_MINUTE;
    await w.deferred[0].fn();
  }, dropLine('near', LATE)],
  // The tests' clearTimeoutFn cancels nothing, so the old timer still fires: the
  // drop is logged once, by the reconfiguration, and not again by the timer.
  ['keep-warm was reconfigured', ['near'], {}, async (w) => {
    w.warmer.rescheduleSchedule(w.schedule);
    await w.deferred[0].fn();
  }, dropLine('near', 'keep-warm reconfigured')],
  ['keep-warm was stopped', ['near'], {}, async (w) => {
    w.warmer.stop();
    await w.deferred[0].fn();
  }, dropLine('near', 'keep-warm stopped')],
  // `warmup off` from a schedule: the reload turns the interval mode off.
  ['keep-warm was turned off', ['near'], {}, async (w) => {
    w.warmer.reschedule(0);
    await w.deferred[0].fn();
  }, dropLine('near', 'keep-warm reconfigured')],
  ['its token refresh outlived its minute', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    w.clock.now = AFTER_ITS_MINUTE;
    w.release();
    await retry;
  }, dropLine('near', LATE)],
  ['its account started a new 5h window during the token refresh', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    w.am.accounts[0].quota.unified5hReset = w.clock.now + 5 * 60 * 60 * 1000;
    w.release();
    await retry;
  }, dropLine('near', '5h window already running')],
  // Both hold by the time the refresh ends; the run stops on its minute first,
  // and the reason is read in that order.
  ['its token refresh outlived its minute while a new 5h window started', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    w.clock.now = AFTER_ITS_MINUTE;
    w.am.accounts[0].quota.unified5hReset = w.clock.now + 5 * 60 * 60 * 1000;
    w.release();
    await retry;
  }, dropLine('near', LATE)],
  // The clock moves on between the stand-down and the reason: the window the
  // run stood down on resets as soon as the stand-down has read it, so no check
  // fails by the time the reason is read.
  ['what stood it down is over when the reason is read', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    const resetAt = w.clock.now + 1;
    Object.defineProperty(w.am.accounts[0].quota, 'unified5hReset', {
      configurable: true,
      get() { w.clock.now = resetAt; return resetAt; },
    });
    w.release();
    await retry;
  }, dropLine('near', 'no longer a warm target')],
  ['keep-warm was reconfigured during the token refresh', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    w.warmer.rescheduleSchedule(null);
    w.release();
    await retry;
  }, dropLine('near', 'keep-warm reconfigured')],
  ['keep-warm was stopped during the token refresh', ['near'], { holdRefresh: true }, async (w) => {
    const retry = w.deferred[0].fn();
    await w.reached;
    w.warmer.stop();
    w.release();
    await retry;
  }, dropLine('near', 'keep-warm stopped')],
  ['it waited behind another delayed warm-up past its minute', ['first', 'second'], { holdFirstSpawn: true }, async (w) => {
    const first = w.deferred[0].fn();
    await w.reached;
    const second = w.deferred[1].fn(); // waits for the first to finish
    w.clock.now = AFTER_ITS_MINUTE;
    w.release();
    await Promise.all([first, second]);
  }, dropLine('second', LATE)],
  ['its account started a new 5h window while it waited behind another', ['first', 'second'], { holdFirstSpawn: true }, async (w) => {
    const first = w.deferred[0].fn();
    await w.reached;
    const second = w.deferred[1].fn();
    w.am.accounts[1].quota.unified5hReset = w.clock.now + 5 * 60 * 60 * 1000;
    w.release();
    await Promise.all([first, second]);
  }, dropLine('second', '5h window already running')],
]) {
  test(`a delayed warm-up dropped because ${what} says so in the log`, async () => {
    const w = await delayedWarmups(names, opts);
    await act(w);
    assert.deepEqual(w.dropped(), [expected]);
    assert.deepEqual(w.sent().filter(name => name !== 'first'), [], 'nothing was sent for the dropped account');
  });
}

// The cancel drops every pending warm-up, and says so for each.
test('stopping keep-warm with two delayed warm-ups pending says so for each', async () => {
  const w = await delayedWarmups(['first', 'second']);
  w.warmer.stop();
  assert.deepEqual(w.dropped(), [dropLine('first', 'keep-warm stopped'), dropLine('second', 'keep-warm stopped')]);
  assert.deepEqual(w.sent(), []);
});

// Controls: a delayed warm-up that goes out logs no drop, and neither does one
// whose outcome the status records - a rejected token refresh, a failed spawn.
test('a delayed warm-up that goes out logs no drop', async () => {
  const w = await delayedWarmups(['near']);
  await w.deferred[0].fn();
  assert.deepEqual(w.sent(), ['near']);
  assert.deepEqual(w.dropped(), []);
});

test('a delayed warm-up whose token refresh is rejected records the error and logs no drop', async () => {
  const w = await delayedWarmups(['near'], { holdRefresh: true });
  const retry = w.deferred[0].fn();
  await w.reached;
  w.am.accounts[0].status = 'error';
  w.release();
  await retry;
  assert.deepEqual(w.sent(), []);
  assert.deepEqual(w.dropped(), []);
  assert.equal(w.warmer.getStatus().accounts[0].status, 'error');
});

test('a delayed warm-up whose spawn fails records the error and logs no drop', async () => {
  const w = await delayedWarmups(['near'], { failSpawn: true });
  await w.deferred[0].fn();
  assert.deepEqual(w.sent(), ['near']);
  assert.deepEqual(w.dropped(), []);
  assert.equal(w.warmer.getStatus().accounts[0].status, 'error');
});

// A config reload re-reads the whole file whatever changed in it, and hands the
// warmer the schedule it found (index.js). One that left the schedule as it was
// must leave keep-warm running; one that changed it reschedules, as before.
const ROLLING = { mode: 'rolling', resetTime: '15:30', timezone: 'Europe/Moscow', anchorResetAt: '2030-09-01T12:30:00.000Z' };
const DAILY = { resetTime: '15:30', timezone: 'Europe/Moscow' };

// Both schedules warm at 07:30Z on 2030-09-01. The slot's sweep over two idle
// accounts is held on its first spawn until `release()`.
async function heldSlot(schedule) {
  const am = new AccountManager([oauth('first'), oauth('second')], 0.98);
  am.ensureTokenFresh = async () => {};
  const clock = { now: Date.parse('2030-09-01T07:29:00.000Z') };
  let release = () => {};
  const held = new Promise(resolve => { release = resolve; });
  let reach = () => {};
  const reached = new Promise(resolve => { reach = resolve; });
  const spawn = async (spec) => {
    spawn.calls.push(spec);
    if (spawn.calls.length === 1) { reach(); await held; }
    return 0;
  };
  spawn.calls = [];
  const timers = [];
  const warmer = makeWarmer(am, spawn, {
    schedule,
    nowFn: () => clock.now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  clock.now = Date.parse('2030-09-01T07:30:00.001Z');
  const slot = timers[0].fn();
  await reached;
  const sent = () => spawn.calls.map(call => call.env.ANTHROPIC_BASE_URL.split('/').at(-1));
  return { warmer, release, slot, sent, inFlight: spawn.calls[0].signal };
}

for (const [what, schedule, reloaded] of [
  ['the same rolling schedule', ROLLING, { ...ROLLING }],
  ['the same daily schedule', DAILY, { ...DAILY }],
  ['the same daily schedule, its mode spelled null', DAILY, { ...DAILY, mode: null }],
]) {
  test(`a reload with ${what} leaves the running sweep alone`, async () => {
    const s = await heldSlot(schedule);
    s.warmer.reloadSchedule(reloaded);
    assert.equal(s.inFlight.aborted, false, 'the warm-up in flight is not killed');
    s.release();
    await s.slot;
    assert.deepEqual(s.sent(), ['first', 'second'], 'the rest of the sweep still goes out');
  });
}

test('a reload with the same schedule leaves the delayed warm-ups alone', async () => {
  const w = await delayedWarmups(['first', 'second']);
  w.warmer.reloadSchedule({ ...w.schedule });
  for (const timer of w.deferred) await timer.fn();
  assert.deepEqual(w.dropped(), []);
  assert.deepEqual(w.sent(), ['first', 'second']);
});

// Off or in interval mode there is no schedule to compare with, so it is armed.
test('a reload that brings a schedule to a warmer without one arms it', async () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const now = Date.parse('2030-09-01T07:29:00.000Z');
  const timers = [];
  const warmer = makeWarmer(am, fakeSpawner(), {
    nowFn: () => now,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  warmer.start();
  warmer.reloadSchedule(ROLLING);
  assert.equal(warmer.getStatus().mode, 'rolling');
  assert.equal(warmer.getStatus().nextWarmupAt, '2030-09-01T07:30:00.000Z');
  assert.equal(timers.length, 1);
});

// Guards: a schedule that differs in any field still reschedules. The mode
// alone: the rolling fields kept, read as a daily schedule.
for (const [field, schedule, changed] of [
  ['mode', ROLLING, { ...ROLLING, mode: undefined }],
  ['anchor', ROLLING, { ...ROLLING, anchorResetAt: '2030-09-02T12:30:00.000Z' }],
  ['reset time', DAILY, { ...DAILY, resetTime: '16:30' }],
  ['timezone', DAILY, { ...DAILY, timezone: 'Europe/Istanbul' }],
]) {
  test(`a reload that changes the schedule's ${field} reschedules it`, async () => {
    const s = await heldSlot(schedule);
    s.warmer.reloadSchedule(changed);
    assert.equal(s.inFlight.aborted, true, 'the old schedule\'s sweep is cut short');
    assert.equal(s.warmer.schedule, changed);
    s.release();
    await s.slot;
  });
}

test('a reload that changes the schedule drops its delayed warm-ups as reconfigured', async () => {
  const w = await delayedWarmups(['first', 'second']);
  w.warmer.reloadSchedule({ ...w.schedule, anchorResetAt: '2030-09-02T12:30:00.000Z' });
  assert.deepEqual(w.dropped(), [dropLine('first', 'keep-warm reconfigured'), dropLine('second', 'keep-warm reconfigured')]);
});

// The sweep picks its targets when it starts; one removed before its turn is
// not warmed, since its pin could resolve to another account.
test('an account removed while a sweep is running is not warmed', async () => {
  const s = await heldSlot(ROLLING);
  const log = console.log;
  console.log = () => {};
  try { s.warmer.am.removeAccount(1); } finally { console.log = log; }
  s.release();
  await s.slot;
  assert.deepEqual(s.sent(), ['first']);
});

// Guards on the removal check: an account after the removed one is renumbered
// in place, so it is still the manager's at its new index, and still warmed.
test('an account renumbered by an earlier removal mid-sweep is still warmed', async () => {
  const s = await heldSlot(ROLLING);
  const log = console.log;
  console.log = () => {};
  try { s.warmer.am.removeAccount(0); } finally { console.log = log; }
  s.release();
  await s.slot;
  assert.deepEqual(s.sent(), ['first', 'second']);
});

test('a delayed warm-up of an account renumbered by an earlier removal still goes out', async () => {
  const w = await delayedWarmups(['first', 'second']);
  const log = console.log;
  console.log = () => {};
  try { w.am.removeAccount(0); } finally { console.log = log; }
  for (const timer of w.deferred) await timer.fn();
  assert.deepEqual(w.sent(), ['second']);
  assert.deepEqual(w.dropped(), [dropLine('first', 'account removed')]);
});

// A bad hand edit still fails the reload and leaves the schedule running.
test('a reload with an invalid schedule throws and keeps the running one', async () => {
  const s = await heldSlot(ROLLING);
  assert.throws(() => s.warmer.reloadSchedule({ ...ROLLING, timezone: 'Moscow' }), /invalid IANA timezone/);
  assert.equal(s.inFlight.aborted, false);
  assert.equal(s.warmer.schedule, ROLLING);
  s.release();
  await s.slot;
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
