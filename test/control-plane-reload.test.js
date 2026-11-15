import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

// proxy.controlPlane is read per request off the running config, so a reload
// that sets it, or drops it, moves bootstrap between the client's login and
// the pool without a restart. The stub upstream records which credential went out.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('a reload switches proxy.controlPlane both ways', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port: proxyPort, configPath } = server;
  const setControlPlane = async (value) => {
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    if (value === undefined) delete disk.proxy.controlPlane; else disk.proxy.controlPlane = value;
    await writeFile(configPath, JSON.stringify(disk));
    const res = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/reload`, { method: 'POST' });
    assert.equal(res.status, 200, await res.text());
  };
  const bootstrap = async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/claude_cli/bootstrap`, { headers: { authorization: 'Bearer client-own-token' } });
    await res.text();
    return seen.at(-1);
  };

  try {
    assert.deepEqual(await bootstrap(), { authorization: 'Bearer client-own-token', apiKey: null });
    await setControlPlane('pool');
    assert.deepEqual(await bootstrap(), { authorization: null, apiKey: 'k1' });
    await setControlPlane(undefined);
    assert.deepEqual(await bootstrap(), { authorization: 'Bearer client-own-token', apiKey: null });
  } finally {
    await server.stop();
    upstream.close();
  }
});
