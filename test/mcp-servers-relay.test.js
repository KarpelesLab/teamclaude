import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyRequestListener } from '../src/server.js';

// The claude.ai connector list (/v1/mcp_servers) belongs to the client's login:
// the connectors it names are then called on mcp-proxy.anthropic.com with that
// same login, so a list fetched under a rotated account names connectors the
// client cannot reach. getActiveAccount throws, so a passing test proves the
// relay never consulted the fleet for these paths.

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function recordingUpstream() {
  const seen = [];
  return listen((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  }).then(r => ({ ...r, seen }));
}

const refusingManager = {
  accounts: [],
  getActiveAccount() { throw new Error('must not rotate a /v1/mcp_servers request'); },
};

async function through(path, init) {
  const { server: upstream, port, seen } = await recordingUpstream();
  const listener = createProxyRequestListener({ accountManager: refusingManager, upstream: `http://127.0.0.1:${port}` });
  const { server: proxy, port: proxyPort } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, init);
    return { status: res.status, text: await res.text(), seen };
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.close();
  }
}

for (const path of ['/v1/mcp_servers?limit=1000&include_additional_installs=true', '/v1/mcp_servers/mcpsrv_abc']) {
  test(`a GET to ${path} keeps the client's own credential`, async () => {
    const { status, seen } = await through(path, { headers: { authorization: 'Bearer client-own-token' } });
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer client-own-token');
    assert.equal(seen[0].url, path, 'the path and its query must reach upstream unchanged');
  });
}
