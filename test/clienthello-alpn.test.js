import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { parseClientHelloAlpn } from '../src/mitm.js';

// Capture the real ClientHello bytes a node TLS client sends for a given ALPN
// offer, by pointing it at a plain TCP server that just records the first bytes.
function captureClientHello(alpn) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.once('data', (d) => { resolve(d); sock.destroy(); srv.close(); });
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: srv.address().port, ALPNProtocols: alpn, rejectUnauthorized: false });
      c.on('error', () => {}); // handshake won't complete; we only want the ClientHello
    });
  });
}

test('parses the ALPN list from a real ClientHello (h2 + http/1.1)', async () => {
  const hello = await captureClientHello(['h2', 'http/1.1']);
  assert.deepEqual(parseClientHelloAlpn(hello), ['h2', 'http/1.1']);
});

test('parses the ALPN list from a real ClientHello (http/1.1 only)', async () => {
  const hello = await captureClientHello(['http/1.1']);
  assert.deepEqual(parseClientHelloAlpn(hello), ['http/1.1']);
});

test('returns undefined for a partial record (need more bytes)', async () => {
  const hello = await captureClientHello(['h2', 'http/1.1']);
  assert.equal(parseClientHelloAlpn(hello.subarray(0, 4)), undefined); // shorter than a record header
  assert.equal(parseClientHelloAlpn(hello.subarray(0, hello.length - 10)), undefined); // truncated record
});

test('returns null when there is no ALPN extension', async () => {
  const hello = await captureClientHello(undefined); // no ALPN offered
  assert.equal(parseClientHelloAlpn(hello), null);
});

test('returns null for non-handshake bytes', () => {
  assert.equal(parseClientHelloAlpn(Buffer.from('GET / HTTP/1.1\r\n\r\n')), null);
});
