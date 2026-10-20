import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// An account whose token has expired and whose renewal could not be done — the
// coordinator stood down (the callback lock was not to be had), or the token
// endpoint refused for now — has nothing upstream will take. Forwarding it anyway
// earns a 401, the 401 forces a refresh that fails the same way, the retry earns
// a second 401, and the client gets a 502: measured, 2 requests to upstream with
// a credential known to be dead.

const H = 3600_000;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function fleet(accounts, coordinator) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    hits.push(token);
    if (token.startsWith('dead-')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', served: token }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98, {});
  am.accounts.forEach((a) => { a.probing = false; });
  am.setRefreshCoordinator(coordinator);
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const send = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    return { status: r.status, body: await r.json() };
  };
  return { send, hits, am, close: () => { proxy.close(); upstream.close(); } };
}

const expired = (name) => ({ name, type: 'oauth', accessToken: `dead-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() - H });
const healthy = (name) => ({ name, type: 'oauth', accessToken: `live-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 8 * H });
const standDown = async () => {
  throw Object.assign(new Error('not renewed without the callback.net lock: the lock was not to be had'), { code: 'CALLBACK_LOCK_UNAVAILABLE' });
};

test('an expired token that could not be renewed is not sent upstream; the client is told, not given a 401', async () => {
  const f = await fleet([expired('a')], standDown);
  try {
    const r = await f.send();
    assert.deepEqual(f.hits, [], 'nothing went upstream with the dead credential');
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
    assert.ok(r.status >= 500, `${r.status}`);
    assert.match(r.body.error.message, /expired and could not be renewed/);
  } finally { f.close(); }
});

test('with another account to serve, the request fails over to it without touching upstream with the dead one', async () => {
  const f = await fleet([expired('a'), healthy('b')], standDown);
  try {
    f.am.accounts[0].quota.unified5h = 0.1; // make «a» the preferred pick
    const r = await f.send();
    assert.equal(r.status, 200);
    assert.deepEqual(f.hits, ['live-b']);
  } finally { f.close(); }
});

test('control: a renewal that works is used, and the request is served with the new token', async () => {
  const f = await fleet([expired('a')], async (_account, refresh) => refresh());
  f.am._refreshFn = async () => ({ accessToken: 'live-a2', refreshToken: 'rt-a2', expiresAt: Date.now() + 8 * H });
  try {
    const r = await f.send();
    assert.equal(r.status, 200);
    assert.deepEqual(f.hits, ['live-a2']);
  } finally { f.close(); }
});
