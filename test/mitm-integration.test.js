import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { KEEP_ALIVE_TIMEOUT_MS } from '../src/server.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { AccountManager } from '../src/account-manager.js';
import { closeUsageStore, openUsageStore, usageStoreAvailable } from '../src/usage/db.js';
import { gate } from '../test-helpers/gate.js';
import { childEnvWithoutProxy } from '../test-helpers/env.js';

const USAGE_STORE_AVAILABLE = usageStoreAvailable();

// The MITM now TERMINATES the tunnel (real h2/h1 server) and forwards each
// request with the shared buffering/retrying proxy listener — so these tests
// drive a real CONNECT + TLS client and a plain-HTTP fake upstream (reachable by
// the forwarder's `fetch`), asserting auth injection, uuid patching, quota
// observation, activity hooks, logging, and transparent retry across accounts.

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

function closeHard(server) {
  if (!server) return;
  server.closeAllConnections?.();
  try { server.close(); } catch { /* already closing */ }
}

// No test here has a deadline of its own: each waits on the exchange it
// checks, and one whose exchange never finishes is failed by the runner's
// timeout (test/README.md). That does not end the wait, so the `finally` after
// it would not run and the servers would hold the file open. `endWith` is what
// ends it: it closes the servers once the test has ended, however it ended,
// and hands connectThroughProxy the test's signal, on which the tunnel socket
// is destroyed (which closes any request on it).
/**
 * @param {import('node:test').TestContext} t
 * @param {...(import('node:net').Server | null | undefined)} servers
 * @returns {AbortSignal} t.signal, for connectThroughProxy
 */
function endWith(t, ...servers) {
  t.after(() => { for (const server of servers) closeHard(server); });
  return t.signal;
}

// Drive a CONNECT through the proxy, then TLS over the tunnel; resolve the TLS
// socket. The raw socket under it is destroyed when `signal` aborts, during the
// handshake or after it.
function connectThroughProxy(proxyPort, target, caCertPem, alpn, signal) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    const onAbort = () => { raw.destroy(); reject(new Error('the test ended before the CONNECT/TLS setup finished')); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    raw.once('close', () => { signal.removeEventListener('abort', onAbort); reject(new Error('socket closed before the TLS handshake finished')); });
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        raw.removeListener('data', onData);
        const sock = tls.connect(
          { socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: alpn },
          () => resolve(sock),
        );
        sock.once('error', reject);
      }
    };
    raw.on('data', onData);
  });
}

const ACCOUNT_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// A plain-HTTP fake upstream. `handler(req, body) -> { status, headers, body }`.
function makeUpstream(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = handler(req, Buffer.concat(chunks).toString('utf8')) || {};
      res.writeHead(out.status || 200, out.headers || {});
      res.end(out.body ?? '');
    });
  });
}

// Build the teamclaude proxy (CONNECT → terminate + forward) against `upPort`.
function makeProxy(am, upPort, { leafCertPem, leafKeyPem }, { logDir = null, hooks = {}, sx = null, usageStore = undefined } = {}) {
  const proxy = http.createServer();
  allowLoopbackForward(proxy); // tunnel-mode targets in these tests are on this machine
  proxy.on('connect', createConnectHandler({
    // upstream host is 127.0.0.1 so a `CONNECT 127.0.0.1:<port>` is 'rewrite' mode.
    config: { upstream: `http://127.0.0.1:${upPort}` },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    logDir, hooks, log: () => {}, sx, usageStore,
  }));
  return proxy;
}

