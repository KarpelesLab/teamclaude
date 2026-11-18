import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener, resolveAccountPin } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

// ── resolveAccountPin (unit) ─────────────────────────────────────────────────

const withIds = (name, accountUuid, orgUuid) => ({ ...oauth(name), accountUuid, orgUuid });

test('resolveAccountPin matches by accountUuid, orgUuid, name and email', () => {
  const am = new AccountManager([
    withIds('me@x.com (Acme)', 'AAA', 'O1'),
    withIds('me@x.com (Beta)', 'AAA', 'O2'),
    withIds('other@x.com', 'BBB', 'O3'),
  ], 0.98);
  assert.equal(resolveAccountPin(am, 'BBB'), 2);              // accountUuid
  assert.equal(resolveAccountPin(am, 'O2'), 1);               // orgUuid
  assert.equal(resolveAccountPin(am, 'me@x.com (Beta)'), 1);  // display name
  assert.equal(resolveAccountPin(am, 'other@x.com'), 2);      // bare email
  assert.equal(resolveAccountPin(am, 'BbB'), 2);              // case-insensitive
});

// One account across several orgs shares an accountUuid, so the qualified form
// is the only way to name the second one; a bare uuid takes the first match.
test('accountUuid/orgUuid selects one account among an org set', () => {
  const am = new AccountManager([
    withIds('me@x.com (Acme)', 'AAA', 'O1'),
    withIds('me@x.com (Beta)', 'AAA', 'O2'),
  ], 0.98);
  assert.equal(resolveAccountPin(am, 'AAA/O2'), 1);
  assert.equal(resolveAccountPin(am, 'AAA/O1'), 0);
  assert.equal(resolveAccountPin(am, 'AAA'), 0);       // first match wins
  assert.equal(resolveAccountPin(am, 'me@x.com'), 0);  // ditto for the email
});

// The rotation index is array position: deleting an account would repoint every
// later pin at a DIFFERENT account, so it is not an accepted pin form.
test('resolveAccountPin does not accept a rotation index', () => {
  const am = new AccountManager([oauth('alpha'), oauth('beta')], 0.98);
  assert.equal(resolveAccountPin(am, '0'), null);
  assert.equal(resolveAccountPin(am, '1'), null);
});

test('resolveAccountPin returns null for an unknown token', () => {
  const am = new AccountManager([oauth('alpha')], 0.98);
  assert.equal(resolveAccountPin(am, 'nope'), null);
  assert.equal(resolveAccountPin(am, ''), null);
  assert.equal(resolveAccountPin(am, '9'), null);
});

test('an account literally named "0" still resolves by name', () => {
  const am = new AccountManager([oauth('x'), { ...oauth('y'), name: '0' }], 0.98);
  assert.equal(resolveAccountPin(am, '0'), 1);
});

// ── end-to-end pin routing (integration) ─────────────────────────────────────

// Stand up a mock upstream that records the path and Authorization it received,
// so we can prove which account a pinned request was routed to and that the
// /tc-acct/<pin> prefix was stripped before forwarding.
async function withProxy(run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([oauth('alpha'), oauth('beta')], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);
  try {
    return await run({ proxyPort, seen, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

const post = (url, signal) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'x', messages: [] }),
  signal,
});

test('a /tc-acct/<name> request is routed to that exact account, prefix stripped', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/beta/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/v1/messages');          // prefix stripped
    assert.equal(seen[0].auth, 'Bearer t-beta');         // routed to 'beta', not rotation default
  });
});

test('pinning by numeric index also works', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/alpha/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-alpha');
  });
});

test('an unknown pin returns 404 and never reaches upstream', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/ghost/v1/messages`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error.type, 'not_found_error');
    assert.equal(seen.length, 0);
  });
});

test('pinning overrides rotation even when another account is the active one', async () => {
  await withProxy(async ({ proxyPort, seen, am }) => {
    am.currentIndex = 0; // rotation would pick 'alpha'
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/beta/v1/messages`);
    await res.text();
    assert.equal(seen[0].auth, 'Bearer t-beta'); // pin wins over the active account
  });
});

test('a normal (unpinned) request still rotates as before', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].path, '/v1/messages');
    assert.equal(seen[0].auth, 'Bearer t-alpha'); // default rotation → first account
  });
});

