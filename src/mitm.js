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
import { createProxyRequestListener, resolveClientAuth, isLoopbackAddr, relayUpgrade, resolveAccountPin, describeConnectError } from './server.js';

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
export function createConnectHandler({ config, accountManager, ensureLeaf, logDir = null, hooks = {}, log = () => {}, sx = null, egress = null, clientUsage = null, dimensionUsage = null }) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const holdMs = (config.holdSeconds || 0) * 1000;

  // One terminating h2/h1 server per pin, minted lazily on the first intercepted
  // CONNECT that needs it (key '' = unpinned, the common case).
  // TLS uses our leaf; ALPN negotiates h2 or http/1.1 (allowHTTP1) with whatever
  // the client offers. It emits 'request' for BOTH protocols, so `forward` — the
  // shared buffering/retrying proxy listener — handles them identically. Each
  // CONNECT feeds it the raw tunnel socket; the client keeps the tunnel open and
  // multiplexes many requests over it, each independently account-selected.
  //
  // Keying by pin is what carries a TC_ACCT pin from the CONNECT to the requests
  // inside the tunnel. The alternative — tagging the raw socket and reading it
  // back from the request — means digging through a TLSSocket and, under h2, a
  // Proxy over the session socket. A listener bound to the account is the same
  // information with none of that. The client identity from the CONNECT's
  // Proxy-Authorization rides the same mechanism (a listener bound to the
  // client), for the same reason. The map is bounded by accounts × client keys,
  // both operator-controlled.
  const serverPromises = new Map();
  const getServer = (pin = '', client = null) => {
    const mapKey = `${pin}\u0000${client || ''}`;
    let p = serverPromises.get(mapKey);
    if (p) return p;
    p = (async () => {
    const { key, cert } = await ensureLeaf();
    const srv = http2.createSecureServer({ key, cert, allowHTTP1: true });
    srv.on('request', createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx, holdMs, config, forcedPin: pin || null, egress, clientUsage, forcedClient: client, dimensionUsage }));
    // Remote Control's real-time channel is a WebSocket (Upgrade handshake),
    // which never fires 'request' — only 'upgrade', with a raw socket instead
    // of a response object (h1-only; falls back to blind h2 passthrough is not
    // needed since WS clients negotiate h1 for the handshake).
    srv.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, upstream, sx));
    srv.on('sessionError', (e) => log(`[TeamClaude] MITM session error: ${e.message}`));
    srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch { /* already gone */ } });
    return srv;
    })().catch((err) => {
      // Don't let a transient cert/disk failure poison the memo forever: drop it
      // so the next intercepted CONNECT retries instead of re-awaiting a cached
      // rejection (which would leave the MITM path dead until a restart).
      serverPromises.delete(mapKey);
      throw err;
    });
    serverPromises.set(mapKey, p);
    return p;
  };

  return (req, clientSocket, head) => {
    clientSocket.on('error', () => {});

    // Auth gate — mirror the HTTP path: loopback is exempt, everything else must
    // present the proxy apiKey (or a clientKeys entry) via Proxy-Authorization.
    // Without this, a remote client can CONNECT api.anthropic.com and have a
    // rotated ACCOUNT TOKEN injected (token theft), or blind-tunnel to arbitrary
    // hosts (open relay / SSRF) — the HTTP path already blocks the equivalent
    // for remote clients. config.proxy is read per CONNECT so a reload that
    // edits clientKeys applies to a running server, matching the HTTP gate.
    const auth = resolveConnectAuth(req, clientSocket, config.proxy);
    if (!auth.ok) {
      try {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="teamclaude"\r\nConnection: close\r\n\r\n');
      } catch { /* client already gone */ }
      clientSocket.destroy();
      return;
    }

    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;
    const mode = hostMode(host, config);

    if (mode === 'tunnel') {
      // Until the upstream connects we still owe the client a CONNECT status
      // line. If we tore the socket down on an upstream failure without one,
      // the client reports "Proxy connection ended before receiving CONNECT
      // response" — so before the tunnel is live, surface failures as a real
      // proxy error status instead of a silent drop.
      let established = false, closed = false;
      // Tear down BOTH sockets when either errors or closes, so a one-sided
      // failure can't leave the paired socket lingering (FD leak). The `closed`
      // guard makes it idempotent (error+close both fire) and ensures we write
      // at most one status line.
      const teardown = (statusLine) => {
        if (closed) return;
        closed = true;
        if (!established && statusLine) {
          try { clientSocket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`); } catch { /* client already gone */ }
        }
        up.destroy(); clientSocket.destroy();
      };
      const up = net.connect(port, host, () => {
        established = true;
        reply200Raw(clientSocket);
        if (head && head.length) up.write(head);
        up.pipe(clientSocket); clientSocket.pipe(up);
      });
      up.on('error', (err) => {
        if (!established) log(`[TeamClaude] tunnel ${host}:${port} failed: ${describeConnectError(err)}`);
        teardown('502 Bad Gateway');
      });
      // A FIN before the tunnel is live (no preceding 'error') is still a failed
      // dial from the client's view — surface a 502 rather than a silent drop.
      up.on('close', () => teardown('502 Bad Gateway'));
      clientSocket.on('close', () => teardown()); // client gone: nothing to write
      up.setTimeout(30_000, () => teardown('504 Gateway Timeout')); // bound a stalled connect/idle tunnel
      return;
    }

    if (mode === 'test') {
      // The built-in test host is answered locally, never forwarded upstream.
      ensureLeaf().then(({ key, cert }) => {
        reply200Raw(clientSocket);
        serveTest(termClaude(clientSocket, head, key, cert, ['http/1.1']));
      }).catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); reply502Raw(clientSocket); clientSocket.destroy(); });
      return;
    }

    // rewrite: terminate the tunnel and forward each request with buffering +
    // retry. Reply 200, hand the raw socket (ClientHello and all) to the h2/h1
    // server, which does TLS + protocol negotiation itself. If the terminating
    // server can't be minted (cert/disk/TLS-init failure) we haven't replied yet
    // — send a 502 so the client sees a real proxy error instead of "Proxy
    // connection ended before receiving CONNECT response".
    // Pin resolution is deliberately confined to `rewrite`. Clients send
    // Proxy-Authorization on EVERY CONNECT, including blind-tunneled third-party
    // hosts, where an account pin is meaningless — rejecting there would take
    // down unrelated traffic over a typo meant for Anthropic.
    const { pin, error } = resolveConnectPin(req, accountManager, config.proxy);
    if (error) {
      log(`[TeamClaude] CONNECT ${host}: ${error}`);
      try {
        clientSocket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="teamclaude"\r\nConnection: close\r\n\r\n`);
      } catch { /* client already gone */ }
      clientSocket.destroy();
      return;
    }

    getServer(pin || '', auth.client).then((srv) => {
      reply200Raw(clientSocket);
      if (head && head.length) clientSocket.unshift(head);
      srv.emit('connection', clientSocket);
    }).catch((err) => { log(`[TeamClaude] MITM ${host}: ${err.message}`); reply502Raw(clientSocket); clientSocket.destroy(); });
  };
}

