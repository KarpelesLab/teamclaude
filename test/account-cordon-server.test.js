import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnServer } from '../test-helpers/spawn-server.js';

// A cordon against the real server: `teamclaude cordon` writes the account's
// row and the running server's reload takes it up, a restart reads it back,
// and a pinned launch naming the account is refused where it would start.

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const run = promisify(execFile);
const SESSION = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, first) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-claude-code-session-id': SESSION },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: first }] }));
  });
}

const status = async port => (await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } })).json())
  .accounts.map((/** @type {any} */ a) => [a.name, a.cordoned, a.cordonRemaining]);

test('a cordon written by the CLI is applied live, keeps the conversation on the account, and survives a restart', { timeout: 120_000 }, async () => {
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(req.headers['x-api-key']);
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const upstreamPort = await listen(upstream);
  let server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamProxy: false,
      accounts: [
        { name: 'work', type: 'apikey', apiKey: 'k-work' },
        { name: 'personal', type: 'apikey', apiKey: 'k-personal' },
      ],
    }),
  });
  const { dir, configPath } = server;
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  delete env.TC_ACCT;
  try {
    assert.equal(await post(server.port, 'the running one'), 200);
    assert.equal(served.at(-1), 'k-work');

    const cordoned = await run(process.execPath, [cli, 'cordon', 'work'], { env, timeout: 30_000 });
    assert.match(cordoned.stdout, /Cordoned account "work": no new conversations go to it/);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).accounts[0].cordoned, true);
    assert.deepEqual(await status(server.port), [['work', true, 1], ['personal', false, undefined]]);

    assert.equal(await post(server.port, 'the running one'), 200);
    assert.equal(served.at(-1), 'k-work', 'the conversation on it stays');
    assert.equal(await post(server.port, 'a new one'), 200);
    assert.equal(served.at(-1), 'k-personal', 'nothing new goes to it');

    // A pinned launch naming it is new work, refused before anything starts,
    // in any spelling the proxy would take for the pin.
    for (const pin of ['work', 'WORK']) {
      await assert.rejects(run(process.execPath, [cli, 'run'], { env: { ...env, TC_ACCT: pin }, timeout: 30_000 }), (/** @type {any} */ error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /is cordoned: it takes no new conversations/);
        return true;
      });
    }

    // The flag is the config's, so a restart keeps it.
    await server.stop();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    server = await spawnServer({ config: () => saved, dir });
    assert.deepEqual((await status(server.port)).map(([name, cordoned]) => [name, cordoned]), [['work', true], ['personal', false]]);
    assert.equal(await post(server.port, 'another new one'), 200);
    assert.equal(served.at(-1), 'k-personal');

    const uncordoned = await run(process.execPath, [cli, 'uncordon', 'work'], { env: { ...env, TEAMCLAUDE_CONFIG: server.configPath }, timeout: 30_000 });
    assert.match(uncordoned.stdout, /Uncordoned account "work"/);
    assert.equal('cordoned' in JSON.parse(await readFile(configPath, 'utf8')).accounts[0], false);
    assert.deepEqual((await status(server.port)).map(([name, cordoned]) => [name, cordoned]), [['work', false], ['personal', false]]);
  } finally {
    await server.stop();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude release empties the running server\'s pins on an account and keeps it in service', { timeout: 120_000 }, async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const upstreamPort = await listen(upstream);
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamProxy: false,
      accounts: [
        { name: 'work', type: 'apikey', apiKey: 'k-work' },
        { name: 'personal', type: 'apikey', apiKey: 'k-personal' },
      ],
    }),
  });
  const env = { ...process.env, TEAMCLAUDE_CONFIG: server.configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const row = async () => (await (await fetch(`http://127.0.0.1:${server.port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } })).json())
    .accounts.find((/** @type {any} */ a) => a.name === 'work');
  try {
    assert.equal(await post(server.port, 'the running one'), 200);
    assert.equal((await row()).knownSessions, 1);

    const released = await run(process.execPath, [cli, 'release', 'work'], { env, timeout: 30_000 });
    assert.match(released.stdout, /Released 1 conversation pinned to "work"/);
    const after = await row();
    assert.equal(after.knownSessions, 0);
    assert.equal(after.disabled, false);
  } finally {
    await server.stop();
    upstream.close();
    await rm(server.dir, { recursive: true, force: true }).catch(() => {});
  }
});
