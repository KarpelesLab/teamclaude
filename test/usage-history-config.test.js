import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { usageStoreAvailable } from '../src/usage/db.js';

const USAGE_STORE_AVAILABLE = usageStoreAvailable();

// proxy.usageHistory is off by default: a server started without it writes no
// usage.db and its route reports no data. With it on, a proxied request lands
// in the history the route serves.

const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withServer(usageHistory, fn, env = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'm', content: [], usage: { input_tokens: 3, output_tokens: 5 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test', ...(usageHistory === undefined ? {} : { usageHistory }) },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
    env,
  });
  try {
    await fn(server);
  } finally {
    await server.stop();
    upstream.close();
  }
}

async function oneRequestThenUsage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
  });
  await res.text();
  return (await fetch(`http://127.0.0.1:${port}/teamclaude/usage?window=5h`)).json();
}

test('usage history is off by default and writes no file', async () => {
  await withServer(undefined, async ({ port, configPath }) => {
    const usage = await oneRequestThenUsage(port);
    assert.equal(usage.available, false);
    assert.equal(usage.totals.requests, 0);
    assert.equal(existsSync(configPath.replace(/\.json$/, '.usage.db')), false);
  });
});

test('proxy.usageHistory true records the request the route then serves', async () => {
  await withServer(true, async ({ port }) => {
    const usage = await oneRequestThenUsage(port);
    assert.equal(usage.available, true);
    assert.equal(usage.totals.requests, 1);
    assert.equal(usage.totals.input, 3);
    assert.equal(usage.totals.output, 5);
  });
});

// Without node:sqlite (Node 20, or 22.5–22.12 without the flag) the server
// still starts with history on, and the route says there is no data. Where
// node:sqlite exists, --no-experimental-sqlite takes it away for the child.
nodeTest('proxy.usageHistory true on a Node without node:sqlite still serves, with no history', async () => {
  const env = USAGE_STORE_AVAILABLE ? { NODE_OPTIONS: '--no-experimental-sqlite' } : {};
  await withServer(true, async ({ port, configPath }) => {
    const usage = await oneRequestThenUsage(port);
    assert.equal(usage.available, false);
    assert.equal(existsSync(configPath.replace(/\.json$/, '.usage.db')), false);
  }, env);
});
