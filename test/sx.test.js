import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { connectThroughProxy, tunnelTls, SxManager } from '../src/sx.js';
import { upstreamFetch } from '../src/upstream-fetch.js';

const T = { timeout: 30000 };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
function closeHard(s) { if (!s) return; s.closeAllConnections?.(); try { s.close(); } catch { /* closing */ } }

// A minimal HTTP CONNECT proxy: requires Basic auth, then blind-tunnels to the
// requested host:port. Records whether auth was seen and the CONNECT target.
function makeConnectProxy({ requireAuth = 'user:pass' } = {}) {
  const seen = { auth: null, target: null, plaintextBytesAfterConnect: 0 };
  const srv = net.createServer((client) => {
    client.once('data', (buf) => {
      const head = buf.toString('latin1');
      const line = head.split('\r\n')[0];
      const m = line.match(/^CONNECT (\S+) HTTP\/1\.1/);
      if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      seen.target = m[1];
      const authLine = head.split('\r\n').find((l) => l.toLowerCase().startsWith('proxy-authorization:'));
      seen.auth = authLine ? Buffer.from(authLine.split(/\s+/)[2], 'base64').toString() : null;
      if (requireAuth && seen.auth !== requireAuth) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const [host, port] = m[1].split(':');
      const up = net.connect(parseInt(port, 10), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Everything after this point is TLS ciphertext (proxy can't read it).
        client.on('data', (d) => { seen.plaintextBytesAfterConnect += isPrintableTls(d) ? 0 : 0; });
        up.pipe(client); client.pipe(up);
      });
      up.on('error', () => client.destroy());
    });
    client.on('error', () => {});
  });
  return { srv, seen };
}
function isPrintableTls() { return false; }

