import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedPort } from '../test-helpers/spawn-server.js';

// The config-changing commands (`priority`, `disable`, `rename`, ...) loaded
// the config, changed one field and saved the copy they had loaded. The save
// replaces the whole file, so a refresh token the running server rotated and
// persisted between that load and that save went back to its old value, dead
// by then, and the account failed with invalid_grant at the next restart
// (#675, #691). Each command has to apply its change to a fresh read taken
// under the config lock instead.
//
// The race is staged, not timed: test-helpers/config-race.js is preloaded into
// the CLI child and renames the "server's" newer config over the file at the
// child's first attempt to take the config lock, which is always after the
// command's opening read and before its write. The staged file being gone
// afterwards is the proof that the race ran.
//
// The real CLI runs against a throwaway TEAMCLAUDE_CONFIG, on a port nothing
// listens on so the post-write reload notification is a no-op.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const racePreload = new URL('../test-helpers/config-race.js', import.meta.url).href;

const baseConfig = (port) => ({
  proxy: { port, apiKey: 'tc-test' },
  upstream: 'https://api.anthropic.com',
  upstreamProxy: false,
  switchThreshold: 0.98,
  accounts: [
    {
      id: 'a-id', name: 'a@example.com', type: 'oauth', accountUuid: 'ua', orgUuid: 'oa',
      accessToken: 'a-at-old', refreshToken: 'a-rt-old', expiresAt: Date.now() + 3_600_000,
    },
    {
      id: 'b-id', name: 'b@example.com', type: 'oauth', accountUuid: 'ub', orgUuid: 'ob',
      accessToken: 'b-at-old', refreshToken: 'b-rt-old', expiresAt: Date.now() + 3_600_000,
    },
  ],
  routes: [{ name: 'fable', match: ['*fable*'], accounts: ['a@example.com', 'b@example.com'] }],
});

/** The base config as the running server leaves it after refreshing both accounts. */
function rotatedConfig(port) {
  const config = baseConfig(port);
  for (const account of config.accounts) {
    account.accessToken = account.accessToken.replace('old', 'rotated');
    account.refreshToken = account.refreshToken.replace('old', 'rotated');
  }
  return config;
}

/**
 * A config on disk, and beside it the newer one the "server" saves while the
 * command runs. `serverEdit` adds what else the server changed in that save.
 */
async function stageRace(serverEdit = () => {}) {
  const port = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-cli-atomic-'));
  const configPath = join(dir, 'config.json');
  const racePath = join(dir, 'server-save.json');
  await writeFile(configPath, JSON.stringify(baseConfig(port)));
  const rotated = rotatedConfig(port);
  serverEdit(rotated);
  await writeFile(racePath, JSON.stringify(rotated));
  return { configPath, racePath };
}

