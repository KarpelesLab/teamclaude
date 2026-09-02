import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const HOUR = 3600_000;

// Upstream answers 403 "Request not allowed" to every token outside `live` —
// how Anthropic rejects a credential it will not serve at all (as opposed to a
// 401, which says the token merely needs refreshing). Records each bearer so a
// test can prove which account was tried.
function forbiddingUpstream(live) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (!live.has(token)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

async function post(port, path = '/v1/messages') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

function entitlementError(code = 'oauth_not_allowed_for_organization') {
  return {
    type: 'error',
    error: {
      type: 'permission_error',
      message: 'OAuth authentication is currently not allowed for this organization.',
      details: { error_code: code },
    },
    request_id: 'req_test',
  };
}

function entitlementUpstream({ deniedToken = 'a-token', delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (token === deniedToken) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(entitlementError()));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

function twoAccounts() {
  return [
    { name: 'a account', type: 'oauth', accessToken: 'a-token', refreshToken: 'ra', expiresAt: Date.now() + HOUR },
    { name: 'b account', type: 'oauth', accessToken: 'b-token', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
  ];
}

// The client never sees the credential the proxy injects, so a 403 about that
// credential is not something the client can act on — but Claude Code reads a
// 403 as "your session is dead", drops its own login and asks for a re-login.
// Report it as a proxy error instead: the account needs attention, the client's
// own credential is untouched.
test('a 403 on the injected credential reaches the client as a proxy error, not a 403', async () => {
  const { server: upstream, seen } = forbiddingUpstream(new Set());   // nothing is accepted
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 502);
    assert.match(body, /proxy_error/);
    assert.match(body, /account \\"a\\"/);             // names the account that was rejected
    assert.match(body, /teamclaude login/);            // a generic credential refusal still recommends re-auth
    assert.equal(seen.length, 1);                      // no other account to try
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A 403 is about one account's credential, so the request itself is still
// serveable — fail over the way the 401 path does rather than giving up.
test('a 403 fails over to another account', async () => {
  const { server: upstream, seen } = forbiddingUpstream(new Set(['b-token']));
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'a-token', refreshToken: 'ra', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accessToken: 'b-token', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
    ],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Two dead credentials and nothing else: there is genuinely nothing to wait for,
// so fail fast and name both rather than inventing a retry-after.
test('with every account refused the error names all of them', async () => {
  const { server: upstream } = forbiddingUpstream(new Set());
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'ra', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
    ],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 502);
    assert.match(body, /\\"a\\"/);                     // quotes are JSON-escaped in the body
    assert.match(body, /\\"b\\"/);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The mixed fleet: one credential is refused, the other account is merely out of
// quota. A reset will still serve this request, so the refusal must not short —
// circuit the exhaustion path — otherwise one bad credential turns every
// recoverable exhaustion into a hard 502 and skips the holdSeconds wait that an
// unattended run depends on.
test('a refusal alongside a merely-exhausted account still reports exhaustion', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer ta') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
      return;
    }
    // Durable quota rejection, far enough out that no inline retry absorbs it.
    res.writeHead(429, {
      'retry-after': '300',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [
      { name: 'a', type: 'oauth', accessToken: 'ta', refreshToken: 'ra', expiresAt: Date.now() + HOUR },
      { name: 'b', type: 'oauth', accessToken: 'tb', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
    ],
    0.98,
    { refreshFn: async () => { throw new Error('must not refresh on a 403'); } },
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 429, 'quota exhaustion, not a hard credential error');
    assert.match(body, /rate_limit_error/);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an OAuth entitlement denial quarantines the account across requests', async () => {
  const { server: upstream, seen } = entitlementUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const first = await post(proxyPort);
    assert.equal(first.status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token']);
    assert.ok(am.accounts[0].entitlementDeniedUntil > Date.now());

    am.currentIndex = 0;
    const second = await post(proxyPort);
    assert.equal(second.status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a generic 403 stays request-local even if its message mentions the entitlement code', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (token === 'a-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(entitlementError('different_permission_error')));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 200);
    assert.equal(am.accounts[0].entitlementDeniedUntil, null);
    am.currentIndex = 0;
    assert.equal((await post(proxyPort)).status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token', 'a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an account is selected again after its entitlement cooldown expires', async () => {
  const { server: upstream, seen } = entitlementUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 200);
    am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
    am.currentIndex = 0;
    assert.equal((await post(proxyPort)).status, 200);
    assert.deepEqual(seen, ['a-token', 'b-token', 'a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('requests queued on an account rotate if another request quarantines it', async () => {
  const { server: upstream, seen } = entitlementUpstream({ delayMs: 30 });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98, {
    ramp: { enabled: true, startConc: 1, stepConc: 1, stepMs: 1000, windowMs: 30_000, pollMs: 5 },
  });
  am.accounts[0].rampStartedAt = Date.now();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const [first, second] = await Promise.all([post(proxyPort), post(proxyPort)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(seen.filter(token => token === 'a-token').length, 1);
    assert.equal(seen.filter(token => token === 'b-token').length, 2);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a fully cooling fleet reports the entitlement re-admission time', async () => {
  const { server: upstream, seen } = entitlementUpstream({ deniedToken: 'only-token' });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 'only-token', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 502);
    const result = await post(proxyPort);
    assert.equal(result.status, 429);
    const retryAfter = Number(result.headers.get('retry-after'));
    assert.ok(retryAfter > 60);
    assert.ok(retryAfter <= 300);
    assert.deepEqual(seen, ['only-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an all-entitlement-denied 502 diagnoses policy instead of recommending login', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push((req.headers.authorization || '').replace(/^Bearer /, ''));
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(entitlementError()));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const result = await post(proxyPort);
    assert.equal(result.status, 502);
    const message = JSON.parse(result.body).error.message;
    assert.match(message, /No account served this request/);
    assert.match(message, /Every configured account returned OAuth entitlement denial/);
    assert.match(message, /oauth_not_allowed_for_organization/);
    assert.match(message, /"a account"/);
    assert.match(message, /"b account"/);
    assert.doesNotMatch(message, /teamclaude login/);
    assert.deepEqual(seen, ['a-token', 'b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a non-JSON 403 does not quarantine the account', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('oauth_not_allowed_for_organization');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 502);
    assert.equal(am.accounts[0].entitlementDeniedUntil, null);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an oversized 403 body is not buffered or used to quarantine', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...entitlementError(), padding: 'x'.repeat(70 * 1024) }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'only', type: 'oauth', accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 502);
    assert.equal(am.accounts[0].entitlementDeniedUntil, null);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a caller-pinned request goes to exactly the account it targeted', async () => {
  const { server: upstream, seen } = entitlementUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(twoAccounts(), 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const result = await post(proxyPort, '/tc-acct/b%20account/v1/messages');
    assert.equal(result.status, 200);
    assert.deepEqual(seen, ['b-token']);
  } finally {
    proxy.close();
    upstream.close();
  }
});