function oauthAccount(name, token, extra = {}) {
  return { name, type: 'oauth', accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Resolve with the contents of the first request log under `dir` that matches
// `pattern`. The log is written through a file stream the request does not wait
// on, so its bytes can land after the client has its whole answer: this waits
// for the directory to change, not for a span of time, and reads again on each
// change. `signal` (the test's t.signal) ends the wait for a log that never
// comes, which the runner's timeout is what reports.
/**
 * @param {string} dir
 * @param {RegExp} pattern
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
function requestLogMatching(dir, pattern, signal) {
  return new Promise((resolve, reject) => {
    const watcher = watch(dir);
    const done = (/** @type {() => void} */ settle) => {
      watcher.close();
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const look = () => {
      const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => readFileSync(join(dir, f), 'utf8'));
      const found = logs.find((text) => pattern.test(text));
      if (found !== undefined) done(() => resolve(found));
    };
    const onAbort = () => done(() => reject(new Error(`no request log under ${dir} matched ${pattern}`)));
    watcher.on('change', look);
    watcher.on('error', (err) => done(() => reject(err)));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // Watching before the first look: a write between the two is then seen by one of them.
    look();
  });
}

// node:sqlite hands back null-prototype rows; compare against plain object literals.
function rawRows(store, sql, ...args) {
  return store.db.prepare(sql).all(...args).map(row => ({ ...row }));
}

