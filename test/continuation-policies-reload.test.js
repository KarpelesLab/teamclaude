import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

// Owner-root continuation policies (IPM fork, AI-1903) through the real server
// as a subprocess: a boot without `continuationPolicies` is byte-for-byte
// legacy, a reload adds/changes roots in the same atomic stretch as the client
// keys and routes, and a malformed reload fails safe to recommend.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));
const HOUR = 3600_000;
const keyHash = (k) => createHash('sha256').update(k).digest('hex');

async function withServer(fn) {
  /** @type {string[]} */
  const hits = [];
  const spentFor = new Set();
  const stub = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const key = String(req.headers['x-api-key'] || '');
    hits.push(key);
    if (spentFor.has(key)) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const stubPort = await listen(stub);
  const logged = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }], requireClientRoute: true },
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      accounts: [
        { name: 'a@example.com', type: 'apikey', apiKey: 'k1' },
        { name: 'b@example.com', type: 'apikey', apiKey: 'k2' },
        { name: 'c@example.com', type: 'apikey', apiKey: 'k3' },
      ],
      clientRoutes: [{ name: 's1+s2+s3', clients: ['ana'], accounts: ['a@example.com', 'b@example.com', 'c@example.com'] }],
    }),
  });
  try {
    await fn({ hits, spentFor, port: logged.port, configPath: logged.configPath });
  } finally {
    await logged.stop();
    stub.close();
  }
}

async function send(port, { session, text, policy, key = 'ana-key' }) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'x-claude-code-session-id': session,
      ...(policy ? { 'x-teamclaude-seat-policy': policy } : {}),
    },
    body: JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

const reload = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
  assert.equal(res.status, 200, await res.text());
};

const status = async (port, key = 'admin-key') => {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key } });
  return res.json();
};

test('boot without the field is legacy; reload adds, changes and fail-safes roots without a restart', async () => {
  await withServer(async ({ hits, spentFor, port, configPath }) => {
    // Boot without continuationPolicies: legacy header behavior, byte-identical.
    assert.equal((await send(port, { session: 'a', text: 'one' })).status, 200);
    spentFor.add('k1');
    const forced = await send(port, { session: 'a', text: 'one', policy: '*=force' });
    assert.equal(forced.status, 200, 'legacy force still hops');
    assert.deepEqual(hits, ['k1', 'k1', 'k2']);
    const bootStatus = await status(port);
    assert.deepEqual(bootStatus.capabilities, { continuationPolicies: 1, workerIdentity: false });
    assert.deepEqual(bootStatus.continuationPolicies, []);
    assert.deepEqual(bootStatus.continuationPolicyErrors, []);
    assert.equal(bootStatus.continuationPolicyLoadError, null);

    // Reload adds a recommend root: the legacy force header is ignored.
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    disk.continuationPolicies = [{ client: 'ana', keyHash: keyHash('ana-key'), mode: 'recommend', revision: 'r_reload1', quarantine: false }];
    await writeFile(configPath, JSON.stringify(disk));
    await reload(port);
    assert.equal((await send(port, { session: 'b', text: 'two' })).status, 200, 'fresh conversation: the queue head servable account');
    spentFor.add('k2');
    const stopped = await send(port, { session: 'b', text: 'two', policy: '*=force' });
    assert.equal(stopped.status, 429, 'the recommend root ignores the legacy force header');
    assert.match(stopped.json?.error?.message ?? '', /next prompt confirms/);
    assert.deepEqual(hits, ['k1', 'k1', 'k2', 'k2', 'k2'], 'no hop under the recommend root');
    let admin = await status(port);
    assert.deepEqual(admin.continuationPolicies, [{ client: 'ana', mode: 'recommend', revision: 'r_reload1', quarantine: false }]);
    let ana = await status(port, 'ana-key');
    assert.deepEqual(ana.caller.continuationPolicy, { source: 'root', mode: 'recommend', revision: 'r_reload1' });
    assert.ok(!JSON.stringify(admin).includes(keyHash('ana-key')), 'the keyHash leaked into status');

    // Reload changes the root to force with a new revision: it applies with no
    // restart, and the legacy recommend header is ignored in turn.
    disk.continuationPolicies = [{ client: 'ana', keyHash: keyHash('ana-key'), mode: 'force', revision: 'r_reload2', quarantine: false }];
    await writeFile(configPath, JSON.stringify(disk));
    await reload(port);
    const forcedAgain = await send(port, { session: 'b', text: 'two', policy: '*=recommend' });
    assert.equal(forcedAgain.status, 200, 'the force root hops despite the legacy recommend header');
    assert.deepEqual(hits.at(-1), 'k3');
    admin = await status(port);
    assert.deepEqual(admin.continuationPolicies, [{ client: 'ana', mode: 'force', revision: 'r_reload2', quarantine: false }]);

    // A malformed reload fails safe to recommend and says so in status.
    spentFor.add('k3');
    disk.continuationPolicies = 'oops';
    await writeFile(configPath, JSON.stringify(disk));
    await reload(port);
    const safe = await send(port, { session: 'b', text: 'two', policy: '*=force' });
    assert.equal(safe.status, 429, 'fail-safe recommend: no hop under a malformed list');
    assert.match(safe.json?.error?.message ?? '', /no other account on this seat can serve now/);
    assert.deepEqual(hits.filter((h) => h === 'k3').length, 2, 'no second k3 attempt: the legacy force header was ignored');
    admin = await status(port);
    assert.equal(admin.continuationPolicyLoadError, 'malformed_list');
    assert.deepEqual(admin.continuationPolicies, []);
    ana = await status(port, 'ana-key');
    assert.deepEqual(ana.caller.continuationPolicy, { source: 'root', mode: 'recommend', revision: null });
  });
});
