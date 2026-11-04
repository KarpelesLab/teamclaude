import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

// The real server as a subprocess (IPM fork AI-1552): `clientRoutes` and
// `proxy.requireClientRoute` are picked up by POST /teamclaude/reload together
// with the client keys, without a restart, and the headless activity log
// carries the gate's reason in its tag slot, in the line shape the gateway
// console parses (`→ <account> [<tag>] (<status>, <dur>s)`). A request
// served on its seat is a pinned request and keeps the `[pin]` tag.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// The gateway console's activity regex (claude-gateway activity.service.ts).
const CONSOLE_LINE = /^(\d{2}:\d{2}:\d{2})\s+(?:\[([^\]]+)\]\s+)?(?:(\S+)\s+)?([A-Z]{3,7})\s+(\S+)(?:\s+\(([^)]*)\))?\s+→\s+(.+?)(?:\s+\[[^\]]+\])?\s+\((\d{3}|null),\s*([\d.]+)(ms|s)\)/;

async function withServer(fn) {
  /** @type {string[]} */
  const hits = [];
  const stub = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    hits.push(String(req.headers['x-api-key'] || ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const stubPort = await listen(stub);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-client-routes-'));
  const activityPath = join(dir, 'activity.log');
  const logged = await spawnServer({
    dir,
    config: () => ({
      proxy: { apiKey: 'admin-key', clientKeys: [{ name: 'ana', key: 'ana-key' }, { name: 'uma', key: 'uma-key' }] },
      upstream: `http://127.0.0.1:${stubPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }, { name: 'b@example.com', type: 'apikey', apiKey: 'k2' }],
      clientRoutes: [{ name: 'seat-a', clients: ['ana'], accounts: ['a@example.com'] }],
    }),
    args: ['--activity-log', activityPath],
  });
  try {
    await fn({ hits, port: logged.port, configPath: logged.configPath, activityPath });
  } finally {
    await logged.stop();
    stub.close();
  }
}

async function send(port, key) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  await res.text();
  return res.status;
}

test('reload applies clientRoutes and requireClientRoute together, and the activity log names the reason', async () => {
  await withServer(async ({ hits, port, configPath, activityPath }) => {
    assert.equal(await send(port, 'ana-key'), 200);
    assert.equal(await send(port, 'uma-key'), 200, 'switch off: a key with no seat still rotates');
    assert.equal(hits[0], 'k1', 'ana is on seat-a');

    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    disk.clientRoutes = [{ name: 'seat-b', clients: ['ana'], accounts: ['b@example.com'] }];
    disk.proxy.requireClientRoute = true;
    await writeFile(configPath, JSON.stringify(disk));
    const reload = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(reload.status, 200, await reload.text());

    hits.length = 0;
    assert.equal(await send(port, 'ana-key'), 200);
    assert.deepEqual(hits, ['k2'], 'the new route applies with no restart');
    assert.equal(await send(port, 'uma-key'), 403, 'and so does the switch');

    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'admin-key' } })).json();
    assert.equal(status.requireClientRoute, true);
    assert.deepEqual(status.clientRoutes.map(r => r.name), ['seat-b']);

    await sleep(200);
    const lines = (await readFile(activityPath, 'utf8')).split('\n');
    const refused = lines.find(l => /\[uma\] POST \/v1\/messages .*→ \(no seat\) \[no-seat\] \(403, /.test(l));
    assert.ok(refused, lines.join('\n'));
    const m = CONSOLE_LINE.exec(refused);
    assert.ok(m, `the console parses the line: ${JSON.stringify(refused)}`);
    assert.equal(m[2], 'uma');
    assert.equal(m[7], '(no seat)');
    assert.equal(m[8], '403');
    assert.ok(lines.some(l => /Seat gate: client "uma" seat \(none\) → no-seat \(403\)/.test(l)), lines.join('\n'));
    const served = lines.find(l => /\[ana\] POST \/v1\/messages .*→ b@example\.com \[pin\] \(200, /.test(l));
    assert.ok(served, lines.join('\n'));
    assert.equal(CONSOLE_LINE.exec(served)?.[7], 'b@example.com');
  });
});