test('MITM h2: authorization injected, x-api-key dropped, quota observed, body relayed', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req, _body) => ({
    status: 200,
    headers: {
      'x-saw-auth': req.headers['authorization'] || 'none',
      'x-saw-xkey': req.headers['x-api-key'] || 'none',
      'x-saw-ct': req.headers['content-type'] || 'none',
      'anthropic-ratelimit-unified-5h-utilization': '0.7',
      'content-type': 'text/plain',
    },
    body: 'upstream-ok',
  }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN', { accountUuid: ACCOUNT_UUID })], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    assert.equal(tlsSock.alpnProtocol, 'h2');
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({
      ':method': 'POST', ':path': '/v1/messages',
      authorization: 'Bearer FAKE', 'x-api-key': 'sk-fake', 'content-type': 'application/json',
    });
    let resp, body = '';
    req.on('response', (h) => { resp = h; });
    req.setEncoding('utf8'); req.on('data', (d) => { body += d; }); req.end('{"model":"x"}');
    await once(req, 'close');

    assert.equal(resp['x-saw-auth'], 'Bearer REAL-TOKEN'); // injected
    assert.equal(resp['x-saw-xkey'], 'none');              // dropped
    assert.equal(resp['x-saw-ct'], 'application/json');    // preserved
    assert.equal(body, 'upstream-ok');
    assert.equal(am.accounts[0].quota.unified5h, 0.7);     // quota observed
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

// A client token refresh (/v1/oauth/token) takes relayRaw, not the forward
// path, and inside an h2 tunnel its answer is written by the h2 server, whose
// writeHead throws on most connection-specific headers. relayRaw used to drop
// only transfer-encoding and connection, so an upstream sending keep-alive,
// upgrade, proxy-connection or a te other than "trailers" (a Node upstream
// sends Keep-Alive by default) made the refresh's answer, its 502 and the
// listener's last-resort 502 all throw, and the rejection that escaped took
// the daemon down. Every name in the set goes now, as on the other paths;
// trailer, which h2 accepts, is checked for that reason alone. connection is
// sent as "trailers", the one value writeHead throws on rather than dropping
// itself, so the drop relayRaw already made stays tested.
test('MITM h2: a token refresh is answered without the upstream\'s connection-specific headers', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req) => ({
    status: 200,
    headers: {
      'content-type': 'application/json',
      connection: 'trailers',
      'keep-alive': 'timeout=5',
      upgrade: 'h2c',
      'proxy-connection': 'keep-alive',
      te: 'gzip',
      trailer: 'x-checksum',
      'x-saw-path': req.url,
    },
    body: '{"access_token":"new"}',
  }));
  const upPort = await listen(upstream);
  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], endWith(t, proxy, upstream));
  try {
    assert.equal(tlsSock.alpnProtocol, 'h2');
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/oauth/token', 'content-type': 'application/json' });
    let resp, body = '';
    req.on('response', (h) => { resp = h; });
    req.setEncoding('utf8'); req.on('data', (d) => { body += d; }); req.end('{"grant_type":"refresh_token"}');
    // The failure this guards leaves the stream unanswered, and this wait has
    // no deadline: the test fails on the error that escapes the proxy, or else
    // on its timeout. Neither ends the wait, so the tunnel is destroyed once
    // the test has ended (node:test aborts t.signal then; see endWith), which
    // closes the stream and lets the finally below run. Without it the servers
    // would hold the file open: on Node 24 and later for good, on Node 20 and
    // 22 until the runner's timeout, which they apply to the whole file too,
    // kills it.
    await new Promise((resolve) => req.once('close', resolve));

    assert.equal(resp?.[':status'], 200);
    assert.equal(body, '{"access_token":"new"}');
    assert.equal(resp['x-saw-path'], '/v1/oauth/token');
    for (const name of ['keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer']) {
      assert.equal(resp[name], undefined, `${name} must not be relayed`);
    }
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

// HTTP2-Settings is one more name the h2 server's writeHead throws on, and it
// was in no path's filter: an upstream answer carrying it took the daemon down
// from each of the four paths behind the MITM that copy the upstream's
// headers, by an uncaught exception from relayStream and an unhandled
// rejection from the other three. One case per path: the forward path,
// relayRaw, relayStream (a client-credential path) and relayOnClientCredential
// (a GET the pooled token draws a scope 403 on, sent again on the client's
// own).
const HTTP2_SETTINGS_CASES = [
  { label: '/v1/messages', method: 'POST', path: '/v1/messages' },
  { label: '/v1/oauth/token', method: 'POST', path: '/v1/oauth/token' },
  { label: '/api/oauth/profile', method: 'GET', path: '/api/oauth/profile' },
  { label: 'a scope-403 retry', method: 'GET', path: '/api/profile-required' },
];
for (const { label, method, path } of HTTP2_SETTINGS_CASES) {
  test(`MITM h2: an upstream answer to ${label} carrying HTTP2-Settings is relayed without it`, async (t) => {
    const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
    const seen = [];
    const upstream = makeUpstream((req) => {
      seen.push(req.headers.authorization);
      // The pooled token is refused for the profile scope; the client's own is served.
      if (req.url === '/api/profile-required' && req.headers.authorization !== 'Bearer client-own-token') {
        return {
          status: 403,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement user:profile', details: { error_code: 'oauth_scope_insufficient', required_scopes: ['user:profile'], match: 'any' } } }),
        };
      }
      return { status: 200, headers: { 'content-type': 'application/json', 'http2-settings': 'AAMAAABkAAQAoAAAAAIAAAAA', 'x-saw-path': req.url }, body: '{"ok":true}' };
    });
    const upPort = await listen(upstream);
    const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
    const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
    const proxyPort = await listen(proxy);

    const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], endWith(t, proxy, upstream));
    try {
      assert.equal(tlsSock.alpnProtocol, 'h2');
      const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
      const req = client.request({ ':method': method, ':path': path, 'content-type': 'application/json', authorization: 'Bearer client-own-token' });
      let resp, body = '';
      req.on('response', (h) => { resp = h; });
      req.setEncoding('utf8'); req.on('data', (d) => { body += d; });
      req.end(method === 'POST' ? '{"model":"x","messages":[]}' : undefined);
      // As in the token-refresh test above: the failure leaves the stream
      // unanswered, and the tunnel is destroyed once the test has ended.
      await new Promise((resolve) => req.once('close', resolve));

      assert.equal(resp?.[':status'], 200);
      assert.equal(body, '{"ok":true}');
      assert.equal(resp['x-saw-path'], path);
      assert.equal(resp['http2-settings'], undefined);
      // The scope case reached its retry: the pooled token first, then the client's own.
      if (path === '/api/profile-required') assert.deepEqual(seen, ['Bearer REAL-TOKEN', 'Bearer client-own-token']);
      client.close();
    } finally {
      tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
    }
  });
}

