import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function fixture(t, { enabled = true, status = { managedClientAuth: { enabled: true } }, down = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-managed-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, key: req.headers['x-api-key'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(status));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  if (down) await new Promise(resolve => server.close(resolve));
  const config = {
    proxy: { port, apiKey: 'tc-test-managed-proxy-key', managedClientAuth: enabled },
    upstream: 'https://api.anthropic.com', upstreamProxy: false,
    accounts: [
      { id: 'account-one', name: 'one', type: 'oauth', accessToken: 'pool-access-one', refreshToken: 'pool-refresh-one' },
      { id: 'account-two', name: 'two', type: 'oauth', accessToken: 'pool-access-two', refreshToken: 'pool-refresh-two' },
    ],
  };
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const credentialsDir = join(dir, 'claude-config');
  await mkdir(credentialsDir);
  const credentialsPath = join(credentialsDir, '.credentials.json');
  await writeFile(credentialsPath, '{"sentinel":"personal-credentials-unchanged"}');
  const capture = join(dir, 'capture.json');
  await writeFile(join(dir, 'claude'), `#!${process.execPath}\nimport('node:fs').then(fs => fs.writeFileSync(process.env.TC_TEST_CAPTURE, JSON.stringify({env:process.env,args:process.argv.slice(2)})));\n`, { mode: 0o700 });
  const environment = {
    ...process.env, TEAMCLAUDE_CONFIG: configPath, CLAUDE_CONFIG_DIR: credentialsDir,
    PATH: `${dir}:${process.env.PATH}`, TC_TEST_CAPTURE: capture,
    ANTHROPIC_API_KEY: 'personal-api-key', ANTHROPIC_AUTH_TOKEN: 'personal-auth',
    CLAUDE_CODE_OAUTH_TOKEN: 'expired-personal-oauth',
    ANTHROPIC_BASE_URL: 'https://direct.example.invalid',
    NO_PROXY: 'api.anthropic.com,.anthropic.com,local.test', no_proxy: '*',
    TC_ACCT: '',
  };
  return { dir, config, configPath, credentialsPath, capture, environment, requests };
}

async function runCli(f, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...f.environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout')); }, 15000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function assertNotSpawned(f) {
  await assert.rejects(access(f.capture), { code: 'ENOENT' });
}

test('managed run launches with a proxy credential and clears personal auth without writing credentials', async t => {
  const f = await fixture(t);
  const beforeConfig = await readFile(f.configPath, 'utf8');
  const beforeCredentials = await readFile(f.credentialsPath, 'utf8');
  const result = await runCli(f, ['run', '--', '--resume', 'conversation-id']);
  assert.equal(result.code, 0, result.stderr);
  const { env, args } = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.ok(env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN !== 'expired-personal-oauth');
  assert.notEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'pool-access-one');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.TC_ACCT, undefined);
  assert.doesNotMatch(env.NO_PROXY, /anthropic|\*/);
  assert.match(env.NO_PROXY, /local\.test/);
  assert.equal(env.HTTPS_PROXY, `http://127.0.0.1:${f.config.proxy.port}`);
  assert.deepEqual(args, ['--resume', 'conversation-id']);
  assert.ok(f.requests.some(r => r.path === '/teamclaude/status' && r.key === f.config.proxy.apiKey));
  assert.match(result.stderr, /Pool-managed authentication/);
  assert.ok(!result.stderr.includes(env.CLAUDE_CODE_OAUTH_TOKEN));
  assert.equal(await readFile(f.configPath, 'utf8'), beforeConfig);
  assert.equal(await readFile(f.credentialsPath, 'utf8'), beforeCredentials);
});

for (const command of ['run', 'env']) {
  test(`managed ${command} refuses --no-mitm`, async t => {
    const f = await fixture(t);
    const result = await runCli(f, [command, '--no-mitm']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /managed.*MITM|MITM.*managed/i);
    assert.equal(result.stdout, '');
    await assertNotSpawned(f);
  });
  test(`managed ${command} refuses unavailable proxy even with --auto-fallback`, async t => {
    const f = await fixture(t, { down: true });
    const result = await runCli(f, [command, '--auto-fallback']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    await assertNotSpawned(f);
  });
  test(`managed ${command} refuses a listening incompatible proxy`, async t => {
    const f = await fixture(t, { status: { accounts: [] } });
    const result = await runCli(f, [command]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /managed.*authentication|compatible/i);
    assert.equal(result.stdout, '');
    await assertNotSpawned(f);
  });
}

test('managed env exports only proxy credential changes and can be evaluated safely', async t => {
  const f = await fixture(t);
  const result = await runCli(f, ['env']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^export CLAUDE_CODE_OAUTH_TOKEN='/m);
  assert.match(result.stdout, /^unset ANTHROPIC_API_KEY$/m);
  assert.match(result.stdout, /^unset ANTHROPIC_AUTH_TOKEN$/m);
  assert.doesNotMatch(result.stdout, /expired-personal-oauth|pool-access|pool-refresh|personal-api-key/);
  const script = join(f.dir, 'env.sh');
  await writeFile(script, result.stdout + '\nclaude --resume conversation-id\n');
  const code = await new Promise(resolve => {
    const child = spawn('/bin/sh', [script], { env: f.environment, stdio: 'ignore' });
    child.on('close', resolve);
  });
  assert.equal(code, 0);
  const { env } = JSON.parse(await readFile(f.capture, 'utf8'));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(env.NO_PROXY, /anthropic|\*/);
  assert.ok(!result.stderr.includes(env.CLAUDE_CODE_OAUTH_TOKEN));
});

test('TC_ACCT identity binding agrees between name and index and rejects an unknown pin', async t => {
  const f = await fixture(t);
  const first = await runCli(f, ['run'], { TC_ACCT: 'two' });
  assert.equal(first.code, 0, first.stderr);
  const named = JSON.parse(await readFile(f.capture, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN;
  const second = await runCli(f, ['run'], { TC_ACCT: '1' });
  assert.equal(second.code, 0, second.stderr);
  const indexed = JSON.parse(await readFile(f.capture, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(named, indexed);
  const third = await runCli(f, ['run']);
  assert.equal(third.code, 0, third.stderr);
  assert.notEqual(JSON.parse(await readFile(f.capture, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN, named);
  await rm(f.capture);
  const bad = await runCli(f, ['run'], { TC_ACCT: 'absent' });
  assert.equal(bad.code, 1);
  await assertNotSpawned(f);
});

test('opt-out preserves legacy personal authentication behavior', async t => {
  const f = await fixture(t, { enabled: false });
  const result = await runCli(f, ['run']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(f.capture, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN, 'expired-personal-oauth');
  assert.equal(f.requests.length, 0);
});
