import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closedPort } from '../test-helpers/spawn-server.js';
import { renderStatusLine } from '../src/claude-code-surface.js';

// `teamclaude switch` drives the real control endpoint, so these run the CLI
// against a real proxy server rather than a stubbed one.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2' },
];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function writeConfig(port, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    // Belt and braces, not load-bearing: Node's global fetch ignores proxy env
    // vars unless NODE_USE_ENV_PROXY is set, so an inherited HTTPS_PROXY does not
    // reach these localhost calls today. Pinned anyway so the test does not start
    // depending on that default.
    upstreamProxy: false,
    switchThreshold: 0.98,
    accounts: ACCTS,
    ...extra,
  }));
  return path;
}

// `input`: what to write to stdin and close it; `true` leaves stdin open.
function runCli(configPath, cliArgs, extraEnv = {}, input = null) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    // The surfaces give the server a second (surfaceTimeoutMs). The proxy these
    // tests ask lives in this process, so a second in which it does not get
    // to run would read as `teamclaude offline`: the budget is lifted, and what
    // the surfaces print is asserted on an answer that arrived.
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_SURFACE_TIMEOUT_MS: '60000', ...extraEnv },
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  // A child that stops reading early (the byte cap) closes the pipe under the write.
  child.stdin?.on('error', () => {});
  if (input != null && input !== true) child.stdin.end(input);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); child.stdin?.destroy(); resolve({ code, stdout, stderr }); });
  });
}

async function withProxy(fn, { amOpts = {}, upstream = 'https://api.anthropic.com', accounts = ACCTS } = {}) {
  const am = new AccountManager(accounts, 0.98, amOpts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream }, {});
  const port = await listen(proxy);
  const configPath = await writeConfig(port);
  try {
    await fn(am, configPath);
  } finally {
    proxy.close();
  }
}

test('switch NAME retargets the running server', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'bob@example.com (Acme)']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /bob@example\.com \(Acme\)/);
    assert.equal(am.currentIndex, 1);
  });
});

test('switch with no name lists accounts and marks the current one', async () => {
  await withProxy(async (am, configPath) => {
    am.currentIndex = 1;
    const res = await runCli(configPath, ['switch']);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.split('\n');
    const alice = lines.find(l => l.includes('alice@example.com'));
    const bob = lines.find(l => l.includes('bob@example.com'));
    assert.ok(alice && bob, res.stdout);
    assert.ok(bob.startsWith('*'), `expected the current account marked: ${bob}`);
    assert.ok(!alice.startsWith('*'), `expected other accounts unmarked: ${alice}`);
  });
});

test('an unknown name exits 1 and prints the valid names', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'nobody@example.com']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /nobody@example\.com/);
    assert.match(res.stderr, /alice@example\.com/);
    assert.match(res.stderr, /bob@example\.com \(Acme\)/);
    assert.equal(am.currentIndex, 0, 'a refused switch must not move the current account');
  });
});

// Same rule as the endpoint: the switch is recorded, but a caller must not be
// told plainly that it worked when no request will ever reach that account.
async function withDisabled(fn) {
  const accts = [
    { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ];
  const am = new AccountManager(accts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: accts,
  }));
  try {
    await fn(am, path);
  } finally {
    proxy.close();
  }
}

test('switching to a disabled account warns instead of reporting a clean success', async () => {
  await withDisabled(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'off@example.com']);
    assert.equal(res.code, 0, 'the switch is still recorded, so this is not a failure');
    const all = res.stdout + res.stderr;
    assert.match(all, /off@example\.com/);
    assert.match(all, /disabled/i, `expected a warning naming the reason: ${all}`);
    assert.match(all, /will not route|not be used|until/i, `expected the consequence spelled out: ${all}`);
  });
});

test('the listing marks a disabled account', async () => {
  await withDisabled(async (am, configPath) => {
    const res = await runCli(configPath, ['switch']);
    assert.equal(res.code, 0, res.stderr);
    const off = res.stdout.split('\n').find(l => l.includes('off@example.com'));
    const alice = res.stdout.split('\n').find(l => l.includes('alice@example.com'));
    assert.match(off, /disabled/i, `expected the disabled account flagged: ${res.stdout}`);
    assert.doesNotMatch(alice, /disabled/i, `expected a healthy account left unflagged: ${res.stdout}`);
  });
});