test('MITM h1: over http/1.1, authorization is injected and the body relayed', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((req, body) => ({
    status: 200,
    headers: { 'x-saw-auth': req.headers['authorization'] || 'none', 'content-type': 'text/plain' },
    body: `echo:${body}`,
  }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1'], endWith(t, proxy, upstream));
  try {
    assert.equal(tlsSock.alpnProtocol, 'http/1.1');
    const resp = await new Promise((resolve, reject) => {
      const r = http.request({ createConnection: () => tlsSock, method: 'POST', path: '/v1/messages',
        headers: { authorization: 'Bearer FAKE', 'x-api-key': 'sk', 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (d) => b += d); res.on('end', () => resolve({ res, b }));
      });
      r.on('error', reject);
      r.end('{"model":"y"}');
    });
    assert.equal(resp.res.headers['x-saw-auth'], 'Bearer REAL-TOKEN');
    assert.equal(resp.b, 'echo:{"model":"y"}');
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM h2: body account_uuid is rewritten to the injected account', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream((_req, body) => {
    let seen = 'none';
    try { seen = JSON.parse(JSON.parse(body).metadata.user_id).account_uuid; } catch { /* ignore */ }
    return { status: 200, headers: { 'x-saw-uuid': seen, 'content-type': 'text/plain' }, body: 'ok' };
  });
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN', { accountUuid: ACCOUNT_UUID })], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const reqBody = JSON.stringify({ model: 'x', metadata: { user_id: JSON.stringify({ account_uuid: '11111111-2222-3333-4444-555555555555' }) } });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    let resp; req.on('response', (h) => { resp = h; }); req.resume(); req.end(reqBody);
    await once(req, 'close');
    assert.equal(resp['x-saw-uuid'], ACCOUNT_UUID); // rewritten to the injected account
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM h2: a quota-429 on one account is transparently retried on another', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const hits = [];
  const upstream = makeUpstream((req) => {
    const auth = req.headers['authorization'];
    hits.push(auth);
    if (auth === 'Bearer TOK-A') {
      // Durable quota rejection → the proxy must switch accounts, not surface this.
      return { status: 429, headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'retry-after': '3600', 'content-type': 'application/json',
      }, body: '{"type":"error","error":{"type":"rate_limit_error"}}' };
    }
    return { status: 200, headers: { 'x-served-by': auth, 'content-type': 'text/plain' }, body: 'served-by-B' };
  });
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('A', 'TOK-A'), oauthAccount('B', 'TOK-B')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    let resp, body = ''; req.on('response', (h) => { resp = h; });
    req.setEncoding('utf8'); req.on('data', (d) => body += d); req.end('{"model":"x"}');
    await once(req, 'close');

    assert.equal(resp[':status'], 200, 'client sees a 200, not the 429');
    assert.equal(body, 'served-by-B');
    assert.deepEqual(hits, ['Bearer TOK-A', 'Bearer TOK-B'], 'tried A, then retried on B');
    assert.equal(am.accounts[0].status, 'throttled', 'account A held after its quota rejection');
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM h2: relayed requests fire the TUI activity hooks with the injected account', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({ status: 201, headers: { 'content-type': 'text/plain' }, body: 'ok' }));
  const upPort = await listen(upstream);

  const events = [];
  const hooks = {
    onRequestStart: (id, info) => events.push({ ev: 'start', id, ...info }),
    onRequestRouted: (id, info) => events.push({ ev: 'routed', id, ...info }),
    onRequestEnd: (id, info) => events.push({ ev: 'end', id, ...info }),
  };
  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem }, { hooks });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    req.resume(); req.end('{"model":"x"}');
    await once(req, 'close');
    client.close();

    const start = events.find((e) => e.ev === 'start');
    const routed = events.find((e) => e.ev === 'routed');
    const end = events.find((e) => e.ev === 'end');
    assert.ok(start && start.method === 'POST' && start.path === '/v1/messages');
    assert.equal(routed?.account, 'acct@x');
    assert.ok(end && end.id === start.id);
    assert.equal(String(end.status), '201');
    assert.equal(end.model, 'x'); // the requested model is reported for the query log
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM logs proxied requests when a log dir is set', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }));
  const upPort = await listen(upstream);

  const logDir = mkdtempSync(join(tmpdir(), 'tc-mitm-log-'));
  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem }, { logDir });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    req.resume(); req.end('{"model":"x"}');
    await once(req, 'close');
    client.close();

    // The log stream is flushed on its own schedule, after the answer: wait
    // for the file to say what was answered, not for a tick.
    const contents = await requestLogMatching(logDir, /RESPONSE 200/, t.signal);
    assert.match(contents, /=== REQUEST \(account: acct@x,/, 'the same file records the request, on the injected account');
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
    rmSync(logDir, { recursive: true, force: true });
  }
});

