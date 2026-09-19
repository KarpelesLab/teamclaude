import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCrashLogPath } from '../src/config.js';

const CRASH_LOG = fileURLToPath(new URL('../src/crash-log.js', import.meta.url));

// The handlers end the process, so they can only be exercised from a child.
// Returns { code, stderr, logged } — the last being what survived on disk.
function crashIn(dir, source) {
  const path = join(dir, 'crash.log');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval',
        `import { installCrashHandlers } from ${JSON.stringify(CRASH_LOG)};
         installCrashHandlers(${JSON.stringify(path)});
         ${source}`],
      async (err, _stdout, stderr) => {
        const logged = await readFile(path, 'utf-8').catch(() => '');
        resolve({ code: err?.code ?? 0, stderr, logged });
      },
    );
  });
}

test('an uncaught exception is recorded before the process dies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-crash-'));
  try {
    const { code, stderr, logged } = await crashIn(dir, 'setTimeout(() => { throw new Error("boom"); }, 0);');
    assert.equal(code, 1);                       // still exits like Node would
    assert.match(logged, /uncaughtException/);
    assert.match(logged, /Error: boom/);
    assert.match(logged, /at /);                 // the stack, not just the message
    assert.match(stderr, /Error: boom/);         // and stderr keeps working
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A rejected promise nobody handles kills the process the same way an uncaught
// exception does, and is just as invisible under the TUI.
test('an unhandled rejection is recorded too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-crash-'));
  try {
    const { code, logged } = await crashIn(dir, 'Promise.reject(new Error("nope"));');
    assert.equal(code, 1);
    assert.match(logged, /unhandledRejection/);
    assert.match(logged, /Error: nope/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Successive crashes must accumulate: the interesting one is often the first,
// and a restart loop would otherwise overwrite it.
test('crashes append rather than overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-crash-'));
  try {
    await crashIn(dir, 'throw new Error("first");');
    const { logged } = await crashIn(dir, 'throw new Error("second");');
    assert.match(logged, /Error: first/);
    assert.match(logged, /Error: second/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the crash log sits next to the config', () => {
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = '/tmp/somewhere/teamclaude.json';
  try {
    assert.equal(getCrashLogPath(), '/tmp/somewhere/teamclaude-crash.log');
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
  }
});
