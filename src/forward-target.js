// Destination policy for the two transparent forward paths: the blind CONNECT
// tunnel (mitm.js) and the absolute-form plain-HTTP relay (server.js).
//
// Both forward to whatever host the client names, with no account logic — that
// is the point, third-party traffic must pass untouched. But "whatever host"
// used to include this machine. The HTTP gate exempts loopback callers from the
// proxy API key (a local process is trusted), so a remote holder of a low-trust
// clientKeys entry could `CONNECT 127.0.0.1:<our port>`, speak plain HTTP inside
// the tunnel, and arrive at our own listener AS a loopback client: unauthenticated,
// unattributed access to /teamclaude/switch, /reload, /status and /v1/messages,
// plus any other loopback-only service on the box and the link-local cloud
// metadata endpoint (169.254.169.254). The plain-HTTP relay had the same hole.
//
// So a forward may not target loopback, the unspecified address (connecting to
// 0.0.0.0 lands on loopback), or link-local. RFC1918 ranges stay open: a LAN
// target is a legitimate thing to proxy to. Nothing legitimate is lost on the
// loopback side either — `teamclaude run`/`env` hand the launched client
// NO_PROXY=localhost,127.0.0.1,::1, so its own loopback traffic never comes here.
//
// The check runs on the RESOLVED address, not the name, because a name is what
// an attacker controls (localtest.me and friends resolve to 127.0.0.1). It also
// runs on the literal name before any dial, so the obvious case never opens a
// connection at all.

import dns from 'node:dns';
import net from 'node:net';
/** @typedef {import('./types.js').CodedError} CodedError */

/** Error code carried by a lookup refused by this policy. */
export const FORBIDDEN_FORWARD = 'EFORBIDDENFORWARD';

/** Parse dotted-quad text to four octets, or null. */
function v4Octets(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null. Handles `::`
 * compression and a trailing dotted-quad (`::ffff:127.0.0.1`), which is how
 * Node reports a mapped IPv4 peer on a dual-stack socket.
 */
function v6Groups(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, ''); // drop a zone id (fe80::1%eth0)
  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  let v4tail = [];
  if (tail) {
    const o = v4Octets(tail[1]);
    if (!o) return null;
    v4tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    // Drop the quad and its colon — unless that colon was half of a `::`, as
    // in "::1.2.3.4", where it must survive as the compression marker.
    s = s.slice(0, tail.index);
    if (s.endsWith(':')) s += ':';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':').map((g) => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  }));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const known = head.length + rest.length + v4tail.length;
  if (halves.length === 2 ? known > 7 : known !== 8) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...v4tail];
}

/** Why `ip` (a literal address) may not be a forward target, or null when it may. */
export function forbiddenAddressReason(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const o = v4Octets(ip);
    if (!o) return null;
    if (o[0] === 127) return 'loopback';
    if (o[0] === 0) return 'unspecified';           // 0.0.0.0/8 — connects to loopback
    if (o[0] === 169 && o[1] === 254) return 'link-local';
    return null;
  }
  if (kind === 6) {
    const g = v6Groups(ip);
    if (!g) return null;
    const zeroTo = (n) => g.slice(0, n).every((x) => x === 0);
    if (zeroTo(8)) return 'unspecified';                                   // ::
    if (zeroTo(7) && g[7] === 1) return 'loopback';                        // ::1
    if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';                  // fe80::/10
    // ::ffff:a.b.c.d (mapped) and the deprecated ::a.b.c.d (compatible) both
    // carry an IPv4 address in the low 32 bits; judge that address.
    if (zeroTo(5) && (g[5] === 0xffff || g[5] === 0)) {
      return forbiddenAddressReason(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    return null;
  }
  return null;
}

/** True when a forward to the literal address `ip` must be refused. */
export function isForbiddenForwardAddress(ip) {
  return forbiddenAddressReason(ip) != null;
}

/**
 * Why a forward to `host` — as named by the client, optionally with the address
 * it resolved to — must be refused, or null when it may proceed. `localhost`
 * and `*.localhost` are refused by name (RFC 6761 reserves them for loopback),
 * so no dial is attempted for the obvious spelling.
 */
export function forbiddenForwardReason(host, resolvedAddress = null) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return `${host} is a loopback name`;
  const byName = forbiddenAddressReason(name);
  if (byName) return `${host} is ${article(byName)} ${byName} address`;
  if (resolvedAddress) {
    const byAddr = forbiddenAddressReason(resolvedAddress);
    if (byAddr) return `${host} resolves to ${resolvedAddress}, ${article(byAddr)} ${byAddr} address`;
  }
  return null;
}
const article = (word) => (/^[aeiou]/.test(word) ? 'an' : 'a');

// ── Test hook ────────────────────────────────────────────────
//
// The test suite has no host but this one, so its tunnel and relay tests target
// 127.0.0.1 — exactly what the policy forbids. A server registered here may
// forward to loopback (and only loopback; unspecified and link-local stay
// refused). Keyed on the server object rather than a config or env knob so
// nothing an operator or client can set reaches it: the only way in is a
// process that already holds the server instance.
const loopbackAllowed = new WeakSet();

/** Tests only: permit loopback forward targets on connections `server` accepts. */
export function allowLoopbackForward(server) {
  loopbackAllowed.add(server);
}

/** Whether the server that accepted `socket` is registered by allowLoopbackForward. */
export function loopbackForwardAllowed(socket) {
  const server = socket?.server;
  return !!server && loopbackAllowed.has(server);
}

/**
 * Policy decision for a target the client named and the address it resolved to.
 * `socket` is the inbound client socket (for the test hook).
 */
export function forwardRefusal(host, resolvedAddress, socket) {
  const why = forbiddenForwardReason(host, resolvedAddress);
  if (why && loopbackForwardAllowed(socket) && /loopback/.test(why)) return null;
  return why;
}

/**
 * A `lookup` function for net.connect / http.request that resolves every
 * address of the target and refuses the whole dial if ANY of them is a
 * forbidden destination — before a single SYN is sent. Refusals arrive on the
 * socket as an error with code FORBIDDEN_FORWARD so the caller can turn it into
 * a 403 rather than the 502 a connect failure gets.
 *
 * Resolving all addresses (not just the one Node would pick) closes the
 * dual-stack gap: a name with one public A record and a loopback AAAA record
 * must not become reachable by luck of address selection.
 */
export function guardedLookup(socket, { lookup = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      for (const { address } of list) {
        const why = forwardRefusal(hostname, address, socket);
        if (why) {
          const e = /** @type {CodedError} */ (new Error(`forward to ${hostname} refused: ${why}`));
          e.code = FORBIDDEN_FORWARD;
          return callback(e);
        }
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]?.address, list[0]?.family);
    });
  };
}
