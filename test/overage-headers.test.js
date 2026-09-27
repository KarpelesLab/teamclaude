import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { createProxyServer, createProxyRequestListener, relayUpgrade, isOverageHeader } from '../src/server.js';
import { createConnectHandler } from '../src/mitm.js';
import { generateCertChain } from '../src/x509.js';

// Claude Code caches the `anthropic-ratelimit-unified-overage-*` family (and
// `upgrade-paths`) as its own org's billing state. In a pool whose accounts
// belong to several organizations, each response carries the headers of
// whichever org served it. `stripOverageHeaders: true` drops that family on
// every path that parses upstream response headers while the plan-quota
// headers still pass through and quota accounting sees the originals; the
// default (off) forwards everything.

const HOUR = 3600_000;
// Reset epochs in the future: a past reset makes _clearExpiredQuotas drop the
// utilization the test reads back.
const NOW_S = Math.floor(Date.now() / 1000);
const RESET_5H = String(NOW_S + 3600);
const RESET_7D = String(NOW_S + 3 * 86400);

// Every overage-family name observed on real responses, plus one non-overage
// unified header of each kind the client legitimately consumes.
const OVERAGE = {
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-reset': RESET_7D,
  'anthropic-ratelimit-unified-overage-in-use': 'false',
  'anthropic-ratelimit-unified-overage-period-monthly-utilization': '0',
  'anthropic-ratelimit-unified-overage-period-channel-utilization': '0',
  'anthropic-ratelimit-unified-upgrade-paths': 'extra_usage',
};
const PLAN = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': RESET_5H,
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.9',
  'anthropic-ratelimit-unified-7d-reset': RESET_7D,
  'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.55',
  'anthropic-ratelimit-unified-7d_oi-reset': RESET_7D,
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function upstreamWithHeaders(extra = {}) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', ...OVERAGE, ...PLAN, ...extra });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

function assertOverageStripped(headers) {
  for (const name of Object.keys(OVERAGE)) {
    assert.equal(headers.get(name), null, `${name} must not reach the client`);
  }
}

function assertPlanPassedThrough(headers) {
  for (const [name, value] of Object.entries(PLAN)) {
    assert.equal(headers.get(name), value, `${name} must pass through unchanged`);
  }
}

// Read a response head off `sock` until the blank line that ends it, however
// the bytes are split into chunks. A close before that point, or no head within
// `timeoutMs`, fails with what did arrive instead of hanging the test.
function readHead(sock, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (fn, v) => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('close', onClose);
      fn(v);
    };
    const onData = (c) => {
      text += c.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end !== -1) done(resolve, text.slice(0, end + 4));
    };
    const onClose = () => done(reject, new Error(`socket closed before the end of the response head; received ${JSON.stringify(text)}`));
    const timer = setTimeout(() => done(reject, new Error(`no complete response head within ${timeoutMs} ms; received ${JSON.stringify(text)}`)), timeoutMs);
    sock.on('data', onData);
    sock.on('close', onClose);
  });
}

// Record the header object each updateQuota call receives, without changing
// what it does with it.
function spyUpdateQuota(am) {
  const seen = [];
  const orig = am.updateQuota.bind(am);
  am.updateQuota = (index, headers) => { seen.push(headers); return orig(index, headers); };
  return seen;
}

test('isOverageHeader matches the overage family and upgrade-paths, nothing else', () => {
  for (const name of Object.keys(OVERAGE)) assert.equal(isOverageHeader(name), true, name);
  assert.equal(isOverageHeader('Anthropic-RateLimit-Unified-Overage-Status'), true, 'case-insensitive');
  for (const name of Object.keys(PLAN)) assert.equal(isOverageHeader(name), false, name);
  assert.equal(isOverageHeader('retry-after'), false);
  assert.equal(isOverageHeader('anthropic-ratelimit-unified-overage'), false, 'needs the trailing dash');
});

