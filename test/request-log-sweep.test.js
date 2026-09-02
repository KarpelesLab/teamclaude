import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveLogRetentionHours, sweepRequestLogs } from '../src/server.js';

// The name openRequestLog produces, for a given local wall-clock time.
function logName(d, reqId = 1) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${stamp}_${String(reqId).padStart(5, '0')}.log`;
}

const HOUR = 3600_000;

// Deletion needs the name AND the mtime to be past the cutoff, so a fixture has
// to age both; writing a file leaves it with a fresh mtime whatever its name says.
function write(dir, name, mtimeAgeHours) {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  const at = new Date(Date.now() - mtimeAgeHours * HOUR);
  utimesSync(path, at, at);
  return path;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-sweep-'));
  const now = Date.now();
  const old = logName(new Date(now - 240 * HOUR), 1);
  const recent = logName(new Date(now - 1 * HOUR), 2);
  const buried = logName(new Date(now - 240 * HOUR), 3);
  const skewed = logName(new Date(now - 240 * HOUR), 4);
  write(dir, old, 240);
  write(dir, recent, 1);
  write(dir, 'notes.txt', 240);
  write(dir, 'README.md', 240);
  write(dir, `${old}.bak`, 240);
  write(dir, skewed, 0);
  mkdirSync(join(dir, 'sub'));
  write(join(dir, 'sub'), buried, 240);
  return { dir, now, old, recent, buried, skewed };
}

test('the sweep deletes only expired files it wrote itself', async () => {
  const { dir, now, old, recent, buried, skewed } = fixture();
  try {
    await sweepRequestLogs(dir, 72, now);

    const left = readdirSync(dir).sort();
    assert.ok(!left.includes(old), 'the expired request log is gone');
    assert.deepEqual(left, [`${old}.bak`, 'README.md', 'notes.txt', recent, skewed, 'sub'].sort());
    assert.deepEqual(readdirSync(join(dir, 'sub')), [buried], 'the sweep does not recurse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logRetentionHours 0 disables the sweep entirely', async () => {
  const { dir, now, old } = fixture();
  try {
    const before = readdirSync(dir).sort();
    await sweepRequestLogs(dir, 0, now);
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.ok(before.includes(old), 'even a long-expired file survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every shape an operator can put in this key. This is the setting that
// deletes files, so the effect of each input is spelled out rather than
// inferred: a quoted "0" keeps everything, a quoted "720" is honoured, and
// anything unreadable falls back to the default window.
test('resolveLogRetentionHours reads each input shape', () => {
  const at = (logRetentionHours) => resolveLogRetentionHours({ logRetentionHours });
  assert.equal(at(0), 0);
  assert.equal(at('0'), 0);
  assert.equal(at(''), 72);
  assert.equal(at('   '), 72);
  assert.equal(at(12), 12);
  assert.equal(at('720'), 720);
  assert.equal(at(-5), 72);
  assert.equal(at('week'), 72);
  assert.equal(at(null), 72);
  assert.equal(at(true), 72);
  assert.equal(resolveLogRetentionHours({}), 72);
  assert.equal(resolveLogRetentionHours(null), 72);
});

// Pins the startup sweep wired into createProxyServer, which is the only code
// here that deletes a file. The interval and its teardown are not covered:
// reaching them needs fake timers, and the sweep they call is pinned above.
test('a server with a logDir sweeps it once at startup', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-sweep-wiring-'));
  const now = Date.now();
  const expired = logName(new Date(now - 240 * HOUR), 1);
  const fresh = logName(new Date(now - 1 * HOUR), 2);
  write(dir, expired, 240);
  write(dir, fresh, 1);

  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com', logDir: dir,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const deadline = Date.now() + 5000;
    while (readdirSync(dir).includes(expired) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    const left = readdirSync(dir);
    assert.ok(!left.includes(expired), 'the startup sweep removed the expired log');
    assert.ok(left.includes(fresh), 'the fresh log survives');
  } finally {
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sweep reports nothing removed when the directory cannot be read', async () => {
  const missing = join(tmpdir(), `tc-sweep-absent-${Date.now()}`);
  assert.equal(await sweepRequestLogs(missing, 72), 0);
});

// The filename carries a local wall clock; a machine that changes timezone can
// make a recent file look expired by hours. mtime is absolute and decides.
test('a file whose name looks expired but whose mtime is fresh is kept', async () => {
  const { dir, now, skewed } = fixture();
  try {
    await sweepRequestLogs(dir, 72, now);
    assert.ok(readdirSync(dir).includes(skewed), 'mtime disagreed with the name, so the file stayed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
