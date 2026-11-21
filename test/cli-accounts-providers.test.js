import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvWithoutProxy } from '../test-helpers/env.js';

// `teamclaude accounts` reads each Claude login's profile from Anthropic, and
// renews a token about to expire first. It did both for every `type: oauth`
// row: a Codex row's OpenAI access token went to api.anthropic.com and its
// refresh token to platform.claude.com, and a third-party backend's API key
// (an `upstream` row) to api.anthropic.com. `teamclaude api` sent whichever
// account it used to the Anthropic upstream too.
//
// Those calls go through the configured upstream proxy. A proxy that records
// each CONNECT and refuses it shows which hosts the command tried to reach,
// and nothing leaves the machine.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
// Inside the five-minute renewal window, so a renewal would be attempted.
const EXPIRING = Date.now() + 60_000;

const claude = {
  id: 'c-id', name: 'claude@example.com', type: 'oauth', accountUuid: 'uc', orgUuid: 'oc',
  accessToken: 'claude-at', refreshToken: 'claude-rt', expiresAt: Date.now() + 3_600_000,
};
const codex = {
  id: 'x-id', name: 'codex@example.com', type: 'oauth', provider: 'codex', accountId: 'ws-1', userId: 'u-1',
  accessToken: 'codex-at', refreshToken: 'codex-rt', expiresAt: EXPIRING,
};
const backend = {
  id: 'b-id', name: 'backend', type: 'oauth', upstream: 'https://backend.example.com/anthropic', priority: 100,
  accessToken: 'backend-key', refreshToken: 'backend-rt', expiresAt: EXPIRING,
};
const longLived = {
  id: 'l-id', name: 'longlived@example.com', type: 'oauth', longLived: true, accessToken: 'll-at', expiresAt: EXPIRING,
};

async function refusingProxy(t) {
  const targets = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket) => {
    targets.push(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { targets, url: `http://127.0.0.1:${server.address().port}` };
}

async function runCli(t, accounts, cliArgs) {
  const proxy = await refusingProxy(t);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-accounts-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ upstreamProxy: proxy.url, accounts }));
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    // NO_PROXY cleared: the upstream proxy above is what the test observes.
    env: childEnvWithoutProxy({ TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1', NO_PROXY: '', no_proxy: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Ends the child with the test, however the test ends.
    signal: t.signal,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr, targets: proxy.targets.toSorted() };
}

test('`teamclaude accounts` sends only Claude logins to Anthropic', async (t) => {
  const baseline = await runCli(t, [claude], ['accounts']);
  assert.equal(baseline.code, 0, baseline.stderr);
  // The observation works: the Claude row's profile read is seen.
  assert.ok(baseline.targets.includes('api.anthropic.com:443'), JSON.stringify(baseline.targets));

  const mixed = await runCli(t, [claude, codex, backend, longLived], ['accounts']);
  assert.equal(mixed.code, 0, mixed.stderr);
  assert.deepEqual(mixed.targets, baseline.targets);
  assert.match(mixed.stdout, /codex@example\.com \(Codex\b/);
  assert.match(mixed.stdout, /backend \(third-party backend\b/);
  assert.match(mixed.stdout, /longlived@example\.com \(long-lived token, inference only\b/);
});

test('`teamclaude api` sends an account\'s credential to its own host', async (t) => {
  // With no --account, the first Claude login is used, wherever it sits. It is
  // routed through a proxy of its own, so its call is told apart from another
  // account's call to the same host.
  const routed = await refusingProxy(t);
  const byDefault = await runCli(t, [codex, backend, { ...claude, routing: routed.url }], ['api', '/v1/models']);
  assert.deepEqual(routed.targets, ['api.anthropic.com:443'], byDefault.stderr);
  assert.deepEqual(byDefault.targets, []);

  // An absolute URL on chatgpt.com, with no --account, takes the Codex login,
  // not the Claude one.
  const routedClaude = await refusingProxy(t);
  const onChatgpt = await runCli(t, [{ ...claude, routing: routedClaude.url }, codex], ['api', 'https://chatgpt.com/backend-api/wham/usage']);
  assert.deepEqual(onChatgpt.targets, ['chatgpt.com:443'], onChatgpt.stderr);
  assert.deepEqual(routedClaude.targets, []);

  // With no Codex login there is none to take: the Claude login's token is not
  // sent to chatgpt.com in its place, nor a Codex login's to Anthropic.
  const noCodex = await runCli(t, [claude], ['api', 'https://chatgpt.com/backend-api/wham/usage']);
  assert.equal(noCodex.code, 1, noCodex.stdout);
  assert.deepEqual(noCodex.targets, []);
  assert.match(noCodex.stderr, /No codex login to use on chatgpt\.com/);
  const noClaude = await runCli(t, [codex], ['api', 'https://api.anthropic.com/v1/models']);
  assert.equal(noClaude.code, 1, noClaude.stdout);
  assert.deepEqual(noClaude.targets, []);

  const asCodex = await runCli(t, [claude, codex], ['api', '/backend-api/wham/usage', '--account', 'codex@example.com']);
  assert.deepEqual(asCodex.targets, ['chatgpt.com:443'], asCodex.stderr);

  const asBackend = await runCli(t, [claude, backend], ['api', '/v1/models', '--account', 'backend']);
  assert.deepEqual(asBackend.targets, ['backend.example.com:443'], asBackend.stderr);
});
