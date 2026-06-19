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

import https from 'node:https';
import { Readable } from 'node:stream';
import { tunnelTls } from './sx.js';

// `useProxy` is decided by the caller (it varies per attempt — e.g. direct first,
// then via sx after a 429). With it false, or sx unprovisioned, this is plain fetch.
export function upstreamFetch(url, opts = {}, sx = null, useProxy = false) {
  if (!sx || !useProxy || !sx.isProvisioned()) return fetch(url, opts);
  return proxiedFetch(url, opts, sx);
}

function proxiedFetch(url, opts, sx) {
  const u = new URL(url);
  const proxy = sx.getProxy();

  // Custom agent: every socket is a TLS connection tunneled through sx.org.
  const agent = new https.Agent({ keepAlive: true });
  agent.createConnection = (_options, cb) => {
    // sx.tlsOptions is undefined in production (system CAs verify api.anthropic.com);
    // tests inject a CA here to reach a self-signed upstream.
    tunnelTls({ proxy, targetHost: u.hostname, targetPort: Number(u.port) || 443, tlsOptions: sx.tlsOptions || {} })
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err));
    return undefined; // socket delivered asynchronously via cb
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      { method: opts.method || 'GET', headers: opts.headers || {}, agent },
      (res) => resolve(makeResponse(res)),
    );
    req.once('error', reject);

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
