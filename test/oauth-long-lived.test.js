import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateAccountEntry } from '../src/identity.js';
import { childEnvWithoutProxy } from '../test-helpers/env.js';

// `teamclaude login --long-lived` makes the request `claude setup-token` makes:
// the scope `user:inference` alone, with a one-year `expires_in` on the code
// exchange. It keeps no refresh token, so nothing can later swap the year-long
// access token for a short one. The paste flow runs in a child process, because
// it reads its code from stdin; a stub token endpoint records what the exchange
// sent.

const oauthUrl = new URL('../src/oauth.js', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
// Answers the token endpoint inside a CLI child (see the file).
const tokenEndpointPreload = new URL('../test-helpers/token-endpoint.js', import.meta.url).href;
const YEAR = 31_536_000;
const MANUAL_REDIRECT = 'https://console.anthropic.com/oauth/code/callback';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// `grant` replaces the expiry fields of the response; by default it echoes the
// requested `expires_in`, or the ordinary eight hours.
async function stubTokenEndpoint(t, { grant } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'at-granted',
        refresh_token: 'rt-granted',
        ...(grant ?? { expires_in: body.expires_in ?? 28_800 }),
      }));
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { endpoint: `http://127.0.0.1:${port}/v1/oauth/token`, seen };
}

// The browser login is what an unrouted flag falls through to, and it opens the
// URL with xdg-open/open. A PATH holding only these stand-ins makes a failing
// run record the call in `<dir>/opened` instead of opening a real browser.
async function inertBin(dir) {
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const opener of ['xdg-open', 'open']) {
    await writeFile(join(bin, opener), `#!/bin/sh\necho "$@" >> '${join(dir, 'opened')}'\n`, { mode: 0o755 });
  }
  return bin;
}

// Runs `program` with stdin held open until the authorize URL is printed, then
// types `code`. Resolves with the URL, the exit code and everything printed.
// The child ends on its own in every case here: the paste flow when its input
// ends, a refused command when it exits. And with its test: `signal` is the
// test's own, so a child left waiting for input it is never given (a change
// that keeps the URL from being printed, say) is killed when the test times
// out, rather than holding the test file open for good. The proxy variables
// are taken out of its environment, so its token exchange reaches the stub and
// not a proxy the developer has exported.
function runPasteFlow(args, { code = 'code-1', env = {}, signal } = {}) {
  const child = spawn(process.execPath, args, {
    env: childEnvWithoutProxy({ TEAMCLAUDE_DISABLE_AUTOUPDATE: '1', ...env }),
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
  });
  // The kill an abort makes is also reported as an 'error'; the close that
  // follows it settles the run.
  child.on('error', () => {});
  let stdout = '';
  let stderr = '';
  let typed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => {
    stdout += c;
    if (!typed && /https:\/\/claude\.ai\/oauth\/authorize\S*/.test(stdout)) {
      typed = true;
      child.stdin.end(`${code}\n`);
    }
  });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise(resolve => child.on('close', status => {
    const match = stdout.match(/https:\/\/claude\.ai\/oauth\/authorize\S*/);
    resolve({ status, stdout, stderr, authorizeUrl: match ? new URL(match[0]) : null });
  }));
}

function loginProgram(options) {
  return [
    '--input-type=module', '-e',
    `const { loginOAuthWithPastedCode } = await import(${JSON.stringify(oauthUrl)});
     const creds = await loginOAuthWithPastedCode(${JSON.stringify(options)});
     console.log('RESULT ' + JSON.stringify(creds));`,
  ];
}

const result = (stdout) => JSON.parse(stdout.match(/^RESULT (.*)$/m)[1]);