// Regression: a tunnel-mode CONNECT whose upstream connect FAILS must return a
// proper proxy error status line, not a silent socket drop. Dropping it made
// the client report "Proxy connection ended before receiving CONNECT response".
test('tunnel: upstream connect failure returns 502, not a silent drop', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  // Grab a port, then free it so a connect there is refused deterministically.
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));

  // config.upstream host is 127.0.0.1, so `CONNECT localhost:<port>` is tunnel mode.
  const am = new AccountManager([oauthAccount('acct@x', 'T')], 0.98);
  const proxy = makeProxy(am, 65500, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  try {
    const status = await new Promise((resolve, reject) => {
      const raw = net.connect(proxyPort, '127.0.0.1');
      // A CONNECT left unanswered and open is failed by the runner's timeout;
      // the socket is destroyed then, which ends this wait.
      t.signal.addEventListener('abort', () => raw.destroy(), { once: true });
      raw.once('error', reject);
      raw.once('connect', () => raw.write(`CONNECT localhost:${deadPort} HTTP/1.1\r\nHost: localhost:${deadPort}\r\n\r\n`));
      let buf = '';
      raw.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) resolve(buf.split('\r\n')[0]); });
      raw.on('close', () => reject(new Error(`socket closed with no complete CONNECT response; received ${JSON.stringify(buf)}`)));
    });
    assert.match(status, /^HTTP\/1\.1 502/, `expected a 502 status line, got: ${status}`);
  } finally {
    closeHard(proxy);
  }
});