// The Basic username from a CONNECT's `Proxy-Authorization`, or null. This is
// the only pin channel expressible in an HTTPS_PROXY URL, which is what
// `teamclaude run` has to work with in MITM mode (there is no request path to
// carry a `/tc-acct/` prefix — inside the tunnel the path is the real upstream
// one). Clients send this preemptively on every CONNECT.
export function connectPinToken(req) {
  const header = (req?.headers?.['proxy-authorization'] || '').trim();
  if (!header.toLowerCase().startsWith('basic ')) return null;
  const dec = Buffer.from(header.slice('basic '.length).trim(), 'base64').toString('utf8'); // "user:pass"
  const colon = dec.indexOf(':');
  return (colon >= 0 ? dec.slice(0, colon) : dec) || null;
}

/**
 * Resolve the account pin on a CONNECT, or a rejection reason.
 *
 * The username slot is overloaded: the documented remote form is
 * `--proxy http://<key>@host:port`, where it holds the proxy apiKey, not an
 * account. So the key wins over any account of the same name — an operator who
 * names an account after their proxy key gets auth, not a surprise pin.
 *
 * An unrecognized username is an ERROR rather than a silently ignored pin: a
 * typo'd account name that quietly served from the wrong account is exactly the
 * failure mode this feature exists to remove.
 *
 * @returns {{pin: string|null, error: string|null}}
 */