test('forwarded /v1/messages: overage headers are stripped, plan-quota headers pass, updateQuota saw the originals', async () => {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
  );
  const seen = spyUpdateQuota(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, stripOverageHeaders: true,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assertOverageStripped(res.headers);
    assertPlanPassedThrough(res.headers);

    // Quota accounting ran on the unstripped copy.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['anthropic-ratelimit-unified-overage-disabled-reason'], 'org_level_disabled');
    assert.equal(seen[0]['anthropic-ratelimit-unified-upgrade-paths'], 'extra_usage');
    assert.equal(am.accounts[0].quota.unified5h, 0.42);
    assert.equal(am.accounts[0].quota.unified7d, 0.9);
    assert.equal(am.accounts[0].quota.unified7dFable, 0.55);
  } finally {
    proxy.close();
    upstream.close();
  }
});

for (const [label, extra] of [['unset (the default)', {}], ['false', { stripOverageHeaders: false }]]) {
  test(`stripOverageHeaders ${label}: /v1/messages forwards the overage headers unchanged`, async () => {
    const upstream = upstreamWithHeaders();
    const upstreamPort = await listen(upstream);
    const am = new AccountManager(
      [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
      0.98,
    );
    const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, ...extra });
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      assert.equal(res.status, 200);
      await res.text();
      for (const [name, value] of Object.entries(OVERAGE)) assert.equal(res.headers.get(name), value, name);
      assertPlanPassedThrough(res.headers);
    } finally {
      proxy.close();
      upstream.close();
    }
  });
}

// The client-credential relay (Remote Control, attachments) and the raw token
// relay bypass forwardRequest, so each needs its own proof.
async function throughListener(listener, path, init) {
  const proxy = http.createServer(listener);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    await res.text();
    return res;
  } finally {
    proxy.close();
  }
}

test('relayStream (/v1/code/*): overage headers are stripped, plan-quota headers pass', async () => {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  try {
    const accountManager = { getActiveAccount() { throw new Error('must not rotate Remote Control'); } };
    const listener = createProxyRequestListener({
      accountManager, upstream: `http://127.0.0.1:${upstreamPort}`, config: { stripOverageHeaders: true },
    });
    const res = await throughListener(listener, '/v1/code/sessions/abc/worker/events/stream', {
      headers: { authorization: 'Bearer client-own-token' },
    });
    assert.equal(res.status, 200);
    assertOverageStripped(res.headers);
    assertPlanPassedThrough(res.headers);
  } finally {
    upstream.close();
  }
});

test('relayStream (/v1/code/*) with stripOverageHeaders unset forwards everything unchanged', async () => {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  try {
    const accountManager = { getActiveAccount() { throw new Error('must not rotate Remote Control'); } };
    const listener = createProxyRequestListener({
      accountManager, upstream: `http://127.0.0.1:${upstreamPort}`, config: {},
    });
    const res = await throughListener(listener, '/v1/code/sessions/abc/worker/events/stream', {
      headers: { authorization: 'Bearer client-own-token' },
    });
    assert.equal(res.status, 200);
    for (const [name, value] of Object.entries(OVERAGE)) assert.equal(res.headers.get(name), value, name);
    assertPlanPassedThrough(res.headers);
  } finally {
    upstream.close();
  }
});

test('relayRaw (POST /v1/oauth/token): overage headers are stripped, plan-quota headers pass', async () => {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  try {
    const accountManager = { getActiveAccount() { throw new Error('must not touch accounts on a client token refresh'); } };
    const listener = createProxyRequestListener({
      accountManager, upstream: `http://127.0.0.1:${upstreamPort}`, config: { stripOverageHeaders: true },
    });
    const res = await throughListener(listener, '/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"grant_type":"refresh_token"}',
    });
    assert.equal(res.status, 200);
    assertOverageStripped(res.headers);
    assertPlanPassedThrough(res.headers);
  } finally {
    upstream.close();
  }
});

test('relayRaw (POST /v1/oauth/token) with stripOverageHeaders unset forwards everything unchanged', async () => {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  try {
    const accountManager = { getActiveAccount() { throw new Error('must not touch accounts on a client token refresh'); } };
    const listener = createProxyRequestListener({
      accountManager, upstream: `http://127.0.0.1:${upstreamPort}`, config: {},
    });
    const res = await throughListener(listener, '/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"grant_type":"refresh_token"}',
    });
    assert.equal(res.status, 200);
    for (const [name, value] of Object.entries(OVERAGE)) assert.equal(res.headers.get(name), value, name);
    assertPlanPassedThrough(res.headers);
  } finally {
    upstream.close();
  }
});

