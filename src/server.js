import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCerts, createConnectHandler } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { parseRequestModel } from './account-manager.js';
import { BodyWriter } from './request-log.js';
import { upstreamFetch } from './upstream-fetch.js';


export const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
const INLINE_RETRY_AFTER_MAX_SECONDS = 15;

// Response header names that are connection-specific and thus illegal on an
// HTTP/2 response (Node's Http2ServerResponse.writeHead rejects them). Also
// hop-by-hop on h1, so stripping them is correct on both paths.
const CONNECTION_SPECIFIC_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'te', 'trailer',
]);

export function createProxyServer(accountManager, config, hooks = {}, sx = null) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const requestHandler = async (req, res) => {
    try {
      // Auth check — skip for localhost connections.
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      // Reload endpoint — re-sync accounts from config without a restart. This
      // is the headless equivalent of pressing 'R' in the TUI. Local control
      // only (no upstream calls); the auth gate above already applies.
      if (req.method === 'POST' && req.url === '/teamclaude/reload') {
        if (!hooks.reload) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload not supported' }));
          return;
        }
        try {
          const added = await hooks.reload();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, added: added || 0 }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      return forward(req, res);
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };

  const forward = createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx });
  const server = http.createServer(requestHandler);

  // Forward-proxy support (always on, so multiple claude instances can use
  // either ANTHROPIC_BASE_URL or HTTPS_PROXY against the same server). A CONNECT
  // to the upstream host is a transparent MITM relay (rewrite only auth); the
  // test host is answered locally; anything else is blind-tunneled. Certs are
  // minted lazily on the first intercepted CONNECT.
  const mitmHost = (() => { try { return new URL(upstream).hostname; } catch { return 'api.anthropic.com'; } })();
  let certsPromise = null;
  const ensureLeaf = async () => {
    certsPromise ||= ensureCerts(mitmHost);
    const c = await certsPromise;
    return { key: c.leafKeyPem, cert: c.leafCertPem };
  };
  server.on('connect', createConnectHandler({ config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx }));

  return server;
}

/**
 * Build the core proxy request listener — buffer the body, then forward with
 * account selection + retry (forwardRequest). Shared by the base HTTP server and
 * the MITM's terminating h2/h1 server, so both get identical buffering, model-
 * aware routing, and retry-on-quota behavior. Control endpoints (status/reload)
 * and the proxy-API-key gate live in the base server's wrapper, not here.
 */
export function createProxyRequestListener({ accountManager, upstream, logDir = null, hooks = {}, sx = null }) {
  let counter = 0;
  return async (req, res) => {
    try {
      // Client token refresh: pass through untouched (the proxy manages its own
      // tokens via ensureTokenFresh; rewriting client refreshes would conflict).
      if (req.method === 'POST' && req.url === '/v1/oauth/token') { await relayRaw(req, res, upstream, sx); return; }
      // Remote Control (/v1/code/*) is bound to the session's paired claude.ai
      // identity — forward with the client's OWN credential (streamed), never a
      // rotated account token, which would 403 the worker event stream.
      if ((req.url || '').startsWith('/v1/code/')) { await relayStream(req, res, upstream, sx); return; }

      const reqId = ++counter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed to resend on a different account after a 429).
      const bodyChunks = [];
      for await (const chunk of req) bodyChunks.push(chunk);
      const body = Buffer.concat(bodyChunks);

      const ctx = { account: null, status: null, tried: new Set(), model: parseRequestModel(body) };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status, model: ctx.model });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };
}

/**
 * Stream a request through to upstream with the client's OWN headers intact
 * (including its authorization) and stream the response back — used for Remote
 * Control (/v1/code/*), whose event stream must keep the paired credential and
 * cannot be buffered.
 */
