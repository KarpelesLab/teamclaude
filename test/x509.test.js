import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';
import { once } from 'node:events';
import { generateCertChain, createCA, createLeaf } from '../src/x509.js';

test('generated CA and leaf parse and form a valid chain', () => {
  const { caCertPem, leafCertPem } = generateCertChain('api.anthropic.com');
  const ca = new X509Certificate(caCertPem);
  const leaf = new X509Certificate(leafCertPem);

  assert.match(ca.subject, /TeamClaude Local CA/);
  assert.equal(ca.ca, true);
  assert.equal(leaf.subject, 'CN=api.anthropic.com');
  assert.equal(leaf.issuer, ca.subject);
  assert.equal(leaf.subjectAltName, 'DNS:api.anthropic.com');
  assert.equal(leaf.verify(ca.publicKey), true);   // leaf signed by CA
  assert.equal(leaf.ca, false);
});

test('a TLS server using the leaf is trusted by a client that trusts the CA', async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('api.anthropic.com');
  const server = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const sock = tls.connect({ host: '127.0.0.1', port, servername: 'api.anthropic.com', ca: [caCertPem] });
    await once(sock, 'secureConnect');
    assert.equal(sock.authorized, true);
    sock.destroy();
  } finally {
    server.close();
  }
});

test('handshake fails when the client does NOT trust our CA', async () => {
  const { leafCertPem, leafKeyPem } = generateCertChain('api.anthropic.com');
  const server = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    // No `ca` override and not in the system store → must be rejected.
    const sock = tls.connect({ host: '127.0.0.1', port, servername: 'api.anthropic.com' });
    const [err] = await once(sock, 'error');
    assert.ok(err); // self-signed / unknown issuer
    sock.destroy();
  } finally {
    server.close();
  }
  void net; // (net imported for symmetry with other tests)
});

test('createCA + createLeaf compose for an arbitrary host', () => {
  const ca = createCA('My CA');
  const leaf = createLeaf('example.test', ca);
  const leafCert = new X509Certificate(leaf.certPem);
  assert.equal(leafCert.subjectAltName, 'DNS:example.test');
  assert.equal(leafCert.verify(new X509Certificate(ca.certPem).publicKey), true);
});