test('a long-lived login asks for inference only, for a year, and keeps no refresh token', async (t) => {
  const { endpoint, seen } = await stubTokenEndpoint(t);
  const before = Date.now();
  const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }), { signal: t.signal });
  assert.equal(run.status, 0, run.stderr);

  // Exactly the scope `claude setup-token` asks for, and no other.
  assert.equal(run.authorizeUrl.searchParams.get('scope'), 'user:inference');
  assert.equal(run.authorizeUrl.searchParams.get('redirect_uri'), MANUAL_REDIRECT);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].expires_in, YEAR);
  assert.equal(seen[0].redirect_uri, MANUAL_REDIRECT);
  assert.equal(seen[0].code, 'code-1');

  const creds = result(run.stdout);
  assert.equal(creds.accessToken, 'at-granted');
  assert.equal(creds.longLived, true);
  assert.equal('refreshToken' in creds, false);
  // Nor a date for one: an ordinary sign-in is given 30 days (#710).
  assert.equal('refreshTokenExpiresAt' in creds, false);
  assert.ok(creds.expiresAt >= before + YEAR * 1000, `expiresAt ${creds.expiresAt} is under a year away`);
});

// The control: without `longLived` the same flow asks for every scope and keeps
// what an ordinary grant returns.
test('the ordinary paste login keeps full scopes, the default lifetime and its refresh token', async (t) => {
  const { endpoint, seen } = await stubTokenEndpoint(t);
  const run = await runPasteFlow(loginProgram({ tokenEndpoint: endpoint }), { signal: t.signal });
  assert.equal(run.status, 0, run.stderr);

  assert.match(run.authorizeUrl.searchParams.get('scope'), /user:sessions:claude_code/);
  assert.equal(run.authorizeUrl.searchParams.get('redirect_uri'), MANUAL_REDIRECT);
  assert.equal('expires_in' in seen[0], false);
  const creds = result(run.stdout);
  assert.equal(creds.refreshToken, 'rt-granted');
  assert.equal('longLived' in creds, false);
});

const DAY_MS = 86_400_000;

// A sign-in's refresh token is dated even when the response states no lifetime:
// 30 days out, the fallback Claude Code uses (#710). One it states stands.
test('an ordinary sign-in is dated 30 days out when its response states no refresh-token lifetime, and keeps one it states', async (t) => {
  for (const grant of [{ expires_in: 28_800 }, { expires_in: 28_800, refresh_token_expires_in: null }, { expires_in: 28_800, refresh_token_expires_at: null }]) {
    const { endpoint } = await stubTokenEndpoint(t, { grant });
    const before = Date.now();
    const run = await runPasteFlow(loginProgram({ tokenEndpoint: endpoint }), { signal: t.signal });
    const after = Date.now();
    assert.equal(run.status, 0, run.stderr);
    const { refreshTokenExpiresAt } = result(run.stdout);
    assert.ok(refreshTokenExpiresAt >= before + 30 * DAY_MS && refreshTokenExpiresAt <= after + 30 * DAY_MS,
      `${JSON.stringify(grant)}: dated ${refreshTokenExpiresAt}, not 30 days out`);
  }
  const { endpoint } = await stubTokenEndpoint(t, { grant: { expires_in: 28_800, refresh_token_expires_in: 7 * 86_400 } });
  const before = Date.now();
  const run = await runPasteFlow(loginProgram({ tokenEndpoint: endpoint }), { signal: t.signal });
  assert.equal(run.status, 0, run.stderr);
  const { refreshTokenExpiresAt } = result(run.stdout);
  assert.ok(refreshTokenExpiresAt >= before + 7 * DAY_MS && refreshTokenExpiresAt < before + 8 * DAY_MS, `dated ${refreshTokenExpiresAt}`);
});

// A response that states a lifetime that cannot be believed - further out than
// any refresh token lives, 0, or long past - said something, and it was not 30
// days: the sign-in is given no date, rather than the assumed one.
test('an ordinary sign-in whose response states a refresh-token lifetime that cannot be believed is given no date', async (t) => {
  for (const grant of [
    { expires_in: 28_800, refresh_token_expires_in: 20 * 365 * 86_400 },
    { expires_in: 28_800, refresh_token_expires_in: 0 },
    { expires_in: 28_800, refresh_token_expires_at: Math.floor(Date.now() / 1000) - 2 * 86_400 },
  ]) {
    const { endpoint } = await stubTokenEndpoint(t, { grant });
    const run = await runPasteFlow(loginProgram({ tokenEndpoint: endpoint }), { signal: t.signal });
    assert.equal(run.status, 0, run.stderr);
    const creds = result(run.stdout);
    assert.equal(creds.refreshToken, 'rt-granted');
    assert.equal('refreshTokenExpiresAt' in creds, false, `${JSON.stringify(grant)}: dated ${creds.refreshTokenExpiresAt}`);
  }
});

