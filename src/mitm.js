// MITM forward-proxy support: local cert lifecycle + CONNECT handling.
//
// When a claude instance is launched with HTTPS_PROXY pointed at teamclaude, it
// sends `CONNECT api.anthropic.com:443`. We terminate TLS with a locally-minted
// leaf cert (trusted by that process via NODE_EXTRA_CA_CERTS), hand the
// decrypted stream to the normal request handler (which injects the real token),
// and forward to the real upstream. Any other CONNECT target is blind-tunneled.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { getConfigPath } from './config.js';
import { generateCertChain } from './x509.js';

const CA_CERT = 'teamclaude-ca.pem';
const LEAF_CERT = 'teamclaude-leaf.pem';
const LEAF_KEY = 'teamclaude-leaf.key';

// A built-in host the MITM proxy always intercepts and answers itself (never
// forwarded upstream). Lets you verify the proxy + CA end-to-end with no
// credentials, e.g.:
//   curl --proxy http://localhost:3456 --cacert <ca.pem> https://www.example.org/
export const TEST_HOST = 'www.example.org';

const certDir = () => dirname(getConfigPath());
const fpath = (n) => join(certDir(), n);

/** Path to the CA cert clients should trust via NODE_EXTRA_CA_CERTS. */
export function caCertPath() {
  return fpath(CA_CERT);
}

async function readIf(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

async function atomicWrite(path, data, mode) {
  const tmp = `${path}.tmp${process.pid}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

// Is the stored leaf signed by the stored CA and valid for every host in `hosts`?
function leafCovers(caCertPem, leafCertPem, hosts) {
  try {
    const ca = new X509Certificate(caCertPem);
    const leaf = new X509Certificate(leafCertPem);
    if (!leaf.verify(ca.publicKey)) return false;
    const names = (leaf.subjectAltName || '').split(',').map((s) => s.trim());
    return hosts.every((h) => names.includes(`DNS:${h}`));
  } catch {
    return false;
  }
}

/**
 * Ensure a CA cert + a leaf for `host` exist in the config dir, generating them
 * if missing/mismatched. The CA *private* key is never persisted — we regenerate
 * the whole chain when needed, so the only on-disk secret is the leaf key (0600),
 * which only authenticates as `host` to a process that already trusts our CA.
 * Returns { caPath, caCertPem, leafCertPem, leafKeyPem }.
 */
export async function ensureCerts(host) {
  const hosts = host === TEST_HOST ? [TEST_HOST] : [host, TEST_HOST];
  const [caCertPem, leafCertPem, leafKeyPem] = await Promise.all([
    readIf(fpath(CA_CERT)), readIf(fpath(LEAF_CERT)), readIf(fpath(LEAF_KEY)),
  ]);

  if (caCertPem && leafCertPem && leafKeyPem && leafCovers(caCertPem, leafCertPem, hosts)) {
    return { caPath: fpath(CA_CERT), caCertPem, leafCertPem, leafKeyPem };
  }

  const chain = generateCertChain(hosts); // caKeyPem intentionally discarded
  await mkdir(certDir(), { recursive: true });
  await atomicWrite(fpath(CA_CERT), chain.caCertPem, 0o644);
  await atomicWrite(fpath(LEAF_CERT), chain.leafCertPem, 0o644);
  await atomicWrite(fpath(LEAF_KEY), chain.leafKeyPem, 0o600);
  return {
    caPath: fpath(CA_CERT),
    caCertPem: chain.caCertPem,
    leafCertPem: chain.leafCertPem,
    leafKeyPem: chain.leafKeyPem,
  };
}

/**
 * Build a `connect` event handler. CONNECT to `mitmHost` is TLS-terminated and
 * fed to `mitmServer` (an http.Server using the normal request handler); any
 * other target is blind-tunneled.
 */
export function createConnectHandler({ interceptHosts, ensureLeaf, mitmServer, log = () => {} }) {
  const intercepted = new Set(interceptHosts);
  return async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    if (intercepted.has(host)) {
      try {
        const { key, cert } = await ensureLeaf();
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) clientSocket.unshift(head);
        const tlsSocket = new tls.TLSSocket(clientSocket, {
          isServer: true, key, cert, ALPNProtocols: ['http/1.1'],
        });
        tlsSocket.__tcLocal = true; // mark as trusted local MITM stream for the auth gate
        tlsSocket.on('error', () => tlsSocket.destroy());
        mitmServer.emit('connection', tlsSocket);
      } catch (err) {
        log(`[TeamClaude] MITM setup failed for ${host}: ${err.message}`);
        clientSocket.destroy();
      }
      return;
    }

    // Transparent passthrough for everything that isn't the intercepted host.
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  };
}
