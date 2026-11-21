import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// One bounded failover hop when the current account cannot serve but a sibling
// can (#137, #165, #156).
//
// #84's argument — moving a shared burst to the next account just throttles it
// too and discards the KV cache — holds under load and not when a sibling is
// idle, which is what every reporter hit. So: at most one hop, never onto an
// account already tried or inside its own 429 pause.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;

const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

async function post(port, path = '/v1/messages') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

async function withFleet(handler, fn, extraConfig = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res, seen); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, ...extraConfig });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

// A rate-limit 429 (no `rejected` status) used to wait 60s and retry the SAME
// account, never touching the idle sibling.
test('a rate-limit 429 fails over once to an idle sibling', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200, 'the idle sibling should have served it');
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// Never onto an account already tried. a refuses the credential (a 403 fails
// the request over and leaves a in rotation), then b answers a rate-limit 429:
// the only idle sibling is a, which this request has tried, so there is no hop
// and b's 429 goes to the client.
test('a rate-limit hop never lands on an account the request already tried', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
      return;
    }
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.deepEqual(seen, ['t-a', 't-b'], 'the hop went back to the account that refused');
    assert.equal(status, 429);
  });
});

// The account a hop went around is tried for the rest of the request too: the
// hop's destination b refuses its credential, and the request fails over to c,
// not back to a, the fleet's current account, which would answer as before.
for (const [what, status, headers] of [
  ['a rate-limit 429', 429, { 'retry-after': '1' }],
  ['a 529', 529, {}],
]) {
  test(`after a hop on ${what} the account it went around is not tried again`, async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      req.resume();
      const token = tokenOf(req);
      seen.push(token);
      if (token === 't-a') {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'overloaded_error' } }));
        return;
      }
      if (token === 't-b') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const am = new AccountManager([...accounts(),
      { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'r', expiresAt: Date.now() + HOUR },
    ], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
    const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const proxyPort = await listen(proxy);
    try {
      const { status: got } = await post(proxyPort);
      assert.equal(got, 200);
      assert.deepEqual(seen, ['t-a', 't-b', 't-c']);
    } finally { proxy.close(); upstream.close(); }
  });
}

// The same for the 5xx hop. a answers a rate-limit 429 (it is paused, and in
// what the request tried, but still available), the request hops to b, and b
// answers 529: the 5xx hop's best sibling would be a, which this request has
// tried, so it goes to c, which ranks below both.
test('a 5xx hop never lands on an account the request already tried', async () => {
  const seen = [];
  let aRefused = false;
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = tokenOf(req);
    seen.push(token);
    if (token === 't-a' && !aRefused) {
      aRefused = true;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', 'anthropic-ratelimit-requests-remaining': '0' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
      return;
    }
    if (token === 't-b') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([...accounts(),
    { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'r', expiresAt: Date.now() + HOUR, priority: 1 },
  ], 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b', 't-c']);
  } finally { proxy.close(); upstream.close(); }
});

// #165: a headerless 429 — no anthropic-ratelimit-* at all — is the same shape.
test('a headerless 429 fails over rather than retrying the same account', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'true' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// The maintainer's point: if the second account is throttled too, the limit is
// scoped to the egress IP, not to either account. Hopping further would prove
// nothing and pay a cold cache each time, so the budget is one hop — the request
// must not walk the fleet.
test('a fleet-wide 429 stops after one hop instead of walking every account', async () => {
  await withFleet((req, res) => {
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 429, 'a 429 the fleet cannot escape belongs to the client');
    assert.equal(seen.length, 2, `expected one hop, upstream saw ${seen.length} attempts`);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

// #156: a 529 is the provider saying it is overloaded, not a statement about
// this account. Surfacing it turned a provider transient into a client failure.
test('an upstream 529 fails over instead of reaching the client', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});

test('a provider-wide 529 stops after one hop and reaches the client', async () => {
  await withFleet((req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 529);
    assert.equal(seen.length, 2, `expected one hop, upstream saw ${seen.length}`);
  });
});

// A quota rejection is durable exhaustion and already rotates; the hop must not
// change that path or double-count against it.
test('a quota-rejection 429 still rotates as before', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ am, proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled', 'a quota rejection still throttles the account');
  });
});

test('isPaused reports the rate-limit pause selection does not model', () => {
  const am = new AccountManager(accounts(), 0.98);
  assert.equal(am.isPaused(0), false);
  am.pauseAccount(0, 30);
  assert.equal(am.isPaused(0), true);
  assert.equal(am.isPaused(1), false);
});

