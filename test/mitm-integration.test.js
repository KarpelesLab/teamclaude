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
    config: { upstream: `https://localhost:${upPort}` },
    accountManager,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    upstreamTlsOptions: { ca: [caCertPem] },
    logDir,
    log: () => {},
  }));
  return proxy;
}

test('MITM h2: ALPN mirrored, only authorization rewritten, quota observed', async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `localhost:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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
    proxy.close(); upstream.close();
  }
});

test('MITM h2 rewrites body account_uuid to the injected account', async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `localhost:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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
    proxy.close(); upstream.close();
  }
});

test('MITM logs proxied requests when --log-to is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-mitmlog-'));
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http2.createSecureServer({ key: leafKeyPem, cert: leafCertPem });
  upstream.on('stream', (s) => { s.respond({ ':status': 200 }); s.end('{"ok":true}'); });
  const upPort = await listen(upstream);
  const proxy = makeProxy(upPort, caCertPem, leafCertPem, leafKeyPem, () => {}, dir);
  const proxyPort = await listen(proxy);

  const tlsSock = await connectThroughProxy(proxyPort, `localhost:${upPort}`, caCertPem, ['h2', 'http/1.1']);
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
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('MITM h1: when upstream is http/1.1, ALPN mirrors and the head auth is rewritten', async () => {
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

  const tlsSock = await connectThroughProxy(proxyPort, `localhost:${upPort}`, caCertPem, ['http/1.1']);
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
    proxy.close(); upstream.close();
  }
});
