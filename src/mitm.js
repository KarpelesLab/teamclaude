// MITM forward-proxy support: local cert lifecycle + terminating CONNECT proxy.
//
// When a claude instance is launched with HTTPS_PROXY pointed at teamclaude it
// sends `CONNECT api.anthropic.com:443`. Rather than byte-relaying the tunnel, we
// TERMINATE it with a real Node HTTP/2 server (allowHTTP1, so an h1 client works
// too) presenting our locally-minted leaf, then forward each request with a
// buffering, retrying client — the SAME path the base proxy uses
// (createProxyRequestListener). That gives per-request account selection, body
// account_uuid rewriting, and — critically — the ability to resend a request on a
// different account when one returns a quota 429, instead of surfacing it. A host
// routing table decides per-CONNECT behavior:
//   api.anthropic.com → terminate + forward,  www.example.org → local test server,
//   anything else      → blind tunnel.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import { getConfigPath } from './config.js';
import { generateCertChain } from './x509.js';
import { createProxyRequestListener } from './server.js';

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

function upstreamHostOf(config) {
  try { return new URL(config?.upstream || 'https://api.anthropic.com').hostname; }
  catch { return 'api.anthropic.com'; }
}

/** Per-CONNECT behavior: 'rewrite' (intercept + token inject), 'test', or 'tunnel'. */
export function hostMode(host, config) {
  if (host === TEST_HOST) return 'test';
  if (host === upstreamHostOf(config)) return 'rewrite';
  return 'tunnel';
}

/**
 * Build a `connect` event handler implementing the terminating MITM described at
 * the top of this file.
 * @param ensureLeaf async () => { key, cert }   // current leaf PEMs
 */
export function createConnectHandler({ config, accountManager, ensureLeaf, logDir = null, hooks = {}, log = () => {}, sx = null }) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const forward = createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx });

  // One terminating h2/h1 server, minted lazily on the first intercepted CONNECT.
  // TLS uses our leaf; ALPN negotiates h2 or http/1.1 (allowHTTP1) with whatever
  // the client offers. It emits 'request' for BOTH protocols, so `forward` — the
  // shared buffering/retrying proxy listener — handles them identically. Each
  // CONNECT feeds it the raw tunnel socket; the client keeps the tunnel open and
  // multiplexes many requests over it, each independently account-selected.
  let serverPromise = null;
  const getServer = () => (serverPromise ||= (async () => {
    const { key, cert } = await ensureLeaf();
    const srv = http2.createSecureServer({ key, cert, allowHTTP1: true });
    srv.on('request', forward);
    srv.on('sessionError', (e) => log(`[TeamClaude] MITM session error: ${e.message}`));
    srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch { /* already gone */ } });
    return srv;
  })());

  return (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;
    const mode = hostMode(host, config);

    if (mode === 'tunnel') {
      const up = net.connect(port, host, () => {
        reply200Raw(clientSocket);
        if (head && head.length) up.write(head);
        up.pipe(clientSocket); clientSocket.pipe(up);
      });
      up.on('error', () => clientSocket.destroy());
      return;
    }

    if (mode === 'test') {
      // The built-in test host is answered locally, never forwarded upstream.
      ensureLeaf().then(({ key, cert }) => {
        reply200Raw(clientSocket);
        serveTest(termClaude(clientSocket, head, key, cert, ['http/1.1']));
      }).catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); clientSocket.destroy(); });
      return;
    }

    // rewrite: terminate the tunnel and forward each request with buffering +
    // retry. Reply 200, hand the raw socket (ClientHello and all) to the h2/h1
    // server, which does TLS + protocol negotiation itself.
    getServer().then((srv) => {
      reply200Raw(clientSocket);
      if (head && head.length) clientSocket.unshift(head);
      srv.emit('connection', clientSocket);
    }).catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); clientSocket.destroy(); });
  };
}

function reply200Raw(sock) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }

function termClaude(clientSocket, head, key, cert, alpn) {
  if (head && head.length) clientSocket.unshift(head);
  const t = new tls.TLSSocket(clientSocket, { isServer: true, key, cert, ALPNProtocols: alpn });
  t.on('error', () => t.destroy());
  return t;
}

// Parse the ALPN protocol list out of a TLS ClientHello.
//   returns string[]  — ALPN extension present
//   returns null       — parsed far enough to know there is no usable ALPN
//   returns undefined  — need more bytes to decide
export function parseClientHelloAlpn(buf) {
  if (buf.length < 5) return undefined;
  if (buf[0] !== 0x16) return null;                 // not a handshake record
  const recEnd = 5 + buf.readUInt16BE(3);
  if (buf.length < recEnd) return undefined;        // wait for the full record
  let p = 5;
  if (buf[p] !== 0x01) return null;                 // not a ClientHello
  const hsEnd = p + 4 + ((buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]);
  const end = Math.min(hsEnd, recEnd);
  p += 4;
  p += 2 + 32;                                      // client_version + random
  if (p >= end) return null;
  p += 1 + buf[p];                                  // session_id
  if (p + 2 > end) return null;
  p += 2 + buf.readUInt16BE(p);                     // cipher_suites
  if (p + 1 > end) return null;
  p += 1 + buf[p];                                  // compression_methods
  if (p + 2 > end) return null;
  let extEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;
  extEnd = Math.min(extEnd, end);
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    if (type === 0x0010) {                          // application_layer_protocol_negotiation
      let q = p + 2;                                // skip ALPN list length
      const listEnd = Math.min(p + len, extEnd);
      const protos = [];
      while (q < listEnd) {
        const l = buf[q]; q += 1;
        if (q + l > listEnd) break;
        protos.push(buf.toString('latin1', q, q + l));
        q += l;
      }
      return protos.length ? protos : null;
    }
    p += len;
  }
  return null;                                      // no ALPN extension
}

// Answer the built-in test host locally over h1 with a canned JSON response.
function serveTest(tlsSock) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) { if (buf.length > 65536) tlsSock.destroy(); return; }
    tlsSock.removeListener('data', onData);
    const reqLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
    const path = reqLine.split(' ')[1] || '/';
    const body = JSON.stringify({ teamclaude: 'mitm-proxy-ok', host: TEST_HOST, path });
    tlsSock.end(
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  };
  tlsSock.on('data', onData);
  tlsSock.on('error', () => tlsSock.destroy());
}
