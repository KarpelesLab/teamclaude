import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStatusLine, stopHookOutput, moveCommand, EMPTY_NOTICE_STATE } from '../src/claude-code-surface.js';
import { stopHookTurn } from '../src/advice-notice-state.js';
import { sanitizeText } from '../src/safe-text.js';

/**
 * A session-advice reply as GET /teamclaude/session-advice answers it.
 * @param {string} reason
 * @param {{ account?: string, via?: 'manual'|'affinity', to?: string|null, ask?: boolean, enabled?: boolean, reread?: number|null }} [o]
 */
function adv(reason, { account = 'A', via = 'affinity', to = null, ask = false, enabled = true, reread = 4200 } = {}) {
  return {
    account, via, context: reread,
    advice: { enabled, ask },
    recommendation: to ? { to, reread } : null,
    reason,
  };
}

const QUOTA = {
  accounts: [
    { name: 'A', buckets: { weeklyShared: { utilization: 0.9 } } },
    { name: 'B', buckets: { weeklyShared: { utilization: 0.25 } } },
    { name: 'C', buckets: { weeklyShared: null } },
  ],
  aggregate: { weeklyShared: { utilization: 0.4 } },
};

test('the status line shows the account, weekly usage per account, and a move only when advised (AC7)', () => {
  assert.equal(renderStatusLine(adv('in-band'), QUOTA), 'on A | A 90% · B 25% · C -');
  assert.equal(renderStatusLine(adv('out-of-band', { to: 'B' }), QUOTA), 'on A | A 90% · B 25% · C - | move to B');
  assert.equal(renderStatusLine(adv('disabled', { enabled: false }), QUOTA), 'on A | A 90% · B 25% · C -',
    'with the feature off it still shows the account and usage');
  assert.equal(renderStatusLine(adv('pinned-unavailable', { via: 'manual', to: 'B' }), QUOTA),
    'on A (pinned) | A 90% · B 25% · C - | pinned account unavailable, move to B');
  assert.equal(renderStatusLine(adv('pinned-unavailable', { via: 'manual' }), QUOTA),
    'on A (pinned) | A 90% · B 25% · C - | pinned account unavailable');
});

test('without the session\'s account the status line shows fleet usage and says so (AC7)', () => {
  assert.equal(renderStatusLine(null, QUOTA), 'session unknown | fleet 40% | A 90% · B 25% · C -');
  assert.equal(renderStatusLine(adv('unknown-session', { account: /** @type {any} */ (null) }), QUOTA),
    'session unknown | fleet 40% | A 90% · B 25% · C -');
  assert.equal(renderStatusLine(adv('in-band'), null), 'on A', 'quota unread: the account alone');
  assert.equal(renderStatusLine(null, null), 'teamclaude offline', 'no server: a neutral line, not an error');
});

test('the Stop hook notices each transition once, through the full sequence (AC8)', () => {
  /** @type {[ReturnType<typeof adv>, boolean][]} */
  const steps = [
    [adv('out-of-band', { to: 'B' }), true],
    [adv('out-of-band', { to: 'B' }), false],
    [adv('out-of-band', { to: 'C' }), false], // a new destination alone is not news
    [adv('in-band'), false], // clears outOfBand
    [adv('out-of-band', { to: 'B' }), true],
    [adv('pinned-unavailable', { account: 'B', via: 'manual', to: 'C' }), true], // pinned to B, B blocked
    [adv('cooldown', { account: 'B', via: 'manual' }), false],
    [adv('pinned-unavailable', { account: 'B', via: 'manual', to: 'C' }), false], // B flaps: not again
    [adv('pinned-unavailable', { account: 'C', via: 'manual', to: 'D' }), true], // pinned to C, C blocked
    [adv('cooldown', { account: 'C', via: 'manual' }), false], // C recovers
    [adv('cooldown', { account: 'D', via: 'manual' }), false], // /switch D: a usable new pin clears pinnedAnnounced
    [adv('cooldown', { account: 'C', via: 'manual' }), false], // /switch C
    [adv('pinned-unavailable', { account: 'C', via: 'manual', to: 'D' }), true], // C blocked again: noticed
  ];
  let state = null;
  steps.forEach(([advice, noticed], i) => {
    const { output, nextState } = stopHookOutput(advice, state);
    assert.equal(output != null, noticed, `step ${i + 1} (${advice.reason} on ${advice.account})`);
    state = nextState;
  });
  assert.deepEqual(state, { outOfBand: false, pinnedAnnounced: 'C' });
});

