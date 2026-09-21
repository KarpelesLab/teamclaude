// Per-account egress routing: send ONE account's traffic through its own proxy.
//
// Distinct from the two fleet-wide egress settings this file deliberately does
// not touch:
//   - `config.upstreamProxy` (upstream-proxy.js) is how the whole HOST reaches
//     the internet — HTTP CONNECT only, one setting for every account.
//   - `config.sx` (sx.js) is the sx.org residential-egress integration, a paid
//     provider with its own routing policy.
// This one is bound to a single account (`accounts[].routing`): every socket
// opened for that account — request forwarding, token refresh, profile, usage
// and quota probes — tunnels through that account's proxy and no other, and
// every other account's traffic is untouched. Because the contract is "ALL of
// this account's traffic", an account with routing set uses it on every
// attempt: neither the sx retry policy nor the fleet upstream proxy applies to
// it (chaining would be two hops to solve one problem, and the first hop would
// not be the proxy the operator pinned).
//
// Schemes: http (CONNECT, like the fleet proxy), socks4, socks4a, socks5 and
// socks5h. The `a`/`h` suffixes follow curl's convention: the bare form
// resolves the target hostname locally, the suffixed form hands the hostname
// to the proxy to resolve — which is usually the point of routing an account
// through a remote network (the exit's DNS view is the exit's geography).
//
// Node's global fetch cannot speak any of these, and "zero dependencies" is a
// project feature, so the SOCKS handshakes are built by hand on the same
// primitives as the CONNECT tunnel (sx.js). TLS stays end-to-end in every
// case: the proxy — socks or CONNECT — relays ciphertext only.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import { connectThroughProxy, handshakeOverTunnel } from './sx.js';

const CONNECT_TIMEOUT_MS = 30000; // same budget as the CONNECT tunnel

export const ROUTING_SCHEMES = ['http', 'socks4', 'socks4a', 'socks5', 'socks5h'];

// The code on every failure to OPEN a connection through an account's routing:
// the proxy refused, hung up, rejected the credentials, could not reach the
// target, or the TLS handshake over the tunnel never completed. It names the
// one case the forward path cannot read off the socket error underneath
// (kept on `cause`): an ECONNREFUSED from the upstream host is the same for
// every account, so failing over is pointless, but an ECONNREFUSED from ONE
// account's proxy says nothing about the others, so failing over is the fix.
// Nothing of the request has been sent when it is raised, so a retry elsewhere
// can never duplicate a request upstream.
export const ROUTING_FAILED = 'TEAMCLAUDE_ROUTING_FAILED';

/**
 * @typedef {Object} RoutingProxy
 * @property {string} protocol  One of ROUTING_SCHEMES.
 * @property {string} host
 * @property {number} port
 * @property {string|null} username
 * @property {string|null} password
 */

/**
 * Parse a per-account routing URL into the shape the connectors want.
 *
 * Accepts `http://`, `socks4(a)://`, `socks5(h)://` with optional
 * `user:pass@`, and a bare `host:port` (a CONNECT proxy by convention, same
 * default as the fleet upstream proxy). Returns null for empty input; throws
 * on anything unusable, so a typo surfaces where the value is entered (the
 * CLI, startup) rather than as a mystery connection failure on the account's
 * first request.
 * @param {any} value
 * @returns {RoutingProxy|null}
 */