// Dropping the refresh token is only safe when the year was actually granted:
// a short token with no way to refresh it would take the account out within
// hours, long after the operator has walked away.
test('a long-lived login fails when the server grants more than a day short of a year', async (t) => {
  for (const [grant, said] of [
    [{ expires_in: 28_800 }, /granted a token for \d+s/],
    [{ expires_in: YEAR - 2 * 86_400 }, /granted a token for \d+s/],
    [{}, /granted no usable expiry/],
    [{ expires_at: 'not-a-time' }, /granted no usable expiry/],
  ]) {
    const { endpoint } = await stubTokenEndpoint(t, { grant });
    const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }), { signal: t.signal });
    assert.notEqual(run.status, 0, JSON.stringify(grant));
    assert.doesNotMatch(run.stdout, /^RESULT /m);
    assert.match(run.stderr, said);
    assert.match(run.stderr, /short of the 31536000s requested/);
  }
});

// The lifetime is judged on the expiry the account will be saved with, whichever
// field it came from, and rounding or clock skew within a day still counts.
test('a long-lived login accepts a year given as expires_at, or a little short', async (t) => {
  for (const grant of [
    { expires_at: Math.floor(Date.now() / 1000) + YEAR + 60 },
    { expires_in: YEAR - 3600 },
  ]) {
    const { endpoint } = await stubTokenEndpoint(t, { grant });
    const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }), { signal: t.signal });
    assert.equal(run.status, 0, `${JSON.stringify(grant)}: ${run.stderr}`);
    assert.equal('refreshToken' in result(run.stdout), false);
  }
});

// A delegated credentials file is read over the saved token on every load and
// reload, so a long-lived login onto such an entry would never take effect.
test('a long-lived login onto an importFrom entry drops the delegation', () => {
  const prev = { id: 'e', name: 'a@example.com', type: 'oauth', importFrom: '~/.claude/.credentials.json', accessToken: 'at-old', refreshToken: 'rt-old' };
  const merged = updateAccountEntry(prev, { type: 'oauth', accessToken: 'at-long', refreshToken: undefined, expiresAt: 1, longLived: true });
  assert.equal('importFrom' in merged, false);
  assert.equal(merged.longLived, true);
  assert.equal(merged.accessToken, 'at-long');
});

// The marker describes the token, so an ordinary login or import over a
// long-lived entry clears it, and the account refreshes again.
test('an ordinary login over a long-lived entry clears the marker and keeps importFrom', () => {
  const prev = { id: 'e', name: 'a@example.com', type: 'oauth', importFrom: '~/.claude/.credentials.json', accessToken: 'at-long', longLived: true };
  const merged = updateAccountEntry(prev, { type: 'oauth', accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 1 });
  assert.equal('longLived' in merged, false);
  assert.equal(merged.importFrom, prev.importFrom);
});

test('`teamclaude login --long-lived` refuses another login kind beside it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, accounts: [] }));
  for (const other of ['--api', '--codex', '--oauth']) {
    const run = await runPasteFlow([cliPath, 'login', other, '--long-lived'], {
      code: '', env: { TEAMCLAUDE_CONFIG: configPath, PATH: await inertBin(dir) }, signal: t.signal,
    });
    assert.equal(run.status, 1, other);
    assert.match(run.stderr, /cannot be combined with --api, --codex or --oauth/, other);
  }
});

