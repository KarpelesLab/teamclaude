import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';

// The MITM now TERMINATES the tunnel (real h2/h1 server) and forwards each
// request with the shared buffering/retrying proxy listener — so these tests
// drive a real CONNECT + TLS client and a plain-HTTP fake upstream (reachable by
// the forwarder's `fetch`), asserting auth injection, uuid patching, quota
// observation, activity hooks, logging, and transparent retry across accounts.

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
const T = { timeout: 30000 };

function closeHard(server) {
  if (!server) return;
  server.closeAllConnections?.();
  try { server.close(); } catch { /* already closing */ }
}

// Drive a CONNECT through the proxy, then TLS over the tunnel; resolve the TLS socket.
function connectThroughProxy(proxyPort, target, caCertPem, alpn) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
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
function makeProxy(am, upPort, { leafCertPem, leafKeyPem }, { logDir = null, hooks = {}, sx = null } = {}) {
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    // upstream host is 127.0.0.1 so a `CONNECT 127.0.0.1:<port>` is 'rewrite' mode.
    config: { upstream: `http://127.0.0.1:${upPort}` },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    logDir, hooks, log: () => {}, sx,
  }));
  return proxy;
}

function oauthAccount(name, token, extra = {}) {
  return { name, type: 'oauth', accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('MITM h2: authorization injected, x-api-key dropped, quota observed, body relayed', T, async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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

test('MITM h1: over http/1.1, authorization is injected and the body relayed', T, async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1']);
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

test('MITM h2: body account_uuid is rewritten to the injected account', T, async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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

test('MITM h2: a quota-429 on one account is transparently retried on another', T, async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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

test('MITM h2: relayed requests fire the TUI activity hooks with the injected account', T, async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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

test('MITM logs proxied requests when a log dir is set', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = makeUpstream(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }));
  const upPort = await listen(upstream);

  const logDir = mkdtempSync(join(tmpdir(), 'tc-mitm-log-'));
  const am = new AccountManager([oauthAccount('acct@x', 'REAL-TOKEN')], 0.98);
  const proxy = makeProxy(am, upPort, { caCertPem, leafCertPem, leafKeyPem }, { logDir });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE', 'content-type': 'application/json' });
    req.resume(); req.end('{"model":"x"}');
    await once(req, 'close');
    client.close();

    // Give the async log stream a tick to flush.
    await new Promise((r) => setTimeout(r, 50));
    const files = readdirSync(logDir).filter((f) => f.endsWith('.log'));
    assert.ok(files.length >= 1, 'a request log file was written');
    const contents = readFileSync(join(logDir, files[0]), 'utf8');
    assert.match(contents, /RESPONSE 200/);
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
    rmSync(logDir, { recursive: true, force: true });
  }
});
