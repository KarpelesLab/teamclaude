import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// What the client is told when no account served it has to name the real cause.
// It said «Upstream refused the credential for account … (403). Check the
// account, then re-add it with: teamclaude login» for every refusal — including
// a 401 on a token whose renewal had just failed for a reason that a re-login
// does not touch: the store's lock denied, the token endpoint's 429.

const H = 3600_000;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function fleet(account, { coordinator, upstreamStatus = 401 } = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"authentication_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([account], 0.98, {});
  am.accounts[0].probing = false;
  if (coordinator) am.setRefreshCoordinator(coordinator);
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const send = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    return { status: r.status, message: (await r.json()).error?.message || '' };
  };
  return { send, am, close: () => { proxy.close(); upstream.close(); } };
}

const expired = { name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H };
const notOwner = 'the callback.net lock could not be taken (this install may not renew this account right now)';

test('a renewal the coordinator could not do: the client is told why, not to re-login', async () => {
  const f = await fleet(expired, {
    coordinator: async () => { throw Object.assign(new Error(`not renewed without the callback.net lock: ${notOwner}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' }); },
  });
  try {
    const r = await f.send();
    assert.match(r.message, /could not be renewed/);
    assert.ok(r.message.includes('this install may not renew this account right now'), r.message);
    assert.doesNotMatch(r.message, /teamclaude login|\(403\)/, r.message);
  } finally { f.close(); }
});

test('a renewal the token endpoint refused for now (429): the client is told so', async () => {
  const f = await fleet(expired, {
    coordinator: async () => { throw Object.assign(new Error('Token refresh failed (429): {"error":{"type":"rate_limit_error"}}'), { status: 429 }); },
  });
  try {
    const r = await f.send();
    assert.match(r.message, /could not be renewed.*429/);
    assert.doesNotMatch(r.message, /teamclaude login|\(403\)/, r.message);
  } finally { f.close(); }
});

test('control: a credential upstream refuses with no failed renewal keeps the advice, with the status it got', async () => {
  const live = { name: 'a', type: 'oauth', accessToken: 'live-a', refreshToken: 'rt-a', expiresAt: Date.now() + 8 * H };
  const f = await fleet(live, { upstreamStatus: 403 });
  try {
    const r = await f.send();
    assert.match(r.message, /refused the credential for account "a" \(403\).*teamclaude login/);
  } finally { f.close(); }
});
