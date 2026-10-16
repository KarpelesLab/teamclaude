import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH = '1';
const { createProxyServer } = await import('../src/server.js');
const { AccountManager } = await import('../src/account-manager.js');

test('browser discovery stays local and model discovery defaults only missing native versions', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    seen.push(options.headers);
    return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
  };
  const am = new AccountManager([{ name: 'test', type: 'apikey', apiKey: 'test-key' }]);
  const server = createProxyServer(am, {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    assert.equal((await root.json()).service, 'TeamClaude');
    assert.equal((await fetch(base + '/favicon.ico')).status, 204);
    assert.equal(seen.length, 0);
    for (const headers of [{}, { 'anthropic-version': '2023-01-01' }]) {
      const response = await fetch(base + '/v1/models?limit=1', { headers });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(seen[0]['anthropic-version'], '2023-06-01');
    assert.equal(seen[1]['anthropic-version'], '2023-01-01');
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