// A reply from something that is not our proxy, or from a version that predates
// the endpoint, must not be reported as "no server" or as an empty account list.
test('an unexpected reply is reported as such, not as a down server', async () => {
  const impostor = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not teamclaude</html>');
  });
  const port = await listen(impostor);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: ACCTS,
  }));
  try {
    const res = await runCli(path, ['switch']);
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /Is the server running\?/, 'something answered, so this is not a down server');
    assert.doesNotMatch(res.stdout, /No accounts configured/, 'an unparseable reply is not an empty fleet');
    assert.match(res.stderr, /unexpected|not a teamclaude|invalid/i, res.stderr);
  } finally {
    impostor.close();
  }
});

// An old server has no /teamclaude/switch, so the request falls through to the
// proxy path and Anthropic answers with an error OBJECT. Printing it raw yields
// "[object Object]", which tells the user nothing.
test('a non-string error field does not print as [object Object]', async () => {
  const oldServer = http.createServer((req, res) => {
    if (req.url === '/teamclaude/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentAccount: 'alice@example.com', accounts: [{ name: 'alice@example.com' }] }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
  });
  const port = await listen(oldServer);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-switch-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com',
    upstreamProxy: false, switchThreshold: 0.98, accounts: ACCTS,
  }));
  try {
    const res = await runCli(path, ['switch', 'alice@example.com']);
    assert.equal(res.code, 1);
    assert.doesNotMatch(res.stderr, /\[object Object\]/, res.stderr);
  } finally {
    oldServer.close();
  }
});

test('a down server exits 1 with the same hint as status', async () => {
  const port = await closedPort();
  const configPath = await writeConfig(port);
  for (const cliArgs of [['switch'], ['switch', 'alice@example.com']]) {
    const res = await runCli(configPath, cliArgs);
    assert.equal(res.code, 1, cliArgs.join(' '));
    assert.match(res.stderr, new RegExp(`Cannot connect to proxy at localhost:${port}`));
    assert.match(res.stderr, /Is the server running\?/);
  }
});

// Accepted-but-never-answered is not "down": it is the shape of a stalled or
// overloaded server, and the command must say so within its deadline rather
// than hang.
test('status diagnoses an accepted connection whose server never answers', async () => {
  const silent = http.createServer(() => { /* accept and intentionally hang */ });
  const port = await listen(silent);
  const configPath = await writeConfig(port);
  try {
    const res = await runCli(configPath, ['status'], { TEAMCLAUDE_STATUS_TIMEOUT_MS: '100' });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /did not answer status within 100ms/);
    assert.match(res.stderr, /event loop may be stalled/);
    assert.doesNotMatch(res.stderr, /Is the server running/);
  } finally {
    silent.closeAllConnections?.();
    silent.close();
  }
});

// `--session` (#543): one session moves, the fleet does not. The id comes from
// $CLAUDE_CODE_SESSION_ID, which Claude Code exports to the commands it runs.
const SID = '3f2a1b9c-0000-4000-8000-000000000001';

test('switch NAME --session pins only that session, from $CLAUDE_CODE_SESSION_ID', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'bob@example.com (Acme)', '--session'], { CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Session 3f2a1b9c pinned to "bob@example\.com \(Acme\)"/);
    assert.equal(am.currentIndex, 0, 'the fleet did not move');
    assert.equal(am.sessionPins.get(SID), 'bob@example.com (Acme)');
    // Nothing has carried this id yet, and the command says so.
    assert.match(res.stderr, /has not seen a request from session 3f2a1b9c/);

    const cleared = await runCli(configPath, ['switch', '--session', SID, '--clear'], { CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /Session 3f2a1b9c unpinned/);
    assert.equal(am.sessionPins.get(SID), null);
  });
});

test('switch --session with no session id to use fails with a usable message', async () => {
  await withProxy(async (_am, configPath) => {
    const res = await runCli(configPath, ['switch', 'alice@example.com', '--session'], { CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /pass --session <id>/);
  });
});

test('a plain switch from inside a session says it moved every session', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', 'bob@example.com (Acme)'], { CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(am.currentIndex, 1);
    assert.match(res.stdout, /moved every session that is not pinned/);
    assert.match(res.stdout, /teamclaude switch --session --to 'bob@example\.com \(Acme\)'$/m, 'one single-quoted shell word');
    const outside = await runCli(configPath, ['switch', 'alice@example.com'], { CLAUDE_CODE_SESSION_ID: '' });
    assert.doesNotMatch(outside.stdout, /moved every session/);
  });
});