export function parseRoutingUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  // What the error text echoes. These messages reach the server log (a bad
  // value in the config is reported at startup and on every reload) and the
  // MCP reply, and the value holds the proxy password.
  const shown = maskRoutingUrl(raw);

  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`invalid routing URL: ${shown}`);
  }
  const protocol = u.protocol.replace(/:$/, '').toLowerCase();
  if (!ROUTING_SCHEMES.includes(protocol)) {
    throw new Error(`unsupported routing protocol "${protocol}" (one of ${ROUTING_SCHEMES.join(', ')}): ${shown}`);
  }
  if (!u.hostname) throw new Error(`routing URL has no host: ${shown}`);

  // Read the port off the raw authority as well as u.port: WHATWG URL refuses
  // most bad ports outright, but accepts `:0`, which no proxy listens on —
  // and a typo must not silently become the scheme default. Empty after a
  // trailing colon means "default", as in URLs.
  const authority = withScheme.slice(withScheme.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  const hostport = authority.slice(authority.lastIndexOf('@') + 1);
  let portRaw = null;
  if (hostport.startsWith('[')) {
    portRaw = /\]:(\d*)$/.exec(hostport)?.[1] ?? null;
  } else if (hostport.includes(':')) {
    portRaw = hostport.slice(hostport.lastIndexOf(':') + 1);
  }
  if (portRaw != null && portRaw !== '' && !/^\d+$/.test(portRaw)) {
    throw new Error(`routing URL has an invalid port: ${shown}`);
  }
  const port = portRaw ? Number(portRaw) : (protocol === 'http' ? 8080 : 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`routing URL has an invalid port: ${shown}`);
  }
  let username;
  let password;
  try {
    username = u.username ? decodeURIComponent(u.username) : null;
    password = u.password ? decodeURIComponent(u.password) : null;
  } catch {
    // URL keeps a stray `%` as written; decodeURIComponent then throws a bare
    // "URI malformed", which names neither the field nor the fix.
    throw new Error(`routing URL credentials have a malformed percent-escape (write a literal % as %25): ${shown}`);
  }
  if (password && (protocol === 'socks4' || protocol === 'socks4a')) {
    // SOCKS4's request carries a userid and nothing else; a password written
    // here would be silently dropped on the floor. Name the fix instead.
    throw new Error(`SOCKS4 has no password authentication — use socks5 for user:pass auth: ${shown}`);
  }
  // URL keeps an IPv6 literal bracketed; the socket layer wants it bare.
  return { protocol, host: u.hostname.replace(/^\[(.*)\]$/, '$1'), port, username, password };
}

/**
 * A routing value AS TYPED, password masked — for text that echoes input which
 * may not parse at all (error messages, the MCP audit log). describeRouting()
 * is the form for a routing that did parse.
 *
 * Cut at the LAST `@`, not the first: an unescaped `@`, `/` or `#` inside a
 * password is exactly the typo that makes a value unparseable, and a mask that
 * stopped early would print the tail of the secret. Over-masking an odd value
 * costs nothing; this text is for reading, never for parsing.
 * @param {any} value
 * @returns {string}
 */
export function maskRoutingUrl(value) {
  const text = String(value ?? '');
  const at = text.lastIndexOf('@');
  if (at < 0) return text;
  const scheme = text.indexOf('://');
  const colon = text.indexOf(':', scheme < 0 ? 0 : scheme + 3);
  if (colon < 0 || colon > at) return text; // a username alone holds no secret
  return `${text.slice(0, colon)}:***${text.slice(at)}`;
}

/**
 * Render a routing back to a storable URL, credentials intact. For writing
 * the config — never for logs or the screen, which must use describeRouting().
 * @param {RoutingProxy|null} routing
 * @returns {string|null}
 */
export function routingToUrl(routing) {
  if (!routing) return null;
  const auth = routing.username
    ? `${encodeURIComponent(routing.username)}${routing.password ? `:${encodeURIComponent(routing.password)}` : ''}@`
    : '';
  return `${routing.protocol}://${auth}${routing.host}:${routing.port}`;
}

/** Render a routing with the password masked; null when there is none. For logs and the TUI.
 * @param {RoutingProxy|null} routing
 * @returns {string|null}
 */
export function describeRouting(routing) {
  if (!routing) return null;
  const auth = routing.username ? `${routing.username}:***@` : '';
  return `${routing.protocol}://${auth}${routing.host}:${routing.port}`;
}

// ── SOCKS5 (RFC 1928 + 1929) ─────────────────────────────────
//
// A handshake-driven state machine over one buffer: greeting (and optional
// user/pass auth), then the CONNECT request, then the reply whose length
// depends on its address type. On success the socket is paused and any bytes
// read past the reply are unshifted, exactly as connectThroughProxy leaves
// it, so the TLS layer handed the socket sees every byte.