test('relayUpgrade: overage headers are dropped from the 101 handshake, others kept', async () => {
  const upstream = http.createServer(() => {});
  const upstreamPort = await listen(upstream);
  upstream.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled\r\n' +
      'anthropic-ratelimit-unified-upgrade-paths: extra_usage\r\n' +
      'anthropic-ratelimit-unified-5h-status: allowed\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(chunk));
  });

  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, `http://127.0.0.1:${upstreamPort}`, null, { stripOverage: true }));
  const port = await listen(proxy);

  const client = net.connect(port, '127.0.0.1');
  try {
    await once(client, 'connect');
    client.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nauthorization: Bearer client-own-token\r\n\r\n',
    );
    const text = await readHead(client);
    assert.match(text, /101 Switching Protocols/);
    assert.doesNotMatch(text, /overage/i);
    assert.doesNotMatch(text, /upgrade-paths/i);
    assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
  } finally {
    client.destroy();
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});

// The direct relayUpgrade test above passes stripOverage itself. These drive
// the handshake through createProxyServer's own 'upgrade' listener, so they
// prove the config flag is wired into it, both on an accepted 101 and on a
// handshake upstream refuses with a plain response.
function upgradeUpstream(statusLine) {
  const upstream = http.createServer(() => {});
  upstream.on('upgrade', (req, socket) => {
    const refused = !statusLine.startsWith('101');
    socket.write(
      `HTTP/1.1 ${statusLine}\r\n` +
      (refused ? 'Content-Length: 0\r\nConnection: close\r\n' : 'Upgrade: websocket\r\nConnection: Upgrade\r\n') +
      'anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled\r\n' +
      'anthropic-ratelimit-unified-upgrade-paths: extra_usage\r\n' +
      'anthropic-ratelimit-unified-5h-status: allowed\r\n\r\n',
    );
    if (refused) socket.end();
    else socket.on('data', (chunk) => socket.write(chunk));
  });
  return upstream;
}

async function handshakeThroughProxyServer(statusLine, extraConfig = {}) {
  const upstream = upgradeUpstream(statusLine);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, ...extraConfig,
  });
  const port = await listen(proxy);
  const client = net.connect(port, '127.0.0.1');
  try {
    await once(client, 'connect');
    client.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nx-api-key: k\r\n' +
      'authorization: Bearer client-own-token\r\n\r\n',
    );
    // Read until the end of the response head (a 101 keeps the socket open; a
    // refused handshake is followed by a close).
    return await readHead(client);
  } finally {
    client.destroy();
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections();
  }
}