// The Claude Code surfaces over the same session (AC5): a move by
// `switch <acct> --session` takes the next request and shows in the status line.
test('after switch NAME --session the next request goes there and the status line shows it (AC5)', async () => {
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(req.headers['x-api-key']);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const log = console.log;
  console.log = () => {};
  try {
    await withProxy(async (am, configPath) => {
      const port = JSON.parse(await readFile(configPath, 'utf8')).proxy.port;
      const message = async () => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-claude-code-session-id': SID },
          body: JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
      };
      await message();
      assert.deepEqual(served, ['k1']);

      const moved = await runCli(configPath, ['switch', 'bob@example.com (Acme)', '--session'], { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(moved.code, 0, moved.stderr);
      await message();
      assert.deepEqual(served, ['k1', 'k2'], 'the next request went to the pinned account');

      const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-api-key': 'tc-test' } })).json();
      const advice = await get(`/teamclaude/session-advice?session=${SID}`);
      assert.equal(advice.account, 'bob@example.com (Acme)');
      assert.equal(advice.via, 'manual');
      assert.match(renderStatusLine(advice, await get('/teamclaude/quota')), /^on bob@example\.com \(Acme\) \(pinned\) \| /);

      const line = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: '' }, JSON.stringify({ session_id: SID }));
      assert.equal(line.code, 0, line.stderr);
      assert.match(line.stdout, /^on bob@example\.com \(Acme\) \(pinned\) \| /);
      const fallback = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: SID }, JSON.stringify({ session_id: 'not-a-known-id' }));
      assert.match(fallback.stdout, /^on bob@example\.com/, 'an unknown stdin id falls back to $CLAUDE_CODE_SESSION_ID');
      const unknown = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: '' }, '{}');
      assert.match(unknown.stdout, /^session unknown \| fleet /);

      const report = await runCli(configPath, ['switch', '--session'], { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(report.code, 0, report.stderr);
      assert.match(report.stdout, /^on bob@example\.com \(Acme\) \(pinned\)/);
      assert.match(report.stdout, /reason: disabled/);
    }, { upstream: `http://127.0.0.1:${upstreamPort}` });
  } finally {
    console.log = log;
    upstream.close();
  }
});

test('switch --session --stay records a decline; with the feature off it says so', async () => {
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', '--session', '--stay'], { CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Session 3f2a1b9c stays where it is/);
    assert.ok(am.adviceCooldowns.has(SID));
    assert.equal(am.sessionPins.get(SID), null, 'a decline pins nothing');
  }, { amOpts: { sessionAdvice: { enabled: true } } });
  await withProxy(async (am, configPath) => {
    const res = await runCli(configPath, ['switch', '--session', SID, '--stay'], { CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /advice is off/);
    assert.equal(am.adviceCooldowns.size, 0);
  });
});

test('stop-hook announces a dead pin once, through a private state directory', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'teamclaude-hook-'));
  try {
    await withProxy(async (am, configPath) => {
      am.sessionPins.set(SID, 'bob@example.com (Acme)');
      // Over its maxUsage cap: the one state here in which a pinned request is not forwarded.
      Object.assign(am.accounts[1], { maxUsage: 0.5 });
      Object.assign(am.accounts[1].quota, { unified7d: 0.9, unified7dReset: Date.now() + 3600_000 });
      assert.equal(am.pinBars(am.accounts[1]), 'unified7d');
      const env = { CLAUDE_CODE_SESSION_ID: '', TMPDIR: tmp };
      const first = await runCli(configPath, ['stop-hook'], env, JSON.stringify({ session_id: SID }));
      assert.equal(first.code, 0, first.stderr);
      const out = JSON.parse(first.stdout);
      assert.equal(out.decision, undefined, 'a dead pin never blocks, even with ask on');
      assert.match(out.systemMessage, /pinned account "bob@example\.com \(Acme\)" cannot serve/);
      assert.deepEqual(await readdir(join(tmp, 'teamclaude-advice')), [`${SID}.json`]);
      const second = await runCli(configPath, ['stop-hook'], env, JSON.stringify({ session_id: SID }));
      assert.equal(second.code, 0, second.stderr);
      assert.equal(second.stdout, '');
    }, { amOpts: { sessionAdvice: { enabled: true, ask: true } } });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('statusline and stop-hook exit 0 against a server that is down', async () => {
  const configPath = await writeConfig(await closedPort());
  const line = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: SID }, JSON.stringify({ session_id: SID }));
  assert.deepEqual([line.code, line.stdout, line.stderr], [0, 'teamclaude offline\n', '']);
  const hook = await runCli(configPath, ['stop-hook'], { CLAUDE_CODE_SESSION_ID: SID }, JSON.stringify({ session_id: SID }));
  assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', '']);
  const garbage = await runCli(configPath, ['stop-hook'], { CLAUDE_CODE_SESSION_ID: '' }, 'not json');
  assert.deepEqual([garbage.code, garbage.stdout], [0, '']);
});