// A hop picked again because its account left (server.js, at the attempt it
// names) is picked under the same exclusions as the first pick: never onto the
// account a rollover moved this request off. a's window rolls, the request is
// moved to b, b answers 529, the hop picks c, and c is removed at the hop's own
// log line. The one account left is a, which the rollover ruled out, so there
// is nowhere to go and the request is not sent there.
test('a 5xx hop picked again after its account left keeps off the rolled-off account', async t => {
  const H = 3600_000;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    const token = tokenOf(req);
    seen.push(token);
    if (token === 't-b') {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(['a', 'b', 'c'].map(n => (
    { name: n, type: 'oauth', accessToken: `t-${n}`, refreshToken: 'r', expiresAt: Date.now() + H }
  )), 0.98, { expiryRouting: { enabled: true, preempt: true } });
  am.accounts.forEach((acct, i) => {
    acct.quota.unified5h = 0.1;
    acct.quota.unified7d = 0.4;
    acct.quota.unified7dReset = Date.now() + (10 + i * 10) * H;
    acct.probing = false;
  });
  am.selectActiveAccount();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    assert.equal((await post(proxyPort)).status, 200);
    assert.deepEqual(seen, ['t-a'], 'the fixture must start on a');
    am.accounts[0].quota.unified7dReset = Date.now() + 500 * H;   // a's window rolls
    t.mock.method(console, 'log', (...args) => {
      if (/failing over once to "c"/.test(String(args[0]))) am.removeAccount(am.accounts.findIndex(a => a.name === 'c'));
    });
    const { status } = await post(proxyPort);
    assert.deepEqual(seen.slice(1), ['t-b'], 'the hop was sent to the account the rollover moved this request off');
    assert.notEqual(status, 200);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The failover hop must not undo a routing decision made one step earlier.
//
// Expiry routing preempts traffic off an account whose weekly window just
// rolled — correctly, since a rolled window is now the furthest-dated and
// should be spent last. That account was never sent a request, so it is absent
// from ctx.tried, and the hop would otherwise hand the request straight back to
// it when the destination answers 429 — reversing the rollover inside the same
// request, and invisibly.
test('a rate-limit hop does not land back on the account a rollover moved off', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const token = tokenOf(req);
    seen.push(token);
    if (token === 't-b') {
      res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const H = 3600_000;
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + H },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + H },
    { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'r', expiresAt: Date.now() + H },
  ], 0.98, { expiryRouting: { enabled: true, tolerance: 1.5, preempt: true } });

  // Everyone has headroom; a's window is the soonest, so traffic starts there.
  am.accounts.forEach((acct, i) => {
    acct.quota.unified7d = 0.4;
    acct.quota.unified7dReset = Date.now() + (i === 0 ? 10 : 20 + i * 10) * H;
  });
  am.currentIndex = 0;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    // One request first, so a's pre-roll reset is observed — a rollover is a
    // CHANGE, and with no earlier reading there is nothing for it to differ from.
    assert.equal((await post(proxyPort)).status, 200);
    assert.deepEqual(seen, ['t-a'], 'the fixture must start on a');

    // a's window rolls: it is now the furthest-dated and should be held, not spent.
    am.accounts[0].quota.unified7dReset = Date.now() + 500 * H;

    const before = seen.length;
    const { status } = await post(proxyPort);
    assert.equal(status, 200);
    const chain = seen.slice(before);
    assert.ok(chain.includes('t-b'), `the roll should have moved traffic off a: ${chain.join(', ')}`);
    assert.ok(!chain.includes('t-a'),
      `the hop returned to the rolled-off account: ${chain.join(', ')}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The same exclusion across a removal. The accounts a rollover moved the request
// off were kept by index, and removing an account renumbers the rest in place
// (removeAccount): with x removed while b holds the request, the record of a
// named b, and the hop went back to a. x never serves; it sits first so that
// its removal moves both.
test('a rate-limit hop does not land back on the rolled-off account when another is removed meanwhile', async () => {
  const H = 3600_000;
  const seen = [];
  let am;
  const upstream = http.createServer((req, res) => {
    const token = tokenOf(req);
    seen.push(token);
    if (token === 't-b') {
      am.removeAccount(0);   // x goes: a becomes 0, b becomes 1
      res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  am = new AccountManager([
    { name: 'x', type: 'oauth', accessToken: 't-x', refreshToken: 'r', expiresAt: Date.now() + H, disabled: true },
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + H },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + H },
  ], 0.98, { expiryRouting: { enabled: true, preempt: true } });
  am.accounts.forEach((acct, i) => {
    acct.quota.unified5h = 0.1;
    acct.quota.unified7d = 0.4;
    acct.quota.unified7dReset = Date.now() + (10 + i * 10) * H;
    acct.probing = false;
  });
  am.selectActiveAccount();

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    assert.equal((await post(proxyPort)).status, 200);
    assert.deepEqual(seen, ['t-a'], 'the fixture must start on a');
    am.accounts[1].quota.unified7dReset = Date.now() + 500 * H;   // a's window rolls

    const before = seen.length;
    const { status } = await post(proxyPort);
    const chain = seen.slice(before);
    assert.deepEqual(chain, ['t-b'], `the hop returned to the rolled-off account: ${chain.join(', ')}`);
    assert.equal(status, 429, 'with nowhere else to hop, b\'s 429 goes to the client');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A pinned request (TC_ACCT, /tc-acct/, a session pin) names the one account the
// client asked for, and docs/routing.md promises it never fails over: a rate
// limit, a 5xx or a stream failure is handled as for any pin to one account. The
// hops above used to ignore the pin and serve it from the idle sibling.
const failA = (status, headers = {}) => (req, res) => {
  if (tokenOf(req) === 't-a') {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : 'api_error' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};

for (const [what, status, headers] of [
  ['an upstream 529', 529, {}],
  ['an upstream 500', 500, {}],
  // Longer than the inline absorb, so the 429 goes back to the client at once.
  ['a rate-limit 429 too long to absorb', 429, { 'retry-after': '3600' }],
]) {
  test(`a pinned request is never moved to a sibling on ${what}`, async () => {
    await withFleet(failA(status, headers), async ({ proxyPort, seen }) => {
      const { status: got } = await post(proxyPort, '/tc-acct/a/v1/messages');
      assert.ok(seen.length > 0 && seen.every(t => t === 't-a'), `only the pinned account is tried, saw ${JSON.stringify(seen)}`);
      assert.equal(got, status, 'the pinned account\'s answer reaches the client');
    });
  });
}

test('the same 529 on an unpinned request still fails over to the sibling', async () => {
  await withFleet(failA(529), async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort, '/v1/messages');
    assert.equal(status, 200);
    assert.deepEqual(seen, ['t-a', 't-b']);
  });
});
