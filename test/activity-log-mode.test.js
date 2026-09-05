import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { TUI } from '../src/tui.js';

// The activity log names which client made each call, so on a shared host it is
// the record that says who was working on what and when. Every sibling file —
// config, state, request log and its directory — is already 0600; this one was
// left at the process umask, typically 0644 (#259).
//
// The mode is asserted through the same createWriteStream call the server makes,
// under an umask that would otherwise widen it.

const MODE = 0o600;

async function withUmask(mask, fn) {
  const prev = process.umask(mask);
  try { return await fn(); } finally { process.umask(prev); }
}

test('a new activity log is created 0600 even under a permissive umask', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-act-'));
  try {
    const path = join(dir, 'activity.log');
    await withUmask(0o000, async () => {
      const s = createWriteStream(path, { flags: 'a', mode: 0o600 });
      s.write('x\n');
      s.end();
      await once(s, 'close');
    });
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, MODE, `expected 0600, got 0${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the TUI opens its activity log 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-act-'));
  try {
    const path = join(dir, 'tui-activity.log');
    const am = {
      accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
      currentIndex: 0, switchThreshold: 0.98,
      getRoutes: () => [], sessionStats: () => ({ active: 0, total: 0 }),
      getStatus: () => ({ accounts: [] }), refreshExpiredQuotas: () => {},
    };
    const tui = new TUI({
      accountManager: am,
      config: { proxy: { port: 1 }, accounts: [], routes: [], blockedModels: [] },
      saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
      activityLogPath: path,
    });
    await withUmask(0o000, async () => { tui._openActivityLog(); });
    assert.ok(tui._activityStream, 'the TUI should have opened its activity stream');
    tui._activityStream.end();
    await once(tui._activityStream, 'close');
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, MODE, `expected 0600, got 0${mode.toString(8)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Mode applies on creation only. A file the operator already placed keeps the
// permissions they chose, rather than being silently chmod'ed underneath them.
test('an existing log file is not re-chmoded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-act-'));
  try {
    const path = join(dir, 'existing.log');
    await writeFile(path, 'old\n');
    await chmod(path, 0o644);
    const s = createWriteStream(path, { flags: 'a', mode: 0o600 });
    s.write('new\n'); s.end();
    await once(s, 'close');
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