test('statusline and stop-hook skip a bad egress proxy setting and still exit 0', async () => {
  const configPath = await writeConfig(await closedPort(), { upstreamProxy: 'socks5://127.0.0.1:1' });
  const line = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: SID }, JSON.stringify({ session_id: SID }));
  assert.deepEqual([line.code, line.stdout, line.stderr], [0, 'teamclaude offline\n', '']);
  const hook = await runCli(configPath, ['stop-hook'], { CLAUDE_CODE_SESSION_ID: SID }, JSON.stringify({ session_id: SID }));
  assert.deepEqual([hook.code, hook.stdout, hook.stderr], [0, '', '']);
  const other = await runCli(configPath, ['switch'], {});
  assert.equal(other.code, 1, 'other commands still refuse it');
  assert.match(other.stderr, /Bad proxy setting/);
});

test('statusline and stop-hook give up on a stdin that never closes, and exit 0', async () => {
  const configPath = await writeConfig(await closedPort());
  const line = await runCli(configPath, ['statusline'], { CLAUDE_CODE_SESSION_ID: '' }, true);
  assert.deepEqual([line.code, line.stdout], [0, 'teamclaude offline\n']);
  const hook = await runCli(configPath, ['stop-hook'], { CLAUDE_CODE_SESSION_ID: SID }, true);
  assert.deepEqual([hook.code, hook.stdout], [0, '']);
  const big = await runCli(configPath, ['stop-hook'], { CLAUDE_CODE_SESSION_ID: SID }, `{"session_id": "${'x'.repeat(300 * 1024)}"}`);
  assert.deepEqual([big.code, big.stdout], [0, '']);
});