test('the hook state carries two fields and the notice names the move', () => {
  const first = stopHookOutput(adv('out-of-band', { to: 'B' }), null);
  assert.deepEqual(first.nextState, { outOfBand: true, pinnedAnnounced: null });
  assert.deepEqual(Object.keys(first.output ?? {}), ['systemMessage']);
  assert.match(/** @type {any} */ (first.output).systemMessage, /from "A" to "B".*4200 tokens.*teamclaude switch --session --to B,/);
  const pinned = stopHookOutput(adv('pinned-unavailable', { via: 'manual' }), null);
  assert.match(/** @type {any} */ (pinned.output).systemMessage, /^teamclaude: the pinned account "A" cannot serve this session\..*--clear/);
  const quoted = stopHookOutput(adv('out-of-band', { to: 'bob (Acme)' }), null);
  assert.match(/** @type {any} */ (quoted.output).systemMessage, /teamclaude switch --session --to 'bob \(Acme\)',/);
});

const EVIL = 'ev$(touch pwned)`touch pwned2`$HOME it\'s "d"\nnext';

/** A printed `teamclaude …` command as a POSIX shell parses it: its argv, with `teamclaude` stubbed.
 * @param {string} command @param {string} cwd */
const shellArgv = (command, cwd) => execFileSync('sh', ['-c', `teamclaude() { printf '%s\\0' "$@"; }; ${command}`], { cwd, encoding: 'utf8' })
  .split('\0').slice(0, -1);