async function relayStream(req, res, upstream, sx) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  try {
    const upstreamRes = await upstreamFetch(`${upstream}${req.url}`, {
      method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : (body.length ? body : undefined),
      redirect: 'manual',
    }, sx, sx?.useByDefault());

    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key) || key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    if (upstreamRes.body) { for await (const chunk of upstreamRes.body) res.write(chunk); }
    res.end();
  } catch (err) {
    console.error('[TeamClaude] Remote Control relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream, sx) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await upstreamFetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    }, sx, sx?.useByDefault());

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// A per-request log that streams to disk as the request/response flow, instead
// of buffering the whole body in memory and writing once at the end. The file
// is opened on first write; header sections are written verbatim and bodies are
// streamed through BodyWriter (JSON pretty-printed on the fly, SSE/other raw),
// so even a ~1M-token response costs only the current chunk.
function openRequestLog(logDir, reqId) {
  const filename = `${logTimestamp()}_${String(reqId).padStart(5, '0')}.log`;
  const ws = createWriteStream(join(logDir, filename), { flags: 'a' });
  ws.on('error', (err) => console.error(`[TeamClaude] Failed to write log: ${err.message}`));
  let ended = false;
  const write = (s) => { if (!ended && s) ws.write(Buffer.from(String(s), 'latin1')); };
  return {
    write,
    // Stream a complete body buffer under a section header.
    body(label, buf, contentType) {
      if (!buf || !buf.length) { write(`\n\n=== ${label} ===\n(empty)`); return; }
      new BodyWriter(write, label, contentType || '').chunk(buf);
    },
    // A BodyWriter to append chunks incrementally (e.g. an SSE response).
    bodyWriter(label, contentType) { return new BodyWriter(write, label, contentType || ''); },
    end() { if (!ended) { ended = true; ws.end('\n'); } },
  };
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

export async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, useSx) {
  const maxRetries = accountManager.accounts.length;
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;

  // Select account, skipping any already tried (and failed) this request.
  // The model scopes availability so a Fable-exhausted account is skipped only
  // for Fable requests (it still serves other models).
  const account = accountManager.getActiveAccount(ctx.tried, ctx.model);
  if (!account) {
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    const exhaustedRetries = ctx.exhaustedRetries || 0;
    if (exhaustedRetries < 1 && retryAfter <= INLINE_RETRY_AFTER_MAX_SECONDS) {
      ctx.exhaustedRetries = exhaustedRetries + 1;
      console.log(`[TeamClaude] All accounts exhausted — waiting ${retryAfter}s before retry`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    ctx.tried.add(account.index);
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // HTTP/2 pseudo-headers (:method, :path, :authority, :scheme) live in
    // req.headers on the h2 server path; fetch rejects `:`-prefixed names.
    if (lk.startsWith(':')) continue;
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }

  const upstreamUrl = `${upstream}${req.url}`;
  const method = req.method;

  // Align the body's account_uuid (in metadata.user_id) with the account whose
  // token we're injecting (same-length patch; no-op if absent).
  const sendBody = account.accountUuid ? patchAccountUuid(body, account.accountUuid) : body;

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => (logDir ? (log ||= openRequestLog(logDir, reqId)) : null);
  const logRequestHead = () => {
    const l = getLog();
    if (!l || reqLogged) return;
    reqLogged = true;
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    if (safeHeaders['authorization']) safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    l.write(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`);
    if (body.length > 0) l.body('REQUEST BODY', body, req.headers['content-type']);
  };

  try {
    const upstreamRes = await upstreamFetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
      redirect: 'manual',
    }, sx, route);

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // On 429, wait the retry-after duration and retry on the same account
    // (this is a transient rate limit, not quota exhaustion).
    if (upstreamRes.status === 429) {
      // Clamp Retry-After to a sane window: missing/invalid falls back to 60s,
      // and out-of-range values are bounded to [1, 300]. A negative value would
      // otherwise bypass the retry cap — setTimeout returns immediately and
      // markRateLimited would set rateLimitedUntil in the past.
      let retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10);
      if (Number.isNaN(retryAfter)) retryAfter = 60;
      // Discard the 429 response body
      await upstreamRes.body?.cancel();

      // Durable quota exhaustion vs. a transient rate limit. A "rejected" unified
      // status means a quota bucket is spent, so waiting and retrying the SAME
      // account is futile — switch to another account now (updateQuota above
      // already recorded the spent bucket's utilization from the headers).
      const rl = rateLimitHeaders;
      const generalRejected = rl['anthropic-ratelimit-unified-5h-status'] === 'rejected'
        || rl['anthropic-ratelimit-unified-7d-status'] === 'rejected';
      const fableRejected = rl['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected' && !generalRejected;
      if ((generalRejected || fableRejected) && retryCount < maxRetries) {
        // A Fable-only rejection leaves the account fine for other models, so we
        // do NOT throttle it globally — the recorded Fable utilization makes
        // selection skip it for Fable requests only. A general rejection spends a
        // shared bucket, so hold the whole account for its reset window.
        if (fableRejected) {
          console.log(`[TeamClaude] Fable weekly exhausted on "${account.name}" — switching account for this Fable request`);
        } else {
          const hold = Math.min(Math.max(retryAfter, 1), 3600);
          console.log(`[TeamClaude] Quota rejection (429) on "${account.name}" — throttling ${hold}s and switching account`);
          accountManager.markRateLimited(account.index, hold);
        }
        ctx.tried.add(account.index);
        if (res.destroyed) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }

      retryAfter = Math.min(Math.max(retryAfter, 1), 300);

      // sx.org failover: 429s are IP-based, so retry via the proxy's egress IP.
      // 'always' is already on sx; '429' switches direct→sx now and skips the
      // wait (a fresh IP isn't throttled). Also arm the sticky window for MITM.
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route;
      sx?.noteRateLimited(retryAfter);

      // Bound the retries: a persistently-throttled upstream must not loop
      // forever (that would tie up the client connection indefinitely).
      // Once retries are exhausted, throttle this account and re-dispatch —
      // getActiveAccount then picks another account, or returns 429 to the
      // client if every account is throttled.
      if (retryCount >= maxRetries) {
        console.log(`[TeamClaude] Persistent 429 on "${account.name}" — throttling ${retryAfter}s and re-dispatching`);
        accountManager.markRateLimited(account.index, retryAfter);
        if (res.destroyed) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

    if (!switchingToSx && retryAfter > INLINE_RETRY_AFTER_MAX_SECONDS) {
      console.log(`[TeamClaude] 429 on "${account.name}" — throttling ${retryAfter}s and re-dispatching without waiting`);
      accountManager.markRateLimited(account.index, retryAfter);
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
    }

    if (switchingToSx) {
      console.log(`[TeamClaude] 429 on "${account.name}" — retrying via sx.org (fresh egress IP)`);
    } else {
        console.log(`[TeamClaude] 429 on "${account.name}" — waiting ${retryAfter}s before retry`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      }
      // Client may have disconnected during the wait
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
    }

    // Log the request head (once) followed by the response headers, streaming
    // to disk from here on.
    logRequestHead();
    getLog()?.write(`\n\n=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers). The
    // connection-specific names are also illegal on an HTTP/2 response — when
    // this runs behind the MITM's h2 server, writeHead would otherwise throw.
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      const l = getLog();
      if (l) { l.write('\n\n=== RESPONSE BODY ===\n(empty)'); l.end(); }
      res.end();
      return;
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming) {
      // Stream each chunk straight to the log as it is relayed — never hold the
      // whole (potentially ~1M-token) SSE body in memory.
      const l = getLog();
      const bw = l ? l.bodyWriter('RESPONSE BODY (streamed)', contentType) : null;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, bw);
      l?.end();
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT');

    // Transient network errors: just close the connection and let the client retry
    if (isTransient) {
      res.destroy();
      return;
    }

    // Any other thrown error is a transport/stream failure, NOT proof the
    // account's credentials are bad — a bad credential comes back as a 401
    // *response*, never a throw. So don't sideline the account (that would drop
    // a healthy account from rotation until a credential change). Instead skip
    // it for the rest of THIS request only and fail over to another account.
    if (retryCount < maxRetries && !res.headersSent) {
      ctx.tried.add(account.index);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      // Append to the log as it streams (no whole-body buffering)
      if (bodyWriter) bodyWriter.chunk(Buffer.from(value));

      const text = decoder.decode(value, { stream: true });

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = acct.rateLimitedUntil || acct.quota.resetsAt;
    if (reset) {
      const ms = new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}
