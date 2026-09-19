import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Control routes match an exact method and path, and anything that missed fell
// through to the forwarder: a typo, or just `GET /teamclaude/reload`, went
// upstream with a fleet account's credential and came back as that server's 404
// (#420). The prefix is the proxy's own, so an unclaimed path under it is
// answered here.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('an unclaimed /teamclaude/ path is a local 404 and never reaches upstream', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => { upstreamHits++; res.writeHead(404); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (const path of ['/teamclaude/reload', '/teamclaude/statuss', '/teamclaude', '/teamclaude/', '/%74eamclaude/reload', '/teamclaude\\reload']) {
      const { status, body } = await rawGet(port, path);
      assert.equal(status, 404, path);
      assert.match(JSON.parse(body).error, /unknown teamclaude control route/, path);
    }
    assert.equal(upstreamHits, 0, 'nothing was forwarded under a fleet credential');

    // The real routes, and ordinary traffic, are untouched.
    assert.equal((await rawGet(port, '/teamclaude/status')).status, 200);
    await rawGet(port, '/v1/models');
    assert.equal(upstreamHits, 1, 'a path outside the prefix is still forwarded');
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