// A client that has gone away must not keep spending quota. The retry ladder
// asks `res.destroyed` at every rung, and `Http2ServerResponse` has no such
// property, so on the MITM path, which is the busy one, each rung reads
// `undefined` and the ladder runs to the end: an abandoned request is retried
// on every remaining account, and each retry is a real upstream call against
// that account's weekly quota.
//
// The measurement is the number of accounts spent, not the number of guards
// passed. Anything that stops the ladder early satisfies this.
//
// Nothing here is timed. The upstream holds its answer to attempt one at a
// gate. The client cancels and then pings: the ping's ack comes back on the
// same connection, behind the cancel, so once it is here the proxy has read
// the cancel. Only then is the gate opened and the rejection sent, so the rung
// is always decided for a client that has already left. The count is read once
// the proxy reports the request ended (onRequestEnd), which a ladder that
// stopped and a ladder that ran through every account both reach: the first
// with one account spent, the second with all four.
test('MITM h2: a cancelled request stops the retry ladder instead of spending every account', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const hits = [];
  const seenFirstHit = gate(t.signal);
  const clientGone = gate(t.signal);
  const requestEnded = gate(t.signal);

  // Every account is answered with a quota rejection, the branch that marks the
  // account and moves to the next one. The first hit waits for the client to go
  // away before answering, so the cancel lands before rung two is decided.
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    hits.push(req.headers['authorization'] || 'none');
    if (hits.length === 1) { seenFirstHit.open(); await clientGone.opened; }
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '1',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
    });
    res.end('{}');
  });
  const upPort = await listen(upstream);

  const am = new AccountManager(
    ['a', 'b', 'c', 'd'].map((n, i) => oauthAccount(n, `t-${n}`, { accountUuid: `${ACCOUNT_UUID.slice(0, -1)}${i}` })),
    0.98,
  );
  const proxy = makeProxy(am, upPort, { leafCertPem, leafKeyPem }, { hooks: { onRequestEnd: () => requestEnded.open() } });
  const proxyPort = await listen(proxy);

  const realLog = console.log; const realErr = console.error;
  console.log = () => {}; console.error = () => {};
  // Through t.after as well: a wait below that never settled is not unwound,
  // and the finally would not run.
  t.after(() => { console.log = realLog; console.error = realErr; });
  let client;
  try {
    const sock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2'], endWith(t, proxy, upstream));
    client = http2.connect(`https://localhost:${upPort}`, { createConnection: () => sock });
    const stream = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
    stream.on('error', () => { /* the cancel below is the point */ });
    stream.end(JSON.stringify({ model: 'claude-opus-5', messages: [] }));

    await seenFirstHit.opened;                       // the upstream has attempt one
    assert.equal(requestEnded.isOpen(), false, 'the request ended before it was cancelled, so this proves nothing');
    stream.close(http2.constants.NGHTTP2_CANCEL);    // the client goes away
    // The ack follows the cancel through the proxy's side of the connection.
    await new Promise((resolve, reject) => {
      client.ping((err) => (err ? reject(err) : resolve(undefined)));
      t.signal.addEventListener('abort', () => reject(new Error('the test ended before the ping was acknowledged')), { once: true });
    });
    clientGone.open();                               // attempt one is now rejected
    await requestEnded.opened;                       // the ladder is over, wherever it stopped
  } finally {
    console.log = realLog; console.error = realErr;
    try { client?.destroy(); } catch { /* already gone */ }
    closeHard(proxy); closeHard(upstream);
  }

  assert.ok(hits.length >= 1, 'the request never reached the upstream, so this proves nothing');
  assert.equal(hits.length, 1,
    `a cancelled h2 request spent ${hits.length} of ${am.accounts.length} accounts; `
    + 'every rung past the first is quota burned for a client that is gone');
});

// Paths for the child below, which runs the proxy out of process.
const X509_PATH = fileURLToPath(new URL('../src/x509.js', import.meta.url));
const MITM_PATH = fileURLToPath(new URL('../src/mitm.js', import.meta.url));
const AM_PATH = fileURLToPath(new URL('../src/account-manager.js', import.meta.url));

