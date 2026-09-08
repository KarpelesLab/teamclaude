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
import { ReadableStream } from 'node:stream/web';
import { tunnelTls } from './sx.js';
import { proxyForHost, proxyAgent } from './upstream-proxy.js';
import { AdmissionGate, DEFAULT_MAX_QUEUE, DEFAULT_QUEUE_TIMEOUT_MS } from './admission-gate.js';

// Pooled keep-alive agents for the direct (non-sx) path. Node's global fetch
// multiplexes ALL requests to an origin over a SINGLE HTTP/2 connection; under
// many concurrent large uploads (Claude Code POSTs ~1MB of context per turn)
// that one connection serializes on HTTP/2's shared flow-control windows —
// api.anthropic.com advertises maxConcurrentStreams=100 (not the limit) but only
// a 64KB initial window, so concurrent uploads queue behind WINDOW_UPDATEs and a
// trivial request can wait minutes for headers (issue #106). Independent HTTP/1.1
// connections have no application-layer flow control: each upload fills its own
// socket at TCP speed, exactly like N direct Claude Code processes. maxSockets is
// per-origin and bounds the fan-out. Escape hatch:
// TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH=1 reverts to the old global-fetch path.
export const DEFAULT_UPSTREAM_MAX_SOCKETS = 256;
const MAX_SOCKETS = positiveInt(process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS, DEFAULT_UPSTREAM_MAX_SOCKETS);

// Admission in front of the pool. Node's Agent queues a request past
// maxSockets internally, without bound and without a deadline, and destroying
// a request parked in that queue need not surface an error until it is handed
// a socket — so a client that had already gone away kept its (megabyte) body
// retained until a long-lived stream ahead of it ended. Requests are admitted
// here, per origin, BEFORE the ClientRequest exists: the queue is bounded
// (TEAMCLAUDE_UPSTREAM_MAX_QUEUE), the wait is bounded
// (TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS), and a caller whose signal aborts
// leaves the queue immediately. A request the gate turns away fails with
// TEAMCLAUDE_UPSTREAM_OVERLOADED, which server.js answers with a 503 and no
// account rotation: the proxy is saturated, not the account. The limit is
// MAX_SOCKETS itself, so an admitted request always finds a pooled socket
// free (a permit is held until the response body ends or is dropped).
export const DEFAULT_UPSTREAM_MAX_QUEUE = DEFAULT_MAX_QUEUE;
export const DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS = DEFAULT_QUEUE_TIMEOUT_MS;
const MAX_QUEUE = nonNegativeInt(process.env.TEAMCLAUDE_UPSTREAM_MAX_QUEUE, DEFAULT_UPSTREAM_MAX_QUEUE);
const QUEUE_TIMEOUT_MS = positiveInt(process.env.TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS, DEFAULT_UPSTREAM_QUEUE_TIMEOUT_MS);
const admissionByOrigin = new Map();

// Counters only (no origins, no request data): for the status endpoint.
export function upstreamPoolStatus() {
  let active = 0, queued = 0;
  for (const gate of admissionByOrigin.values()) { active += gate.active; queued += gate.queue.length; }
  return { active, queued, origins: admissionByOrigin.size, perOriginLimit: MAX_SOCKETS, maxQueue: MAX_QUEUE, queueTimeoutMs: QUEUE_TIMEOUT_MS };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
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
  const { headersTimeoutMs, queueTimeoutMs, ...fetchOpts } = opts;
  const timeoutMs = resolveHeadersTimeout(headersTimeoutMs);
  // The admission wait is a per-call option of the node:http paths only; the
  // global-fetch escape hatch is not gated (it has no socket pool to protect).
  const nodeOpts = queueTimeoutMs == null ? fetchOpts : { ...fetchOpts, queueTimeoutMs };
  if (sx && useProxy && sx.isProvisioned()) return proxiedFetch(url, nodeOpts, sx, timeoutMs);
  // The global-fetch escape hatch cannot speak CONNECT (that is why the tunnel
  // is hand-rolled at all), so an upstream proxy overrides it rather than being
  // silently dropped — on a host that needs the proxy, ignoring it means every
  // request fails.
  const useGlobal = USE_GLOBAL_FETCH && !proxyForHost(new URL(url).hostname);
  return useGlobal ? directFetch(url, fetchOpts, timeoutMs) : pooledFetch(url, nodeOpts, timeoutMs);
}

/**
 * `fetch` for teamclaude's own control-plane calls — OAuth token exchange and
 * refresh, profile, usage. Identical to global fetch when no upstream proxy is
 * configured; tunneled through it when one is.
 *
 * These are not request-forwarding traffic, but they are the calls that decide
 * whether an account can be added or kept alive at all. Leaving them direct
 * would mean `login` fails and every token refresh dies on a host that can only
 * reach the network through a proxy, which is precisely the reported setup.
 */
export function proxyFetch(url, opts = {}) {
  const { headersTimeoutMs, ...rest } = opts;
  if (!proxyForHost(new URL(url).hostname)) return fetch(url, rest);
  return pooledFetch(url, rest, resolveHeadersTimeout(headersTimeoutMs));
}