test('`teamclaude login --long-lived` runs the long-lived paste flow', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, accounts: [] }));
  // An empty answer stops the login before any network call.
  const run = await runPasteFlow([cliPath, 'login', '--long-lived', '--name', 'year'], {
    code: '', env: { TEAMCLAUDE_CONFIG: configPath, PATH: await inertBin(dir) }, signal: t.signal,
  });
  assert.equal(existsSync(join(dir, 'opened')), false, 'the long-lived login opened a browser');
  assert.ok(run.authorizeUrl, `no authorize URL printed:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.authorizeUrl.searchParams.get('scope'), 'user:inference');
  assert.match(run.stderr, /No authorization code provided/);
});

// The token cannot read the profile every other login is named from, so the
// name has to be given, and the login stops before a sign-in link is shown:
// an authorization code is single-use, and would be spent for nothing.
test('`teamclaude login --long-lived` without --name stops before the sign-in link', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, accounts: [] }));
  const run = await runPasteFlow([cliPath, 'login', '--long-lived'], {
    code: '', env: { TEAMCLAUDE_CONFIG: configPath, PATH: await inertBin(dir) }, signal: t.signal,
  });
  assert.equal(run.status, 1);
  assert.equal(run.authorizeUrl, null, `a sign-in link was printed:\n${run.stdout}`);
  assert.match(run.stderr, /--long-lived needs --name/);
  assert.equal(existsSync(join(dir, 'opened')), false);
});

// The whole `teamclaude login --long-lived --name <name>`, through the code
// exchange (answered by test-helpers/token-endpoint.js with `response`) to the
// saved config. Resolves with the exit status, what was printed and the
// accounts saved.
async function longLivedLoginAs(t, accounts, response, name = 'A') {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts }));
  const run = await runPasteFlow(['--import', tokenEndpointPreload, cliPath, 'login', '--long-lived', '--name', name], {
    env: { TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_TEST_TOKEN_RESPONSE: JSON.stringify(response), PATH: await inertBin(dir) },
    signal: t.signal,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, saved: JSON.parse(await readFile(configPath, 'utf8')).accounts };
}

const accountA = () => ({
  id: 'a-id', name: 'A', type: 'oauth', accountUuid: 'uuid-A', orgUuid: 'org-A', orgName: 'Org A',
  hasClaudeMax: true, rateLimitTier: 'max_20x', accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: Date.now() + 3_600_000,
});
const yearGrant = (extra = {}) => ({ access_token: 'at-year', refresh_token: 'rt-not-kept', expires_in: YEAR, ...extra });

// The token cannot read its profile, so the code exchange's answer is the only
// thing that says which account signed in. Where it names one, that decides,
// as the profile does for `teamclaude login`: a sign-in as another account
// does not take this entry's ids, it is added under the name given.
test('a long-lived login named onto an entry, signed in as another account, is added beside it and leaves the entry as it was', async (t) => {
  const before = accountA();
  const { status, stdout, stderr, saved } = await longLivedLoginAs(t, [before], yearGrant({
    account: { uuid: 'uuid-B', email_address: 'b@example.com' }, organization: { uuid: 'org-B', name: 'Org B' },
  }));
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /Added account "A"/);
  assert.match(stdout, /A long-lived token serves inference only: saved as "A"/);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], before, 'the existing entry is untouched');
  assert.equal(saved[1].name, 'A');
  assert.equal(saved[1].accountUuid, 'uuid-B');
  assert.equal(saved[1].orgUuid, 'org-B');
  assert.equal(saved[1].orgName, 'Org B');
  assert.equal(saved[1].accessToken, 'at-year');
  assert.equal(saved[1].longLived, true);
  assert.equal('refreshToken' in saved[1], false);
  assert.equal('hasClaudeMax' in saved[1], false, 'no plan: nothing read one');
});

// The same account, or an answer that names none: the entry's token is
// replaced, it is marked long-lived, and what an earlier full login recorded
// (ids, organization, plan) stays. An organization without an account is not
// an identity, and neither is an account id that is not a string: neither
// replaces the entry's.
test('a long-lived login onto its own entry replaces the token, marks it, and keeps its ids and plan', async (t) => {
  for (const response of [
    yearGrant({ account: { uuid: 'uuid-A' }, organization: { uuid: 'org-A', name: 'Org A' } }),
    yearGrant(),
    yearGrant({ organization: { uuid: 'org-B', name: 'Org B' } }),
    yearGrant({ account: { uuid: 123 }, organization: { uuid: 'org-B', name: 'Org B' } }),
  ]) {
    const { status, stdout, stderr, saved } = await longLivedLoginAs(t, [accountA()], response);
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /Updated account "A"/, JSON.stringify(response));
    assert.equal(saved.length, 1);
    const [a] = saved;
    assert.equal(a.id, 'a-id');
    assert.equal(a.accessToken, 'at-year');
    assert.equal(a.longLived, true);
    assert.equal('refreshToken' in a, false);
    assert.equal('refreshTokenExpiresAt' in a, false);
    assert.deepEqual([a.accountUuid, a.orgUuid, a.orgName], ['uuid-A', 'org-A', 'Org A']);
    assert.deepEqual([a.hasClaudeMax, a.rateLimitTier], [true, 'max_20x']);
  }
});

// The answer decides which entry this is, as the profile does for `teamclaude
// login`: when an entry already holds the account it names, that entry is the
// one renewed, under its own name, and it becomes long-lived (an ordinary one
// stops syncing here). The name given does not rename it, and is not added.
test('a long-lived login whose answer names an account an entry holds renews that entry, under its own name', async (t) => {
  const b = { id: 'b-id', name: 'b@example.com', type: 'oauth', accountUuid: 'uuid-B', orgUuid: 'org-B', orgName: 'Org B', accessToken: 'at-B', refreshToken: 'rt-B', expiresAt: Date.now() + 3_600_000 };
  const { status, stdout, stderr, saved } = await longLivedLoginAs(t, [b], yearGrant({
    account: { uuid: 'uuid-B', email_address: 'b@example.com' }, organization: { uuid: 'org-B', name: 'Org B' },
  }), 'ci');
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /Updated account "b@example.com"/);
  assert.match(stdout, /A long-lived token serves inference only: saved as "b@example.com"/);
  assert.doesNotMatch(stdout, /"ci"/);
  assert.deepEqual(saved.map(a => a.name), ['b@example.com']);
  assert.equal(saved[0].accessToken, 'at-year');
  assert.equal(saved[0].longLived, true);
  assert.equal('refreshToken' in saved[0], false);
});

