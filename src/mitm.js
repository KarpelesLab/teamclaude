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
import { makeMitmTap, makeActivityTap, combineTaps } from './request-log.js';
import { tunnelTls } from './sx.js';

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
export function createConnectHandler({ config, accountManager, ensureLeaf, upstreamTlsOptions = {}, logDir = null, hooks = {}, log = () => {}, sx = null }) {
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

    intercept({ host, port, mode, clientSocket, head, accountManager, ensureLeaf, upstreamTlsOptions, logDir, hooks, log, sx })
      .catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); clientSocket.destroy(); });
  };
}

async function intercept({ host, port, mode, clientSocket, head, accountManager, ensureLeaf, upstreamTlsOptions, logDir, hooks = {}, log, sx }) {
  const { key, cert } = await ensureLeaf();

  if (mode === 'test') {
    reply200Raw(clientSocket);
    const tlsSock = termClaude(clientSocket, head, key, cert, ['http/1.1']);
    serveTest(tlsSock);
    return;
  }

  // rewrite: be a faithful ALPN mirror. We don't terminate TLS at the byte
  // level (that's node:tls), so to avoid imposing our own protocol preference we
  // peek the client's ClientHello, read the exact ALPN list it offers, present
  // THAT list to the upstream, let the upstream pick, then terminate the client
  // with whatever the upstream selected. The upstream decides — constrained to
  // what the client can speak — so an http/1.1-only client (undici/claude) and
  // an h2 client both negotiate end-to-end exactly as they would directly.
  // We do NOT pin one account to the tunnel. The client holds this CONNECT
  // tunnel open (keep-alive) and sends many requests over it, and the upstream
  // TLS socket is account-agnostic — an account is only the injected auth header
  // plus the body account_uuid. So we choose the account PER REQUEST (below) and
  // can roll onto a fresh one the instant the current account hits a limit, with
  // no tunnel teardown and no restart. Here we only need SOME account to exist
  // and warm its token for the likely-first request.
  const initial = accountManager.getActiveAccount();
  if (!initial) { clientSocket.destroy(); return; }
  await accountManager.ensureTokenFresh(initial.index);

  reply200Raw(clientSocket);
  const offered = await peekClientAlpn(clientSocket, head); // client's ALPN list, or null

  // When sx.org is enabled, dial the upstream THROUGH its proxy (different egress
  // IP — the IP-based-429 workaround); TLS still terminates end-to-end at the
  // upstream, so the proxy sees only ciphertext. Otherwise connect directly.
  // autoSelectFamily (happy-eyeballs) is the default on Node 20+ but not 18; set
  // it explicitly so a dual-stack upstream whose IPv6 path is unreachable falls
  // back to IPv4 instead of hanging the connect (option ignored pre-18.13).
  let upstreamSock;
  if (sx?.useForConnect()) {
    upstreamSock = await tunnelTls({
      proxy: sx.getProxy(), targetHost: host, targetPort: port,
      tlsOptions: { ...(offered ? { ALPNProtocols: offered } : {}), ...upstreamTlsOptions },
    });
  } else {
    upstreamSock = tls.connect({
      host, port, servername: host, autoSelectFamily: true,
      ...(offered ? { ALPNProtocols: offered } : {}),
      ...upstreamTlsOptions,
    });
    await new Promise((resolve, reject) => {
      upstreamSock.once('secureConnect', resolve);
      upstreamSock.once('error', reject);
    });
  }
  const upstreamAlpn = upstreamSock.alpnProtocol; // false if none negotiated
  const alpn = upstreamAlpn || 'http/1.1';        // relay protocol selector

  // Terminate the client advertising exactly what the upstream chose (a subset
  // of what the client offered, so it always overlaps).
  const claudeTls = new tls.TLSSocket(clientSocket, {
    isServer: true, key, cert,
    ...(upstreamAlpn ? { ALPNProtocols: [upstreamAlpn] } : {}),
  });
  claudeTls.on('error', () => { claudeTls.destroy(); upstreamSock.destroy(); });
  upstreamSock.on('error', () => claudeTls.destroy());
  await new Promise((resolve, reject) => {
    claudeTls.once('secure', resolve);
    claudeTls.once('error', reject);
  });

  // Per-request account binding. The relay calls back at each request boundary
  // (h2 stream / h1 message) with its id; we pick the current best account then,
  // remember it by id, and reuse THAT account to patch the body account_uuid and
  // to attribute the response's quota/429 — so a request and its response always
  // agree on one account even while different requests on this tunnel use
  // different accounts.
  const reqAccounts = new Map(); // id -> account
  const pickFor = async (id) => {
    // getActiveAccountFresh blocks to refresh only if the chosen account's token
    // has ALREADY expired (e.g. we just rotated onto an account that sat idle
    // past its token lifetime) — so we never inject a dead token. Never leave a
    // mid-tunnel request unauthenticated: if every account is over quota right
    // now, fall back to the tunnel's initial account (its response 429 will then
    // throttle it and the next request rolls on).
    const account = (await accountManager.getActiveAccountFresh()) || initial;
    reqAccounts.set(id, account);
    // Opportunistic (non-blocking) refresh for the expiring-soon case: the
    // current credential is still valid, so this request goes out immediately and
    // later requests pick up the refreshed token.
    accountManager.ensureTokenFresh(account.index);
    return account;
  };
  const forget = (id) => reqAccounts.delete(id);

  // Same-length streaming body patch (account_uuid) for the account THIS request
  // was bound to; null when that account has no UUID.
  const makeBodyPatcher = (id) => {
    const a = reqAccounts.get(id);
    return a?.accountUuid ? new AccountUuidPatcher(a.accountUuid) : null;
  };
  const observer = makeQuotaObserver(accountManager, (id) => reqAccounts.get(id), sx);

  // Fan request lifecycle out to the on-disk log (when configured) AND the live
  // TUI activity feed. The account is resolved per request id so logs/feed show
  // the account THAT request actually used (populated before the tap's req/head).
  const nameFor = (id) => reqAccounts.get(id)?.name || initial.name;
  const tap = combineTaps(makeMitmTap(logDir, nameFor), makeActivityTap(hooks, nameFor));

  if (alpn === 'h2') {
    h2Relay(claudeTls, upstreamSock, {
      // Async: pickFor may block to refresh an expired token before we inject it.
      // The relay awaits the returned promise before forwarding the request.
      rewriteRequest: async (fields, id) => makeRewriteRequest(await pickFor(id))(fields),
      makeBodyPatcher,
      onResponseHeaders: observer,
      onStreamClose: forget,
      tap,
      log,
    });
  } else {
    h1Relay(claudeTls, upstreamSock, {
      rewriteHead: async (h, id) => {
        const account = await pickFor(id);
        const auth = account.type === 'oauth'
          ? { authorization: `Bearer ${account.credential}` }
          : { apiKey: account.credential };
        return rewriteH1Auth(h, auth);
      },
      makeBodyPatcher,
      onResponseHeaders: observer,
      onStreamClose: forget,
      tap,
    });
  }
}

