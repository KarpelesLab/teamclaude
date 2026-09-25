import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An account's own routing proxy going down is the failure this feature adds,
// and the one the forward path's older reasoning gets backwards: a refused
// connection used to mean "the same for every account, so close and let the
// client retry". From ONE account's proxy it means "this account only", and
// the retry would land on the same dead path. These pin the behaviour that
// follows from that: fail over at once, then hold the account out briefly.

const TMP = mkdtempSync(join(tmpdir(), 'tc-routing-failover-'));
process.env.TEAMCLAUDE_CONFIG = join(TMP, 'config.json');
// Before the imports: the budget routingAgent gives a tunnel is read once, at
// module load. Its 20s default is what a black-holed proxy costs a request in
// production; the test that needs one cannot wait that long. Nothing else in
// this file comes near it (a refused port fails at once, the mock relays at
// once).
process.env.TEAMCLAUDE_ROUTING_TIMEOUT_MS = '800';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer, isTransientUpstreamError } = await import('../src/server.js');
const { routingAgent, parseRoutingUrl, isRoutingFailure, ROUTING_FAILED } = await import('../src/account-routing.js');
const { renderStatus, UNAVAILABLE_TEXT } = await import('../src/status-renderer.js');
const { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } = await import('../src/upstream-proxy.js');

const T = { timeout: 30000 };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function closedPort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function startUpstream() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push({ url: req.url, key: req.headers['x-api-key'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  });
  return { srv, hits };
}

// No-auth SOCKS5 relay, for the "proxy came back" half.
function startSocks5() {
  const connects = [];
  const srv = net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (chunk) => {
      if (stage === 'relay') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 + (buf[1] || 0)) return;
        buf = buf.subarray(2 + buf[1]);
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'request') {
        if (buf.length < 10) return;
        const host = [...buf.subarray(4, 8)].join('.');
        const port = buf.readUInt16BE(8);
        buf = buf.subarray(10);
        connects.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy());
        stage = 'relay';
      }
    });
  });
  return { srv, connects };
}

// Accepts the TCP connection and never writes a byte: a proxy that is up but
// wedged, which is what a black-holed or firewalled proxy looks like from here
// and the one failure a bare connect cannot tell from success.
function startBlackHole() {
  const sockets = new Set();
  const srv = net.createServer((c) => {
    sockets.add(c);
    c.on('error', () => {});
    c.on('close', () => sockets.delete(c));
  });
  return { srv, close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}

// Resolves with the HTTP response, or with the socket error when the proxy
// destroyed the connection (the transient path this must NOT take).
function post(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ type: 'response', status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (err) => resolve({ type: 'error', code: err.code }));
    req.end(JSON.stringify({ model: 'claude-test-model', max_tokens: 1, messages: [] }));
  });
}

async function captureLogs(fn) {
  const lines = [];
  const originals = { log: console.log, error: console.error };
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { Object.assign(console, originals); }
  return lines;
}

test.afterEach(() => resetUpstreamProxy());

test('a failure to connect through the routing proxy is ROUTING_FAILED, names the proxy masked, and keeps the socket cause', T, async () => {
  const dead = await closedPort();
  const agent = routingAgent(parseRoutingUrl(`socks5h://alice:s3cret@127.0.0.1:${dead}`), { targetHost: '127.0.0.1', targetPort: 9, tls: false });
  const err = await new Promise((resolve) => {
    const req = http.request('http://127.0.0.1:9/', { agent }, () => resolve(null));
    req.once('error', resolve);
    req.end();
  });
  assert.ok(err instanceof Error);
  assert.equal(err.code, ROUTING_FAILED);
  assert.equal(isRoutingFailure(err), true);
  assert.ok(err.message.includes(`account routing proxy socks5h://alice:***@127.0.0.1:${dead}`), err.message);
  assert.equal(err.message.includes('s3cret'), false, err.message);
  assert.match(err.message, /ECONNREFUSED/);
  assert.equal(err.cause?.code ?? err.cause?.errors?.[0]?.code, 'ECONNREFUSED', 'the socket-level reason survives on cause');
});

