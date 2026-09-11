import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

async function withConfigDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-lock-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  const path = join(dir, 'teamclaude.json');
  process.env.TEAMCLAUDE_CONFIG = path;
  try {
    const cfg = await import('../src/config.js');
    await writeFile(path, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [] }));
    await fn({ dir, cfg, path, lockPath: `${path}.lock` });
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
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
    const started = Date.now();
    await cfg.saveConfig({ fresh: true });
    assert.ok(Date.now() - started < 1000, 'a stale lock does not cost the 2 s wait');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'the stale lock is gone');
  });
});

test('a fresh lock whose pid is dead is broken', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
    const started = Date.now();
    await cfg.saveConfig({ fresh: true });
    assert.ok(Date.now() - started < 1000, 'a dead holder does not cost the 2 s wait');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
  });
});

test('a live lock held by another process delays the write until it is released', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    // The other writer: takes the lock exactly as we do, holds it 500 ms, releases.
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      process.stdout.write('locked\\n');
      setTimeout(() => fs.unlinkSync(process.argv[1]), 500);
    `, lockPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => holder.on('exit', resolve));
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });

    const started = Date.now();
    await cfg.saveConfig({ fresh: true });
    const waited = Date.now() - started;
    assert.ok(waited >= 400, `the write waited for the holder (waited ${waited}ms)`);
    assert.ok(waited < 1500, `the write went through as soon as the lock was released, not at the 2 s cap (waited ${waited}ms)`);
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.equal(await exited, 0, 'the holder unlinked its own lock; nobody removed it from under it');
    assert.deepEqual(await readdir(dir), ['teamclaude.json']);
  });
});

test('the lock is released after a success and after a throwing mutator', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await cfg.atomicConfigUpdate(config => { config.ok = true; });
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'released after success');

    await assert.rejects(cfg.atomicConfigUpdate(() => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(await readdir(dir), ['teamclaude.json'], 'released after a throw');
    assert.equal((await readJson(path)).ok, true, 'the failed update wrote nothing');

    // And the next writer is not held up by anything the failure left behind.
    const started = Date.now();
    await cfg.saveConfig({ after: true });
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(await readJson(path), { after: true });
  });
});

test('a lock that stays held past the 2 s budget is bypassed with one warning, and left in place', async () => {
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    // Fresh, and the pid is alive (ours): nothing lets a writer break it.
    const body = { pid: process.pid, at: Date.now() };
    await writeFile(lockPath, JSON.stringify(body));
    const warnings = [];
    const origError = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    try {
      const started = Date.now();
      await cfg.saveConfig({ fresh: true });
      const waited = Date.now() - started;
      assert.ok(waited >= 1900 && waited < 4000, `gave up at the budget, not before and not much after (waited ${waited}ms)`);
    } finally {
      console.error = origError;
    }
    assert.deepEqual(await readJson(path), { fresh: true }, 'the write still landed');
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /teamclaude\.json\.lock is still held/);
    assert.deepEqual(await readJson(lockPath), body, 'the other holder\'s lock was not touched');
  });
});
