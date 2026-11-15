import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server (token refresh), the CLI (login/import/priority/...) and a GUI
// client all rewrite the config with a temp+rename. Two of them racing keep only
// the later write, and the edit that is lost is as likely as not a freshly
// rotated refresh token — which costs a re-login. Writers therefore hold an
// advisory lock file, `<config>.lock`, across the read-modify-write. These pin
// the protocol other clients interoperate with: exclusive create, a JSON body
// of {pid, at}, staleness by age or dead pid, a bounded wait, and that the lock
// is advisory — a writer that cannot get it still writes.

// `lockWaitMs` is the wait budget for the run, when a test's assertions depend
// on it: a test that must observe a release before the budget runs out gets a
// budget no scheduler stall can exhaust; a test of the budget itself gets a
// short one, so it is fast and its lower bound is the only timing it asserts.
async function withConfigDir(fn, { lockWaitMs = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-lock-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  const prevWait = process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS;
  const path = join(dir, 'teamclaude.json');
  process.env.TEAMCLAUDE_CONFIG = path;
  if (lockWaitMs != null) process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS = String(lockWaitMs);
  else delete process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS;
  try {
    const cfg = await import('../src/config.js');
    await writeFile(path, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [] }));
    await fn({ dir, cfg, path, lockPath: `${path}.lock` });
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    if (prevWait === undefined) delete process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS;
    else process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS = prevWait;
  }
}

// The bypass warning is the one observable difference between a write that
// waited for the holder and one that gave up on it.
function captureBypassWarnings() {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => {
    const line = args.join(' ');
    if (/is still held by another process/.test(line)) warnings.push(line);
    else origError(...args);
  };
  return { warnings, restore: () => { console.error = origError; } };
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf-8'));

// A pid that no process has: a child that has already exited.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('exit', resolve));
  return child.pid;
}

test('two concurrent atomicConfigUpdate calls both land', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await Promise.all([
      cfg.atomicConfigUpdate(config => { config.first = 1; }),
      cfg.atomicConfigUpdate(config => { config.second = 2; }),
    ]);
    const on = await readJson(path);
    assert.equal(on.first, 1);
    assert.equal(on.second, 2);
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'no lock or temp file remains');
  });
});

test('a lock older than 10 s is broken even though its pid is alive', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'a stale lock is broken, not waited out and bypassed');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'the stale lock is gone');
  });
});

test('a fresh lock whose pid is dead is broken', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'a dead holder\'s lock is broken, not waited out and bypassed');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
  });
});

