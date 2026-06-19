// sx.org proxy integration — an IP-based-429 workaround.
//
// teamclaude's transient 429s key on the proxy's OUTBOUND IP, not the account,
// so account failover doesn't help. sx.org is a residential proxy-port provider:
// with an API key we provision a port and tunnel upstream Anthropic traffic
// through it, giving a different egress IP. Crucially, TLS terminates END-TO-END
// at the upstream (we `tls.connect` over the tunnel with the upstream's
// servername and the default secure cert check) — the sx.org proxy only ever
// relays ciphertext and cannot see request content.
//
// When no API key is configured (or mode is 'off') this module is dormant and the
// dial paths behave exactly as before — routing is decided per-attempt by
// useByDefault() / useOn429() / useForConnect(), all false until provisioned.

import net from 'node:net';
import tls from 'node:tls';

const CONNECT_TIMEOUT_MS = 30000; // residential exits can be slow to establish

// Resolved per call (not at import) so tests can point it at a local mock.
const sxBase = () => process.env.SX_API_BASE || 'https://api.sx.org';

// ── sx.org REST (apiKey is a query param; these hit api.sx.org directly, never
// the proxy, and are unrelated to Anthropic traffic) ──
async function sxGet(path, apiKey, params = {}) {
  const url = new URL(sxBase() + path);
  url.searchParams.set('apiKey', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return res.json();
}

async function sxPost(path, apiKey, body) {
  const url = new URL(sxBase() + path);
  url.searchParams.set('apiKey', apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export const SX_MODES = ['off', '429', 'always'];
const normalizeMode = (m) => (SX_MODES.includes(m) ? m : 'always');

// Normalize either API shape into { host, port, username, password, portId }.
//   ports-list:  { proxy: "host:port", login, password, id }
//   create-port: { server, port, login, password, id }
function parsePort(p) {
  let host, port;
  if (typeof p.proxy === 'string' && p.proxy.includes(':')) {
    const i = p.proxy.lastIndexOf(':');
    host = p.proxy.slice(0, i); port = p.proxy.slice(i + 1);
  } else {
    host = p.server; port = p.port;
  }
  return { host, port: parseInt(port, 10), username: p.login, password: p.password, portId: p.id };
}

/**
 * Open a CONNECT tunnel through an HTTP proxy to targetHost:targetPort and
 * resolve with the raw (still-plaintext) socket once the proxy answers 200.
 */
export function connectThroughProxy({ proxyHost, proxyPort, auth, targetHost, targetPort, timeout = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let buf = '';
    const timer = setTimeout(() => fail(new Error(`sx.org proxy CONNECT timed out after ${timeout}ms`)), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
    };
    const fail = (err) => { cleanup(); sock.destroy(); reject(err); };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) { if (buf.length > 65536) fail(new Error('sx.org proxy CONNECT response too large')); return; }
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      if (!m || m[1] !== '200') { fail(new Error(`sx.org proxy refused CONNECT: ${statusLine}`)); return; }
      cleanup();
      sock.pause(); // stop flowing so the TLS layer we hand it to sees every byte
      const rest = Buffer.from(buf.slice(idx + 4), 'latin1'); // bytes already past the header
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.once('connect', () => {
      const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
      if (auth) lines.push(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`);
      lines.push('Proxy-Connection: keep-alive', '', '');
      sock.write(lines.join('\r\n'));
    });
    sock.on('data', onData);
    sock.once('error', fail);
  });
}

/**
 * CONNECT through `proxy`, then complete a TLS handshake to targetHost so TLS is
 * end-to-end (the proxy sees ciphertext only). Resolves with the TLSSocket after
 * secureConnect. Cert verification stays at its secure default; tests inject a CA
 * via tlsOptions.ca.
 */
export async function tunnelTls({ proxy, targetHost, targetPort = 443, tlsOptions = {} }) {
  const sock = await connectThroughProxy({
    proxyHost: proxy.host,
    proxyPort: proxy.port,
    auth: proxy.username ? `${proxy.username}:${proxy.password}` : null,
    targetHost,
    targetPort,
  });
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket: sock, servername: targetHost, ...tlsOptions });
    const onErr = (err) => { tlsSock.removeListener('secureConnect', onOk); sock.destroy(); reject(err); };
    const onOk = () => { tlsSock.removeListener('error', onErr); resolve(tlsSock); };
    tlsSock.once('secureConnect', onOk);
    tlsSock.once('error', onErr);
  });
}

/**
 * Holds the sx.org credential + the provisioned proxy. Shared in-process by the
 * reverse proxy, the MITM handler, and the TUI so a key change applies live.
 */
export class SxManager {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.apiKey = null;
    this.proxy = null;   // { host, port, username, password, portId }
    this.mode = 'always'; // off | 429 | always — how routing decisions are made
    this._rlUntil = 0;    // sticky-routing window end (ms) for '429' mode
  }

  isProvisioned() { return !!(this.apiKey && this.proxy); }
  getProxy() { return this.proxy; }
  getMode() { return this.mode; }

  // ── routing decisions ──
  // Reverse-proxy first attempt: only 'always' routes pre-emptively.
  useByDefault() { return this.isProvisioned() && this.mode === 'always'; }
  // Reverse-proxy retry after a 429: 'always' and '429' both route (the 429 is
  // IP-based, so a fresh egress IP can clear it).
  useOn429() { return this.isProvisioned() && this.mode !== 'off'; }
  // MITM connect-time (one tunnel carries many requests, so no per-request
  // failover): 'always' routes; '429' routes only inside the sticky window set
  // when a 429 was recently observed.
  useForConnect() {
    if (!this.isProvisioned() || this.mode === 'off') return false;
    return this.mode === 'always' || this.isRecentlyRateLimited();
  }

  noteRateLimited(seconds = 60) { this._rlUntil = Date.now() + Math.min(Math.max(seconds, 1), 300) * 1000; }
  isRecentlyRateLimited() { return Date.now() < this._rlUntil; }

  /** Set the API key (+ optional mode) and provision unless mode is 'off'. */
  async configure(apiKey, mode = this.mode) {
    this.mode = normalizeMode(mode);
    if (!apiKey) { this.disable(); return { ok: false, error: 'no API key' }; }
    this.apiKey = apiKey;
    if (this.mode === 'off') { this.proxy = null; return { ok: true, mode: this.mode, proxy: null }; }
    return this._ensureProxy();
  }

  /** Switch mode WITHOUT clearing the key; provision lazily when turning on. */
  async setMode(mode) {
    this.mode = normalizeMode(mode);
    if (this.mode === 'off') { this.proxy = null; return { ok: true, mode: this.mode }; }
    if (this.apiKey && !this.proxy) return this._ensureProxy();
    return { ok: true, mode: this.mode, proxy: this.proxy };
  }

  /** Full deconfigure — forget the key entirely. */
  disable() { this.apiKey = null; this.proxy = null; }

  async _ensureProxy() {
    try {
      this.proxy = await this.provision();
      this.log(`[TeamClaude] sx.org proxy ready: ${this.proxy.host}:${this.proxy.port}`);
      return { ok: true, mode: this.mode, proxy: this.proxy };
    } catch (err) {
      this.proxy = null;
      this.log(`[TeamClaude] sx.org provisioning failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** Account balance/traffic, or null on error. */
  async getBalance() {
    if (!this.apiKey) return null;
    try {
      const r = await sxGet('/v2/user/balance', this.apiKey);
      return r?.success ? r : null;
    } catch { return null; }
  }

  /** Reuse an active port if one exists, else create a residential US one. */
  async provision() {
    if (!this.apiKey) throw new Error('sx.org API key not set');
    const list = await sxGet('/v2/proxy/ports', this.apiKey, { per_page: 50 });
    const proxies = list?.message?.proxies || [];
    const active = proxies.find((p) => p.status === 1 && p.login && p.password && p.proxy);
    if (active) return parsePort(active);

    const created = await sxPost('/v2/proxy/create-port', this.apiKey, {
      country_code: 'US', proxy_type_id: 1, type_id: 1, // type_id 1 = residential
    });
    if (!created?.success || !created.data) {
      const detail = created?.errors ? JSON.stringify(created.errors) : (created?.message || JSON.stringify(created));
      throw new Error(`sx.org create-port failed: ${detail}`);
    }
    return parsePort(created.data);
  }
}
