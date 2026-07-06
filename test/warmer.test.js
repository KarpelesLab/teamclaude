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
  assert.match(spawn.calls[0].env.ANTHROPIC_BASE_URL, /\/tc-acct\/0$/, 'pinned the idle account (index 0)');
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
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999/tc-acct/0');
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
