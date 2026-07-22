// Zero-dependency `fetch` shim that routes upstream requests through the sx.org
// proxy when it is enabled. With sx disabled it IS global fetch (byte-for-byte
// the same behavior), so the default path is unchanged.
//
// Node's global fetch can't use a CONNECT proxy without `undici` (a dependency —
// and "zero dependencies" is a project feature), so when sx is enabled we issue
// the request with `https.request` over a tunneled TLS socket and return a small
// object exposing exactly the fetch-Response surface src/server.js relies on:
// `status`, `headers.get()/.entries()`, `text()`, `arrayBuffer()`, and `body`
// (a web ReadableStream, so streamResponse()'s getReader()/cancel() is untouched).

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { tunnelTls } from './sx.js';

// Pooled keep-alive agents for the direct (non-sx) path. Node's global fetch
// multiplexes ALL requests to an origin over a SINGLE HTTP/2 connection; under
// many concurrent large uploads (Claude Code POSTs ~1MB of context per turn)
// that one connection serializes on HTTP/2's shared flow-control windows —
// api.anthropic.com advertises maxConcurrentStreams=100 (not the limit) but only
// a 64KB initial window, so concurrent uploads queue behind WINDOW_UPDATEs and a
// trivial request can wait minutes for headers (issue #106). Independent HTTP/1.1
// connections have no application-layer flow control: each upload fills its own
// socket at TCP speed, exactly like N direct Claude Code processes. keep-alive
// reuses idle sockets (Node unrefs them, so they don't hold the process open);
// maxSockets is per-origin and bounds the fan-out. Escape hatch:
// TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH=1 reverts to the old global-fetch path.
const MAX_SOCKETS = Number(process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS) || 256;
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
const USE_GLOBAL_FETCH = /^(1|true|yes|on)$/i.test(process.env.TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH || '');

// Time to wait for RESPONSE HEADERS before treating the upstream socket as dead.
// This is NOT a limit on the response body (SSE completions can stream for
// minutes); the deadline is cleared the instant headers arrive, so a slow, long
// answer is never cut. It measures time-to-first-byte only, which streaming
// delivers within seconds, and its job is to convert an indefinite hang on a
// half-dead pooled socket (e.g. after the host's network drops and reconnects,
// leaving Node's global fetch pool holding stale keep-alive connections) into a
// fast, retryable failure. Without it a reused dead socket hangs until Node's
// 300s default, long past the point the client gave up, and only a full process
// restart clears the poisoned pool. Each aborted request evicts one dead socket,
// so a burst of stale connections drains over the next few retries.
//
// NOTE (non-streaming requests): for a request without `stream: true`, the whole
// response arrives as the "headers+body" unit, so first-byte ≈ full generation.
// Claude Code's completions stream, so this is safe in practice, but a very long
// non-streaming generation could trip this — raise it per-call or via the env var
// for such callers. Mid-stream stalls (a drop AFTER headers) are handled
// separately by the body-idle watchdog in server.js's streamResponse.
//
// We abort ONLY in the pre-headers window and clear the timer once the body
// starts, so we never abort mid-stream. That matters: an AbortSignal fired after
// data has started leaves the socket occupied and leaks a "zombie" connection
// that drains the pool over time; aborting before the first byte lets undici
// destroy the socket cleanly instead. The textbook fix is dispatcher-level
// timeouts via undici's setGlobalDispatcher(new Agent({ headersTimeout,
// keepAliveTimeout })); we stay zero-dependency, so this reactive guard is the
// stand-in.
//
// Default is generous (well above Claude's realistic first-byte, even when
// queued or under load) so a slow-but-legitimate response is never mistaken for
// a dead socket. Override with TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS (or
// per-call opts).
const DEFAULT_HEADERS_TIMEOUT_MS = 120_000;

function resolveHeadersTimeout(perCall) {
  if (perCall != null) return perCall;
  const env = Number(process.env.TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS);
  return env > 0 ? env : DEFAULT_HEADERS_TIMEOUT_MS;
}

function headersTimeoutError(ms) {
  const err = new Error(`upstream response headers timed out after ${ms}ms`);
  // Recognized by server.js isTransient → fail fast + let the client retry, so
  // Node's fetch pool evicts the stale connection instead of wedging.
  err.code = 'TEAMCLAUDE_HEADERS_TIMEOUT';
  return err;
}