/** @type {Record<number, string>} */
const SOCKS5_ERRORS = {
  0x01: 'general failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

/** Bytes in a SOCKS5 reply given the buffer so far; 0 = more to read, -1 = unparseable.
 * @param {Buffer} buf
 * @param {number} atypOffset
 * @returns {number}
 */
function socks5ReplyLength(buf, atypOffset) {
  if (buf.length < atypOffset + 1) return 0;
  const atyp = buf[atypOffset];
  if (atyp === 0x01) return atypOffset + 1 + 4 + 2;      // IPv4
  if (atyp === 0x04) return atypOffset + 1 + 16 + 2;     // IPv6
  if (atyp === 0x03) {                                    // domain
    if (buf.length < atypOffset + 2) return 0;
    return atypOffset + 2 + buf[atypOffset + 1] + 2;
  }
  return -1; // unknown ATYP — the reply can never be parsed
}

/** The ATYP..PORT body of the CONNECT request, resolving locally unless the scheme says the proxy does.
 * @param {{ protocol: string, targetHost: string, targetPort: number, label: string }} args
 * @returns {Promise<Buffer>}
 */
async function socks5Target({ protocol, targetHost, targetPort, label }) {
  // socks5h: the proxy resolves. socks5: resolve here and send the literal.
  if (protocol === 'socks5h') {
    const host = Buffer.from(targetHost, 'utf8');
    if (host.length > 255) throw new Error(`${label}: target hostname too long for SOCKS5`);
    return Buffer.concat([Buffer.from([0x03, host.length]), host, portBytes(targetPort)]);
  }
  let ip = targetHost;
  if (!net.isIP(targetHost)) {
    let found;
    try {
      found = await dns.lookup(targetHost);
    } catch (/** @type {any} */ err) {
      throw new Error(`${label}: local DNS lookup of ${targetHost} failed (use socks5h to resolve at the proxy): ${err.message}`);
    }
    ip = found.address;
  }
  if (net.isIP(ip) === 6) {
    return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(ip), portBytes(targetPort)]);
  }
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(ip.split('.').map(Number)), portBytes(targetPort)]);
}

/** @param {string} ip
 * @returns {Buffer}
 */
function ipv6Bytes(ip) {
  // Expand :: runs, then pack eight 16-bit groups. A zone id (fe80::1%lo0) is
  // link-local addressing and means nothing to a remote proxy — drop it.
  const [head, tail] = ip.split('%', 1)[0].split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
  const out = Buffer.alloc(16);
  parts.forEach((p, i) => out.writeUInt16BE(parseInt(p || '0', 16), i * 2));
  return out;
}

/** @param {number} port
 * @returns {Buffer}
 */
function portBytes(port) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(port);
  return b;
}

/** @param {{ proxy: RoutingProxy, targetHost: string, targetPort: number, timeout: number, label: string }} args
 * @returns {Promise<import('node:net').Socket>}
 */
function connectThroughSocks5({ proxy, targetHost, targetPort, timeout, label }) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer|null} */
    let requestBody = null; // ATYP..PORT, resolved (possibly via DNS) on connect
    const sock = net.connect({ port: proxy.port, host: proxy.host, autoSelectFamily: true });
    let buf = Buffer.alloc(0);
    let stage = proxy.username ? 'greeting-auth' : 'greeting';
    const timer = setTimeout(() => fail(new Error(`${label} SOCKS5 handshake timed out after ${timeout}ms`)), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
      sock.removeListener('close', onClose);
    };
    /** @param {any} err */
    const fail = (err) => { cleanup(); sock.destroy(); reject(err); };
    // A proxy that hangs up mid-handshake is an error, not a silent wait:
    // without this the promise never settles when the socket closes cleanly.
    const onClose = () => fail(new Error(`${label}: connection closed during the SOCKS5 handshake`));
    sock.once('close', onClose);

    const sendConnect = () => {
      stage = 'connect';
      // Set before the greeting went out — the state machine only reaches this
      // point afterwards, which TS cannot see.
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), /** @type {Buffer} */ (requestBody)]));
    };

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting' || stage === 'greeting-auth') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { fail(new Error(`${label}: not a SOCKS5 proxy (greeting version ${buf[0]})`)); return; }
        const method = buf[1];
        consume(2);
        if (method === 0x00) { sendConnect(); return; }
        if (method === 0x02 && stage === 'greeting-auth') {
          // RFC 1929 username/password: VER=1, ULEN, UNAME, PLEN, PASSWD. The
          // stage exists only when username is set, which TS cannot see.
          const uname = Buffer.from(/** @type {string} */ (proxy.username), 'utf8');
          const passwd = Buffer.from(proxy.password || '', 'utf8');
          if (uname.length > 255 || passwd.length > 255) { fail(new Error(`${label}: SOCKS5 credentials exceed 255 bytes`)); return; }
          stage = 'auth';
          sock.write(Buffer.concat([Buffer.from([0x01, uname.length]), uname, Buffer.from([passwd.length]), passwd]));
          return;
        }
        if (method === 0xff) { fail(new Error(`${label}: SOCKS5 proxy accepts no offered authentication method${proxy.username ? '' : ' (it may require credentials)'}`)); return; }
        fail(new Error(`${label}: SOCKS5 proxy chose unsupported auth method 0x${method.toString(16)}`));
        return;
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1];
        consume(2);
        if (status !== 0x00) { fail(new Error(`${label}: SOCKS5 authentication failed`)); return; }
        sendConnect();
        return;
      }
      // stage === 'connect': VER, REP, RSV, ATYP, BND.ADDR, BND.PORT
      const want = socks5ReplyLength(buf, 3);
      if (want < 0) { fail(new Error(`${label}: SOCKS5 reply has unknown address type ${buf[3]}`)); return; }
      if (want === 0 || buf.length < want) return;
      const rep = buf[1];
      const rest = buf.subarray(want);
      if (buf[0] !== 0x05) { fail(new Error(`${label}: not a SOCKS5 proxy (reply version ${buf[0]})`)); return; }
      if (rep !== 0x00) { fail(new Error(`${label}: SOCKS5 CONNECT to ${targetHost}:${targetPort} failed — ${SOCKS5_ERRORS[rep] || `code ${rep}`}`)); return; }
      cleanup();
      sock.pause(); // stop flowing so the TLS layer we hand it to sees every byte
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    /** Drop the consumed head of the buffer.
     * @param {number} n */
    const consume = (n) => { buf = buf.subarray(n); };

    sock.once('connect', () => {
      socks5Target({ protocol: proxy.protocol, targetHost, targetPort, label }).then((body) => {
        requestBody = body;
        const methods = proxy.username ? [0x00, 0x02] : [0x00];
        sock.write(Buffer.from([0x05, methods.length, ...methods]));
      }, fail);
    });
    sock.on('data', onData);
    sock.once('error', fail);
  });
}