function runCli({ configPath, racePath }, cliArgs) {
  const child = spawn(process.execPath, ['--import', racePreload, cliPath, ...cliArgs], {
    env: {
      ...process.env,
      TEAMCLAUDE_CONFIG: configPath,
      TEAMCLAUDE_TEST_RACE_WITH: racePath,
      TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
      // The child inherits the shell: keep the reload notification off any proxy.
      HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
      HTTP_PROXY: '', http_proxy: '', NO_PROXY: '*', no_proxy: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit\n${stdout}\n${stderr}`)); }, 60_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Run a command across the staged race and return what it left on disk, having
 * checked that the race ran and that no account lost its rotated tokens.
 */
async function runAcrossRace(cliArgs, serverEdit) {
  const staged = await stageRace(serverEdit);
  const res = await runCli(staged, cliArgs);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(existsSync(staged.racePath), false, 'the server save was staged between the read and the write');
  const saved = JSON.parse(await readFile(staged.configPath, 'utf8'));
  for (const account of saved.accounts) {
    // Before, the -old tokens came back with the command's save.
    assert.match(account.refreshToken, /-rt-rotated$/, `${cliArgs.join(' ')}: ${account.id} keeps its rotated refresh token`);
    assert.match(account.accessToken, /-at-rotated$/, `${cliArgs.join(' ')}: ${account.id} keeps its rotated access token`);
  }
  assert.equal(existsSync(`${staged.configPath}.lock`), false, 'the config lock is released');
  return { saved, res };
}

const byId = (config, id) => config.accounts.find(a => a.id === id);

test('priority sets the number on a fresh read and keeps a token rotated meanwhile', async () => {
  const { saved, res } = await runAcrossRace(['priority', 'a@example.com', '7']);
  assert.equal(byId(saved, 'a-id').priority, 7);
  assert.match(res.stdout, /Set priority of "a@example\.com" to 7 \(lower = preferred\)/);
});

test('priority --first is placed against the priorities on disk, and says the number it wrote', async () => {
  // The server's save also carries a priority the command never loaded.
  const { saved, res } = await runAcrossRace(['priority', 'a@example.com', '--first'], config => {
    config.accounts[1].priority = -5;
  });
  assert.equal(byId(saved, 'b-id').priority, -5);
  assert.equal(byId(saved, 'a-id').priority, -6);
  assert.match(res.stdout, /Set priority of "a@example\.com" to -6 /);
});

test('disable and enable keep a token rotated meanwhile', async () => {
  const disabled = await runAcrossRace(['disable', 'a@example.com']);
  assert.equal(byId(disabled.saved, 'a-id').disabled, true);
  assert.match(disabled.res.stdout, /Disabled account "a@example\.com"/);

  const enabled = await runAcrossRace(['enable', 'a@example.com'], config => {
    config.accounts[0].disabled = true;
  });
  assert.equal('disabled' in byId(enabled.saved, 'a-id'), false);
  assert.match(enabled.res.stdout, /Enabled account "a@example\.com"/);
});

test('cordon keeps a token rotated meanwhile', async () => {
  const { saved, res } = await runAcrossRace(['cordon', 'a@example.com']);
  assert.equal(byId(saved, 'a-id').cordoned, true);
  assert.match(res.stdout, /Cordoned account "a@example\.com"/);
});

test('rename renames the row and its routes, and the renamed row keeps its rotated token', async () => {
  const { saved, res } = await runAcrossRace(['rename', 'a@example.com', 'A1']);
  assert.equal(byId(saved, 'a-id').name, 'A1');
  assert.deepEqual(saved.routes[0].accounts, ['A1', 'b@example.com']);
  assert.match(res.stdout, /Renamed "a@example\.com" to "A1" \(updated route: fable\)/);
});

test('remove takes out one row and leaves the other with its rotated token', async () => {
  const { saved, res } = await runAcrossRace(['remove', 'a@example.com']);
  assert.deepEqual(saved.accounts.map(a => a.id), ['b-id']);
  assert.match(res.stdout, /Removed account "a@example\.com"/);
});

test('threshold keeps a token rotated meanwhile, and drops a table set meanwhile', async () => {
  const plain = await runAcrossRace(['threshold', '90']);
  assert.equal(plain.saved.switchThreshold, 0.9);
  assert.match(plain.res.stdout, /Switch threshold set to 90%/);

  const perBucket = await runAcrossRace(['threshold', 'unified7d=80']);
  assert.deepEqual(perBucket.saved.switchThreshold, { default: 0.98, unified7d: 0.8 });

  // A per-bucket table the command never loaded is still the one it replaces.
  const dropped = await runAcrossRace(['threshold', '90'], config => {
    config.switchThreshold = { default: 0.95, unified7d: 0.8 };
  });
  assert.equal(dropped.saved.switchThreshold, 0.9);
  assert.match(dropped.res.stdout, /Dropped the per-bucket thresholds \(unified7d\)/);
});

test('route add and route rm keep a token rotated meanwhile', async () => {
  const added = await runAcrossRace(['route', 'add', 'opus', '--match', '*opus*', '--accounts', 'b@example.com']);
  assert.deepEqual(added.saved.routes.map(r => r.name), ['fable', 'opus']);
  assert.match(added.res.stdout, /Added route "opus"/);

  const removed = await runAcrossRace(['route', 'rm', 'fable']);
  assert.deepEqual(removed.saved.routes, []);
  assert.match(removed.res.stdout, /Removed route "fable"/);
});

test('probe, warmup and distribute keep a token rotated meanwhile', async () => {
  const probe = await runAcrossRace(['probe', '300']);
  assert.equal(probe.saved.quotaProbeSeconds, 300);

  const warmup = await runAcrossRace(['warmup', '600']);
  assert.equal(warmup.saved.warmupSeconds, 600);

  const distribute = await runAcrossRace(['distribute', 'on']);
  assert.equal(distribute.saved.distributeSessions, true);
});

test('routing none clears the routing on a fresh read', async () => {
  const { saved, res } = await runAcrossRace(['routing', 'a@example.com', 'none'], config => {
    config.accounts[0].routing = 'http://127.0.0.1:9';
  });
  assert.equal('routing' in byId(saved, 'a-id'), false);
  assert.match(res.stdout, /Cleared routing for "a@example\.com"/);
});

// A refused change must leave the file exactly as it found it: same bytes,
// nothing re-serialised over it. The refusal is now decided inside the update,
// with the lock held and the server's save already in, so "as it found it" is
// that save; a command that refuses before reaching the lock never ran the
// race, and the file is the one it started with.
async function assertUntouched(staged, before, serverSave) {
  const expected = existsSync(staged.racePath) ? before : serverSave;
  assert.equal(await readFile(staged.configPath, 'utf8'), expected);
  assert.equal(existsSync(`${staged.configPath}.lock`), false, 'the config lock is released');
}

for (const [cliArgs, message] of /** @type {Array<[string[], RegExp]>} */ ([
  [['priority', 'nobody@example.com', '3'], /^Account "nobody@example\.com" not found$/m],
  [['priority', 'a@example.com'], /^Provide an integer priority, or --first \/ --last\.$/m],
  [['disable', 'nobody@example.com'], /^Account "nobody@example\.com" not found$/m],
  [['cordon', 'nobody@example.com'], /^Account "nobody@example\.com" not found$/m],
  [['remove', 'nobody@example.com'], /^Account "nobody@example\.com" not found$/m],
  [['rename', 'a@example.com', 'b@example.com'], /already names another account/],
  [['route', 'rm', 'nope'], /^Route "nope" not found$/m],
  [['threshold', 'nosuchbucket=50'], /Unknown quota bucket "nosuchbucket"/],
  [['probe', '5'], /Minimum probe interval is 30s/],
])) {
  test(`${cliArgs.join(' ')} is refused without writing the config`, async () => {
    const staged = await stageRace();
    const before = await readFile(staged.configPath, 'utf8');
    const serverSave = await readFile(staged.racePath, 'utf8');
    const res = await runCli(staged, cliArgs);
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stderr, message);
    await assertUntouched(staged, before, serverSave);
  });
}

test('an ambiguous account is refused with the candidates, without writing the config', async () => {
  // The same email under two orgs: the name alone picks neither.
  const twoOrgs = config => {
    config.accounts[0].name = 'x@example.com (Org A)';
    config.accounts[0].orgName = 'Org A';
    config.accounts[1].name = 'x@example.com (Org B)';
    config.accounts[1].orgName = 'Org B';
  };
  const staged = await stageRace(twoOrgs);
  // Ambiguous from the start, not only once the server has saved.
  const stale = JSON.parse(await readFile(staged.configPath, 'utf8'));
  twoOrgs(stale);
  const before = JSON.stringify(stale);
  await writeFile(staged.configPath, before);
  const serverSave = await readFile(staged.racePath, 'utf8');
  const res = await runCli(staged, ['disable', 'x@example.com']);
  assert.equal(res.code, 1, res.stdout);
  assert.match(res.stderr, /^"x@example\.com" matches 2 accounts — disambiguate with --org <name\|uuid>:$/m);
  assert.match(res.stderr, /^ {2}- x@example\.com \(Org A\) {2}\(org: Org A\)$/m);
  assert.match(res.stderr, /^ {2}- x@example\.com \(Org B\) {2}\(org: Org B\)$/m);
  await assertUntouched(staged, before, serverSave);
});