test('a live lock held by another process delays the write until it is released', async () => {
  // A budget no stall of this process can run out: the write below must be
  // seen to wait for the release, never to give up on it.
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    // The other writer: takes the lock exactly as we do, holds it until told
    // to let go (a byte on stdin), and releases. Event-driven rather than
    // timed, so what the test observes is ordering, not the scheduler.
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      process.stdout.write('locked\\n');
      process.stdin.once('data', () => { fs.unlinkSync(process.argv[1]); process.exit(0); });
    `, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => holder.on('exit', resolve));
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });

    const { warnings, restore } = captureBypassWarnings();
    try {
      const write = cfg.saveConfig({ fresh: true });
      // While the holder has the lock, the write has not happened: the file
      // still carries what withConfigDir put there.
      await new Promise(r => setTimeout(r, 100));
      assert.deepEqual(await readJson(path), { proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [] }, 'the write waited for the holder');
      holder.stdin.write('go\n');
      await write;
    } finally {
      restore();
    }
    assert.deepEqual(warnings, [], 'the write went through on the release, not by giving up on the lock');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.equal(await exited, 0, 'the holder unlinked its own lock; nobody removed it from under it');
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
  }, { lockWaitMs: 600_000 });
});

test('the lock is released after a success and after a throwing mutator', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await cfg.atomicConfigUpdate(config => { config.ok = true; });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'released after success');

    await assert.rejects(cfg.atomicConfigUpdate(() => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'released after a throw');
    assert.equal((await readJson(path)).ok, true, 'the failed update wrote nothing');

    // And the next writer is not held up by anything the failure left behind.
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ after: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'nothing left behind was waited out');
    assert.deepEqual(await readJson(path), { after: true });
  });
});

test('a lock that stays held past the wait budget is bypassed with one warning, and left in place', async () => {
  // A short budget: what is asserted is that the writer waited at least that
  // long and then gave up with one warning. How much later it actually ran is
  // the scheduler's, not the code's, so no upper bound.
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    // Fresh, and the pid is alive (ours): nothing lets a writer break it.
    const body = { pid: process.pid, at: Date.now() };
    await writeFile(lockPath, JSON.stringify(body));
    const { warnings, restore } = captureBypassWarnings();
    try {
      const started = Date.now();
      await cfg.saveConfig({ fresh: true });
      const waited = Date.now() - started;
      assert.ok(waited >= 200, `gave up no sooner than the budget (waited ${waited}ms)`);
    } finally {
      restore();
    }
    assert.deepEqual(await readJson(path), { fresh: true }, 'the write still landed');
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /teamclaude\.json\.lock is still held by another process after 200ms/);
    assert.deepEqual(await readJson(lockPath), body, 'the other holder\'s lock was not touched');
  }, { lockWaitMs: 200 });
});

test('a waiter that judged a lock stale does not remove the fresh lock a faster waiter has since taken', async () => {
  // Two waiters find a dead holder's lock. A breaks it and takes the lock; B,
  // which had already judged the old lock stale, must not then unlink A's. The
  // interleaving is forced at the one point where B has read the stale lock but
  // not yet acted: B's liveness probe of the dead pid. There, this test plays
  // out all of A (break the stale lock, take a fresh one) before B resumes.
  await withConfigDir(async ({ cfg, lockPath }) => {
    const dead = await deadPid();
    writeFileSync(lockPath, JSON.stringify({ pid: dead, at: Date.now() }));
    // A is a live process that holds the lock and never lets go within the test.
    const holder = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] });
    const aBody = { pid: holder.pid, at: Date.now() };
    const realKill = process.kill;
    let interleaved = false;
    mock.method(process, 'kill', (pid, signal) => {
      if (pid === dead && !interleaved) {
        interleaved = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, JSON.stringify(aBody), { flag: 'wx' });
      }
      return realKill(pid, signal);
    });
    const { warnings, restore } = captureBypassWarnings();
    let lockDuringUpdate;
    try {
      await cfg.atomicConfigUpdate(async () => {
        lockDuringUpdate = await readFile(lockPath, 'utf-8').catch(err => err.code);
      });
    } finally {
      restore();
      mock.restoreAll();
      holder.kill();
      await new Promise(resolve => holder.on('exit', resolve));
    }
    assert.ok(interleaved, 'the interleaving point was reached');
    assert.equal(lockDuringUpdate, JSON.stringify(aBody), 'A\'s fresh lock was left standing, not unlinked by B');
    assert.equal(warnings.length, 1, 'B waited out the live holder and gave up once: ' + warnings.join('\n'));
  }, { lockWaitMs: 200 });
});

test('a steal guard left by a crashed waiter does not block breaking a stale lock', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    writeFileSync(lockPath, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
    const guardPath = `${lockPath}.steal`;
    writeFileSync(guardPath, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(guardPath, old, old);
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'recovered without bypassing the lock');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'neither lock nor guard remains');
  }, { lockWaitMs: 600_000 });
});

test('a stale lock that cannot be removed falls back to the wait budget instead of spinning', async () => {
  // A non-empty directory at the lock path reads as garbled and old (stale) but
  // unlink refuses it, as it would a stale lock owned by another user in a
  // sticky directory. The waiter must give up at the budget, not retry forever.
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'keep'), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.deepEqual(await readJson(path), { fresh: true }, 'the write still landed');
    assert.deepEqual(await readdir(lockPath), ['keep'], 'the unremovable lock was left alone');
  }, { lockWaitMs: 200 });
});

test('a waiter does not break a stale lock while another waiter holds the break guard', async () => {
  // The other breaker appears at the moment this waiter has judged the lock
  // stale: the guard, not the re-judge, is what must keep this waiter's hands off.
  await withConfigDir(async ({ cfg, lockPath }) => {
    const dead = await deadPid();
    const body = { pid: dead, at: Date.now() };
    writeFileSync(lockPath, JSON.stringify(body));
    const realKill = process.kill;
    let interleaved = false;
    mock.method(process, 'kill', (pid, signal) => {
      if (pid === dead && !interleaved) {
        interleaved = true;
        writeFileSync(`${lockPath}.steal`, '', { flag: 'wx' });
      }
      return realKill(pid, signal);
    });
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); mock.restoreAll(); }
    assert.ok(interleaved, 'the interleaving point was reached');
    assert.deepEqual(await readJson(lockPath), body, 'the lock was not broken under the other breaker');
    assert.equal(warnings.length, 1, warnings.join('\n'));
  }, { lockWaitMs: 200 });
});
