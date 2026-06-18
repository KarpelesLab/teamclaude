import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

// Tear a server down hard: destroy any lingering connections (CONNECT-hijacked
// sockets are NOT closed by server.close(), which only stops accepting), then
// close. Without this, Node 18's test runner — which, unlike Node 20+, does not
// force-exit — keeps the event loop alive on a leaked handle and the run hangs.
function closeHard(server) {
  if (!server) return;
  server.closeAllConnections?.();
  try { server.close(); } catch { /* already closing */ }
}

// node:test per-test timeout: turn any future deadlock into a fast, located
// failure instead of a 30-minute CI stall (option form works on Node 18).
const T = { timeout: 30000 };

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

function makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, onQuota, logDir = null) {
  const account = { index: 0, type: 'oauth', credential: 'REAL-TOKEN', accountUuid: ACCOUNT_UUID, name: 'acct@x' };
  const accountManager = {
    getActiveAccount: () => account,
    ensureTokenFresh: async () => {},
    updateQuota: (i, h) => onQuota(h),
    markRateLimited: () => {},
  };
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    // Address the upstream by IP (servers bind 127.0.0.1) so the test never
    // depends on how the host resolves `localhost` — on a dual-stack box that
    // prefers ::1, Node 18 (no happy-eyeballs) would otherwise hang the dial.
    // SNI is pinned to the cert's name via upstreamTlsOptions.servername.
    config: { upstream: `https://127.0.0.1:${upPort}` },
    accountManager,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    upstreamTlsOptions: { ca: [caCertPem], servername: 'localhost' },
    logDir,
    log: () => {},
  }));
  return proxy;
}

test('MITM h2: ALPN mirrored, only authorization rewritten, quota observed', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

  const upstream = http2.createSecureServer({ key: leafKeyPem, cert: leafCertPem });
  upstream.on('stream', (s, h) => {
    s.respond({
      ':status': 200,
      'x-saw-auth': h.authorization || 'none',
      'x-saw-xkey': h['x-api-key'] || 'none',
      'x-saw-ct': h['content-type'] || 'none',
      'anthropic-ratelimit-unified-5h-utilization': '0.7',
    });
    s.end('upstream-ok');
  });
  const upPort = await listen(upstream);

  let quota = null;
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, (h) => { quota = h; });
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
  try {
    assert.equal(tlsSock.alpnProtocol, 'h2'); // mirrored from the (h2) upstream
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({
      ':method': 'POST', ':path': '/v1/design/mcp',
      authorization: 'Bearer FAKE', 'x-api-key': 'sk-fake', 'content-type': 'application/json',
    });
    let resp, body = '';
    req.on('response', (h) => { resp = h; });
    req.setEncoding('utf8'); req.on('data', (d) => { body += d; }); req.end('{}');
    await once(req, 'close');

    assert.equal(resp['x-saw-auth'], 'Bearer REAL-TOKEN'); // injected
    assert.equal(resp['x-saw-xkey'], 'none');              // dropped
    assert.equal(resp['x-saw-ct'], 'application/json');    // preserved
    assert.equal(body, 'upstream-ok');
    assert.ok(quota && quota['anthropic-ratelimit-unified-5h-utilization'] === '0.7');
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM h2 rewrites body account_uuid to the injected account', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http2.createSecureServer({ key: leafKeyPem, cert: leafCertPem });
  upstream.on('stream', (s) => {
    let body = '';
    s.on('data', (d) => { body += d; });
    s.on('end', () => {
      let seen = 'none';
      try { seen = JSON.parse(JSON.parse(body).metadata.user_id).account_uuid; } catch { /* ignore */ }
      s.respond({ ':status': 200, 'x-seen-uuid': seen });
      s.end('ok');
    });
  });
  const upPort = await listen(upstream);
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => {});
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer FAKE' });
    const reqBody = JSON.stringify({ metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '4c39e915-eb47-450d-9bf4-4cbbcd049a08' }) } });
    let resp;
    req.on('response', (h) => { resp = h; });
    req.resume(); req.end(reqBody);
    await once(req, 'close');
    assert.equal(resp['x-seen-uuid'], ACCOUNT_UUID); // body uuid rewritten to the injected account's
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