// ── SOCKS4 / SOCKS4a ─────────────────────────────────────────
//
// One request, one fixed-size reply. The request carries a userid and no
// password (parseRoutingUrl refuses a password up front). socks4 resolves the
// target here and must get an IPv4; socks4a sends the 0.0.0.x marker and lets
// the proxy resolve the trailing domain.

/** @type {Record<number, string>} */
const SOCKS4_ERRORS = {
  0x5b: 'request rejected or failed',
  0x5c: 'identd unreachable at the client',
  0x5d: 'identd reports a different user id',
};

/** @param {{ proxy: RoutingProxy, targetHost: string, targetPort: number, timeout: number, label: string }} args
 * @returns {Promise<import('node:net').Socket>}
 */
function connectThroughSocks4({ proxy, targetHost, targetPort, timeout, label }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port: proxy.port, host: proxy.host, autoSelectFamily: true });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`${label} SOCKS4 handshake timed out after ${timeout}ms`)), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
      sock.removeListener('close', onClose);
    };
    /** @param {any} err */
    const fail = (err) => { cleanup(); sock.destroy(); reject(err); };
    const onClose = () => fail(new Error(`${label}: connection closed during the SOCKS4 handshake`));
    sock.once('close', onClose);
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const rest = buf.subarray(8);
      const code = buf[1];
      if (code !== 0x5a) { fail(new Error(`${label}: SOCKS4 CONNECT to ${targetHost}:${targetPort} failed — ${SOCKS4_ERRORS[code] || `code ${code}`}`)); return; }
      cleanup();
      sock.pause();
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.once('connect', () => {
      buildSocks4Request({ proxy, targetHost, targetPort, label }).then((req) => sock.write(req), fail);
    });
    sock.on('data', onData);
    sock.once('error', fail);
  });
}

/** @param {{ proxy: RoutingProxy, targetHost: string, targetPort: number, label: string }} args
 * @returns {Promise<Buffer>}
 */
async function buildSocks4Request({ proxy, targetHost, targetPort, label }) {
  let ip;
  let domain = null;
  if (proxy.protocol === 'socks4a') {
    domain = Buffer.from(targetHost, 'utf8');
    ip = Buffer.from([0, 0, 0, 1]); // the 0.0.0.x marker that says "domain follows"
  } else {
    let literal = targetHost;
    if (net.isIP(literal) !== 4) {
      let found;
      try {
        found = await dns.lookup(literal, { family: 4 });
      } catch (/** @type {any} */ err) {
        throw new Error(`${label}: SOCKS4 needs an IPv4 target and local DNS lookup of ${targetHost} failed (use socks4a to resolve at the proxy): ${err.message}`);
      }
      literal = found.address;
    }
    ip = Buffer.from(literal.split('.').map(Number));
  }
  const userid = Buffer.from(proxy.username || '', 'utf8');
  return Buffer.concat([
    Buffer.from([0x04, 0x01]), portBytes(targetPort), ip, userid, Buffer.from([0x00]),
    ...(domain ? [domain, Buffer.from([0x00])] : []),
  ]);
}

