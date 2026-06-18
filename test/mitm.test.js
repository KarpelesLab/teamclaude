import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

// Point cert storage at a temp dir before importing modules that read the path.
const TMP = mkdtempSync(join(tmpdir(), 'tc-mitm-'));
process.env.TEAMCLAUDE_CONFIG = join(TMP, 'config.json');

const { ensureCerts, caCertPath, TEST_HOST } = await import('../src/mitm.js');
const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

// CONNECT through the proxy, then TLS over the tunnel; resolve the decrypted socket.
function connectTls(proxyPort, target, caCertPem, servername) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        raw.removeListener('data', onData);
        const sock = tls.connect({ socket: raw, servername, ca: [caCertPem] }, () => resolve(sock));
        sock.once('error', reject);
      }
    };
    raw.on('data', onData);
  });
}

function httpOver(sock, hostHeader, path = '/') {
  return new Promise((resolve) => {
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('close', () => resolve(buf));
  });
}

test('ensureCerts generates a CA + leaf covering the host and the test host, idempotently', async () => {
  const a = await ensureCerts('api.anthropic.com');
  assert.equal(a.caPath, caCertPath());
  const leaf = new X509Certificate(a.leafCertPem);
  const names = (leaf.subjectAltName || '').split(',').map((s) => s.trim());
  assert.ok(names.includes('DNS:api.anthropic.com'));
  assert.ok(names.includes(`DNS:${TEST_HOST}`));

  // Second call returns the same cert (no regeneration).
  const b = await ensureCerts('api.anthropic.com');
  assert.equal(a.leafCertPem, b.leafCertPem);
});

test('CONNECT to the test host is intercepted and answered locally (proxy + CA proof)', async () => {
  const { caCertPem } = await ensureCerts('api.anthropic.com');
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    const sock = await connectTls(port, `${TEST_HOST}:443`, caCertPem, TEST_HOST);
    assert.equal(sock.authorized, true); // our leaf trusted via the CA
    const resp = await httpOver(sock, TEST_HOST, '/hello');
    assert.match(resp, /200/);
    assert.match(resp, /"teamclaude":"mitm-proxy-ok"/);
    assert.match(resp, /"path":"\/hello"/);
  } finally {
    proxy.close();
  }
});

test('CONNECT to a non-intercepted host is blind-tunneled', async () => {
  // Echo server stands in for "some other host".
  const echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {});
  const port = await listen(proxy);
  try {
    const raw = net.connect(port, '127.0.0.1');
    await once(raw, 'connect');
    raw.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    // Wait for the 200, then send a payload and expect it echoed back.
    let established = false;
    const got = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      raw.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!established && buf.includes('\r\n\r\n')) {
          established = true;
          buf = Buffer.alloc(0);
          raw.write('PING');
        } else if (established && buf.toString().includes('PING')) {
          resolve(buf.toString());
        }
      });
    });
    assert.match(got, /PING/);
    raw.destroy();
  } finally {
    proxy.close();
    echo.close();
  }
});