// A cancelled h2 stream must not strand the request handler.
//
// `res.write` to a cancelled stream returns false, which sends streamResponse
// into its backpressure wait. That wait listens for `drain` or `close`, and on a
// stream that is already closed neither will ever arrive: `close` fired before
// the listener existed and `drain` does not fire on a closed stream. The read
// that would have broken out first is the one this change is about.
//
// A stranded handler holds the event loop, so this runs in a child. In process
// it would leave the runner unable to exit whether it passed or failed, and a
// test that cannot fail cleanly is not a test.
function h2SseCancelInChild(signal) {
  const source = `
    import http from 'node:http';
    import http2 from 'node:http2';
    import { generateCertChain } from ${JSON.stringify(X509_PATH)};
    import { createConnectHandler } from ${JSON.stringify(MITM_PATH)};
    import { AccountManager } from ${JSON.stringify(AM_PATH)};

    console.log = () => {}; console.error = () => {};
    const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
    const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

    // The parent closes this pipe when it is done with the child or dies
    // itself; a child whose handler is stranded would otherwise outlive it.
    process.stdin.on('close', () => process.exit(1));
    process.stdin.resume();

    // Feeds the proxy after the client has left, so the proxy has chunks to
    // write to a stream that is already closed: one chunk for the client to
    // read, then nothing until the cancel has reached the proxy, then the rest,
    // one write at a time.
    let clientLeft;
    const clientGone = new Promise(r => { clientLeft = r; });
    const upstream = http.createServer(async (req, res) => {
      for await (const c of req) void c;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"n":0}\\n\\n');
      await clientGone;
      for (let n = 1; n < 200 && !res.destroyed; n++) {
        res.write('data: {"n":' + n + '}\\n\\n');
        await new Promise(r => setImmediate(r));
      }
      res.end();
    });
    const upPort = await listen(upstream);

    const started = [], ended = [];
    let handlerReturned;
    const returned = new Promise(r => { handlerReturned = r; });
    const am = new AccountManager([{
      name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r',
      expiresAt: Date.now() + 3600000,
    }], 0.98);
    const proxy = http.createServer();
    proxy.on('connect', createConnectHandler({
      config: { proxy: {}, upstream: 'http://127.0.0.1:' + upPort },
      accountManager: am,
      ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
      hooks: { onRequestStart: (id) => started.push(id), onRequestEnd: (id) => { ended.push(id); handlerReturned(); } },
    }));
    const proxyPort = await listen(proxy);

    // CONNECT, then h2 over the tunnel.
    const net = await import('node:net');
    const tls = await import('node:tls');
    const raw = net.connect(proxyPort, '127.0.0.1');
    await new Promise(r => raw.once('connect', r));
    raw.write('CONNECT 127.0.0.1:' + upPort + ' HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n');
    await new Promise(r => raw.once('data', r));
    const sock = tls.connect({ socket: raw, ca: caCertPem, servername: 'localhost', ALPNProtocols: ['h2'] });
    await new Promise(r => sock.once('secureConnect', r));

    const client = http2.connect('https://localhost:' + upPort, { createConnection: () => sock });
    client.on('error', () => {});
    const stream = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
    stream.on('error', () => {});
    stream.end(JSON.stringify({ model: 'claude-opus-5', messages: [], stream: true }));

    // The stream is cancelled mid-flight: after the client has read a chunk,
    // and with the entry still open.
    await new Promise(r => stream.once('data', r));
    const endedBeforeCancel = ended.length;
    stream.close(http2.constants.NGHTTP2_CANCEL);
    // The ack follows the cancel through the proxy's side of the connection,
    // so the chunks the upstream sends from here on reach a proxy that has
    // read the cancel.
    await new Promise(r => client.ping(r));
    clientLeft();

    // The entry closing is the signal that the handler returned. There is no
    // deadline on it: a stranded handler never closes the entry, the child
    // never reports, and the parent's test ends on the runner's timeout.
    await returned;
    process.stdout.write(JSON.stringify({ started: started.length, endedBeforeCancel, ended: ended.length }));
    process.exit(0);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source],
      { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvWithoutProxy() });
    const out = [];
    const err = [];
    child.stdout.on('data', d => out.push(String(d)));
    child.stderr.on('data', d => err.push(String(d)));
    child.stdin.on('error', () => {});
    // A stranded handler keeps the child alive, so the parent has to be the one
    // that ends it: once the test has ended, which for a child that never
    // reports is the runner's timeout. Nothing is asserted on that; a test that
    // got here has already failed.
    signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('close', (code) => {
      try { resolve(JSON.parse(out.join(''))); } catch { resolve({ error: out.join('') || `child produced nothing (exit ${code}): ${err.join('')}` }); }
    });
  });
}

test('MITM h2: a cancelled stream does not strand the request handler', async (t) => {
  // A cancelled h2 stream that left the request handler waiting on a drain or
  // close that cannot arrive never closes its activity entry, and the child
  // never reports: that failure is this test ending on the runner's timeout.
  const got = await h2SseCancelInChild(t.signal);
  assert.equal(got.error, undefined, `the child did not report: ${JSON.stringify(got)}`);
  assert.equal(got.started, 1, `one activity entry is opened, or this proves nothing: ${JSON.stringify(got)}`);
  assert.equal(got.endedBeforeCancel, 0, `the entry closed before the cancel, so nothing was cancelled mid-flight: ${JSON.stringify(got)}`);
  assert.equal(got.ended, 1, `the cancelled stream's entry closed once: ${JSON.stringify(got)}`);
});

