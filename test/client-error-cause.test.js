import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { refreshAccessToken } from '../src/oauth.js';
import { PROVIDERS } from '../src/provider.js';

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

// A token endpoint answering every renewal the same way, through the real
// refreshAccessToken, as a coordinator: `renew` stands in for the provider call.
async function tokenEndpoint(status, body, type = 'application/json') {
  const srv = http.createServer((req, res) => { req.resume(); res.writeHead(status, { 'content-type': type }); res.end(body); });
  const port = await listen(srv);
  return { renew: (/** @type {string} */ rt) => refreshAccessToken(rt, `http://127.0.0.1:${port}/token`), close: () => srv.close() };
}
// A page from something in front of the token endpoint (a firewall, a proxy)
// says nothing about the refresh token, which is kept (oauth.js
// isRefreshRejection), so a re-login is not what to advise. A 403 page and an
// empty 401, so that neither status can stand in for the token's refusal.
const PAGES = /** @type {const} */ ([[403, '<html><body>Access denied</body></html>', 'text/html'], [401, '', 'text/plain']]);

test('a renewal answered by a page in front of the token endpoint: the client is told to retry, not to re-login', async () => {
  for (const [status, body, type] of PAGES) {
    const page = await tokenEndpoint(status, body, type);
    const f = await fleet(expired, { coordinator: () => page.renew('rt-a') });
    try {
      const r = await f.send();
      assert.match(r.message, new RegExp(`could not be renewed.*\\(${status}\\).*Retry shortly`), r.message);
      assert.doesNotMatch(r.message, /teamclaude login/, r.message);
      assert.equal(f.am.accounts[0].status, 'active');
    } finally { f.close(); page.close(); }
  }
});

test('a 401 whose forced renewal meets a page in front of the token endpoint: the client is told the renewal failed, not to re-login', async () => {
  for (const [status, body, type] of PAGES) {
    const page = await tokenEndpoint(status, body, type);
    const live = { name: 'a', type: 'oauth', accessToken: 'live-a', refreshToken: 'rt-a', expiresAt: Date.now() + 8 * H };
    const f = await fleet(live, { coordinator: () => page.renew('rt-a') });
    try {
      const r = await f.send();
      assert.match(r.message, new RegExp(`token of "a" could not be renewed.*\\(${status}\\)`), r.message);
      assert.doesNotMatch(r.message, /teamclaude login/, r.message);
    } finally { f.close(); page.close(); }
  }
});

// The advice stays where it helps: a refresh token the token endpoint refused
// (invalid_grant) is replaced by a re-login. Reaching the unrenewed answer with
// one takes the last retry: b's 401 forces a renewal, and its new token's 529
// hops the request to a, whose renewal is refused.
test('a renewal the token endpoint refused on the last retry: the client is told to re-login', async () => {
  const refusing = await tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' }));
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    res.writeHead(token === 'old-b' ? 401 : 529, { 'content-type': 'application/json' });
    res.end(`{"type":"error","error":{"type":"${token === 'old-b' ? 'authentication_error' : 'overloaded_error'}"}}`);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'b', type: 'oauth', accessToken: 'old-b', refreshToken: 'rt-b', expiresAt: Date.now() + 8 * H },
    { name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H },
  ], 0.98, {});
  am.accounts.forEach((a) => { a.probing = false; });
  am.setRefreshCoordinator(async (account) => (account.name === 'b'
    ? { accessToken: 'new-b', refreshToken: 'rt-b2', expiresAt: Date.now() + 8 * H }
    : refusing.renew(account.refreshToken)));
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.equal(am.accounts[1]._deadRefreshToken, 'rt-a');
    assert.match(message, /token of "a" has expired and could not be renewed.*invalid_grant.*Re-add it with: teamclaude login/, message);
  } finally { proxy.close(); upstream.close(); refusing.close(); }
});