test('a proxy that refuses the credentials is ROUTING_FAILED too', T, async () => {
  // Greets, selects user/pass, then rejects whatever is offered.
  const srv = net.createServer((c) => {
    let stage = 0;
    c.on('error', () => {});
    c.on('data', () => {
      if (stage === 0) { stage = 1; c.write(Buffer.from([0x05, 0x02])); return; }
      if (stage === 1) { stage = 2; c.write(Buffer.from([0x01, 0x01])); c.end(); }
    });
  });
  const port = await listen(srv);
  try {
    const agent = routingAgent(parseRoutingUrl(`socks5://alice:wrong@127.0.0.1:${port}`), { targetHost: '127.0.0.1', targetPort: 9, tls: false });
    const err = await new Promise((resolve) => {
      const req = http.request('http://127.0.0.1:9/', { agent }, () => resolve(null));
      req.once('error', resolve);
      req.end();
    });
    assert.equal(err?.code, ROUTING_FAILED);
    assert.match(err.message, /SOCKS5 authentication failed/);
    assert.equal(err.message.includes('wrong'), false, 'the password stays out of the message');
    // Said once, not "account routing proxy …: account routing proxy …".
    assert.equal(err.message.match(/account routing proxy/g)?.length, 1, err.message);
  } finally {
    srv.close();
  }
});

test('isTransientUpstreamError: a routing failure fails over even though its cause is ECONNREFUSED', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.equal(isTransientUpstreamError(cause), true, 'the control: from the upstream host it is transient');
  const wrapped = Object.assign(new Error('account routing proxy socks5://127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1', { cause }), { code: ROUTING_FAILED });
  assert.equal(isTransientUpstreamError(wrapped), false);
  // A timeout inside the tunnel setup is the same story.
  const timedOut = Object.assign(new Error('account routing proxy … SOCKS5 handshake timed out after 30000ms'), { code: ROUTING_FAILED });
  assert.equal(isTransientUpstreamError(timedOut), false);
});