/** CONNECT/SOCKS through `proxy.protocol`'s connector to targetHost:targetPort.
 * @param {RoutingProxy} proxy
 * @param {{ targetHost: string, targetPort: number, timeout?: number, label?: string }} options
 * @returns {Promise<import('node:net').Socket>}
 */
export function connectThroughRouting(proxy, { targetHost, targetPort, timeout = CONNECT_TIMEOUT_MS, label = 'account routing proxy' }) {
  if (proxy.protocol === 'http') {
    return connectThroughProxy({
      proxyHost: proxy.host,
      proxyPort: proxy.port,
      auth: proxy.username ? `${proxy.username}:${proxy.password ?? ''}` : null,
      targetHost,
      targetPort,
      timeout,
      label,
    });
  }
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') {
    return connectThroughSocks5({ proxy, targetHost, targetPort, timeout, label });
  }
  return connectThroughSocks4({ proxy, targetHost, targetPort, timeout, label });
}

/**
 * An http(s).Agent whose sockets are tunnels through one account's routing
 * proxy. Same shape and rationale as upstream-proxy.js's proxyAgent:
 * keepAlive is off because createConnection closes over one target, so a
 * pooled socket could never be reused for another host anyway. TLS is
 * established end-to-end over the tunnel, so the proxy sees ciphertext only
 * and cert verification stays at its secure default.
 *
 * `routing` may be the parsed object or the stored URL string; the string is
 * parsed here so a caller holding the config shape need not care.
 * @param {RoutingProxy|string} routing
 * @param {{ targetHost: string, targetPort: number, tls?: boolean, tlsOptions?: Record<string, any> }} options
 * @returns {http.Agent | https.Agent}
 */
export function routingAgent(routing, { targetHost, targetPort, tls: useTls = true, tlsOptions = {} }) {
  const proxy = /** @type {RoutingProxy} */ (typeof routing === 'string' ? parseRoutingUrl(routing) : routing);
  // Names WHICH proxy in every failure: a fleet may hold several, and "SOCKS5
  // authentication failed" alone sends the operator to the wrong one.
  const label = `account routing proxy ${describeRouting(proxy)}`;
  const agent = new (useTls ? https : http).Agent({ keepAlive: false });
  agent.createConnection = (
    /** @type {import('node:http').ClientRequestArgs} */ _options,
    /** @type {(err: Error | null, sock: import('node:stream').Duplex) => void} */ cb,
  ) => {
    const failed = (/** @type {any} */ err) => cb(routingFailure(err, label), /** @type {any} */ (null));
    connectThroughRouting(proxy, { targetHost, targetPort, label })
      .then((sock) => {
        if (!useTls) {
          // The tunnel pauses the socket so a TLS layer sees every byte. On the
          // plaintext path nothing resumes it, so resume after the caller has it
          // (same subtlety as proxyAgent).
          cb(null, sock);
          sock.resume();
          return;
        }
        handshakeOverTunnel(sock, { servername: targetHost, tlsOptions })
          .then((tlsSock) => cb(null, tlsSock), failed);
      })
      .catch(failed);
    return undefined; // socket is delivered asynchronously through cb
  };
  return agent;
}

/**
 * Wrap a connection failure as ROUTING_FAILED. The original stays on `cause`
 * with its own code, for the log and for anything that wants the socket-level
 * reason.
 * @param {any} err
 * @param {string} label
 * @returns {import('./types.js').CodedError}
 */
function routingFailure(err, label) {
  // Happy-eyeballs reports an all-addresses-failed connect as an AggregateError
  // with an empty message and one reason per address.
  const reason = (Array.isArray(err?.errors) && err.errors.length
    ? err.errors.map((/** @type {any} */ e) => e?.message).filter(Boolean).join('; ')
    : '') || err?.message || String(err);
  const wrapped = /** @type {import('./types.js').CodedError} */ (
    new Error(reason.startsWith(label) ? reason : `${label}: ${reason}`, { cause: err }));
  wrapped.code = ROUTING_FAILED;
  return wrapped;
}

/** Whether a failure is (or wraps) a ROUTING_FAILED.
 * @param {any} err
 * @returns {boolean}
 */
export function isRoutingFailure(err) {
  return err?.code === ROUTING_FAILED || err?.cause?.code === ROUTING_FAILED;
}