// A hold arms the same guard, but a re-login does not lift it (docs/accounts.md):
// the hold's own words, in status, say what to do. So no advice to sign in again.
test('a renewal refused for a hold on the last retry: the client is not told to re-login', async () => {
  const holding = await tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant', error_description: 'account_on_hold', error_uri: 'https://claude.ai/restricted' }));
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    res.writeHead(token === 'old-b' ? 401 : 529, { 'content-type': 'application/json' });
    res.end(`{"type":"error","error":{"type":"${token === 'old-b' ? 'authentication_error' : 'overloaded_error'}"}}`);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'b', type: 'oauth', accessToken: 'old-b', refreshToken: 'rt-b', expiresAt: Date.now() + 8 * H },
    { name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H },
  ], 0.98, {});
  am.accounts.forEach((a) => { a.probing = false; });
  am.setRefreshCoordinator(async (account) => (account.name === 'b'
    ? { accessToken: 'new-b', refreshToken: 'rt-b2', expiresAt: Date.now() + 8 * H }
    : holding.renew(account.refreshToken)));
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.equal(am.accounts[1].errorReason?.code, 'account_on_hold');
    assert.match(message, /token of "a" has expired and could not be renewed.*account_on_hold/, message);
    assert.doesNotMatch(message, /teamclaude login/, message);
  } finally { proxy.close(); upstream.close(); holding.close(); }
});

// The advice names the account's own login command (its errorReason.remedy):
// a Codex account signs in again with `teamclaude login --codex`. The same last
// retry as above, through the Codex path, with the Codex backend pointed at a
// local server for the test.
test('a Codex renewal refused on the last retry: the client is told the Codex login', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    res.writeHead(token === 'old-b' ? 401 : 529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: token === 'old-b' ? 'unauthorized' : 'overloaded' } }));
  });
  const upstreamPort = await listen(upstream);
  const backend = PROVIDERS.codex.upstream;
  PROVIDERS.codex.upstream = `http://127.0.0.1:${upstreamPort}`;
  const codex = (/** @type {string} */ name, /** @type {Record<string, any>} */ extra) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, refreshToken: `rt-${name}`, ...extra });
  const am = new AccountManager([
    codex('b', { accessToken: 'old-b', expiresAt: Date.now() + 8 * H }),
    codex('a', { accessToken: 'dead-a', expiresAt: Date.now() - H }),
  ], 0.98, {
    codexRefreshFn: async (/** @type {string} */ rt) => {
      if (rt === 'rt-b') return { accessToken: 'new-b', refreshToken: 'rt-b2', expiresAt: Date.now() + 8 * H };
      throw Object.assign(new Error('Codex token refresh failed (401): {}'), { status: 401 });
    },
  });
  am.accounts.forEach((a) => { a.probing = false; });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, {});
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-luna', input: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.equal(am.accounts[1]._deadRefreshToken, 'rt-a');
    assert.match(message, /token of "a" has expired and could not be renewed.*Re-add it with: teamclaude login --codex/, message);
  } finally { PROVIDERS.codex.upstream = backend; proxy.close(); upstream.close(); }
});

// The other advice site, refusalMessage: a Codex account refused (403) while a
// renewal of its token was being refused (a refresh from another request, or
// the probe), so it holds a dead refresh token and a failure when the 403 lands.
test('a Codex account refused while its renewal is refused: the client is told the Codex login', async () => {
  /** @type {() => void} */
  let release = () => {};
  const answered = new Promise((resolve) => { release = resolve; });
  /** @type {() => void} */
  let arrived = () => {};
  const forwarded = new Promise((resolve) => { arrived = resolve; });
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    arrived();
    await answered;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'forbidden' } }));
  });
  const upstreamPort = await listen(upstream);
  const backend = PROVIDERS.codex.upstream;
  PROVIDERS.codex.upstream = `http://127.0.0.1:${upstreamPort}`;
  const am = new AccountManager([
    { name: 'a', type: 'oauth', provider: 'codex', accountId: 'acct-a', accessToken: 'live-a', refreshToken: 'rt-a', expiresAt: Date.now() + 8 * H },
  ], 0.98, { codexRefreshFn: async () => { throw Object.assign(new Error('Codex token refresh failed (401): {}'), { status: 401 }); } });
  am.accounts[0].probing = false;
  am.selectActiveAccount();
  const proxy = createProxyServer(am, {});
  const port = await listen(proxy);
  try {
    const sent = fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-luna', input: [] }),
    });
    await forwarded;
    await am.ensureTokenFresh(0, true);
    assert.equal(am.accounts[0]._deadRefreshToken, 'rt-a');
    release();
    const message = (await (await sent).json()).error?.message || '';
    assert.match(message, /token of "a" could not be renewed.*Re-add it with: teamclaude login --codex/, message);
  } finally { PROVIDERS.codex.upstream = backend; release(); proxy.close(); upstream.close(); }
});

