import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedPort } from '../test-helpers/spawn-server.js';

// `teamclaude ends <account> <time>` / `--clear` (#676) writes accounts[].endsAt.
// The real CLI runs against a throwaway TEAMCLAUDE_CONFIG, on a port nothing
// listens on so the post-write reload notification is a no-op.
//
// Like its sibling commands it must change a fresh read taken under the config
// lock, not the copy it loaded at its start (#675). The race is staged as in
// cli-atomic-config.test.js: test-helpers/config-race.js renames the "server's"
// newer config over the file at the child's first attempt to take the lock.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const racePreload = new URL('../test-helpers/config-race.js', import.meta.url).href;

const config = (port, tokens, edit = () => {}) => {
  const c = {
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    accounts: [
      { id: 'a-id', name: 'a@example.com', type: 'oauth', accountUuid: 'ua', orgUuid: 'oa', accessToken: `a-at-${tokens}`, refreshToken: `a-rt-${tokens}`, expiresAt: Date.now() + 3_600_000 },
      { id: 'b-id', name: 'b@example.com', type: 'oauth', accountUuid: 'ub', orgUuid: 'ob', accessToken: `b-at-${tokens}`, refreshToken: `b-rt-${tokens}`, expiresAt: Date.now() + 3_600_000 },
    ],
  };
  edit(c);
  return c;
};

/** A config on disk and, beside it, the newer one the "server" saves mid-command. */
async function stage(edit) {
  const port = await closedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-cli-ends-'));
  const configPath = join(dir, 'config.json');
  const racePath = join(dir, 'server-save.json');
  await writeFile(configPath, JSON.stringify(config(port, 'old', edit)));
  await writeFile(racePath, JSON.stringify(config(port, 'rotated', edit)));
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

/** Run a command that writes, and return what it left on disk. */
async function write(cliArgs, edit) {
  const staged = await stage(edit);
  const res = await runCli(staged, cliArgs);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(existsSync(staged.racePath), false, 'the server save was staged between the read and the write');
  const saved = JSON.parse(await readFile(staged.configPath, 'utf8'));
  for (const account of saved.accounts) {
    assert.match(account.refreshToken, /-rt-rotated$/, `${account.id} keeps the refresh token rotated meanwhile`);
  }
  assert.equal(existsSync(`${staged.configPath}.lock`), false, 'the config lock is released');
  return { saved, res };
}

/** Run a command that must be refused, and check it wrote nothing. */
async function refused(cliArgs) {
  const staged = await stage();
  const before = await readFile(staged.configPath, 'utf8');
  const res = await runCli(staged, cliArgs);
  assert.equal(res.code, 1, `${cliArgs.join(' ')} exits 1\n${res.stdout}`);
  // Either the lock was never taken, or it was and the fresh read was left as is.
  const after = JSON.parse(await readFile(staged.configPath, 'utf8'));
  for (const account of after.accounts) assert.equal('endsAt' in account, false, 'nothing was written');
  if (existsSync(staged.racePath)) assert.equal(await readFile(staged.configPath, 'utf8'), before);
  assert.equal(existsSync(`${staged.configPath}.lock`), false, 'the config lock is released');
  return res;
}

const byId = (saved, id) => saved.accounts.find(a => a.id === id);
const two = n => String(n).padStart(2, '0');

test('ends sets an exact time on a fresh read, as the UTC instant', async () => {
  const at = new Date(Date.now() + 30 * 86_400_000);
  at.setMilliseconds(0);
  const { saved, res } = await write(['ends', 'a@example.com', at.toISOString()]);
  assert.equal(byId(saved, 'a-id').endsAt, at.toISOString());
  assert.equal('endsAt' in byId(saved, 'b-id'), false);
  assert.match(res.stdout, /Account "a@example\.com" ends \d{4}-\d{2}-\d{2}.* \(in (29|30) days\)/);
});

test('ends takes a bare date as the start of that day in local time', async () => {
  // A day a month out, so the fixture never names a date that has passed.
  const day = new Date(Date.now() + 30 * 86_400_000);
  const text = `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
  const localMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const { saved, res } = await write(['ends', 'b@example.com', text]);
  assert.equal(Date.parse(byId(saved, 'b-id').endsAt), localMidnight);
  assert.ok(res.stdout.includes(`Account "b@example.com" ends ${text} (in `), res.stdout);
});

test('ends takes epoch milliseconds, and the time may follow --org', async () => {
  const at = Date.now() + 5 * 86_400_000;
  const { saved } = await write(['ends', 'a@example.com', '--org', 'oa', String(at)]);
  assert.equal(byId(saved, 'a-id').endsAt, at);
});

test('ends accepts a time that has passed, and says it does nothing', async () => {
  const { saved, res } = await write(['ends', 'a@example.com', '2020-01-01T00:00:00Z']);
  assert.equal(byId(saved, 'a-id').endsAt, '2020-01-01T00:00:00.000Z');
  assert.match(res.stdout, /\(ended\)/);
  assert.match(res.stdout, /already passed, so it has no effect/);
});

test('ends --clear removes the key and leaves the other account its own', async () => {
  const { saved, res } = await write(['ends', 'a@example.com', '--clear'], c => {
    c.accounts[0].endsAt = '2030-01-01T00:00:00.000Z';
    c.accounts[1].endsAt = 1893456000000;
  });
  assert.equal('endsAt' in byId(saved, 'a-id'), false);
  assert.equal(byId(saved, 'b-id').endsAt, 1893456000000);
  assert.match(res.stdout, /Cleared the end time of "a@example\.com"/);
});

test('ends refuses a time it cannot parse, with the usage', async () => {
  for (const bad of ['tomorrow', '2030-02-31', '12/01/2030']) {
    const res = await refused(['ends', 'a@example.com', bad]);
    assert.ok(res.stderr.includes(`"${bad}" is not a time.`), res.stderr);
    assert.match(res.stderr, /Usage: teamclaude ends <account-name\|email> <time>/);
    assert.match(res.stderr, /start of that day in local time/);
  }
});

test('ends refuses a missing time, a missing account, and --clear with a time', async () => {
  for (const cliArgs of [['ends'], ['ends', 'a@example.com'], ['ends', '--clear'], ['ends', 'a@example.com', '2030-01-01', '--clear']]) {
    const res = await refused(cliArgs);
    assert.match(res.stderr, /Usage: teamclaude ends /, cliArgs.join(' '));
  }
});

test('ends refuses an unknown account', async () => {
  const res = await refused(['ends', 'nobody@example.com', '2030-01-01']);
  assert.match(res.stderr, /Account "nobody@example\.com" not found/);
  const cleared = await refused(['ends', 'nobody@example.com', '--clear']);
  assert.match(cleared.stderr, /Account "nobody@example\.com" not found/);
});