test('an account name reaches the hook text as one line and the shell as one word', async () => {
  const evil = EVIL;
  const clean = sanitizeText(evil);
  const dir = await mkdtemp(join(tmpdir(), 'tc-shell-'));
  try {
    for (const ask of [false, true]) {
      const out = /** @type {any} */ (stopHookOutput(adv('out-of-band', { account: evil, to: evil, ask }), null).output);
      const text = ask ? out.reason : out.systemMessage;
      assert.doesNotMatch(text, /\n/);
      const command = /(teamclaude switch --session --to .+?)(?:, or keep|\. To keep)/.exec(text)?.[1] ?? '';
      // The command as printed, run by a POSIX shell: one argument, nothing expanded.
      assert.deepEqual(shellArgv(command, dir), ['switch', '--session', '--to', clean]);
    }
    const sid = '3f2a1b9c-0000-4000-8000-000000000001';
    assert.deepEqual(shellArgv(/** @type {string} */ (moveCommand(adv('out-of-band', { to: evil }), sid)), dir),
      ['switch', '--session', sid, '--to', clean], 'the report\'s ready-to-run command');
    assert.equal(moveCommand(adv('in-band'), sid), null, 'no move, no command');
    assert.deepEqual(await readdir(dir), [], 'no command substitution ran');
    const pinned = /** @type {any} */ (stopHookOutput(adv('pinned-unavailable', { account: evil, via: 'manual', to: evil }), null).output);
    assert.doesNotMatch(pinned.systemMessage, /\n/);
    assert.doesNotMatch(renderStatusLine(adv('out-of-band', { account: evil, to: evil }), QUOTA), /\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('router-moves shows no move and clears the out-of-band notice', () => {
  assert.equal(renderStatusLine(adv('router-moves'), QUOTA), 'on A | A 90% · B 25% · C -');
  const { output, nextState } = stopHookOutput(adv('router-moves'), { outOfBand: true, pinnedAnnounced: null });
  assert.equal(output, null);
  assert.deepEqual(nextState, { outOfBand: false, pinnedAnnounced: null });
});

test('with sessionAdvice off the Stop hook prints nothing and keeps its state', () => {
  const state = { outOfBand: true, pinnedAnnounced: 'B' };
  const { output, nextState } = stopHookOutput(adv('disabled', { enabled: false }), state);
  assert.equal(output, null);
  assert.equal(nextState, state);
  assert.deepEqual(stopHookOutput(null, null), { output: null, nextState: EMPTY_NOTICE_STATE });
});

test('the hook blocks only for an out-of-band move with ask on, never for a dead pin (AC10)', () => {
  const quiet = stopHookOutput(adv('out-of-band', { to: 'B', ask: false }), null).output;
  assert.ok(quiet && !('decision' in quiet) && 'systemMessage' in quiet);
  const asked = /** @type {any} */ (stopHookOutput(adv('out-of-band', { to: 'B', ask: true }), null).output);
  assert.equal(asked.decision, 'block');
  assert.match(asked.reason, /Ask the user whether to move it.*teamclaude switch --session --to B\..*teamclaude switch --session --stay/);
  assert.equal(asked.systemMessage, undefined);
  const pinned = /** @type {any} */ (stopHookOutput(adv('pinned-unavailable', { via: 'manual', to: 'B', ask: true }), null).output);
  assert.equal(pinned.decision, undefined);
  assert.equal(typeof pinned.systemMessage, 'string');
});

test('the state file lives in a 0700 directory, one file per session, written before the answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-surface-'));
  const dir = join(root, 'teamclaude-advice');
  try {
    const id = '3f2a1b9c-0000-4000-8000-000000000001';
    assert.ok(await stopHookTurn(dir, id, adv('out-of-band', { to: 'B' })));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')), { outOfBand: true, pinnedAnnounced: null });
    assert.equal(await stopHookTurn(dir, id, adv('out-of-band', { to: 'B' })), null, 'the file remembers the notice');
    assert.ok(await stopHookTurn(dir, 'other-session', adv('out-of-band', { to: 'B' })), 'another session has its own file');

    // A session with nothing to remember leaves no file behind.
    assert.equal(await stopHookTurn(dir, 'quiet-session', adv('in-band')), null);
    await assert.rejects(stat(join(dir, 'quiet-session.json')), { code: 'ENOENT' });

    // A crafted id never becomes a path outside the directory.
    assert.equal(await stopHookTurn(dir, '../escape', adv('out-of-band', { to: 'B' })), null);
    assert.ok(await stopHookTurn(dir, '..', adv('out-of-band', { to: 'B' })));
    await stat(join(dir, '...json'));

    // Feature off: the directory is not even created.
    const offDir = join(root, 'off');
    assert.equal(await stopHookTurn(offDir, id, adv('disabled', { enabled: false })), null);
    await assert.rejects(stat(offDir), { code: 'ENOENT' });

    // A directory open to others is not trusted with the file.
    const open = join(root, 'open');
    await mkdir(open);
    await chmod(open, 0o777);
    await symlink(join(root, 'victim'), join(open, `${id}.json`));
    await writeFile(join(root, 'victim'), 'keep');
    assert.equal(await stopHookTurn(open, id, adv('out-of-band', { to: 'B' })), null);
    assert.equal(await readFile(join(root, 'victim'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the /switch skill carries its shell command, argument and choice markers (AC9)', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-code', 'skills', 'switch', 'SKILL.md');
  const skill = await readFile(path, 'utf8');
  assert.match(skill, /^!`teamclaude switch --session`$/m, 'inline command that injects the session state');
  assert.match(skill, /\$ARGUMENTS/);
  assert.match(skill, /AskUserQuestion/);
  assert.match(skill, /teamclaude switch --session --stay/);
  assert.match(skill, /^allowed-tools: Bash\(teamclaude switch --session \*\)$/m, 'one prefix rule, no mid-rule wildcard');
  assert.match(skill, /`teamclaude switch --session --to '\$ARGUMENTS'`/, 'the arguments as one quoted word');
  assert.match(skill, /verbatim/);
  assert.match(skill, /`move command:`.*exactly as printed, character for character\. Never rebuild it from the account name/s,
    'the recommended move runs the server-quoted command');
  const commands = [...skill.matchAll(/`(teamclaude [^`]*)`/g)].map(m => m[1]);
  assert.ok(commands.length >= 4);
  for (const command of commands) assert.match(command, /^teamclaude switch --session(?: |$)/, command);
});