// One person in two organizations: two entries with one account UUID. An answer
// that names the account and not its organization cannot tell them apart, and
// would land on whichever came first; it is taken as naming no account, so the
// name decides. So is one whose organization id is not a string.
const twoOrganizations = () => [
  { id: 'p1', name: 'p@example.com (Org 1)', type: 'oauth', accountUuid: 'uuid-P', orgUuid: 'org-1', orgName: 'Org 1', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 },
  { id: 'p2', name: 'p@example.com (Org 2)', type: 'oauth', accountUuid: 'uuid-P', orgUuid: 'org-2', orgName: 'Org 2', accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000 },
];

test('a long-lived login whose answer names the account but not its organization goes by the name', async (t) => {
  for (const response of [
    yearGrant({ account: { uuid: 'uuid-P' } }),
    yearGrant({ account: { uuid: 'uuid-P' }, organization: { uuid: 1, name: 'Org 1' } }),
  ]) {
    const before = twoOrganizations();
    const { status, stdout, stderr, saved } = await longLivedLoginAs(t, before, response, 'ci');
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /Added account "ci"/, JSON.stringify(response));
    assert.deepEqual(saved.slice(0, 2), before, 'both organizations\' entries are untouched');
    assert.deepEqual([saved[2].name, saved[2].accountUuid, saved[2].orgUuid, saved[2].longLived], ['ci', undefined, undefined, true]);
  }
});

test('a long-lived login whose answer names the account and its organization renews that organization\'s entry', async (t) => {
  const before = twoOrganizations();
  const { status, stdout, stderr, saved } = await longLivedLoginAs(t, before, yearGrant({
    account: { uuid: 'uuid-P' }, organization: { uuid: 'org-2', name: 'Org 2' },
  }), 'ci');
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /Updated account "p@example.com \(Org 2\)"/);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0], before[0]);
  assert.deepEqual([saved[1].accessToken, saved[1].longLived, 'refreshToken' in saved[1]], ['at-year', true, false]);
});

// A login named after an API-key account turned the key's entry into an OAuth
// one that still held the key. Named so on the command line, with no OAuth
// account of that name, it is refused before its sign-in link: nothing is
// spent, nothing is written, and it says what to do.
const apiKeyWork = () => ({ id: 'k-id', name: 'work', type: 'apikey', apiKey: 'sk-ant-api03-made-up', priority: 100 });
const REFUSED = /"work" already names an API-key account: sign in under another --name, or remove or rename that account first/;