// Default direct path: HTTP/1.1 over a pooled keep-alive agent, so N concurrent
// requests use N connections instead of serializing over one h2 connection (#106).
//
// "Direct" here means "not via sx". A configured upstream proxy (config
// `upstreamProxy`, or HTTPS_PROXY — see upstream-proxy.js) still applies: on
// those hosts there is no such thing as a direct socket to api.anthropic.com,
// which is the whole of issue #155.
function pooledFetch(url, opts, timeoutMs) {
  const u = new URL(url);
  const isHttp = u.protocol === 'http:';
  const port = Number(u.port) || (isHttp ? 80 : 443);
  const proxy = proxyForHost(u.hostname);
  if (proxy) {
    const agent = proxyAgent(proxy, { targetHost: u.hostname, targetPort: port, tls: !isHttp, tlsOptions: opts.tlsOptions || {} });
    return nodeRequest(u, opts, timeoutMs, { transport: isHttp ? http : https, agent });
  }
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
  // The caller's signal (the client went away) is relayed onto ours for the
  // same pre-headers window as the timer, and detached with it: aborting an
  // undici fetch mid-body is what leaks the zombie connections described
  // above. Relayed by hand rather than with AbortSignal.any, which needs
  // Node 20.3 while package.json admits 20.0.
  const caller = opts.signal;
  const relay = () => ctrl.abort(caller.reason);
  if (caller?.aborted) relay();
  else caller?.addEventListener?.('abort', relay, { once: true });
  const settled = () => { clearTimeout(timer); caller?.removeEventListener?.('abort', relay); };
  return fetch(url, { ...opts, signal: ctrl.signal }).then(
    (res) => { settled(); return res; },
    (err) => { settled(); throw err; },
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
async function nodeRequest(u, opts, timeoutMs, { transport, agent }) {
  // Admit before constructing the ClientRequest (see the admission comment at
  // the top). A caller that is turned away, or whose signal aborts while it
  // waits, never touches Node's Agent queue and drops its body right here.
  let gate = admissionByOrigin.get(u.origin);
  if (!gate) {
    gate = new AdmissionGate(MAX_SOCKETS, MAX_QUEUE);
    admissionByOrigin.set(u.origin, gate);
  }
  const forget = () => { if (!gate.active && !gate.queue.length && admissionByOrigin.get(u.origin) === gate) admissionByOrigin.delete(u.origin); };
  const admitted = await gate.enter({ signal: opts.signal, timeoutMs: opts.queueTimeoutMs ?? QUEUE_TIMEOUT_MS });
  if (!admitted) {
    forget();
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const err = new Error(`upstream admission queue for ${u.origin} is full or its wait deadline passed`);
    err.code = 'TEAMCLAUDE_UPSTREAM_OVERLOADED';
    throw err;
  }
  // Idempotent: the permit is released on whichever of the response's end,
  // close, error or the request's error comes first, and every path that can
  // drop the response body unread destroys it (nodeToWeb's cancel), so a
  // dropped body still closes and still releases.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    gate.leave();
    forget();
  };
  try {
    return await sendNodeRequest(u, opts, timeoutMs, { transport, agent }, release);
  } catch (err) { release(); throw err; }
}

function sendNodeRequest(u, opts, timeoutMs, { transport, agent }, release) {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      u,
      { method: opts.method || 'GET', headers: opts.headers || {}, agent },
      (res) => {
        clearTimeout(timer);
        const finish = () => { cleanupAbort(); release(); };
        res.once('end', finish);
        res.once('close', finish);
        res.once('error', finish);
        resolve(makeResponse(res));
      },
    );
    const timer = setTimeout(() => req.destroy(headersTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();

    // Honour an AbortSignal the way fetch does. Callers that already guard a
    // hung call this way (oauth's refresh timeout, which otherwise wedges every
    // request for that account) must keep working when the call is tunneled.
    // The listener stays attached through the body: unlike undici, destroying
    // a node:http request mid-body tears the socket down cleanly, and a client
    // that leaves mid-stream should not keep the upstream socket (and its
    // permit) busy until the body-idle watchdog fires.
    const signal = opts.signal;
    const onAbort = () => req.destroy(signal?.reason ?? new Error('aborted'));
    const cleanupAbort = () => signal?.removeEventListener?.('abort', onAbort);
    // Registered before the aborted check below: a synchronous req.destroy()
    // there must find its error listener in place.
    req.once('error', (err) => { clearTimeout(timer); cleanupAbort(); release(); reject(err); });
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); req.destroy(); reject(signal.reason ?? new Error('aborted')); return; }
      signal.addEventListener?.('abort', onAbort, { once: true });
    }

    const body = opts.body;
    const method = (opts.method || 'GET').toUpperCase();
    if (body == null || method === 'GET' || method === 'HEAD') req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(Buffer.from(body));
    else req.end(String(body));
  });
}

// Adapt a Node IncomingMessage to a web ReadableStream. Done by hand rather than
// Readable.toWeb because that adapter double-closes the controller on Node 18
// (ERR_INVALID_STATE "Controller is already closed" when the socket's 'close'
// fires after 'end'), which crashes the process. The `closed` guard makes close
// idempotent; backpressure via pause/resume so a slow consumer doesn't buffer the
// whole (possibly minutes-long) stream in memory.
function nodeToWeb(res) {
  let closed = false;
  const close = (controller) => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* already closed / consumer gone */ }
  };
  return new ReadableStream({
    start(controller) {
      res.on('data', (chunk) => {
        try { controller.enqueue(chunk); } catch { return; }
        if (controller.desiredSize != null && controller.desiredSize <= 0) res.pause();
      });
      res.on('end', () => close(controller));
      res.on('close', () => close(controller));
      res.on('error', (err) => {
        if (closed) return;
        closed = true;
        try { controller.error(err); } catch { /* consumer gone */ }
      });
    },
    pull() { res.resume(); },
    cancel() { res.destroy(); },
  });
}

// Wrap a Node IncomingMessage as the subset of a fetch Response that server.js uses.
function makeResponse(res) {
  const web = nodeToWeb(res); // single web stream — one consumer either way
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
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: makeHeaders(res.headers),
    body: web,
    async json() { return JSON.parse((await collect()).toString('utf8')); },
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