test('MITM logs proxied requests when --log-to is set', T, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-mitmlog-'));
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http2.createSecureServer({ key: leafKeyPem, cert: leafCertPem });
  upstream.on('stream', (s) => { s.respond({ ':status': 200 }); s.end('{"ok":true}'); });
  const upPort = await listen(upstream);
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => {}, dir);
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['h2', 'http/1.1']);
  try {
    const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages', authorization: 'Bearer SECRET-FAKE' });
    req.resume(); req.end('{"hi":1}');
    await once(req, 'close');
    await new Promise((r) => setTimeout(r, 150)); // let the async file write land
    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.ok(files.length >= 1, 'a log file was written');
    const content = readFileSync(join(dir, files[0]), 'utf8');
    assert.match(content, /\/v1\/messages/);     // request line
    assert.match(content, /RESPONSE 200/);        // response status
    assert.match(content, /REQUEST BODY/);        // request body section
    assert.ok(!content.includes('SECRET-FAKE'));  // client token never logged (replaced + masked)
    client.close();
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream); rmSync(dir, { recursive: true, force: true });
  }
});

test('MITM h1: when upstream is http/1.1, ALPN mirrors and the head auth is rewritten', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

  // http/1.1-only TLS upstream that echoes the authorization it received.
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem, ALPNProtocols: ['http/1.1'] }, (s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n')) {
        const auth = (buf.match(/authorization: (.*)\r\n/i) || [])[1] || 'none';
        const xkey = /x-api-key:/i.test(buf) ? 'present' : 'none';
        const body = JSON.stringify({ auth, xkey });
        s.end(`HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      }
    });
  });
  const upPort = await listen(upstream);
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => {});
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1']);
  try {
    assert.equal(tlsSock.alpnProtocol, 'http/1.1'); // mirrored
    tlsSock.write('GET /v1/messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer FAKE\r\nx-api-key: sk-fake\r\n\r\n');
    let buf = '';
    tlsSock.setEncoding('utf8');
    tlsSock.on('data', (d) => { buf += d; });
    await once(tlsSock, 'end');
    const body = JSON.parse(buf.slice(buf.indexOf('{')));
    assert.equal(body.auth, 'Bearer REAL-TOKEN'); // rewritten
    assert.equal(body.xkey, 'none');              // dropped
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});

// Regression (token leak / mangled logs seen in a real MITM capture): claude-cli
// reuses ONE keep-alive h1 connection for many requests. The relay must frame
// each request — rewrite EVERY request's auth (not just the first), log each
// exchange to its own masked record, and observe each response's quota — instead
// of treating everything after the first head as one giant body.
test('MITM h1 keep-alive: every request is reframed, rewritten, masked, and quota-observed', T, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-h1ka-'));
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

  // Raw http/1.1 upstream that stays keep-alive and echoes, per request, the auth
  // it saw + the request path, plus a rate-limit header for quota observation.
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem, ALPNProtocols: ['http/1.1'] }, (s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
        const head = buf.slice(0, idx);
        const clMatch = head.match(/content-length: (\d+)/i);
        const need = clMatch ? parseInt(clMatch[1], 10) : 0;
        if (buf.length < idx + 4 + need) break;          // wait for the full body
        buf = buf.slice(idx + 4 + need);
        const auth = (head.match(/authorization: (.*)/i) || [])[1]?.trim() || 'none';
        const path = head.split('\r\n')[0].split(' ')[1];
        const body = JSON.stringify({ auth, path });
        s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nanthropic-ratelimit-unified-5h-utilization: 0.5\r\nconnection: keep-alive\r\n\r\n${body}`);
      }
    });
  });
  const upPort = await listen(upstream);
  let quotaHits = 0;
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => { quotaHits++; }, dir);
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1']);
  const readJson = () => new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d;
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const need = parseInt((buf.match(/content-length: (\d+)/i) || [])[1], 10);
      if (buf.length < i + 4 + need) return;
      tlsSock.removeListener('data', onData);
      resolve(JSON.parse(buf.slice(i + 4, i + 4 + need)));
    };
    tlsSock.on('data', onData);
  });
  try {
    tlsSock.setEncoding('utf8');
    // First request: a small JSON body (mirrors the quota probe in the capture).
    const p1 = readJson();
    tlsSock.write('POST /v1/messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer FAKE-1\r\ncontent-type: application/json\r\ncontent-length: 9\r\n\r\n{"q":"x"}');
    const r1 = await p1;
    // Second request on the SAME connection — the one that used to leak + mangle.
    const p2 = readJson();
    tlsSock.write('POST /v1/messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer FAKE-2-LEAK\r\nx-api-key: sk-leak\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"hello":1}');
    const r2 = await p2;

    assert.equal(r1.auth, 'Bearer REAL-TOKEN', 'first request auth rewritten');
    assert.equal(r2.auth, 'Bearer REAL-TOKEN', 'second request auth ALSO rewritten (was the bug)');
    assert.equal(quotaHits, 2, 'quota observed on both h1 responses');

    await new Promise((r) => setTimeout(r, 150)); // let async log writes land
    const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
    assert.equal(files.length, 2, 'each request gets its OWN log file (was concatenated into one)');
    const all = files.map((f) => readFileSync(join(dir, f), 'utf8'));
    const blob = all.join('\n');
    assert.ok(!blob.includes('FAKE-1') && !blob.includes('FAKE-2-LEAK'), 'client tokens never logged unmasked');
    assert.ok(!blob.includes('sk-leak'), 'client x-api-key never logged');
    assert.ok(all.every((c) => /=== REQUEST \(h1/.test(c)), 'both files have a proper request head section');
    assert.ok(all.every((c) => /=== RESPONSE 200 \(h1\)/.test(c)), 'both files log the response head');
    assert.ok(all.every((c) => /"auth"/.test(c)), 'response JSON body is logged (pretty)');
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream); rmSync(dir, { recursive: true, force: true });
  }
});