// `useProxy` is decided by the caller (it varies per attempt — e.g. direct first,
// then via sx after a 429). With it false, or sx unprovisioned, this is plain fetch
// (plus the headers-timeout guard).
export function upstreamFetch(url, opts = {}, sx = null, useProxy = false) {
  const { headersTimeoutMs, ...fetchOpts } = opts;
  const timeoutMs = resolveHeadersTimeout(headersTimeoutMs);
  if (sx && useProxy && sx.isProvisioned()) return proxiedFetch(url, fetchOpts, sx, timeoutMs);
  return USE_GLOBAL_FETCH ? directFetch(url, fetchOpts, timeoutMs) : pooledFetch(url, fetchOpts, timeoutMs);
}

// Default direct path: HTTP/1.1 over a pooled keep-alive agent, so N concurrent
// requests use N connections instead of serializing over one h2 connection (#106).
function pooledFetch(url, opts, timeoutMs) {
  const u = new URL(url);
  const isHttp = u.protocol === 'http:';
  return nodeRequest(u, opts, timeoutMs, { transport: isHttp ? http : https, agent: isHttp ? httpAgent : httpsAgent });
}

// Legacy direct path (escape hatch): Node global fetch, driven by our own
// AbortController so we can arm a headers-only deadline and disarm it the moment
// headers arrive (letting the body stream with no deadline). AbortSignal.timeout
// can't do this — it would also kill the body.
function directFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(headersTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  return fetch(url, { ...opts, signal: ctrl.signal }).then(
    (res) => { clearTimeout(timer); return res; },
    (err) => { clearTimeout(timer); throw err; },
  );
}

// sx path: every socket is a fresh TLS connection tunneled through sx.org. The
// agent is created per request (its createConnection closes over this call's
// target), so keep-alive would give no reuse — it would only park the tunneled
// socket in a soon-orphaned pool and leak an open sx.org connection per request.
function proxiedFetch(url, opts, sx, timeoutMs) {
  const u = new URL(url);
  const proxy = sx.getProxy();
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, cb) => {
    // sx.tlsOptions is undefined in production (system CAs verify api.anthropic.com);
    // tests inject a CA here to reach a self-signed upstream.
    tunnelTls({ proxy, targetHost: u.hostname, targetPort: Number(u.port) || 443, tlsOptions: sx.tlsOptions || {} })
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err));
    return undefined; // socket delivered asynchronously via cb
  };
  return nodeRequest(u, opts, timeoutMs, { transport: https, agent });
}

// Shared node:http(s) request → the fetch-Response subset server.js uses, with
// the headers-only deadline: it fires before headers arrive and tears the request
// down; it is cleared the instant the response starts, so a body that streams for
// minutes is never cut. `req` is created BEFORE the timer so a synchronous
// throw (e.g. an invalid client header) can't leave a scheduled timer that later
// fires against an uninitialized binding.
function nodeRequest(u, opts, timeoutMs, { transport, agent }) {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      u,
      { method: opts.method || 'GET', headers: opts.headers || {}, agent },
      (res) => { clearTimeout(timer); resolve(makeResponse(res)); },
    );
    const timer = setTimeout(() => req.destroy(headersTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    req.once('error', (err) => { clearTimeout(timer); reject(err); });

    const body = opts.body;
    const method = (opts.method || 'GET').toUpperCase();
    if (body == null || method === 'GET' || method === 'HEAD') req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(Buffer.from(body));
    else req.end(String(body));
  });
}

// Wrap a Node IncomingMessage as the subset of a fetch Response that server.js uses.
function makeResponse(res) {
  const web = Readable.toWeb(res); // single web stream — one consumer either way
  const collect = async () => {
    const chunks = [];
    const reader = web.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  };
  return {
    status: res.statusCode,
    headers: makeHeaders(res.headers),
    body: web,
    async text() { return (await collect()).toString('utf8'); },
    async arrayBuffer() { const b = await collect(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}

// res.headers already has lowercased keys; values are string | string[] (set-cookie).
function makeHeaders(h) {
  const flat = (v) => (Array.isArray(v) ? v.join(', ') : v);
  const entries = function* () { for (const [k, v] of Object.entries(h)) yield [k, flat(v)]; };
  return {
    get: (name) => { const v = h[name.toLowerCase()]; return v == null ? null : flat(v); },
    entries,
    [Symbol.iterator]: entries,
  };
}
