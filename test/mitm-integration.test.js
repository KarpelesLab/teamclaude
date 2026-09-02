import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

// Regression: a tunnel-mode CONNECT whose upstream connect FAILS must return a
// proper proxy error status line, not a silent socket drop. Dropping it made
// the client report "Proxy connection ended before receiving CONNECT response".
test('tunnel: upstream connect failure returns 502, not a silent drop', T, async () => {
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
      raw.once('error', reject);
      raw.once('connect', () => raw.write(`CONNECT localhost:${deadPort} HTTP/1.1\r\nHost: localhost:${deadPort}\r\n\r\n`));
      let buf = '';
      raw.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) resolve(buf.split('\r\n')[0]); });
      raw.on('close', () => { if (!buf) reject(new Error('socket closed with no CONNECT response')); });
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
test('MITM h2: a cancelled request stops the retry ladder instead of spending every account', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const hits = [];
  let cancelled = null;
  const seenFirstHit = new Promise(r => { cancelled = r; });

  // Every account is answered with a quota rejection, the branch that marks the
  // account and moves to the next one. The first hit waits for the client to go
  // away before answering, so the cancel lands before rung two is decided.
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    hits.push(req.headers['authorization'] || 'none');
    if (hits.length === 1) { cancelled(); await new Promise(r => setTimeout(r, 250)); }
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
  const proxy = makeProxy(am, upPort, { leafCertPem, leafKeyPem });
  const proxyPort = await listen(proxy);

  const realLog = console.log; const realErr = console.error;
  console.log = () => {}; console.error = () => {};
  let client;
  try {
    const sock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2']);
    client = http2.connect(`https://localhost:${upPort}`, { createConnection: () => sock });
    const stream = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
    stream.on('error', () => { /* the cancel below is the point */ });
    stream.end(JSON.stringify({ model: 'claude-opus-5', messages: [] }));

    await seenFirstHit;                              // the upstream has attempt one
    stream.close(http2.constants.NGHTTP2_CANCEL);    // the client goes away

    // Wait for the ladder to go quiet rather than for a fixed span. A fixed
    // sleep passes for the wrong reason if the loop stalls: the servers close
    // and the count is read before the remaining rungs ever run.
    const settleMs = 400;
    const capMs = 15000;
    const startedAt = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    while (Date.now() - startedAt < capMs) {
      if (hits.length !== lastCount) { lastCount = hits.length; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= settleMs) break;
      await new Promise(r => setTimeout(r, 50));
    }
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
function h2SseCancelInChild() {
  const source = `
    import http from 'node:http';
    import http2 from 'node:http2';
    import { generateCertChain } from ${JSON.stringify(X509_PATH)};
    import { createConnectHandler } from ${JSON.stringify(MITM_PATH)};
    import { AccountManager } from ${JSON.stringify(AM_PATH)};

    console.log = () => {}; console.error = () => {};
    const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
    const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

    // Keeps feeding the proxy, so it keeps writing to a client that has left.
    let stop = false;
    const upstream = http.createServer(async (req, res) => {
      for await (const c of req) void c;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (let n = 0; !stop && n < 200; n++) {
        res.write('data: {"n":' + n + '}\\n\\n');
        await new Promise(r => setTimeout(r, 20));
      }
      res.end();
    });
    const upPort = await listen(upstream);

    const started = [], ended = [];
    const am = new AccountManager([{
      name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r',
      expiresAt: Date.now() + 3600000,
    }], 0.98);
    const proxy = http.createServer();
    proxy.on('connect', createConnectHandler({
      config: { proxy: {}, upstream: 'http://127.0.0.1:' + upPort },
      accountManager: am,
      ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
      hooks: { onRequestStart: (id) => started.push(id), onRequestEnd: (id) => ended.push(id) },
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

    let sawChunk = false;
    await new Promise((resolve) => {
      stream.on('data', () => { if (!sawChunk) { sawChunk = true; resolve(); } });
      setTimeout(resolve, 6000);
    });
    stream.close(http2.constants.NGHTTP2_CANCEL);

    // The entry closing is the signal that the handler returned.
    const returned = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 8000);
      const poll = setInterval(() => {
        if (started.length > 0 && ended.length >= started.length) {
          clearTimeout(deadline); clearInterval(poll); resolve(true);
        }
      }, 50);
    });
    stop = true;
    process.stdout.write(JSON.stringify({ sawChunk, started: started.length, ended: ended.length, returned }));
    process.exit(0);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', d => out.push(String(d)));
    child.stderr.on('data', () => {});
    // The ceiling is the point: a stranded handler keeps the child alive, so the
    // parent has to be the one that gives up.
    const kill = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', () => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out.join(''))); } catch { resolve({ error: out.join('') || 'child produced nothing' }); }
    });
  });
}

test('MITM h2: a cancelled stream does not strand the request handler', { ...T, timeout: 60000 }, async () => {
  const got = await h2SseCancelInChild();
  assert.ok(got.sawChunk, `the stream never delivered a chunk, so nothing was cancelled mid-flight: ${JSON.stringify(got)}`);
  assert.ok(got.started > 0, `no activity entry was opened, so this proves nothing: ${JSON.stringify(got)}`);
  assert.ok(got.returned,
    'a cancelled h2 stream left the request handler waiting on a drain or close that cannot arrive; '
    + `its activity entry never closed and the handler holds the event loop: ${JSON.stringify(got)}`);
});
