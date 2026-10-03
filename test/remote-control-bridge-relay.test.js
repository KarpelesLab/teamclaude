import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener } from '../src/server.js';

// Since Claude Code 2.1.287 `claude remote-control` honours HTTPS_PROXY
// (anthropics/claude-code#97352), so the bridge's control plane reaches the
// proxy: it registers the machine as an environment, polls that environment for
// work, and creates and drives the sessions it serves. None of it is inference,
// and all of it is bound to the client's own login. Under a rotated fleet token
// the environment landed in a different account's org on each restart, creating
// its session answered 404, and the work poll, whose bearer is the environment
// secret rather than an OAuth token, drew a 401 from every account in turn.
//
// The account manager here throws from getActiveAccount, so any test that passes
// proves the relay never even consulted the fleet for that path.

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// Records what reached upstream, the body included: registration and session
// creation are POSTs, and relayStream pipes their body rather than buffering it.
function recordingUpstream() {
  const seen = [];
  return listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || null,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }).then(r => ({ ...r, seen }));
}

async function through(accountManager, method, path, body) {
  const { server: upstream, port, seen } = await recordingUpstream();
  const listener = createProxyRequestListener({ accountManager, upstream: `http://127.0.0.1:${port}` });
  const { server: proxy, port: proxyPort } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method,
      headers: { authorization: 'Bearer client-own-token', ...(body && { 'content-type': 'application/json' }) },
      body,
    });
    return { status: res.status, text: await res.text(), seen };
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.close();
  }
}

const refusingManager = {
  accounts: [],
  getActiveAccount() { throw new Error('must not rotate a Remote Control bridge request'); },
};

// The calls the 2.1.287 bridge makes, in the shapes its bundle builds (the ids
// are placeholders). A query string goes out on the wire but is not part of the
// classified path, so the bare collection still matches when it carries one.
for (const [method, path] of [
  ['POST', '/v1/environments/bridge'],
  ['GET', '/v1/environments/env_01/work/poll'],
  ['GET', '/v1/environments/env_01/work/poll?reclaim_older_than_ms=5000'],
  ['POST', '/v1/environments/env_01/work/work_01/ack'],
  ['POST', '/v1/environments/env_01/work/work_01/heartbeat'],
  ['POST', '/v1/environments/env_01/bridge/reconnect'],
  ['POST', '/v1/environments/bridge/env_01/offline'],
  ['POST', '/v1/sessions'],
  ['GET', '/v1/sessions?beta=true'],
  ['GET', '/v1/sessions/session_01'],
  ['POST', '/v1/sessions/session_01/events'],
  ['POST', '/v2/session_ingress/shttp/mcp/session_01'],
  ['POST', '/v2/ccr-sessions/-/meta/mcp'],
]) {
  test(`${method} ${path} keeps the client's own credential`, async () => {
    const body = method === 'POST' ? JSON.stringify({ environment_id: 'env_01' }) : undefined;
    const { status, seen } = await through(refusingManager, method, path, body);
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer client-own-token',
      'a fleet token was attached to the Remote Control bridge');
    assert.equal(seen[0].url, path, 'the path must be forwarded exactly as sent');
    if (body) assert.equal(seen[0].body, body, 'the body must reach upstream unchanged');
  });
}

// The other side of the segment boundary. Each entry ends in '/', and only the
// collection itself matches without it, so a path that merely shares the
// letters is not the bridge and is served by the rotated fleet account like any
// other. A bare '/v1/sessions' prefix would pass every test above and still
// take '/v1/sessionsX'.
function fleetManager() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'fleet-token', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
}

for (const path of ['/v1/sessionsX', '/v1/environmentsX/bridge']) {
  test(`${path} is not the bridge and still rotates`, async () => {
    const { status, seen } = await through(fleetManager(), 'GET', path);
    assert.equal(status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer fleet-token',
      'a path outside the bridge namespaces must be served by the rotated fleet account');
  });
}
