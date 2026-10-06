import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateAccountEntry } from '../src/identity.js';

// `teamclaude login --long-lived` asks for `user:inference user:profile` with a
// one-year `expires_in` — the token endpoint refuses a custom lifetime for any
// wider scope set — and keeps no refresh token, so nothing can later swap the
// year-long access token for a short one. The paste flow runs in a child
// process, because it reads its code from stdin; a stub token endpoint records
// what the exchange sent.

const oauthUrl = new URL('../src/oauth.js', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
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
function runPasteFlow(args, { code = 'code-1', env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  // A flow that never reads the code (the browser login waits on its callback
  // forever) must fail the test, not hang it.
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise(resolve => child.on('close', status => {
    clearTimeout(killer);
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

test('a long-lived login asks for inference and profile only, for a year, and keeps no refresh token', async (t) => {
  const { endpoint, seen } = await stubTokenEndpoint(t);
  const before = Date.now();
  const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }));
  assert.equal(run.status, 0, run.stderr);

  assert.equal(run.authorizeUrl.searchParams.get('scope'), 'user:inference user:profile');
  assert.equal(run.authorizeUrl.searchParams.get('redirect_uri'), MANUAL_REDIRECT);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].expires_in, YEAR);
  assert.equal(seen[0].redirect_uri, MANUAL_REDIRECT);
  assert.equal(seen[0].code, 'code-1');

  const creds = result(run.stdout);
  assert.equal(creds.accessToken, 'at-granted');
  assert.equal(creds.longLived, true);
  assert.equal('refreshToken' in creds, false);
  assert.ok(creds.expiresAt >= before + YEAR * 1000, `expiresAt ${creds.expiresAt} is under a year away`);
});

// The control: without `longLived` the same flow asks for every scope and keeps
// what an ordinary grant returns.
test('the ordinary paste login keeps full scopes, the default lifetime and its refresh token', async (t) => {
  const { endpoint, seen } = await stubTokenEndpoint(t);
  const run = await runPasteFlow(loginProgram({ tokenEndpoint: endpoint }));
  assert.equal(run.status, 0, run.stderr);

  assert.match(run.authorizeUrl.searchParams.get('scope'), /user:sessions:claude_code/);
  assert.equal(run.authorizeUrl.searchParams.get('redirect_uri'), MANUAL_REDIRECT);
  assert.equal('expires_in' in seen[0], false);
  const creds = result(run.stdout);
  assert.equal(creds.refreshToken, 'rt-granted');
  assert.equal('longLived' in creds, false);
});

// Dropping the refresh token is only safe when the year was actually granted:
// a short token with no way to refresh it would take the account out within
// hours, long after the operator has walked away.
test('a long-lived login fails when the server grants more than a day short of a year', async (t) => {
  for (const [grant, said] of [
    [{ expires_in: 28_800 }, /granted a token for 2880\ds/],
    [{ expires_in: YEAR - 2 * 86_400 }, /granted a token for \d+s/],
    [{}, /granted no usable expiry/],
    [{ expires_at: 'not-a-time' }, /granted no usable expiry/],
  ]) {
    const { endpoint } = await stubTokenEndpoint(t, { grant });
    const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }));
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
    const run = await runPasteFlow(loginProgram({ longLived: true, tokenEndpoint: endpoint }));
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
      code: '', env: { TEAMCLAUDE_CONFIG: configPath, PATH: await inertBin(dir) },
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
  const run = await runPasteFlow([cliPath, 'login', '--long-lived'], {
    code: '', env: { TEAMCLAUDE_CONFIG: configPath, PATH: await inertBin(dir) },
  });
  assert.equal(existsSync(join(dir, 'opened')), false, 'the long-lived login opened a browser');
  assert.ok(run.authorizeUrl, `no authorize URL printed:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.authorizeUrl.searchParams.get('scope'), 'user:inference user:profile');
  assert.match(run.stderr, /No authorization code provided/);
});