// The base listener holds an idle keep-alive connection for KEEP_ALIVE_TIMEOUT_MS
// so a client's pool is always the side that closes (see server-keepalive.test.js).
// The MITM terminates a server of its own, and that one was left at whatever the
// runtime defaults to: measured on node 24 it advertised no `Keep-Alive` header
// at all while the base listener advertised `timeout=120`, and on node 26 the
// same server closes an idle h1 connection after 6s. Half of one proxy answered
// to a number nobody chose. Asserted on the header the client actually reads,
// through a real tunnel, because that is what a connection pool schedules against.
test('MITM h1: the terminating server advertises the base idle window and reuses the connection', async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1'], endWith(t, proxy, upstream));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = () => tlsSock;
  try {
    // Completing a keep-alive response arms Node's socket timer. On Node
    // 24.6.0 an unset HTTP/2 keepAliveTimeoutBuffer makes that timeout NaN;
    // reading only the advertised header does not prove the socket is reusable.
    for (let i = 0; i < 3; i++) {
      const { res, body, reusedSocket } = await new Promise((resolve, reject) => {
        const r = http.request({
          agent, method: 'POST', path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.once('error', reject);
          response.on('end', () => resolve({ res: response, body, reusedSocket: r.reusedSocket }));
        });
        r.once('error', reject);
        r.end('{"model":"x"}');
      });
      assert.equal(res.statusCode, 200);
      assert.equal(body, 'ok');
      assert.equal(reusedSocket, i > 0, 'subsequent requests must reuse the same tunnel');
      assert.equal(res.headers['keep-alive'], `timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`,
        'the MITM half of the proxy must not keep its own idle window');
    }
  } finally {
    agent.destroy();
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

// createConnectHandler threads usageStore into its inner
// createProxyRequestListener, so a request made over a CONNECT tunnel is
// recorded like a base-URL one. Drives a real CONNECT + TLS request end to end (same harness as the tests
// above) against a real in-memory store, then reads the row back with plain SQL.
test('MITM: a request through the tunnel writes exactly one usage row', { skip: !USAGE_STORE_AVAILABLE && 'node:sqlite needs Node 22.5+' }, async (t) => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'served-model', usage: { input_tokens: 3, output_tokens: 5 } }),
  }));
  const upPort = await listen(upstream);

  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const usageStore = openUsageStore({ path: ':memory:' });
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem }, { usageStore });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1'], endWith(t, proxy, upstream));
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    let resp; req.on('response', (h) => { resp = h; });
    req.resume(); req.end('{"model":"x"}');
    await once(req, 'close');
    client.close();

    assert.equal(resp[':status'], 200);

    // No config.proxy is set anywhere in this harness, so usageCallerLabel
    // resolves every caller to '(open)' — the same value the base HTTP path
    // would use unconfigured. It reaches this row via the SAME
    // createProxyRequestListener the base listener uses (mitm.js reuses it for
    // the tunnel's terminating server), through the single recordRequest call
    // in its outer finally block. The row's model is the REQUESTED model
    // (ctx.model, from the client's own body — "x" here), not the upstream
    // response's `model` field, which this fake upstream sets to something
    // else on purpose to make that distinction observable.
    const rows = rawRows(usageStore, `
      SELECT dc.label AS caller, da.label AS account, dm.label AS model,
             u.status, u.input, u.output
      FROM usage u
      JOIN dim dc ON dc.id = u.caller_id  AND dc.kind = 'caller'
      JOIN dim da ON da.id = u.account_id AND da.kind = 'account'
      JOIN dim dm ON dm.id = u.model_id   AND dm.kind = 'model'
    `);
    assert.deepEqual(rows, [{ caller: '(open)', account: 'acct@x', model: 'x', status: 200, input: 3, output: 5 }]);
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream); closeUsageStore(usageStore);
  }
});