test('a login named after an API-key account is refused before its sign-in link, and nothing is written', async (t) => {
  for (const kind of ['--long-lived', '--token']) {
    const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'config.json');
    const config = { proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [apiKeyWork()] };
    await writeFile(configPath, JSON.stringify(config));
    const run = await runPasteFlow(['--import', tokenEndpointPreload, cliPath, 'login', kind, '--name', 'work'], {
      env: { TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_TEST_TOKEN_RESPONSE: JSON.stringify(yearGrant()), PATH: await inertBin(dir) },
      signal: t.signal,
    });
    assert.equal(run.status, 1, `${kind}: ${run.stdout}\n${run.stderr}`);
    assert.equal(run.authorizeUrl, null, `${kind}: a sign-in link was printed`);
    assert.match(run.stderr, REFUSED, kind);
    assert.doesNotMatch(run.stderr, /token-endpoint stub: answered|\n\s+at /, kind);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config, kind);
  }
});

// A Codex account of that name is no reason to go ahead: a Claude login is
// never a Codex account's, so it is refused before its link all the same.
test('a long-lived login named after a Codex and an API-key account is refused before its sign-in link', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-long-lived-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const codex = { id: 'c-id', name: 'work', type: 'oauth', provider: 'codex', accountId: 'acct-w', accessToken: 'at-c', refreshToken: 'rt-c', expiresAt: Date.now() + 3_600_000 };
  const config = { proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [codex, apiKeyWork()] };
  await writeFile(configPath, JSON.stringify(config));
  const run = await runPasteFlow(['--import', tokenEndpointPreload, cliPath, 'login', '--long-lived', '--name', 'work'], {
    env: { TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_TEST_TOKEN_RESPONSE: JSON.stringify(yearGrant()), PATH: await inertBin(dir) },
    signal: t.signal,
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.authorizeUrl, null, 'a sign-in link was printed');
  assert.match(run.stderr, REFUSED);
  assert.doesNotMatch(run.stderr, /token-endpoint stub: answered|\n\s+at /);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
});

// With an OAuth account of that name too, the login may be its own and goes
// ahead. It renews that one when it is; when its answer names another account,
// the save refuses it all the same (its token is then dropped, and nothing is
// written).
const workTwice = () => [
  { id: 'w-id', name: 'work', type: 'oauth', accountUuid: 'uuid-W', orgUuid: 'org-W', orgName: 'Org W', accessToken: 'at-W', refreshToken: 'rt-W', expiresAt: Date.now() + 3_600_000 },
  apiKeyWork(),
];

test('a long-lived login named after an OAuth and an API-key account renews the OAuth one, and is refused when it is another account', async (t) => {
  const own = await longLivedLoginAs(t, workTwice(), yearGrant(), 'work');
  assert.equal(own.status, 0, `${own.stdout}\n${own.stderr}`);
  assert.match(own.stdout, /Updated account "work"/);
  assert.deepEqual(own.saved.map(a => [a.type, a.accessToken ?? a.apiKey]), [['oauth', 'at-year'], ['apikey', 'sk-ant-api03-made-up']]);

  const before = workTwice();
  const other = await longLivedLoginAs(t, before, yearGrant({ account: { uuid: 'uuid-Y' }, organization: { uuid: 'org-Y', name: 'Org Y' } }), 'work');
  assert.equal(other.status, 1, `${other.stdout}\n${other.stderr}`);
  assert.match(other.stderr, REFUSED);
  assert.doesNotMatch(other.stderr, /\n\s+at /, 'a refusal, not a crash');
  assert.doesNotMatch(other.stdout, /Added account|Updated account|Saved to/);
  assert.deepEqual(other.saved, before);
});

// Only an API-key account's name is refused: an entry of no kind (a hand edit
// with no "type", which is never loaded) does not stop the login.
test('a long-lived login named after an entry with no type is not refused', async (t) => {
  const { status, stdout, stderr } = await longLivedLoginAs(t, [{ id: 'u-id', name: 'work', accessToken: 'at-hand' }], yearGrant(), 'work');
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /already names/);
});