// Regression (the run --mitm "ConnectionRefused"): an http/1.1-only client — what
// undici/claude offers when it tunnels through a proxy — against an upstream that
// ALSO speaks h2. We must adopt the CLIENT's protocol (http/1.1) and mirror it
// upstream, not force the upstream's preferred h2 onto the client (which would
// fail the TLS handshake with no_application_protocol).
test('MITM: http/1.1-only client against a dual h2+h1 upstream negotiates http/1.1', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');

  // Dual-protocol upstream: allowHTTP1 means it serves BOTH h2 (stream) and
  // http/1.1 (request). It prefers h2 when offered both.
  const upstream = http2.createSecureServer({ key: leafKeyPem, cert: leafCertPem, allowHTTP1: true });
  upstream.on('stream', (s, h) => { // h2 path (should NOT be taken here)
    s.respond({ ':status': 200, 'x-proto': 'h2', 'x-saw-auth': h.authorization || 'none' });
    s.end('h2');
  });
  upstream.on('request', (req, res) => { // http/1.1 path
    res.writeHead(200, { 'connection': 'close', 'x-proto': 'h1', 'x-saw-auth': req.headers.authorization || 'none', 'x-saw-xkey': req.headers['x-api-key'] || 'none' });
    res.end('h1-ok');
  });
  const upPort = await listen(upstream);
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => {});
  const proxyPort = await listen(proxy);

  // Client offers ONLY http/1.1 — like undici tunnelling through the proxy.
  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, ['http/1.1']);
  try {
    assert.equal(tlsSock.alpnProtocol, 'http/1.1'); // client's choice honored, not forced to h2
    tlsSock.write('GET /v1/messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer FAKE\r\nx-api-key: sk-fake\r\n\r\n');
    let buf = '';
    tlsSock.setEncoding('utf8');
    tlsSock.on('data', (d) => { buf += d; });
    await once(tlsSock, 'end');
    assert.match(buf, /x-proto: h1/i);              // served over http/1.1 end-to-end
    assert.match(buf, /x-saw-auth: Bearer REAL-TOKEN/i); // token injected
    assert.match(buf, /x-saw-xkey: none/i);         // x-api-key dropped
    assert.match(buf, /h1-ok/);
  } finally {
    tlsSock.destroy(); closeHard(proxy); closeHard(upstream);
  }
});