function reply200Raw(sock) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }

function termClaude(clientSocket, head, key, cert, alpn) {
  if (head && head.length) clientSocket.unshift(head);
  const t = new tls.TLSSocket(clientSocket, { isServer: true, key, cert, ALPNProtocols: alpn });
  t.on('error', () => t.destroy());
  return t;
}

// Read the client's first TLS record (the ClientHello) to learn the ALPN
// protocol list it offers, WITHOUT consuming it: bytes are unshifted back so the
// real TLS handshake still sees the full ClientHello. Returns the protocol
// string array, or null if there is no ALPN extension / it can't be parsed (in
// which case we offer the upstream no ALPN and mirror its no-ALPN result).
function peekClientAlpn(sock, head) {
  return new Promise((resolve) => {
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let done = false;
    const finish = (result) => {
      if (done) return; done = true;
      sock.removeListener('readable', onReadable);
      sock.removeListener('end', onEnd);
      sock.removeListener('error', onEnd);
      if (buf.length) sock.unshift(buf); // put the ClientHello back for node:tls
      resolve(result);
    };
    const tryParse = () => {
      const r = parseClientHelloAlpn(buf);
      if (r === undefined && buf.length < 16384) return false; // need more bytes
      finish(Array.isArray(r) ? r : null);
      return true;
    };
    // Read in PAUSED mode (readable/read) — never switch the socket to flowing,
    // or the TLSSocket we hand it to afterwards won't receive the unshifted bytes.
    const onReadable = () => {
      let chunk;
      while ((chunk = sock.read()) !== null) {
        buf = Buffer.concat([buf, chunk]);
        if (tryParse()) return;
      }
    };
    const onEnd = () => finish(null);
    sock.on('readable', onReadable);
    sock.once('end', onEnd);
    sock.once('error', onEnd);
    if (tryParse()) return; // head may already contain the whole ClientHello
    onReadable();           // drain anything already buffered
  });
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

// Rewrite only the auth field on an h2 request header list (account token in,
// client's x-api-key out). Preserves order; marks auth never-indexed.
function makeRewriteRequest(account) {
  const isOAuth = account.type === 'oauth';
  return (fields) => {
    // Remote Control control channel (/v1/code/*) is bound to the session's
    // paired claude.ai identity; injecting a rotated account's token makes the
    // worker event stream 403 and breaks Remote Control. Pass it through so
    // Claude's own credential reaches the server (mirror of rewriteH1Auth).
    const pathField = fields.find((f) => f.name.toString().toLowerCase() === ':path');
    if (pathField && pathField.value.toString().startsWith('/v1/code/')) return fields;
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

// `accountFor` maps a relay request id to the account that request was bound to,
// so quota/429s land on the RIGHT account when a tunnel rotates accounts.
function makeQuotaObserver(accountManager, accountFor, sx = null) {
  return (fields, id) => {
    const account = accountFor(id);
    if (!account) return; // response with no matching request id (already forgotten / unpaired)
    const m = {};
    for (const f of fields) m[f.name.toString().toLowerCase()] = f.value.toString();
    if (!m[':status']) return;
    const rl = {};
    for (const k in m) if (k.startsWith('anthropic-ratelimit-')) rl[k] = m[k];
    if (Object.keys(rl).length) accountManager.updateQuota(account.index, rl);
    if (m[':status'] === '429') {
      let ra = parseInt(m['retry-after'], 10);
      if (Number.isNaN(ra)) ra = 60;
      ra = Math.min(Math.max(ra, 1), 300);
      accountManager.markRateLimited(account.index, ra);
      // The very next request on this same tunnel will now pick a different
      // account (this one is throttled) — no teardown needed.
      // Arm sx.org sticky routing so the next MITM tunnel uses the proxy (in
      // '429' mode); no-op in 'off'/'always'.
      sx?.noteRateLimited(ra);
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