test('switch NAME --session --stay is a usage error', async () => {
  await withProxy(async (am, configPath) => {
    for (const cliArgs of [['switch', 'alice@example.com', '--session', '--stay'], ['switch', '--session', '--clear', '--stay']]) {
      const res = await runCli(configPath, cliArgs, { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(res.code, 1, cliArgs.join(' '));
      assert.match(res.stderr, /^Usage: teamclaude switch --session/);
      assert.equal(am.sessionPins.get(SID), null, 'nothing was pinned');
      assert.equal(am.adviceCooldowns.size, 0, 'nothing was declined');
    }
  }, { amOpts: { sessionAdvice: { enabled: true } } });
});

test('switch --session --to takes the next word as the account, whatever it looks like', async () => {
  const odd = [
    { name: '--clear', type: 'apikey', apiKey: 'k3' },
    { name: '-x@example.com', type: 'apikey', apiKey: 'k4' },
  ];
  await withProxy(async (am, configPath) => {
    const before = am.currentIndex;
    for (const name of ['--clear', '-x@example.com', 'bob@example.com (Acme)']) {
      for (const cliArgs of [['switch', '--session', '--to', name], ['switch', '--session', SID, '--to', name]]) {
        const res = await runCli(configPath, cliArgs, { CLAUDE_CODE_SESSION_ID: SID });
        assert.equal(res.code, 0, `${cliArgs.join(' ')}: ${res.stderr}`);
        assert.equal(am.sessionPins.get(SID), name, cliArgs.join(' '));
        assert.equal(am.currentIndex, before, 'the fleet did not switch');
      }
    }
    const other = '9d0e4c11-0000-4000-8000-000000000002';
    const byId = await runCli(configPath, ['switch', '--session', other, '--to', 'alice@example.com'], { CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(byId.code, 0, byId.stderr);
    assert.equal(am.sessionPins.get(other), 'alice@example.com', 'the id between --session and --to is the one pinned');
    assert.equal(am.sessionPins.get(SID), 'bob@example.com (Acme)', 'and only that one');
    const missing = await runCli(configPath, ['switch', '--session', '--to', '--nobody'], { CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--nobody/);
    assert.equal(am.sessionPins.get(SID), 'bob@example.com (Acme)', 'a failed move leaves the pin alone');
  }, { accounts: [...ACCTS, ...odd] });
});

test('switch --to is a usage error outside the exact form --session [<id>] --to <account>', async () => {
  await withProxy(async (am, configPath) => {
    const before = am.currentIndex;
    for (const cliArgs of [
      ['switch', '--to', 'bob@example.com (Acme)'],
      ['switch', '--session', '--to'],
      ['switch', 'alice@example.com', '--session', '--to', 'bob@example.com (Acme)'],
      ['switch', '--session', '--to', 'bob@example.com (Acme)', '--stay'],
      ['switch', '--session', '--clear', '--to', 'bob@example.com (Acme)'],
      ['switch', '--to', 'bob@example.com (Acme)', '--session', SID],
      ['switch', '--session', '--to', 'alice@example.com', '--session', SID],
    ]) {
      const res = await runCli(configPath, cliArgs, { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(res.code, 1, cliArgs.join(' '));
      assert.match(res.stderr, /^(?:Usage: teamclaude switch --session \[<id>\] --to <account>|Unexpected words after the account)/, cliArgs.join(' '));
      assert.equal(am.sessionPins.get(SID), null);
      assert.equal(am.currentIndex, before);
    }
  });
});

test('switch --session --to a b names the stray word and pins nothing', async () => {
  await withProxy(async (am, configPath) => {
    for (const cliArgs of [['switch', '--session', '--to', 'bob@example.com', '(Acme)'], ['switch', '--session', SID, '--to', 'a', 'b']]) {
      const res = await runCli(configPath, cliArgs, { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(res.code, 1, cliArgs.join(' '));
      assert.match(res.stderr, /^Unexpected words after the account ".+": .+\. Quote an account name with spaces as one word\./);
      assert.equal(am.sessionPins.pins.size, 0, 'no session was pinned');
    }
  });
});

test('switch --session prints the recommended move as a command that, run as printed, makes exactly that move', async () => {
  const evil = { name: "it's $(touch pwned) `touch pwned2` co", type: 'apikey', apiKey: 'k5' };
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-cmd-'));
  try {
    await withProxy(async (am, configPath) => {
      am.sessionPins.set(SID, 'bob@example.com (Acme)');
      Object.assign(am.accounts[1], { maxUsage: 0.5 });
      Object.assign(am.accounts[1].quota, { unified7d: 0.9, unified7dReset: Date.now() + 3600_000 });
      am.accounts[0].disabled = true;
      const report = await runCli(configPath, ['switch', '--session'], { CLAUDE_CODE_SESSION_ID: SID });
      assert.equal(report.code, 0, report.stderr);
      const line = report.stdout.split('\n').find(l => l.startsWith('move command: '));
      assert.equal(line, `move command: teamclaude switch --session ${SID} --to 'it'\\''s $(touch pwned) \`touch pwned2\` co'`);
      // Run by a shell exactly as printed, with `teamclaude` standing for this CLI.
      const child = spawn('sh', ['-c', `teamclaude() { "$NODE" "$CLI" "$@"; }; ${line.slice('move command: '.length)}`], {
        cwd: dir, env: { ...process.env, NODE: process.execPath, CLI: cliPath, TEAMCLAUDE_CONFIG: configPath, CLAUDE_CODE_SESSION_ID: '' },
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      assert.equal(am.sessionPins.get(SID), evil.name, 'the session moved to exactly that account');
      assert.deepEqual(await readdir(dir), [], 'no command substitution ran');
      const json = await runCli(configPath, ['switch', '--session', '--json'], { CLAUDE_CODE_SESSION_ID: SID });
      assert.doesNotMatch(json.stdout, /move command/, '--json stays the raw server answer');
    }, { accounts: [...ACCTS, evil], amOpts: { sessionAdvice: { enabled: true } } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