test('connectThroughProxy + tunnelTls establish END-TO-END TLS through the proxy', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  // TLS upstream that echoes a JSON body over HTTP/1.1.
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => {
    s.on('data', () => {
      const body = JSON.stringify({ ok: true, sni: s.servername || null });
      s.end(`HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  const upPort = await listen(upstream);
  const { srv: proxy, seen } = makeConnectProxy();
  const proxyPort = await listen(proxy);

  try {
    const tlsSock = await tunnelTls({
      proxy: { host: '127.0.0.1', port: proxyPort, username: 'user', password: 'pass' },
      targetHost: 'localhost', targetPort: upPort,
      tlsOptions: { ca: caCertPem },
    });
    tlsSock.write('GET / HTTP/1.1\r\nhost: localhost\r\n\r\n');
    let buf = '';
    tlsSock.setEncoding('utf8');
    tlsSock.on('data', (d) => { buf += d; });
    await once(tlsSock, 'end');

    assert.equal(seen.target, `localhost:${upPort}`, 'proxy saw the CONNECT target');
    assert.equal(seen.auth, 'user:pass', 'proxy received Basic auth');
    const body = JSON.parse(buf.slice(buf.indexOf('{')));
    assert.equal(body.ok, true, 'TLS terminated at the upstream (decrypted its response)');
    assert.equal(body.sni, 'localhost', 'upstream saw correct SNI through the tunnel');
  } finally {
    closeHard(proxy); closeHard(upstream);
  }
});

test('connectThroughProxy rejects on a non-200 CONNECT (bad auth)', T, async () => {
  const { srv: proxy } = makeConnectProxy({ requireAuth: 'user:pass' });
  const proxyPort = await listen(proxy);
  try {
    await assert.rejects(
      connectThroughProxy({ proxyHost: '127.0.0.1', proxyPort, auth: 'user:WRONG', targetHost: 'localhost', targetPort: 9, timeout: 5000 }),
      /refused CONNECT/,
    );
  } finally { closeHard(proxy); }
});

test('upstreamFetch routes through the proxy and exposes the fetch-Response surface', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  // Upstream replies JSON for /json and an SSE stream for /sse.
  const upstream = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => {
    s.once('data', (d) => {
      const path = d.toString('latin1').split(' ')[1] || '/';
      if (path === '/sse') {
        s.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n');
        s.write('data: one\n\n');
        s.write('data: two\n\n');
        s.end();
      } else {
        const body = JSON.stringify({ hello: 'world' });
        s.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-test: yes\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      }
    });
  });
  const upPort = await listen(upstream);
  const { srv: proxy, seen } = makeConnectProxy({ requireAuth: null });
  const proxyPort = await listen(proxy);

  // sx stub: provisioned, with a test CA so the self-signed upstream verifies.
  const sx = {
    isProvisioned: () => true,
    getProxy: () => ({ host: '127.0.0.1', port: proxyPort, username: null, password: null }),
    tlsOptions: { ca: caCertPem },
  };

  try {
    // Non-streaming: status, headers.get/.entries, text/arrayBuffer.
    const res = await upstreamFetch(`https://localhost:${upPort}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, sx, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-test'), 'yes');
    assert.equal(res.headers.get('X-Test'), 'yes', 'header lookup is case-insensitive');
    const keys = [...res.headers.entries()].map(([k]) => k);
    assert.ok(keys.includes('content-type'));
    const txt = await res.text();
    assert.deepEqual(JSON.parse(txt), { hello: 'world' });
    assert.equal(seen.target, `localhost:${upPort}`);

    // Streaming: body is a web ReadableStream with a working reader.
    const sse = await upstreamFetch(`https://localhost:${upPort}/sse`, {}, sx, true);
    assert.equal(sse.headers.get('content-type'), 'text/event-stream');
    const reader = sse.body.getReader();
    let streamed = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; streamed += Buffer.from(value).toString('utf8'); }
    assert.match(streamed, /data: one/);
    assert.match(streamed, /data: two/);
  } finally {
    closeHard(proxy); closeHard(upstream);
  }
});

test('upstreamFetch is plain global fetch when useProxy is false', T, async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"direct":true}'); });
  const port = await listen(server);
  try {
    // no sx
    const res = await upstreamFetch(`http://127.0.0.1:${port}/`, {}, null, true);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(await res.text()), { direct: true });
    // provisioned but useProxy=false → still direct (would otherwise fail: no real proxy)
    const sx = { isProvisioned: () => true, getProxy: () => ({ host: '127.0.0.1', port: 1 }) };
    const res2 = await upstreamFetch(`http://127.0.0.1:${port}/`, {}, sx, false);
    assert.equal(res2.status, 200);
  } finally { closeHard(server); }
});

test('SxManager routing decisions follow the mode', T, () => {
  const sx = new SxManager();
  sx.apiKey = 'k'; sx.proxy = { host: 'h', port: 1 }; // simulate provisioned

  sx.mode = 'always';
  assert.deepEqual([sx.useByDefault(), sx.useOn429(), sx.useForConnect()], [true, true, true]);

  sx.mode = '429';
  assert.equal(sx.useByDefault(), false, 'first attempt is direct in 429 mode');
  assert.equal(sx.useOn429(), true, 'retry routes via sx after a 429');
  assert.equal(sx.useForConnect(), false, 'MITM stays direct until a 429 is seen');
  sx.noteRateLimited(10);
  assert.equal(sx.useForConnect(), true, 'MITM routes via sx inside the sticky window');

  sx.mode = 'off';
  assert.deepEqual([sx.useByDefault(), sx.useOn429(), sx.useForConnect()], [false, false, false]);

  sx.mode = 'always'; sx.proxy = null; // unprovisioned: nothing routes
  assert.deepEqual([sx.useByDefault(), sx.useOn429(), sx.useForConnect()], [false, false, false]);
});

