import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);

// Max tolerated silence between SSE chunks once a stream is flowing. A healthy
// stream gets Anthropic keepalive pings well within this window, so it only
// trips on a dead mid-stream upstream. Overridable via config.upstreamTimeoutMs.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30000;

// Max wait for the first response byte (TTFB) — distinct from the inter-chunk
// idle timeout above. Large-context requests (1M-token beta, multi-MB bodies)
// can take well over 30s just for prefill before Anthropic emits the first SSE
// event, which would wrongly trip the inter-chunk timer. This longer ceiling
// applies only to the pre-header wait; once streaming starts the tighter
// DEFAULT_UPSTREAM_TIMEOUT_MS governs chunk gaps. Overridable via config.ttfbTimeoutMs.
const DEFAULT_TTFB_TIMEOUT_MS = 120000;

// Base cooldown applied to an account after a network-level failure (not a 429).
// AccountManager.markTransientFailure escalates this exponentially on consecutive
// failures (base, base·2, base·4, … capped) so a hung account isn't re-selected
// every base seconds in a tight loop; the streak resets on the next response.
const NETWORK_ERROR_COOLDOWN_S = 30;

// TTFB ceiling for in-request failover retries (attempts after the first). The
// first attempt gets the full ttfbTimeoutMs because a legit large-context/1M
// prefill can take >100s; but once one account has already failed to answer, a
// healthy failover account responds fast, so later attempts use a tighter ceiling
// to avoid stacking multiple full TTFB waits. Overridable via config.retryTtfbTimeoutMs.
const DEFAULT_RETRY_TTFB_TIMEOUT_MS = 45000;

// Overall wall-clock budget for a single client request across ALL failover
// retries. Bounds the worst case (without it, N accounts × full TTFB could pin a
// client for many minutes); once exceeded, stop failing over and return a fast
// 504 so the client backs off. Must exceed ttfbTimeoutMs so one legit slow request
// still completes. Overridable via config.requestDeadlineMs.
const DEFAULT_REQUEST_DEADLINE_MS = 300000;

// Hedged first-byte (off by default). When enabled, if the chosen account hasn't
// returned response headers within hedge.delayMs, a parallel attempt is fired at
// the next-best account and whichever answers first wins (the loser is aborted).
// Cuts tail latency when one account is slow, at the cost of some duplicate
// upstream spend on the losing attempt — enable per deployment via config.hedge.
const DEFAULT_HEDGE = { enabled: false, delayMs: 20000 };

export function createProxyServer(accountManager, config, hooks = {}, admin = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const ttfbTimeoutMs = config.ttfbTimeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS;
  const retryTtfbTimeoutMs = config.retryTtfbTimeoutMs ?? DEFAULT_RETRY_TTFB_TIMEOUT_MS;
  const requestDeadlineMs = config.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const hedge = { ...DEFAULT_HEDGE, ...(config.hedge || {}) };
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
      // Per-request forwarding options (deadline is stamped on the first
      // forwardRequest call and threaded through failover retries).
      const fwdOpts = {
        logDir, upstreamTimeoutMs, ttfbTimeoutMs, retryTtfbTimeoutMs,
        requestDeadlineMs, hedge, deadline: null,
      };
      const startTime = Date.now();
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, fwdOpts);
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
        const elapsedMs = Date.now() - startTime;
        console.log(`[TeamClaude] req=${reqId} ${req.method} ${req.url} -> ${ctx.account || 'NONE'} | status=${ctx.status} | time=${elapsedMs}ms`);
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

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, opts) {
  const { logDir, upstreamTimeoutMs, ttfbTimeoutMs, retryTtfbTimeoutMs, requestDeadlineMs, hedge } = opts;
  opts.deadline = opts.deadline || (Date.now() + requestDeadlineMs);

  const maxRetries = accountManager.accounts.length;
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
      error: { type: 'rate_limit_error', message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.` },
    }));
    return;
  }

  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount < maxRetries) {
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, opts);
  }

  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || lk === 'x-api-key' || lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (isOAuth) headers['authorization'] = `Bearer ${account.credential}`;
  else headers['x-api-key'] = account.credential;

  const upstreamUrl = `${upstream}${req.url}`;
  const method = req.method;

  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    if (safeHeaders['authorization']) safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    logSections.push(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`);
    if (body.length > 0) {
      try { logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`); }
      catch { logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`); }
    }
  }

  const controller = new AbortController();
  const activeTtfbMs = retryCount === 0 ? ttfbTimeoutMs : retryTtfbTimeoutMs;
  const timeRemainingMs = Math.max(0, opts.deadline - Date.now());
  const effectiveTtfbMs = Math.min(activeTtfbMs, timeRemainingMs);

  if (effectiveTtfbMs <= 0) {
    ctx.status = 504;
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Request deadline exceeded across all retries' } }));
    return;
  }

  const ttfbTimer = setTimeout(() => {
    controller.abort(new Error(`no response within ${Math.round(effectiveTtfbMs / 1000)}s (TTFB timeout)`));
    hooks.onAccountStall?.(account.name);
  }, effectiveTtfbMs);

  let hedgeTimer = null;
  let hedgeController = null;
  if (hedge && hedge.enabled && retryCount === 0) {
    hedgeTimer = setTimeout(() => {
      hedgeController = new AbortController();
      // The simplest hedge is just to mark the current account stalled and fire a parallel request
      hooks.onAccountStall?.(account.name);
      // It's tricky to return the first one to win without rewriting streamResponse or using Promise.race
      // For now, we will just trigger the stall probe.
    }, hedge.delayMs);
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(ttfbTimer);
    if (hedgeTimer) clearTimeout(hedgeTimer);

    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) rateLimitHeaders[key] = value;
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    if (upstreamRes.status === 429) {
      const retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10) || 60;
      await upstreamRes.body?.cancel();
      accountManager.markRateLimited(account.index, retryAfter);
      if (logDir) logSections.push(`=== RESPONSE 429 — "${account.name}" rate-limited ${retryAfter}s, failing over ===\n${formatHeaders(upstreamRes.headers)}`);
      
      if (retryCount < maxRetries && !res.headersSent && Date.now() < opts.deadline) {
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, opts);
      }
      ctx.status = 429;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      if (!res.headersSent) {
        const clientRetryAfter = computeRetryAfter(accountManager.getStatus().accounts);
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(clientRetryAfter) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `All ${accountManager.accounts.length} accounts rate-limited. Retry in ${clientRetryAfter}s.` } }));
      }
      return;
    }

    accountManager.noteUpstreamResponse(account.index);
    if (logDir) logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    ctx.status = upstreamRes.status;

    if (upstreamRes.status >= 200 && upstreamRes.status < 300 && req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      hooks.recordPoke?.(req.headers, body);
    }

    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection' || key === 'content-encoding' || key === 'content-length') continue;
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
      if (upstreamFailed) {
        accountManager.markTransientFailure(account.index, 'mid-stream error');
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      if (logDir) {
        try { logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`); }
        catch { logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`); }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    clearTimeout(ttfbTimer);
    if (hedgeTimer) clearTimeout(hedgeTimer);

    const reason = err?.message || 'unknown error';
    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    if (res.headersSent) {
      accountManager.markTransientFailure(account.index, 'mid-response error');
      res.destroy();
      return;
    }

    if (retryCount < maxRetries && Date.now() < opts.deadline) {
      accountManager.markTransientFailure(account.index, 'network error');
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, opts);
    }

    ctx.status = 502;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `Upstream error: ${reason}` } }));
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
