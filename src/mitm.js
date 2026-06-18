// MITM forward-proxy support: local cert lifecycle + transparent CONNECT relay.
//
// When a claude instance is launched with HTTPS_PROXY pointed at teamclaude it
// sends `CONNECT api.anthropic.com:443`. We act as a transparent MITM: dial the
// real upstream first (mirroring SNI + adopting its negotiated ALPN), present
// claude our locally-minted leaf advertising that same protocol, then relay the
// decrypted stream — rewriting ONLY the auth header (h2 via our HPACK codec, h1
// via a plaintext head edit) and reading quota from responses. Everything else
// is copied as-is. A host routing table decides per-CONNECT behavior:
//   api.anthropic.com → rewrite,  www.example.org → local test server,
//   anything else      → blind tunnel.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { getConfigPath } from './config.js';
import { generateCertChain } from './x509.js';
import { h2Relay, h1Relay, rewriteH1Auth } from './h2/relay.js';
import { AccountUuidPatcher } from './account-uuid-rewrite.js';
import { makeMitmTap } from './request-log.js';

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
 * Build a `connect` event handler implementing the transparent MITM described
 * at the top of this file.
 * @param ensureLeaf async () => { key, cert }   // current leaf PEMs
 */
export function createConnectHandler({ config, accountManager, ensureLeaf, upstreamTlsOptions = {}, logDir = null, log = () => {} }) {
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

    intercept({ host, port, mode, clientSocket, head, accountManager, ensureLeaf, upstreamTlsOptions, logDir, log })
      .catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); clientSocket.destroy(); });
  };
}

async function intercept({ host, port, mode, clientSocket, head, accountManager, ensureLeaf, upstreamTlsOptions, logDir, log }) {
  const { key, cert } = await ensureLeaf();

  if (mode === 'test') {
    reply200Raw(clientSocket);
    const tlsSock = termClaude(clientSocket, head, key, cert, ['http/1.1']);
    serveTest(tlsSock);
    return;
  }

  // rewrite: dial upstream first, mirror its ALPN, then terminate claude.
  const account = accountManager.getActiveAccount();
  if (!account) { clientSocket.destroy(); return; }
  await accountManager.ensureTokenFresh(account.index);

  const upstreamSock = tls.connect({ host, port, servername: host, ALPNProtocols: ['h2', 'http/1.1'], ...upstreamTlsOptions });
  await new Promise((resolve, reject) => {
    upstreamSock.once('secureConnect', resolve);
    upstreamSock.once('error', reject);
  });
  const alpn = upstreamSock.alpnProtocol || 'http/1.1';

  reply200Raw(clientSocket);
  const claudeTls = termClaude(clientSocket, head, key, cert, [alpn]);
  upstreamSock.on('error', () => claudeTls.destroy());

  await new Promise((resolve) => claudeTls.once('secure', resolve));

  // Per-stream streaming body patcher: align metadata.user_id.account_uuid with
  // the injected account (same length; no-op if the account has no UUID).
  const makeBodyPatcher = account.accountUuid
    ? () => new AccountUuidPatcher(account.accountUuid)
    : null;
  const tap = makeMitmTap(logDir, account.name);

  if (alpn === 'h2') {
    h2Relay(claudeTls, upstreamSock, {
      rewriteRequest: makeRewriteRequest(account),
      makeBodyPatcher,
      onResponseHeaders: makeQuotaObserver(accountManager, account),
      tap,
      log,
    });
  } else {
    const auth = account.type === 'oauth'
      ? { authorization: `Bearer ${account.credential}` }
      : { apiKey: account.credential };
    h1Relay(claudeTls, upstreamSock, { rewriteHead: (h) => rewriteH1Auth(h, auth), makeBodyPatcher, tap });
  }
}

function reply200Raw(sock) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }

function termClaude(clientSocket, head, key, cert, alpn) {
  if (head && head.length) clientSocket.unshift(head);
  const t = new tls.TLSSocket(clientSocket, { isServer: true, key, cert, ALPNProtocols: alpn });
  t.on('error', () => t.destroy());
  return t;
}

// Rewrite only the auth field on an h2 request header list (account token in,
// client's x-api-key out). Preserves order; marks auth never-indexed.
function makeRewriteRequest(account) {
  const isOAuth = account.type === 'oauth';
  return (fields) => {
    let replaced = false;
    const out = [];
    for (const f of fields) {
      const n = f.name.toString().toLowerCase();
      if (n === 'x-api-key') continue;
      if (n === 'authorization') {
        if (isOAuth) { out.push({ name: f.name, value: Buffer.from(`Bearer ${account.credential}`), sensitive: true }); replaced = true; }
        continue;
      }
      out.push(f);
    }
    if (!replaced) {
      out.push(isOAuth
        ? { name: Buffer.from('authorization'), value: Buffer.from(`Bearer ${account.credential}`), sensitive: true }
        : { name: Buffer.from('x-api-key'), value: Buffer.from(account.credential), sensitive: true });
    }
    return out;
  };
}

function makeQuotaObserver(accountManager, account) {
  return (fields) => {
    const m = {};
    for (const f of fields) m[f.name.toString().toLowerCase()] = f.value.toString();
    if (!m[':status']) return;
    const rl = {};
    for (const k in m) if (k.startsWith('anthropic-ratelimit-')) rl[k] = m[k];
    if (Object.keys(rl).length) accountManager.updateQuota(account.index, rl);
    if (m[':status'] === '429') {
      let ra = parseInt(m['retry-after'], 10);
      if (Number.isNaN(ra)) ra = 60;
      accountManager.markRateLimited(account.index, Math.min(Math.max(ra, 1), 300));
    }
  };
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