export function resolveConnectPin(req, accountManager, proxyConfig) {
  // Historically this took the bare apiKey string; accept both so existing
  // callers/tests keep working while the handler passes the full proxy config
  // (needed to recognize clientKeys entries in the username slot).
  const proxy = typeof proxyConfig === 'string' ? { apiKey: proxyConfig } : proxyConfig;
  const token = connectPinToken(req);
  if (!token) return { pin: null, error: null };
  if (resolveClientAuth(proxy, token).ok && (proxy?.apiKey || proxy?.clientKeys?.length)) {
    return { pin: null, error: null };
  }
  if (resolveAccountPin(accountManager, token) == null) {
    return { pin: null, error: `Unknown account pin "${token}"` };
  }
  return { pin: token, error: null };
}

/**
 * Authorize a CONNECT and resolve which client identity it carries — the
 * CONNECT-side counterpart of server.js's resolveClientAuth, sharing its
 * semantics: no keys configured → open; loopback exempt (both unattributed);
 * otherwise the proxy apiKey or a clientKeys entry must be presented via
 * `Proxy-Authorization` (Bearer <key>, or Basic where the key is the username
 * or password — so `--proxy http://<key>@host:port` works).
 * Returns { ok, client }.
 */
export function resolveConnectAuth(req, socket, proxyConfig) {
  const hasKeys = !!(proxyConfig?.apiKey || (Array.isArray(proxyConfig?.clientKeys) && proxyConfig.clientKeys.length));
  if (!hasKeys) return { ok: true, client: null };
  const m = /^\s*(basic|bearer)\s+(.+?)\s*$/i.exec(req?.headers?.['proxy-authorization'] || '');
  let auth = { ok: false, client: null };
  if (m) {
    let presented = m[2];
    if (m[1].toLowerCase() === 'basic') {
      const dec = Buffer.from(m[2], 'base64').toString('utf8'); // "user:pass"
      const i = dec.indexOf(':');
      const user = i >= 0 ? dec.slice(0, i) : dec;
      const pass = i >= 0 ? dec.slice(i + 1) : '';
      // Try both slots: the documented remote form carries the key in either.
      auth = resolveClientAuth(proxyConfig, pass || user);
      if (!auth.ok && pass && user) auth = resolveClientAuth(proxyConfig, user);
    } else {
      auth = resolveClientAuth(proxyConfig, presented);
    }
  }
  // Loopback is exempt from the key requirement, but a valid key it DID present
  // still names it (matching the HTTP gate, where a local caller with a client
  // key is attributed like any other).
  if (!auth.ok && isLoopbackAddr(socket?.remoteAddress)) return { ok: true, client: null };
  return auth;
}

// Boolean back-compat wrapper (pre-clientKeys signature). Exported for tests.
export function connectAuthorized(req, socket, proxyApiKey) {
  return resolveConnectAuth(req, socket, { apiKey: proxyApiKey }).ok;
}

function reply200Raw(sock) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }
function reply502Raw(sock) { try { sock.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch { /* client already gone */ } }

function termClaude(clientSocket, head, key, cert, alpn) {
  if (head && head.length) clientSocket.unshift(head);
  const t = new tls.TLSSocket(clientSocket, { isServer: true, key, cert, ALPNProtocols: alpn });
  t.on('error', () => t.destroy());
  return t;
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