test('createProxyServer upgrade listener: 101 handshake strips overage headers when enabled', async () => {
  const text = await handshakeThroughProxyServer('101 Switching Protocols', { stripOverageHeaders: true });
  assert.match(text, /101 Switching Protocols/);
  assert.doesNotMatch(text, /overage/i);
  assert.doesNotMatch(text, /upgrade-paths/i);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('createProxyServer upgrade listener: stripOverageHeaders unset keeps overage headers on the 101', async () => {
  const text = await handshakeThroughProxyServer('101 Switching Protocols');
  assert.match(text, /101 Switching Protocols/);
  assert.match(text, /anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled/);
  assert.match(text, /anthropic-ratelimit-unified-upgrade-paths: extra_usage/);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('createProxyServer upgrade listener: a refused handshake (403) strips overage headers, keeps the status header', async () => {
  const text = await handshakeThroughProxyServer('403 Forbidden', { stripOverageHeaders: true });
  assert.match(text, /^HTTP\/1\.1 403 Forbidden/);
  assert.doesNotMatch(text, /overage/i);
  assert.doesNotMatch(text, /upgrade-paths/i);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('createProxyServer upgrade listener: a refused handshake with stripOverageHeaders false keeps overage headers', async () => {
  const text = await handshakeThroughProxyServer('403 Forbidden', { stripOverageHeaders: false });
  assert.match(text, /^HTTP\/1\.1 403 Forbidden/);
  assert.match(text, /anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled/);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

// Send raw bytes to `port` and collect everything until the peer closes.
async function rawExchange(port, data) {
  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write(data);
  const chunks = [];
  client.on('data', (c) => chunks.push(c));
  await once(client, 'close');
  return Buffer.concat(chunks).toString('latin1');
}

async function absoluteFormThroughProxyServer(extraConfig = {}) {
  const upstream = upstreamWithHeaders();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1', ...extraConfig });
  allowLoopbackForward(proxy); // the fake upstream stands in for a remote host but lives on 127.0.0.1
  const port = await listen(proxy);
  try {
    const text = await rawExchange(port,
      `GET http://127.0.0.1:${upstreamPort}/v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`);
    return text.split('\r\n\r\n')[0];
  } finally {
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections();
  }
}

test('relayHttpForward (absolute-form request): overage headers are stripped, plan-quota headers pass', async () => {
  const head = await absoluteFormThroughProxyServer({ stripOverageHeaders: true });
  assert.match(head, /^HTTP\/1\.1 200/);
  assert.doesNotMatch(head, /overage/i);
  assert.doesNotMatch(head, /upgrade-paths/i);
  assert.match(head, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('relayHttpForward (absolute-form request) with stripOverageHeaders: false forwards the overage headers', async () => {
  const head = await absoluteFormThroughProxyServer({ stripOverageHeaders: false });
  assert.match(head, /^HTTP\/1\.1 200/);
  assert.match(head, /anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled/);
  assert.match(head, /anthropic-ratelimit-unified-upgrade-paths: extra_usage/);
  assert.match(head, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('createProxyServer upgrade listener: a refused handshake whose headers all drop is still well-formed', async () => {
  // Every header upstream sends is filtered (connection-specific, content-length,
  // overage), so the relayed head carries only the status line and Connection.
  const upstream = net.createServer((s) => {
    s.once('data', () => s.end(
      'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n' +
      'anthropic-ratelimit-unified-overage-status: rejected\r\n\r\n',
    ));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, stripOverageHeaders: true,
  });
  const port = await listen(proxy);
  try {
    const text = await rawExchange(port,
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nx-api-key: k\r\n\r\n');
    assert.equal(text, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  } finally {
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
  }
});

// The MITM listener has its own 'upgrade' handler (src/mitm.js), which passes
// the flag to relayUpgrade separately from createProxyServer. These drive a
// handshake through a real terminated CONNECT tunnel, as
// mitm-upgrade-host.test.js does, so a dropped argument there fails here.
// Bounded: a CONNECT reply or TLS handshake that stalls, or a socket that
// closes first, rejects within `timeoutMs` and destroys both sockets, so the
// caller's teardown runs instead of waiting on the test timeout.
function connectThroughProxy(proxyPort, target, caCertPem, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    /** @type {tls.TLSSocket | null} */
    let sock = null;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      raw.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`CONNECT/TLS setup did not finish within ${timeoutMs} ms`)), timeoutMs);
    const onClose = () => fail(new Error('socket closed before the TLS handshake finished'));
    raw.once('error', fail);
    raw.once('close', onClose);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { fail(new Error(status)); return; }
      sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['http/1.1'] }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        raw.removeListener('error', fail);
        raw.removeListener('close', onClose);
        resolve(sock);
      });
      sock.once('error', fail);
      sock.once('close', onClose);
    };
    raw.on('data', onData);
  });
}

// closeAllConnections() skips sockets handed off to an 'upgrade' or 'connect'
// listener, so a test that upgrades records every accepted socket itself and
// destroys them in teardown.
function trackSockets(server) {
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return () => { for (const s of sockets) s.destroy(); };
}

async function handshakeThroughMitm(extraConfig = {}) {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = upgradeUpstream('101 Switching Protocols');
  const destroyUpstreamSockets = trackSockets(upstream);
  const upPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR }],
    0.98,
  );
  const proxy = http.createServer();
  const destroyProxySockets = trackSockets(proxy);
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}`, mitm: { http1Only: true }, ...extraConfig },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  let tlsSock;
  try {
    tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem);
    tlsSock.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${upPort}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'authorization: Bearer client-own-token\r\n\r\n',
    );
    return await readHead(tlsSock);
  } finally {
    tlsSock?.destroy();
    destroyProxySockets();
    proxy.closeAllConnections?.();
    proxy.close();
    destroyUpstreamSockets();
    upstream.closeAllConnections();
    upstream.close();
  }
}

test('MITM upgrade listener: 101 handshake strips overage headers when enabled', { timeout: 30000 }, async () => {
  const text = await handshakeThroughMitm({ stripOverageHeaders: true });
  assert.match(text, /101 Switching Protocols/);
  assert.doesNotMatch(text, /overage/i);
  assert.doesNotMatch(text, /upgrade-paths/i);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

test('MITM upgrade listener: stripOverageHeaders unset keeps overage headers on the 101', { timeout: 30000 }, async () => {
  const text = await handshakeThroughMitm();
  assert.match(text, /101 Switching Protocols/);
  assert.match(text, /anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled/);
  assert.match(text, /anthropic-ratelimit-unified-upgrade-paths: extra_usage/);
  assert.match(text, /anthropic-ratelimit-unified-5h-status: allowed/);
});

// The flag is sampled once per request, at dispatch (forwardRequest's ctx), so
// a reload that flips it mid-request must not change what that request's
// failover hop does, and the next request must see the new value. Drives the
// in-stream failover of stream-failure-failover.test.js: the first account
// answers 200 and reports overloaded_error as its first event, the proxy hops
// once to the sibling, and the config is flipped while the first attempt is
// in flight.
const SSE_START = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } } };
const SSE_STOP = { type: 'message_stop' };
const SSE_OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
const sseFrame = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

for (const dispatched of [false, true]) {
  test(`stream failover keeps the stripOverageHeaders value it was dispatched with (${dispatched}), the next request sees the new one`, async () => {
    /** @type {string[]} */
    const seen = [];
    /** @type {{ proxy: {}, stripOverageHeaders: boolean }} */
    const config = { proxy: {}, stripOverageHeaders: dispatched };
    const upstream = http.createServer(async (req, res) => {
      for await (const c of req) void c;
      seen.push(String(req.headers.authorization || '').replace(/^Bearer t-/, ''));
      res.writeHead(200, { 'content-type': 'text/event-stream', ...OVERAGE, ...PLAN });
      if (seen.length === 1) {
        // A reload lands while the first attempt is in flight.
        config.stripOverageHeaders = !dispatched;
        res.end(sseFrame(SSE_OVERLOADED));
        return;
      }
      res.end(sseFrame(SSE_START) + sseFrame(SSE_STOP));
    });
    const upstreamPort = await listen(upstream);
    const account = (name) => ({
      name, type: 'oauth', accountId: `acct-${name}`, accessToken: `t-${name}`, refreshToken: 'r',
      expiresAt: Date.now() + HOUR, upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    const am = new AccountManager([account('one'), account('two')], 0.98);
    const proxy = createProxyServer(am, config);
    const proxyPort = await listen(proxy);
    const post = async () => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      return { res, body };
    };
    const assertOverage = (headers, stripped, label) => {
      for (const [name, value] of Object.entries(OVERAGE)) {
        assert.equal(headers.get(name), stripped ? null : value, `${label}: ${name}`);
      }
      assertPlanPassedThrough(headers);
    };

    try {
      const first = await post();
      assert.equal(first.res.status, 200);
      assert.equal(seen.length, 2, 'the in-stream refusal hopped once');
      assert.notEqual(seen[0], seen[1], 'the hop went to the sibling');
      assert.equal(first.body, sseFrame(SSE_START) + sseFrame(SSE_STOP), "the client reads the sibling's stream");
      assert.equal(config.stripOverageHeaders, !dispatched, 'the config did change mid-request');
      assertOverage(first.res.headers, dispatched, 'the hop keeps the dispatch-time value');

      const second = await post();
      assert.equal(second.res.status, 200);
      assert.equal(seen.length, 3);
      assertOverage(second.res.headers, !dispatched, 'the next request samples the new value');
    } finally {
      proxy.close();
      upstream.close();
    }
  });
}