// The advice follows the refresh token the account holds: one refused while
// newer tokens arrived (a reload, a sign-in) is not theirs to sign in again for.
test('a refusal of the token a renewal sent, after newer tokens arrived: the client is not told to re-login over it', async () => {
  const refusing = await tokenEndpoint(400, JSON.stringify({ error: 'invalid_grant' }));
  const f = await fleet(expired, {
    coordinator: async (account) => {
      const sent = account.refreshToken;
      // Newer tokens land while the renewal is out, already expired themselves.
      f.am.updateAccountTokens(0, { accessToken: 'dead-a2', refreshToken: 'rt-a2', expiresAt: Date.now() - H });
      return refusing.renew(sent);
    },
  });
  try {
    const r = await f.send();
    assert.equal(f.am.accounts[0]._deadRefreshToken, 'rt-a');
    assert.equal(f.am.accounts[0].refreshToken, 'rt-a2');
    assert.match(r.message, /could not be renewed/);
    assert.doesNotMatch(r.message, /teamclaude login/, r.message);
  } finally { f.close(); refusing.close(); }
});

// The unrenewed answer reads the accounts by the names the request recorded,
// and one of them can be gone by then: here b's renewal removes a (a reload
// that dropped it, say) before failing the same way. The missing account gets
// no advice, and the answer is still the unrenewed one.
test('an account removed while the request was out: the unrenewed answer still comes, without re-login advice', async () => {
  const page = await tokenEndpoint(403, '<html><body>Access denied</body></html>', 'text/html');
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'dead-a', refreshToken: 'rt-a', expiresAt: Date.now() - H },
    { name: 'b', type: 'oauth', accessToken: 'dead-b', refreshToken: 'rt-b', expiresAt: Date.now() - H },
  ], 0.98, {});
  am.accounts.forEach((a) => { a.probing = false; });
  am.setRefreshCoordinator(async (account) => {
    if (account.name === 'b') am.removeAccount(am.accounts.findIndex((a) => a.name === 'a'));
    return page.renew(account.refreshToken);
  });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.deepEqual(am.accounts.map((a) => a.name), ['b']);
    assert.equal(r.status, 503, message);
    assert.match(message, /token of "a", "b" has expired and could not be renewed.*Retry shortly/, message);
    assert.doesNotMatch(message, /teamclaude login/, message);
  } finally { proxy.close(); upstream.close(); page.close(); }
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

// The renewal failure quoted is the unrenewed account's own (recordRefusal), not
// that of the first account of its name: here a disabled one, listed first, with
// no failed renewal behind it.
test('an unrenewable token is quoted from its own account beside a same-named disabled one', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"authentication_error"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't-off', refreshToken: 'rt-off', expiresAt: Date.now() + H, disabled: true }, expired], 0.98, {});
  for (const account of am.accounts) account.probing = false;
  am.setRefreshCoordinator(async () => { throw Object.assign(new Error(`not renewed without the callback.net lock: ${notOwner}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' }); });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    const message = (await r.json()).error?.message || '';
    assert.equal(r.status, 503, message);
    assert.ok(message.includes('this install may not renew this account right now'), message);
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