test('a routed account with a dead proxy fails over to the next account and is held out of rotation', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.srv);
  const dead = await closedPort();

  const am = new AccountManager([
    { name: 'routed', type: 'apikey', apiKey: 'sk-routed', priority: 0, routing: `socks5://alice:s3cret@127.0.0.1:${dead}` },
    { name: 'direct', type: 'apikey', apiKey: 'sk-direct', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {});
  const port = await listen(proxy);
  try {
    let first;
    const lines = await captureLogs(async () => { first = await post(port); });
    assert.equal(first.type, 'response', `the connection was reset instead of failing over: ${JSON.stringify(first)}\n${lines.join('\n')}`);
    assert.equal(first.status, 200, lines.join('\n'));
    assert.deepEqual(upstream.hits.map(h => h.key), ['sk-direct'], 'served by the account whose path works');

    const failed = lines.filter(l => l.includes('Routing proxy failed for account "routed"'));
    assert.equal(failed.length, 1, lines.join('\n'));
    assert.ok(failed[0].includes('socks5://alice:***@127.0.0.1'), failed[0]);
    assert.equal(lines.some(l => l.includes('s3cret')), false, 'the proxy password is in no log line');
    assert.match(failed[0], /out of rotation for \d+s/);

    assert.equal(am.unavailableReason(am.accounts[0]), 'routing');
    const payload = am.getStatus().accounts[0];
    assert.equal(payload.unavailable, 'routing');
    assert.ok(Date.parse(payload.routingFailedUntil) > Date.now());

    // The requests behind it do not each pay the connect failure.
    const again = await captureLogs(async () => { assert.equal((await post(port)).status, 200); });
    assert.equal(again.some(l => l.includes('Routing proxy failed')), false, again.join('\n'));
    assert.deepEqual(upstream.hits.map(h => h.key), ['sk-direct', 'sk-direct']);

    // And the operator can read why, in words.
    const rendered = renderStatus(am.getStatus(), { color: false });
    assert.ok(rendered.includes(UNAVAILABLE_TEXT.routing), rendered);
    assert.match(rendered, /routing proxy down, retry in/);
  } finally {
    proxy.close(); upstream.srv.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});

test('a proxy that accepts the connection and never answers is a routing failure: the forward fails over and the hold is armed', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.srv);
  const hole = startBlackHole();
  const holePort = await listen(hole.srv);

  const am = new AccountManager([
    { name: 'routed', type: 'apikey', apiKey: 'sk-routed', priority: 0, routing: `socks5h://127.0.0.1:${holePort}` },
    { name: 'direct', type: 'apikey', apiKey: 'sk-direct', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {});
  const port = await listen(proxy);
  try {
    let first;
    const started = Date.now();
    const lines = await captureLogs(async () => { first = await post(port); });
    assert.equal(first.type, 'response', `reset instead of failing over: ${JSON.stringify(first)}\n${lines.join('\n')}`);
    assert.equal(first.status, 200, lines.join('\n'));
    assert.deepEqual(upstream.hits.map(h => h.key), ['sk-direct'], 'served by the account whose path works');
    // The tunnel's own budget gave up, not some caller's longer signal (which
    // would have surfaced as a generic timeout and been retried as transient).
    assert.ok(Date.now() - started < 10_000, `the forward waited ${Date.now() - started}ms on the wedged proxy`);

    const failed = lines.filter(l => l.includes('Routing proxy failed for account "routed"'));
    assert.equal(failed.length, 1, lines.join('\n'));
    assert.match(failed[0], /SOCKS5 handshake timed out after 800ms/);
    assert.equal(am.unavailableReason(am.accounts[0]), 'routing');
    assert.ok(am.accounts[0].routingFailedUntil > Date.now(), 'the account sits out the cooldown');
  } finally {
    proxy.close(); upstream.srv.close(); hole.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});

test('the only account\'s dead proxy is answered with the reason and a short retry-after, never a reset', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.srv);
  const dead = await closedPort();
  const am = new AccountManager([
    { name: 'routed', type: 'apikey', apiKey: 'sk-routed', routing: `socks5://127.0.0.1:${dead}` },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {});
  const port = await listen(proxy);
  try {
    let first; let second;
    const lines = await captureLogs(async () => { first = await post(port); second = await post(port); });
    for (const outcome of [first, second]) {
      assert.equal(outcome.type, 'response', `reset instead of answered: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.status, 429);
      const retryAfter = Number(outcome.headers['retry-after']);
      assert.ok(retryAfter >= 1 && retryAfter <= 30, `retry-after reflects the cooldown, not the untimed 60s default: ${retryAfter}`);
      const message = JSON.parse(outcome.body).error.message;
      assert.match(message, /account "routed" cannot reach its routing proxy/, message);
      assert.equal(/quota/i.test(message), false, `a dead proxy is not a quota problem: ${message}`);
    }
    assert.equal(lines.filter(l => l.includes('Routing proxy failed')).length, 1, 'the second request never dialled the dead proxy');
    assert.equal(upstream.hits.length, 0);
  } finally {
    proxy.close(); upstream.srv.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});

test('the cooldown is per account, short, lifted by a working response, and dropped when the routing changes', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.srv);
  const socks = startSocks5();
  const socksPort = await listen(socks.srv);
  const dead = await closedPort();

  const am = new AccountManager([
    { name: 'routed', type: 'apikey', apiKey: 'sk-routed', routing: `socks5://127.0.0.1:${dead}` },
    { name: 'direct', type: 'apikey', apiKey: 'sk-direct' },
  ], 0.98);

  assert.equal(am.markRoutingFailed(1), null, 'an account with no routing has no routing to fail');
  assert.equal(am.unavailableReason(am.accounts[1]), null);

  const until = am.markRoutingFailed(0);
  assert.ok(until > Date.now() && until <= Date.now() + 30_000 + 50, 'the default hold is 30s');
  assert.equal(am.markRoutingFailed(0, 5), until, 'a shorter hold never shortens a longer one');
  assert.equal(am.isRoutingDown(0), true);
  assert.equal(am.isRoutingDown(0, until + 1), false, 'expiry is consumed lazily');
  assert.equal(am.accounts[0].routingFailedUntil, null);

  // A new URL is a new path: the operator who fixed it does not wait out the old hold.
  am.markRoutingFailed(0);
  am.setRouting(0, parseRoutingUrl(`socks5://127.0.0.1:${dead}`));
  assert.equal(am.isRoutingDown(0), true, 'the same URL written again changes nothing');
  am.setRouting(0, parseRoutingUrl(`socks5://127.0.0.1:${socksPort}`));
  assert.equal(am.isRoutingDown(0), false);

  // A response through the proxy lifts a hold armed by some other path (a probe, a refresh).
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {});
  const port = await listen(proxy);
  try {
    am.accounts[0].routingFailedUntil = Date.now() + 30_000;
    const pinned = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/tc-acct/routed/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(null));
      req.end(JSON.stringify({ model: 'claude-test-model', max_tokens: 1, messages: [] }));
    });
    assert.equal(pinned, 200, 'a pin still targets exactly the account it names');
    assert.deepEqual(socks.connects, [`127.0.0.1:${upstreamPort}`]);
    assert.equal(am.accounts[0].routingFailedUntil, null);
  } finally {
    proxy.close(); upstream.srv.close(); socks.srv.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});

test('a token refresh that cannot reach the routing proxy arms the cooldown without erroring the account', T, async () => {
  const failure = Object.assign(new Error('account routing proxy socks5://127.0.0.1:1: connect ECONNREFUSED 127.0.0.1:1'), { code: ROUTING_FAILED });
  const am = new AccountManager([
    { name: 'oauth-routed', type: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() - 1000, routing: 'socks5://127.0.0.1:1' },
  ], 0.98, { refreshFn: async () => { throw failure; } });
  await captureLogs(() => am.ensureTokenFresh(0));
  assert.equal(am.accounts[0].status, 'active', 'a dead proxy is not a dead credential');
  assert.equal(am.unavailableReason(am.accounts[0]), 'routing');
});