test('SxManager mode off keeps the key and skips provisioning; turning on provisions', T, async () => {
  const api = makeSxApi((path) => {
    if (path === '/v2/proxy/ports') return { success: true, message: { proxies: [{ id: 7, status: 1, proxy: '9.9.9.9:1080', login: 'u', password: 'p' }] } };
    return { success: false };
  });
  const port = await listen(api);
  process.env.SX_API_BASE = `http://127.0.0.1:${port}`;
  try {
    const sx = new SxManager();
    const r = await sx.configure('KEY', 'off');
    assert.equal(r.ok, true);
    assert.equal(sx.getMode(), 'off');
    assert.equal(sx.apiKey, 'KEY', 'key retained');
    assert.equal(sx.isProvisioned(), false, 'not provisioned while off');

    const r2 = await sx.setMode('always');
    assert.equal(r2.ok, true);
    assert.equal(sx.isProvisioned(), true, 'provisioned when turned on');
    assert.deepEqual(sx.getProxy(), { host: '9.9.9.9', port: 1080, username: 'u', password: 'p', portId: 7 });
  } finally { delete process.env.SX_API_BASE; closeHard(api); }
});

// Mock the sx.org REST API so provision() can be exercised without network/spend.
function makeSxApi(handler) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = handler(req.url.split('?')[0], req.method, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return srv;
}

test('SxManager.provision reuses an existing active port', T, async () => {
  const api = makeSxApi((path) => {
    if (path === '/v2/proxy/ports') {
      return { success: true, message: { proxies: [
        { id: 1, status: 2, proxy: 'dead:1', login: 'x', password: 'y' }, // inactive
        { id: 2, status: 1, proxy: '1.2.3.4:9999', login: 'alice', password: 'secret' },
      ] } };
    }
    return { success: false };
  });
  const port = await listen(api);
  process.env.SX_API_BASE = `http://127.0.0.1:${port}`;
  try {
    const sx = new SxManager();
    const r = await sx.configure('KEY');
    assert.equal(r.ok, true);
    assert.deepEqual(sx.getProxy(), { host: '1.2.3.4', port: 9999, username: 'alice', password: 'secret', portId: 2 });
    assert.equal(sx.isProvisioned(), true);
  } finally { delete process.env.SX_API_BASE; closeHard(api); }
});

test('SxManager.provision creates a port when none exist', T, async () => {
  let created = false;
  const api = makeSxApi((path, method, body) => {
    if (path === '/v2/proxy/ports') return { success: true, message: { proxies: [] } };
    if (path === '/v2/proxy/create-port' && method === 'POST') {
      const b = JSON.parse(body);
      assert.equal(b.country_code, 'US'); assert.equal(b.type_id, 1); assert.equal(b.proxy_type_id, 1);
      created = true;
      return { success: true, data: { id: 42, server: '5.6.7.8', port: 8080, login: 'bob', password: 'pw' } };
    }
    return { success: false };
  });
  const port = await listen(api);
  process.env.SX_API_BASE = `http://127.0.0.1:${port}`;
  try {
    const sx = new SxManager();
    const r = await sx.configure('KEY');
    assert.equal(created, true, 'create-port was called');
    assert.equal(r.ok, true);
    assert.deepEqual(sx.getProxy(), { host: '5.6.7.8', port: 8080, username: 'bob', password: 'pw', portId: 42 });
  } finally { delete process.env.SX_API_BASE; closeHard(api); }
});

test('SxManager.configure reports an error when provisioning fails', T, async () => {
  const api = makeSxApi((path) => {
    if (path === '/v2/proxy/ports') return { success: true, message: { proxies: [] } };
    return { success: false, errors: { country_code: ['required'] } };
  });
  const port = await listen(api);
  process.env.SX_API_BASE = `http://127.0.0.1:${port}`;
  try {
    const sx = new SxManager();
    const r = await sx.configure('KEY');
    assert.equal(r.ok, false);
    assert.match(r.error, /create-port failed/);
    assert.equal(sx.isProvisioned(), false, 'not enabled when provisioning fails');
  } finally { delete process.env.SX_API_BASE; closeHard(api); }
});
