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

// "Every account this request reached could not be renewed" is about the accounts
// it could reach: a disabled one is never tried, and counting it against the whole
// fleet hid the real cause behind a generic answer.
test('an unrenewable token is still named when a disabled account sits in the fleet', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"authentication_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([expired, { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'rt-c', expiresAt: Date.now() + H, disabled: true }], 0.98, {});
  am.accounts[0].probing = false;
  am.setRefreshCoordinator(async () => { throw Object.assign(new Error(`not renewed without the callback.net lock: ${notOwner}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' }); });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.match(message, /could not be renewed/, `status ${r.status}: ${message}`);
  } finally { proxy.close(); upstream.close(); }
});

// Control: "nothing else was tried" still means every account the request could
// reach. Beside an unrenewable token, an account whose five-hour window is spent
// will serve this request once it resets, so the client is told to wait - the
// quota answer - not that a renewal failed.
test('control: an unrenewable token beside a spent account still gets the quota answer', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"authentication_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([expired, { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'rt-b', expiresAt: Date.now() + H }], 0.98, {});
  am.accounts[0].probing = false;
  am.accounts[1].probing = false;
  Object.assign(am.accounts[1].quota, { unified5h: 1, unified5hReset: Date.now() + H, sessionWindowStated: true });
  am.setRefreshCoordinator(async () => { throw Object.assign(new Error(`not renewed without the callback.net lock: ${notOwner}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' }); });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.equal(r.status, 429, `status ${r.status}: ${message}`);
    assert.doesNotMatch(message, /could not be renewed/);
  } finally { proxy.close(); upstream.close(); }
});

// A conversation keeps a cordoned account (_keepOnCordoned), so a request can
// still be sent to one; when it is the only account and its token cannot be
// renewed, that is the whole story - the renewal's answer, not a quota wait.
test('a conversation kept on a cordoned account is told its token could not be renewed', async () => {
  let expired = false;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(expired ? 401 : 200, { 'content-type': 'application/json' });
      res.end(expired ? '{"type":"error","error":{"type":"authentication_error"}}' : '{}');
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'solo', type: 'oauth', accessToken: 't-solo', refreshToken: 'rt-solo', expiresAt: Date.now() + H }], 0.98, {});
  am.accounts[0].probing = false;
  am.setRefreshCoordinator(async () => { throw Object.assign(new Error(`not renewed without the callback.net lock: ${notOwner}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' }); });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const turn = (messages) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': 'kept' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages }),
  });
  try {
    assert.equal((await turn([{ role: 'user', content: 'start' }])).status, 200);
    am.setCordoned(0, true);
    expired = true;
    Object.assign(am.accounts[0], { accessToken: 'expired', expiresAt: Date.now() - 1000 });
    const r = await turn([{ role: 'user', content: 'start' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }]);
    const message = (await r.json()).error?.message || '';
    assert.match(message, /could not be renewed/, `status ${r.status}: ${message}`);
  } finally { proxy.close(); upstream.close(); }
});
