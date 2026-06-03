import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// Max tolerated upstream silence, in ms. Bounds both the wait for the response
// head (time-to-first-byte) AND the gap between chunks once a stream is flowing,
// so a hung connection can't stall the client forever — before or after headers.
// A healthy stream gets SSE keepalive pings well inside this window, so it only
// trips on a dead upstream. Overridable via config.upstreamTimeoutMs.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;
// Brief cooldown applied to an account after a network-level failure (not a 429),
// so the immediate failover retry picks a different account and the erroring one
// auto-recovers shortly after.
const NETWORK_ERROR_COOLDOWN_S = 30;

export function createProxyServer(accountManager, config, hooks = {}, admin = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  let requestCounter = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
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

      // Reload endpoint — re-sync accounts from disk config (add new, remove
      // deleted, refresh credentials) on the running server, no restart.
      if (req.method === 'POST' && req.url === '/teamclaude/reload') {
        if (!admin.reload) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_implemented', message: 'Reload not available' } }));
          return;
        }
        // Drain any request body before responding
        for await (const _chunk of req) { /* ignore */ }
        try {
          const summary = await admin.reload();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...summary }, null, 2));
        } catch (err) {
          console.error('[TeamClaude] Reload failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'reload_error', message: err.message } }));
        }
        return;
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, upstreamTimeoutMs);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    });

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

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const maxRetries = accountManager.accounts.length;

  // Select account
  const account = accountManager.getActiveAccount();
  if (!account) {
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
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
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, upstreamTimeoutMs);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
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

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  // Bound time-to-first-byte so a hung upstream can't stall the request forever
  // (no failover, no log). Cleared the moment headers arrive, so a long stream is
  // never cut off — only the wait for the response head is bounded.
  const controller = new AbortController();
  const ttfbTimer = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(ttfbTimer);

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // A 429 means this account is rate-limited or out of quota. Mark it
    // unavailable for the retry-after window and immediately fail over to the
    // next available account, rather than holding the client connection open
    // waiting on a dead account (for quota exhaustion retry-after can be hours).
    // Once every account is throttled, getActiveAccount() returns null on the
    // next pass and the client gets a 429 with a proper retry-after to back off.
    if (upstreamRes.status === 429) {
      const retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10) || 60;
      // Discard the 429 response body
      await upstreamRes.body?.cancel();
      accountManager.markRateLimited(account.index, retryAfter);

      if (logDir) {
        logSections.push(`=== RESPONSE 429 — "${account.name}" rate-limited ${retryAfter}s, failing over ===\n${formatHeaders(upstreamRes.headers)}`);
      }
      console.log(`[TeamClaude] 429 on "${account.name}" — rate-limited ${retryAfter}s, failing over`);

      if (retryCount < maxRetries && !res.headersSent) {
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, upstreamTimeoutMs);
      }

      // Retries exhausted — tell the client to back off.
      ctx.status = 429;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      if (!res.headersSent) {
        const clientRetryAfter = computeRetryAfter(accountManager.getStatus().accounts);
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after': String(clientRetryAfter),
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `All ${accountManager.accounts.length} accounts rate-limited. Retry in ${clientRetryAfter}s.`,
          },
        }));
      }
      return;
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

    ctx.status = upstreamRes.status;

    // Learn the OAuth-acceptable request shape from successful Claude Code
    // traffic so the quota prober can replay it against idle accounts. Only on
    // 2xx, so a rejected model/beta/system never poisons the template.
    if (upstreamRes.status >= 200 && upstreamRes.status < 300 &&
        req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      hooks.recordPoke?.(req.headers, body);
    }

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end();
      return;
    }

    const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

    if (isStreaming) {
      const streamLog = logDir ? [] : null;
      const { upstreamFailed } = await streamResponse(
        upstreamRes.body, res, account.index, accountManager, streamLog, controller, upstreamTimeoutMs,
      );
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      // The stream died mid-flight (upstream reset/terminated, or went silent
      // past the idle timeout) while the client was still connected. We can't
      // retry the in-flight request — bytes are already committed — but cool the
      // account down so the client's reconnect fails over to another account
      // instead of deterministically re-selecting this same dead one.
      if (upstreamFailed) {
        accountManager.markRateLimited(account.index, NETWORK_ERROR_COOLDOWN_S, 'mid-stream error');
        console.log(`[TeamClaude] Mid-stream failure on "${account.name}" — cooling down ${NETWORK_ERROR_COOLDOWN_S}s; client retry will fail over`);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    clearTimeout(ttfbTimer);
    // Our own TTFB abort reads better as a timeout than as a bare "aborted".
    const reason = err?.name === 'AbortError'
      ? `no response within ${Math.round(upstreamTimeoutMs / 1000)}s`
      : (err?.message || 'unknown error');
    console.error(`[TeamClaude] Upstream error (account "${account.name}"): ${reason}`);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    // The response already started — we can't safely retry on another account.
    // Drop the connection, but cool this account down first so the client's
    // reconnect fails over instead of landing back on the same failing account.
    if (res.headersSent) {
      accountManager.markRateLimited(account.index, NETWORK_ERROR_COOLDOWN_S, 'mid-response error');
      res.destroy();
      return;
    }

    // A network-level failure before any bytes reached the client (hang/abort,
    // reset, refused, TLS, undici "terminated", …) means this account is
    // unhealthy right now. Cool it down briefly so the retry lands on a
    // different account, and fail over — mirroring the 429 path — instead of
    // dropping the client back onto the same dead account.
    if (retryCount < maxRetries) {
      accountManager.markRateLimited(account.index, NETWORK_ERROR_COOLDOWN_S, 'network error');
      console.log(`[TeamClaude] Upstream error on "${account.name}" (${reason}) — cooling down ${NETWORK_ERROR_COOLDOWN_S}s, failing over`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, upstreamTimeoutMs);
    }

    // Every account failed — return a clean error for the client to back off on.
    ctx.status = 502;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: `Upstream error: ${reason}` },
    }));
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 *
 * `controller` is the request's AbortController and `idleMs` the max tolerated
 * gap between upstream chunks: if the upstream goes silent that long mid-stream,
 * we abort the read so a hung connection surfaces as an error instead of
 * stalling the client forever. Returns `{ upstreamFailed }` — true only when the
 * stream broke on the upstream side while the client was still connected (so the
 * caller can cool the account down). A client disconnect is NOT a fault.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, streamLog, controller, idleMs) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let upstreamFailed = false;

  // Idle timer rearmed around each read(): a healthy stream gets SSE pings well
  // within idleMs, so this only fires on a dead upstream. Not armed during the
  // backpressure wait below — that's client slowness, not upstream silence.
  let idleTimer = null;
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  try {
    while (true) {
      if (idleMs) idleTimer = setTimeout(() => controller.abort(), idleMs);
      let result;
      try {
        result = await reader.read();
      } finally {
        clearIdle();
      }
      const { done, value } = result;
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

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
  } catch {
    // Upstream read rejected mid-stream (reset, undici "terminated", or our own
    // idle-timeout abort). Only a fault if the client is still here — a client
    // disconnect can also reject the read, and that's not the account's problem.
    if (!res.destroyed) upstreamFailed = true;
  } finally {
    clearIdle();
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }

  return { upstreamFailed };
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