// A pinned account in error (a credential upstream refused, with no refresh
// token to renew it by) is never sent the request. The request records it as
// tried and is answered on the next attempt; recorded as anything the next
// attempt does not recognise, the pin was tried again on every attempt until
// the retry budget ran out, and then sent.
test('a request pinned to an account in error is answered without reaching upstream', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'alpha', type: 'oauth', accessToken: 't-alpha', expiresAt: Date.now() + 3600_000 },
    oauth('beta'),
  ], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  am.accounts[0].status = 'error';
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/alpha/v1/messages`);
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.match(body.error.message, /^Pinned account is unavailable/);
    assert.deepEqual(seen, [], 'the pinned account in error was sent the request');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The escaping of a `/tc-acct/` segment is the CLIENT's, so a malformed one is
// an ordinary bad request rather than something the proxy should choke on:
// decodeURIComponent throws URIError on '%', '%zz' and a truncated '%E0%A4'.
// The request is raced against a timer, so "never answered" is a failed
// assertion rather than a run that never finishes.
async function postWithin(url, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await post(url, ac.signal);
    await res.text();
    return res.status;
  } catch (err) {
    if (err.name === 'AbortError') return 'HUNG';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

test('a /tc-acct/ pin with a malformed escape is answered, not left hanging', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    for (const pin of ['%', '%zz', '%E0%A4']) {
      assert.equal(await postWithin(`http://127.0.0.1:${proxyPort}/tc-acct/${pin}/v1/messages`), 404,
        `a pin of "${pin}" left the client waiting on a request nobody will answer`);
    }
    // A well-formed but unresolvable pin is the same answer, which is the point:
    // an undecodable pin is an unusable pin, not an internal error.
    assert.equal(await postWithin(`http://127.0.0.1:${proxyPort}/tc-acct/%67%68/v1/messages`), 404);
    assert.equal(seen.length, 0, 'an unresolvable pin reached upstream');
  });
});

// ── a pin across an account removal ─────────────────────────────────────────

// Removing an account renumbers the rest of the fleet in place (removeAccount),
// and a pinned request can be waiting when it happens: for its body, for a
// refresh, for upstream. The pin was held as an index, so the request was sent
// to whichever account had slid into its account's place. `onStart` runs at
// onRequestStart, after the pin is resolved and before the body is read;
// `onRefresh` inside the forced refresh a 401 starts. Upstream answers 401 to
// the tokens in `revoked` and 200 to any other. `send` sends a request pinned
// to beta in the pin's `form`: the path prefix, TC_ACCT (the listener a pinned
// MITM tunnel feeds, which carries the pin as forcedPin) or an operator session
// pin.
async function withRemoval({ onStart = null, onRefresh = null, revoked = [], form = 'path' }, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (revoked.includes(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has been revoked' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([oauth('alpha'), oauth('beta'), oauth('gamma')], 0.98, {
    refreshFn: async () => {
      onRefresh?.(am);
      return { accessToken: 't-renewed', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
    },
  });
  if (form === 'session') am.sessionPins.set('sess-pin', 'beta');
  const config = { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` };
  const hooks = { onRequestStart: () => onStart?.(am) };
  const proxy = form === 'TC_ACCT'
    ? http.createServer(createProxyRequestListener({ accountManager: am, upstream: config.upstream, config, hooks, forcedPin: 'beta' }))
    : createProxyServer(am, config, hooks);
  const proxyPort = await listen(proxy);
  const send = () => fetch(`http://127.0.0.1:${proxyPort}${form === 'path' ? '/tc-acct/beta' : ''}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(form === 'session' ? { 'x-claude-code-session-id': 'sess-pin' } : {}) },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  try {
    return await run({ send, seen });
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

const removeNamed = (am, name) => am.removeAccount(am.accounts.findIndex(a => a.name === name));

test('a pinned request keeps its account when another is removed before it is forwarded', async () => {
  await withRemoval({ onStart: am => removeNamed(am, 'alpha') }, async ({ send, seen }) => {
    const res = await send();
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['t-beta'], 'the pin went to the account that took its place');
  });
});

test('a pinned request keeps its account when another is removed while it is in flight', async () => {
  await withRemoval({ revoked: ['t-beta'], onRefresh: am => removeNamed(am, 'alpha') }, async ({ send, seen }) => {
    const res = await send();
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['t-beta', 't-renewed'], 'the retry after the refresh went to another account');
  });
});

// The pinned account itself leaves. Nothing else may serve the pin and waiting
// will not bring the account back, so the request is answered as a pin that
// names no account is: the unknown-pin 404, in each of the pin's forms.
for (const [form, message] of [
  ['path', 'Unknown account pin "beta"'],
  ['TC_ACCT', 'Unknown account pin "beta" (from TC_ACCT)'],
  ['session', 'Unknown account pin "beta" (session pin; clear it with: teamclaude switch --session --clear)'],
]) {
  test(`a pinned request whose account is removed while it is in flight is answered 404 (${form})`, async () => {
    await withRemoval({ form, revoked: ['t-beta'], onRefresh: am => removeNamed(am, 'beta') }, async ({ send, seen }) => {
      const res = await send();
      const body = await res.json();
      assert.equal(res.status, 404);
      assert.deepEqual(body.error, { type: 'not_found_error', message });
      assert.deepEqual(seen, ['t-beta'], 'the request went to another account once its own had left');
    });
  });
}
