import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream, writeSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCerts, createConnectHandler } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { sanitizeToolPairs } from './tool-pair-sanitize.js';
import { parseRequestModel, parseAdvisorModel } from './account-manager.js';
import { TopLevelFieldFinder, modelGlobMatches } from './model.js';
import { BodyWriter, truncationNote } from './request-log.js';
import { upstreamFetch } from './upstream-fetch.js';
import { tunnelTls } from './sx.js';
import { createEgressGuard } from './egress-guard.js';


export const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
// Path prefix for the deprecated URL-based account pin (superseded by TC_ACCT).
const PIN_PREFIX = '/tc-acct/';
const INLINE_RETRY_AFTER_MAX_SECONDS = 15;
// How long the proxy will absorb a rate-limit 429's retry-after inline (waiting
// on the SAME account) before surfacing a 429 + retry-after to the client. A
// rate-limit 429 never rotates accounts (that just moves the burst); it pauses
// the account so concurrent requests wait, then retries the same account.
const RATE_LIMIT_ABSORB_MAX_SECONDS =
  Number(process.env.TEAMCLAUDE_RATE_LIMIT_ABSORB_MAX_SECONDS) || 60;

// Response header names that are connection-specific and thus illegal on an
// HTTP/2 response (Node's Http2ServerResponse.writeHead rejects them). Also
// hop-by-hop on h1, so stripping them is correct on both paths.
const CONNECTION_SPECIFIC_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'te', 'trailer',
]);

// Constant-time proxy-API-key comparison (both the HTTP gate and the CONNECT
// gate use it). Returns false on any type/length mismatch without leaking timing.
export function safeKeyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// True if a socket's remote address is loopback — the proxy-key gate exempts
// localhost on both the HTTP and CONNECT paths.
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function createProxyServer(accountManager, config, hooks = {}, sx = null) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  const holdMs = (config.holdSeconds || 0) * 1000;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const requestHandler = async (req, res) => {
    try {
      // Auth check — skip for localhost connections.
      const clientKey = req.headers['x-api-key'];
      const isLocal = isLoopbackAddr(req.socket.remoteAddress);
      if (proxyApiKey && !safeKeyEqual(clientKey, proxyApiKey) && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Control-plane mutations are refused when the request was issued by a web
      // page. The gate above exempts loopback from the API key, so without this
      // any site the operator happens to visit can POST here cross-origin: a
      // `fetch(..., {mode:'no-cors', body})` with a text/plain content type is a
      // CORS "simple request", so no preflight is sent and the request lands.
      // The page cannot read the reply, but the side effect is the point —
      // forcing the whole fleet onto one named account is a targeted quota
      // drain, and reload is reachable the same way.
      //
      // Origin (and Sec-Fetch-Site) are set by the browser and cannot be
      // forged from page JavaScript, while curl and the CLI send neither — so
      // this costs legitimate callers nothing. Deliberately not a content-type
      // requirement, which would also close the hole but would break the
      // documented `curl -X POST .../teamclaude/reload` that sends no body.
      if (req.method === 'POST' && (req.url || '').startsWith('/teamclaude/')
          && !isSameOriginControlRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'cross-origin request refused: the control plane is not reachable from a web page',
        }));
        return;
      }

      // Forward-proxy request (HTTP_PROXY): an absolute-form URL is a tool
      // proxying plain HTTP to some host. Account logic is only for hosts we
      // manage (the Anthropic upstream, which is HTTPS-only and never arrives
      // this way); forward anything else transparently instead of hijacking it.
      if (/^https?:\/\//i.test(req.url || '')) { relayHttpForward(req, res); return; }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        const status = accountManager.getStatus();
        const extra = hooks.getStatusExtra?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...extra, ...status }, null, 2));
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

      // Switch endpoint — make one account the preferred one, the headless
      // equivalent of picking it with 's' in the TUI. Both do the same single
      // thing: move currentIndex. That is a preference, and a weak one: _select
      // abandons it as soon as the account is unavailable, and also whenever any
      // available account carries a strictly lower priority value. So the answer
      // reports whether the choice will actually take effect rather than only
      // that it was recorded. Body:
      // {"account": "<name|email|accountUuid|accountUuid/orgUuid|orgUuid>"}.
      // Local control only (no upstream calls); the auth gate above applies.
      if (req.method === 'POST' && req.url === '/teamclaude/switch') {
        const names = () => (accountManager.accounts || []).map(a => a.name);
        let target;
        try {
          const raw = await readControlBody(req);
          target = JSON.parse(raw || '{}')?.account;
        } catch (err) {
          // Say which of the two it was, but never echo the parser's own message
          // back to a caller — that is our internals, not their input.
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"', accounts: names() }));
          return;
        }
        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"`, accounts: names() }));
          return;
        }
        accountManager.currentIndex = index;
        const name = accountManager.accounts[index].name;
        // Recording the choice and the choice taking effect are two different
        // things: selection skips an account it cannot use on the very next
        // request, so a bare "ok" would be a lie for a disabled or spent target.
        // The switch still happens (that is the TUI's behaviour) and the answer
        // says whether traffic will follow it.
        const { eligible, reason } = accountManager.eligibility(index);
        // Leave a trace where every other account change already leaves one: the
        // TUI swaps console.log for its activity pane and headless mode tees it
        // to the activity log, so this one line covers both. Without it a manual
        // switch is the only account change that happens invisibly — on exactly
        // the background-service deployment this endpoint exists for.
        console.log(`[TeamClaude] Switched to account "${name}" (manual)`
          + (eligible ? '' : ` — ${reason}, so rotation will not use it`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: name, eligible, ...(reason ? { reason } : {}) }));
        return;
      }

      return forward(req, res);
    } catch (err) {
      reportFailure('[TeamClaude] Unhandled error:', err);
      // The window above throws for real: `getStatusExtra` is a hook the
      // application installs, and reload/switch reach the account manager.
      answerUnhandled(res);
    }
  };

  // Opt-in egress pin: null unless config.egress.pin is set, and then shared by
  // the base listener and the MITM one so both honour the same hold.
  const egress = createEgressGuard(config, console.error);
  const forward = createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx, holdMs, config, egress });
  const server = http.createServer(requestHandler);

  // What bounds a directory of one-shot dumps is deleting the expired ones, not
  // rotating a growing file. Swept once at startup, because a backlog is usually
  // already sitting behind the restart that enables this, then on a timer. The
  // interval is unref'd so it never holds the process open.
  if (logDir) {
    const sweep = () => {
      // The message names the setting that stops it: the proxy self-updates, so
      // the first sweep can arrive with a release the operator never read about.
      const hours = resolveLogRetentionHours(config);
      return sweepRequestLogs(logDir, hours)
        .then((n) => {
          if (n) console.log(`[TeamClaude] Removed ${n} expired request log(s) from ${logDir} (logRetentionHours=${hours}, set 0 to keep them)`);
        })
        .catch(() => {});
    };
    sweep();
    const sweepTimer = setInterval(sweep, LOG_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    server.on('close', () => clearInterval(sweepTimer));
  }

  // Forward-proxy support (always on, so multiple claude instances can use
  // either ANTHROPIC_BASE_URL or HTTPS_PROXY against the same server). A CONNECT
  // to the upstream host is a transparent MITM relay (rewrite only auth); the
  // test host is answered locally; anything else is blind-tunneled. Certs are
  // minted lazily on the first intercepted CONNECT.
  const mitmHost = (() => { try { return new URL(upstream).hostname; } catch { return 'api.anthropic.com'; } })();
  let certsPromise = null;
  const ensureLeaf = async () => {
    // Reset the memo on failure so a transient cert error doesn't wedge the MITM
    // path permanently (a cached rejected promise would re-throw on every CONNECT).
    certsPromise ||= ensureCerts(mitmHost).catch((err) => { certsPromise = null; throw err; });
    const c = await certsPromise;
    return { key: c.leafKeyPem, cert: c.leafCertPem };
  };
  server.on('connect', createConnectHandler({ config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx, egress }));
  // Remote Control's real-time channel is a WebSocket, not a request/response
  // call — Node fires 'upgrade' for that handshake, never 'request', so it
  // needs its own listener (base-URL routing path; the MITM path wires the
  // same relayUpgrade onto its own terminating server in mitm.js).
  server.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, upstream, sx));

  return server;
}

/**
 * Whether a control-plane POST did NOT come from a web page.
 *
 * Both headers are browser-set and unforgeable from page JavaScript:
 *   - `Sec-Fetch-Site` is the explicit answer where it exists (Chrome, Safari,
 *     Firefox). Anything but `same-origin` / `none` is a page reaching across.
 *   - `Origin` is the fallback for browsers that send no Sec-Fetch-Site. Its
 *     mere presence on a POST to a local control endpoint means a page issued
 *     it; matching it against our own host would mean guessing which of
 *     localhost / 127.0.0.1 / [::1] / a LAN address the caller used, and a
 *     browser-issued same-origin call is not a thing worth supporting here.
 *
 * Non-browser callers (curl, the CLI, `teamclaude attach`) send neither and are
 * unaffected.
 */
export function isSameOriginControlRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return !req.headers.origin;
}

// Read a control-endpoint body as text. Capped, unlike the proxied request path:
// these endpoints carry a couple of fields, so anything larger is a mistake or an
// attack and buffering it whole would be the wrong answer either way.
async function readControlBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve an account pin to an index, or null.
 *
 * Accepted forms, first match wins:
 *   - `accountUuid/orgUuid` — fully qualified, the only form that distinguishes
 *     one person's accounts across several orgs
 *   - `accountUuid`
 *   - `orgUuid`
 *   - the display name (`email` or `email (Org)`), or the bare email
 *
 * UUIDs are the identity to use for anything scripted or long-lived: display
 * names are rewritten in place when an email gains a second org (see
 * accountsCommand), so a name is a convenience, not an identifier.
 *
 * The rotation index is deliberately NOT accepted. It is array position, so
 * deleting an account would silently repoint every later pin at a DIFFERENT
 * account — a wrong-account misroute rather than an honest failure.
 */
export function resolveAccountPin(accountManager, token) {
  const accounts = accountManager.accounts || [];
  const norm = (s) => (s || '').trim().toLowerCase();
  const t = norm(token);
  if (!t) return null;

  const at = (pick) => accounts.findIndex(a => norm(pick(a)) === t);
  const qualified = accounts.findIndex(a => a.accountUuid && a.orgUuid
    && `${norm(a.accountUuid)}/${norm(a.orgUuid)}` === t);

  for (const i of [
    qualified,
    at(a => a.accountUuid),
    at(a => a.orgUuid),
    at(a => a.name),
    at(a => (a.name || '').split(' (')[0]), // display name minus the org suffix
  ]) if (i >= 0) return i;

  return null;
}

/**
 * What actually went wrong on a failed connect, as a string worth printing.
 *
 * Node's happy-eyeballs dialer (`autoSelectFamily`, on by default across the
 * versions this package supports; `package.json` declares `node >=20`, measured
 * here on 24) reports a connect where every address failed as an AggregateError.
 * Node builds that error with an empty `message`; the per-address reasons are in
 * `.errors`. Any multi-address host reaches this, and the upstream is one, so
 * `err.message` prints nothing for the failure operators most need to read.
 *
 * Looked for one level down as well, because `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH`
 * routes through global fetch, which wraps the same failure in a TypeError whose
 * own message is the equally unhelpful "fetch failed".
 *
 * The `err.message` fallback is required: with `autoSelectFamily` off, and on
 * every single-address failure, the reason arrives as a plain Error in
 * `message`. It also covers a wrapper whose `.cause` carries no reasons.
 */
export function describeConnectError(err) {
  const reasons = (e) => (Array.isArray(e?.errors) ? e.errors.map(c => c?.message).filter(Boolean) : []);
  const own = reasons(err);
  return (own.length ? own : reasons(err?.cause)).join('; ') || err?.message;
}

// Paths that must reach upstream with the client's own credential (never a
// rotated account token): the Remote Control channel and attachment transfers.
// teamclaude applies its account logic (rotation, exhaustion, token injection)
// ONLY to hosts it manages — the Anthropic upstream. Anything else must be
// forwarded transparently, never hijacked into "all accounts exhausted". For
// HTTPS this is already true (the CONNECT tunnel in mitm.js blind-relays
// non-upstream hosts). This is the plain-HTTP counterpart: a tool honoring
// HTTP_PROXY sends an ABSOLUTE-form request (`GET http://host/path`), which
// otherwise gets misrouted to Anthropic. Blind-relay it to its target with the
// client's own headers — no account selection, no token injection,
// content-encoding passed through (a transparent forward proxy). Anthropic is
// HTTPS-only, so in practice this only ever sees third-party hosts.
export function relayHttpForward(req, res) {
  let target;
  try { target = new URL(req.url); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Malformed forward-proxy URL' } }));
    return;
  }
  const transport = target.protocol === 'http:' ? http : https;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Drop hop-by-hop + proxy-control headers; `host` is reset from the target.
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'proxy-connection') continue;
    headers[key] = value;
  }

  const upstreamReq = transport.request(target, { method: req.method, headers }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    console.error(`[TeamClaude] HTTP forward to ${target.host} failed:`, describeConnectError(err));
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  });
  res.on('close', () => upstreamReq.destroy());
  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

const CLIENT_CREDENTIAL_PATHS = ['/v1/code/', '/api/oauth/files/', '/api/oauth/file_upload'];

/**
 * Build the core proxy request listener — buffer the body, then forward with
 * account selection + retry (forwardRequest). Shared by the base HTTP server and
 * the MITM's terminating h2/h1 server, so both get identical buffering, model-
 * aware routing, and retry-on-quota behavior. Control endpoints (status/reload)
 * and the proxy-API-key gate live in the base server's wrapper, not here.
 */
export function createProxyRequestListener({ accountManager, upstream, logDir = null, hooks = {}, sx = null, holdMs = 0, config = {}, forcedPin = null, egress = null }) {
  let counter = 0;
  return async (req, res) => {
    // The activity entry this request opened, while it is still open. Every
    // consumer holds the row until it is told the request ended, so exactly one
    // path must close it. Each closing site clears this first, which is how the
    // outer catch tells an entry it still has to account for from one that is
    // already closed.
    let openEntry = null;
    try {
      // Claude Code's telemetry (`/api/event_logging/*`) is high-volume noise in
      // the activity log. `config.eventLogging` (read live so the TUI toggle takes
      // effect immediately): 'show' forwards + displays; 'hide' (default) forwards
      // but suppresses the activity entry; 'block' answers 200 locally without
      // forwarding (no upstream round-trip, no account/token spent).
      const eventLogging = config?.eventLogging || 'hide';
      const isEventLog = (req.url || '').startsWith('/api/event_logging');
      if (isEventLog && eventLogging === 'block') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const hideActivity = isEventLog && eventLogging !== 'show';
      // Egress pin (opt-in): with the exit IP off the pinned one — a VPN that
      // dropped — hold rather than send. Upstream answers a request from an
      // unexpected region with a 403 that Claude Code reports as a dead session,
      // so sending it costs a re-login while waiting costs latency. Checked here
      // rather than per-account: it is a property of the connection, and this is
      // the one path every request takes, MITM included.
      if (egress?.enabled()) {
        const state = await egress.waitUntilPinned({ isAborted: () => clientGone(res) });
        if (clientGone(res)) return;
        if (!state.ok) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '30' });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'proxy_error',
              message: `Egress is ${state.ip || 'unknown'}, not the pinned ${state.expected.join(', ')} — not sending this request. Check the VPN.`,
            },
          }));
          return;
        }
      }
      // Client token refresh: pass through untouched (the proxy manages its own
      // tokens via ensureTokenFresh; rewriting client refreshes would conflict).
      if (req.method === 'POST' && req.url === '/v1/oauth/token') { await relayRaw(req, res, upstream, sx); return; }
      // Remote Control (/v1/code/*) is bound to the session's paired claude.ai
      // identity — forward with the client's OWN credential (streamed), never a
      // rotated account token, which would 403 the worker event stream.
      // Attachment transfers (/api/oauth/files/*, /api/oauth/file_upload) are
      // likewise account-bound: files uploaded from claude.ai belong to the
      // paired identity, so fetching them with a rotated token 403s and Claude
      // Code silently drops the image from the message.
      if (CLIENT_CREDENTIAL_PATHS.some((p) => (req.url || '').startsWith(p))) { await relayStream(req, res, upstream, sx); return; }

      // Account pin: a request to `/tc-acct/<name-or-index>/...` (e.g. via
      // ANTHROPIC_BASE_URL=http://host:port/tc-acct/deepseek) is forced onto that
      // one account, bypassing rotation. Used by the keep-warm scheduler and for
      // manual per-account testing. The prefix is stripped before forwarding.
      let pinnedIndex = null;
      // DEPRECATED: the path-prefix pin. Superseded by TC_ACCT, which works in
      // MITM mode too (this form cannot — inside a CONNECT tunnel the path is
      // the real upstream one). Kept for the warmer and for direct API callers.
      // One segment only, so the fully-qualified `accountUuid/orgUuid` form is
      // not expressible here; use TC_ACCT for that.
      const url = req.url || '';
      const afterPrefix = url.startsWith(PIN_PREFIX) ? url.slice(PIN_PREFIX.length) : null;
      // The token runs to the next '/', which also begins the real request path.
      const tokenEnd = afterPrefix == null ? -1 : afterPrefix.indexOf('/');
      if (tokenEnd > 0) {
        // The escaping of this segment is the CLIENT's, so a malformed one
        // ("/tc-acct/%/v1/messages") makes decodeURIComponent throw URIError.
        // That is an ordinary bad request, not an internal error: decode
        // defensively and fall through to the unknown-pin 404 below, which is
        // what a pin nobody can resolve already means. An undecodable token is
        // reported as it arrived, since there is no decoded form to name.
        const raw = afterPrefix.slice(0, tokenEnd);
        let token = null;
        try { token = decodeURIComponent(raw); } catch { token = null; }
        pinnedIndex = token == null ? null : resolveAccountPin(accountManager, token);
        if (pinnedIndex == null) {
          const shown = token ?? raw;
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${shown}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${shown}"` } }));
          return;
        }
        req.url = afterPrefix.slice(tokenEnd);
      }

      // MITM-mode pin. A CONNECT carrying `Proxy-Authorization: Basic <acct>:…`
      // has no URL to hang a `/tc-acct/` prefix on — the path inside the tunnel
      // is the real Anthropic one — so the pin arrives as a listener bound to
      // that account (see createConnectHandler). Resolved per request rather
      // than at CONNECT time: a hot reload can renumber accounts while a tunnel
      // is open, and a name outliving an index is the safer half of that race.
      if (pinnedIndex == null && forcedPin != null) {
        pinnedIndex = resolveAccountPin(accountManager, forcedPin);
        if (pinnedIndex == null) {
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${forcedPin}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${forcedPin}" (from TC_ACCT)` } }));
          return;
        }
      }

      const reqId = ++counter;
      // Claude Code tags each session's requests with this header (present on
      // /v1/messages and count_tokens). Read from headers up front so it drives
      // session-aware routing (issue #109) and colors the TUI activity stream.
      const sessionId = req.headers['x-claude-code-session-id'] || null;
      if (!hideActivity) {
        // Marked open BEFORE the hook runs. The shipped TUI hook registers its
        // row and then renders, and the render can rethrow, so a hook that
        // throws part way through has already opened a row that something must
        // close. The cost of this order is one spurious close if the hook threw
        // before registering anything, which every consumer already tolerates.
        openEntry = { reqId, sessionId };
        hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionId, pinned: pinnedIndex != null });
      }

      // Buffer request body (needed to resend on a different account after a 429).
      // Peek the top-level `model` field incrementally as chunks arrive so the
      // TUI can show it the instant it appears in the stream — usually the first
      // frame — rather than waiting for the whole body and the request to finish.
      const bodyChunks = [];
      const modelFinder = new TopLevelFieldFinder('model');
      for await (const chunk of req) {
        bodyChunks.push(chunk);
        if (!modelFinder.done) {
          const found = modelFinder.push(chunk);
          if (found && !hideActivity) hooks.onRequestModel?.(reqId, { model: found });
        }
      }
      const body = Buffer.concat(bodyChunks);

      const model = modelFinder.done ? modelFinder.value : parseRequestModel(body);
      // An advisor request (Claude Code's advisor tool) carries a SECOND model
      // nested in tools[]; the advisor sub-inference runs on the selected
      // account, so selection must be eligible for it too (issue #98).
      const advisorModel = parseAdvisorModel(body);

      // Model blocklist (issue #116): reject a request for a blocked model right
      // here instead of forwarding it. A model no account can serve (e.g. Fable
      // once it left base plans) otherwise gets rate-limited upstream and hangs
      // the pipeline; a fast, non-retryable 400 lets the client move on. Read
      // live from the shared config so the TUI editor takes effect immediately.
      const blockedBy = model ? (config?.blockedModels || []).find((p) => modelGlobMatches(p, model)) : null;
      if (blockedBy) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Model "${model}" is blocked by teamclaude (matched "${blockedBy}").` } }));
        }
        openEntry = null;   // this path owns the close below; the outer catch must not repeat it
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model, sessionId });
        return;
      }

      const ctx = { account: null, status: null, tried: new Set(), reauthed: new Set(), model, advisorModel, pinnedIndex, holdBudgetMs: holdMs, sessionId, logLevel: resolveLogLevel(config), logMaxBodyBytes: resolveLogMaxBodyBytes(config) };
      // Hold the session "in flight" across the WHOLE request (incl. retries and
      // a multi-minute streaming completion) so it stays counted as active and
      // never expires mid-request.
      accountManager.beginSession(sessionId);
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        // Same rule as the two outer catches: a recovery path does not report
        // through a console that may be the thing that failed. Here it also
        // decides which error gets reported at all, since a throw from the
        // report would carry the render failure outward in place of this one.
        reportFailure('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
      } finally {
        accountManager.endSession(sessionId);
        // Cleared BEFORE the hook, because the hook can throw: leaving the entry
        // marked open would send the outer catch to call that same throwing hook
        // a second time for one request.
        openEntry = null;
        if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status, model: ctx.model, sessionId, pinned: ctx.pinnedIndex != null });
      }
    } catch (err) {
      reportFailure('[TeamClaude] Unhandled error:', err);
      // Close the activity entry. Only the inner path has a `finally`, so a
      // throw above it opens a row that nothing else will ever close, and every
      // consumer holds an open row indefinitely: the TUI keeps it in `active`
      // and never idles its animation, a headless consumer's in-flight count
      // grows by one. `for await (const chunk of req)` rejects when a client
      // cancels mid-body, which Ctrl+C in Claude Code does, on a daemon that
      // runs for weeks.
      if (openEntry) {
        // 499 when nothing was sent and nothing will be, either because the
        // client is gone or because the response is past the point of saying
        // anything; 502 is what the answer below is about to write.
        const status = res.headersSent || clientGone(res) ? 499 : 502;
        const entry = openEntry;
        openEntry = null;
        // Guarded, because the throw that landed here may be this hook. Escaping
        // this catch means escaping an async request listener with nothing above
        // it, which is an unhandled rejection, and crash-log.js turns that into
        // exit(1). A broken activity hook must not take the daemon down, and it
        // must not cost the socket its answer below either.
        try {
          hooks.onRequestEnd?.(entry.reqId, {
            method: req.method, path: req.url, account: null, status,
            model: null, sessionId: entry.sessionId, pinned: false,
          });
        } catch (hookErr) {
          reportFailure('[TeamClaude] activity hook failed while closing a request:', hookErr);
        }
      }
      // The code above the inner try (the egress hold, the pin parsing, body
      // buffering, the activity hooks) runs outside the 502 that guards
      // forwardRequest, and the inner `finally` calls onRequestEnd after the
      // response has streamed.
      answerUnhandled(res);
    }
  };
}

/**
 * Report a failure without depending on the console to survive it.
 *
 * Under the TUI the console is the TUI: `console.error` appends to the activity
 * log and repaints, so a render that throws makes `console.error` throw. That
 * matters because these reports are the FIRST statement of the paths that
 * recover from a throw, and the throw being recovered from is often the same
 * broken render. An unguarded report there skips the whole recovery.
 *
 * Falls back to stderr rather than swallowing, so a render bug still leaves a
 * diagnostic. The TUI already does this when its own activity stream fails.
 *
 * `writeSync` rather than `process.stderr.write`, because the fallback has to
 * fail the way this function promises to. A closed stderr makes the stream
 * surface EPIPE asynchronously, as an error event no `try` around the call can
 * see, and this daemon treats an uncaught EPIPE as fatal. `writeSync` throws
 * where it is called, so the catch below is real.
 */
function reportFailure(...args) {
  try {
    console.error(...args);
  } catch {
    try {
      writeSync(2, `${args.map(a => a?.stack || String(a)).join(' ')}\n`);
    } catch { /* nothing left to report with */ }
  }
}

/**
 * Has the client gone away?
 *
 * `res.destroyed` answers that on the base HTTP/1 listener and not on the MITM
 * one: `Http2ServerResponse` has no `destroyed` property at all, so the read is
 * `undefined` and the question is answered "no" for every h2 request, on the
 * path that carries most of the traffic. The h2 equivalent lives on the
 * underlying stream.
 *
 * Asked wherever the answer decides whether to spend something the client will
 * never receive. On the retry ladder that is an upstream call and a slice of an
 * account's weekly quota per rung, which is the opposite of what rotation is
 * for. In practice the ladder is cut short by the abort probe handed to
 * `admit()`, which is polled while a request waits for a concurrency slot; the
 * reads on the individual rungs are the backstop for a request that never
 * waited.
 *
 * In `streamResponse` the cost is the handler itself. Writing to a cancelled
 * stream returns false, and the backpressure wait below then listens for a
 * `drain` or a `close` that has already happened and will not happen again, so
 * the handler never returns and its activity entry never closes.
 */
function clientGone(res) {
  return !!res.destroyed || !!res.stream?.destroyed;
}

/**
 * The last response an outer catch can send. Three states:
 *
 *   - Nothing written yet: send a 502. Guarded on headersSent, because a second
 *     writeHead raises ERR_HTTP_HEADERS_SENT from inside the catch.
 *   - Headers sent, body unfinished: destroy. There is no status left to send,
 *     and end() would present the truncated bytes as a complete reply.
 *   - Response already ended: leave it alone, the client has its answer.
 *
 * `forwardRequest`'s own catch already carries the same pair of arms.
 */
function answerUnhandled(res) {
  if (!res.headersSent && !clientGone(res)) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
  } else if (!res.writableEnded) {
    res.destroy();
  }
}

// Per-request https.Agent tunneled through sx.org — one-shot (no keep-alive
// reuse, matching upstream-fetch.js's proxiedFetch), so a fresh sx tunnel is
// dialed for this connection only.
function sxAgent(sx, targetHost) {
  const proxy = sx.getProxy();
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, cb) => {
    tunnelTls({ proxy, targetHost, targetPort: 443, tlsOptions: sx.tlsOptions || {} })
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err));
    return undefined;
  };
  return agent;
}

/**
 * Relay a request to upstream with the client's OWN headers intact (including
 * its authorization) — used for Remote Control (/v1/code/*), whose event
 * stream is a long-poll: the client keeps the request open indefinitely and
 * the upstream may withhold response headers for minutes between events. No
 * buffering, no timeout, no reconstruction — just pipe bytes both ways as they
 * arrive, exactly like a transparent proxy would.
 */
function relayStream(req, res, upstream, sx) {
  const target = new URL(`${upstream}${req.url}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key) || key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
    // pipe() only propagates 'end'. If the upstream leg dies mid-response
    // (network blip, upstream restart), upstreamRes emits 'aborted'/'error'
    // and the pipe just stops — the client's long-poll stays open forever and
    // the CLI keeps waiting on a channel that can no longer deliver events.
    // Destroying res closes the client socket, which is the one signal its
    // reconnect logic reacts to.
    upstreamRes.on('aborted', () => res.destroy());
    upstreamRes.on('error', () => res.destroy());
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control relay error:', describeConnectError(err));
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    } else {
      // Headers already went out (the long-poll was live), so a 502 body can't
      // be written anymore. Close the client socket instead of leaving it
      // half-dead: seen in production as a `socket hang up` logged here while
      // the CLI's Remote Control stream silently waited on it for 45+ minutes.
      res.destroy();
    }
  });
  // Client disconnected (e.g. Claude Code closed the channel): tear down the
  // upstream side too instead of leaking an open connection.
  res.on('close', () => upstreamReq.destroy());

  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

/**
 * Relay a WebSocket upgrade (e.g. Remote Control's real-time
 * `/v1/session_ingress/ws/*` channel) to upstream with the client's own
 * headers intact. An HTTP server never emits 'request' for an Upgrade
 * handshake — only 'upgrade', with a raw socket instead of a response object —
 * so this needs its own relay rather than going through relayStream/res.
 * Reuses Node's http(s) client, which already knows how to speak the Upgrade
 * handshake (emits its own 'upgrade' event on a 101); once that fires it's
 * just two raw sockets spliced together.
 */
export function relayUpgrade(req, socket, head, upstream, sx) {
  const target = new URL(`${upstream}${req.url}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Unlike relayStream, do NOT strip 'upgrade'/'connection' here — they ARE
    // the handshake. Only 'host' (the client transport reconstructs it from
    // `target`) and h2 pseudo-headers are dropped.
    if (lk.startsWith(':') || lk === 'host') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headerLines = Object.entries(upstreamRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headerLines}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    // An upgraded socket defaults to half-open: the peer's FIN only ends the
    // READABLE side ('end'), it does NOT destroy the socket or fire 'close' —
    // so without this, one side hanging up (dropped wifi, killed CLI) leaves
    // the other socket open forever. destroy() is idempotent, so reacting to
    // both 'end' and 'close' on each side is a safe, redundant backstop.
    socket.on('end', () => upstreamSocket.destroy());
    upstreamSocket.on('end', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    // The 101 detaches this socket from upstreamReq, so the request's 'error'
    // listener no longer covers it. A link that flaps mid-session then raises
    // 'error' (write EPIPE / read ECONNRESET) on a socket nobody listens to,
    // which Node escalates to an uncaught exception — one dropped WebSocket
    // would kill the proxy for every other session. Close the pair instead.
    upstreamSocket.on('error', () => socket.destroy());
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control WebSocket relay error:', describeConnectError(err));
    socket.destroy();
  });
  socket.on('error', () => upstreamReq.destroy());

  upstreamReq.end();
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
      // `.text()` already decompressed the body, so drop content-encoding and
      // the now-stale content-length (both refer to the compressed bytes) — else
      // a gzip'd upstream response reaches the client mis-framed / truncated.
      if (key === 'transfer-encoding' || key === 'connection' ||
          key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', describeConnectError(err));
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

// How much of each request the `logDir` log records. 'body' is what the logger
// has always done; 'headers' drops both body sections, which is the difference
// between a kilobyte and a megabyte per request.
const LOG_LEVELS = new Set(['off', 'headers', 'body']);
const DEFAULT_LOG_LEVEL = 'body';

export function resolveLogLevel(config) {
  const level = config?.logLevel;
  return LOG_LEVELS.has(level) ? level : DEFAULT_LOG_LEVEL;
}

// Bodies are what make the log large, and a cap bounds nothing unless it
// actually applies: at 256 KiB the kept head and tail are each larger than
// anyone reads by eye, while a request log stops scaling with the context the
// request carried. 0 opts out, as with the other bounding settings.
const DEFAULT_LOG_MAX_BODY_BYTES = 262_144;

export function resolveLogMaxBodyBytes(config) {
  const raw = config?.logMaxBodyBytes;
  // A quoted number in hand-edited JSON is a common slip, so read it. A blank
  // string is not a number and means "unset", which must reach the default:
  // Number('') is 0, and 0 here would be the unbounded logging this bounds.
  // Number() on null or true would likewise read as 0 and 1 rather than junk.
  const max = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (max === 0) return 0;
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_LOG_MAX_BODY_BYTES;
}

// The names openRequestLog writes, and nothing else. Deletion keys off this
// pattern rather than off mtime so a file the logger did not create cannot
// match: the directory is one the operator named, and may hold anything.
const LOG_FILE_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(\d{3})_\d{5,}\.log$/;
const LOG_SWEEP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LOG_RETENTION_HOURS = 72;

export function resolveLogRetentionHours(config) {
  const raw = config?.logRetentionHours;
  // Strings only, and it matters most here: this is the setting that deletes.
  // A quoted "0" must mean "keep everything" rather than falling back to the
  // default and deleting, and a quoted "720" must not silently become 72. A
  // blank string means "unset" and reaches the default, since Number('') is 0.
  // Number() on null or true would instead read as 0 and 1.
  const hours = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (hours === 0) return 0;
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOG_RETENTION_HOURS;
}

/**
 * Delete expired request logs from `logDir`, returning how many were removed.
 *
 * Candidates come from the filename, which openRequestLog stamps in local time,
 * so the scan costs one readdir and no stat for everything it skips — it has to
 * stay cheap over a directory holding tens of thousands of files. Anything that
 * is not a file, not name-matched, or inside a subdirectory is left alone.
 *
 * Only names already past the cutoff are stat'd, and mtime has to agree before
 * the unlink. The name's clock is local, so a machine that changes timezone (a
 * laptop does it by itself) can age a file by hours; mtime is absolute. Every
 * disagreement between the two therefore keeps the file, which is the bias this
 * operation needs — including for a file still being appended to, whose mtime
 * is fresh however old its name looks.
 */
export async function sweepRequestLogs(logDir, retentionHours, now = Date.now()) {
  if (!(retentionHours > 0)) return 0;
  const cutoff = now - retentionHours * 3600_000;
  let entries;
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = LOG_FILE_RE.exec(entry.name);
    if (!m) continue;
    const started = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
    // Negated so anything not definitively older than the cutoff is skipped.
    // The pattern admits only digits and Date rolls every such combination into
    // a real time, so this cannot be indeterminate today; the shape keeps the
    // bias toward skipping if the pattern is ever loosened.
    if (!(started < cutoff)) continue;
    const path = join(logDir, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      if (!(mtimeMs < cutoff)) continue;
    } catch {
      continue;
    }
    try {
      await unlink(path);
      removed++;
    } catch { /* already gone, or a concurrent sweep won the race */ }
  }
  return removed;
}

// A per-request log that streams to disk as the request/response flow, instead
// of buffering the whole body in memory and writing once at the end. The file
// is opened on first write; header sections are written verbatim and bodies are
// streamed through BodyWriter (JSON pretty-printed on the fly, SSE/other raw),
// so even a ~1M-token response costs only the current chunk.
function openRequestLog(logDir, reqId, { level = DEFAULT_LOG_LEVEL, maxBodyBytes = DEFAULT_LOG_MAX_BODY_BYTES } = {}) {
  const filename = `${logTimestamp()}_${String(reqId).padStart(5, '0')}.log`;
  const ws = createWriteStream(join(logDir, filename), { flags: 'a' });
  ws.on('error', (err) => console.error(`[TeamClaude] Failed to write log: ${err.message}`));
  let ended = false;
  const write = (s) => { if (!ended && s) ws.write(Buffer.from(String(s), 'latin1')); };
  return {
    write,
    // Stream a complete body buffer under a section header.
    body(label, buf, contentType) {
      if (level === 'headers') return;
      if (!buf || !buf.length) { write(`\n\n=== ${label} ===\n(empty)`); return; }
      if (maxBodyBytes > 0) {
        // A complete body is already held whole, so keeping its tail costs no
        // extra memory — and the tail is where the newest message and the latest
        // tool result sit, which is usually what the log was opened for.
        const half = Math.max(1, Math.floor(maxBodyBytes / 2));
        const dropped = buf.length - 2 * half;
        if (dropped > 0) {
          // The tail goes in raw. Replaying it through the head's formatter would
          // carry that formatter's depth and in-string state across the gap: the
          // indentation would be wrong, and once the tail's closing brackets
          // outnumber the depth it throws on a negative repeat count.
          const head = new BodyWriter(write, label, contentType || '');
          head.chunk(buf.subarray(0, half));
          head.end();
          write(`\n${truncationNote(dropped)}\n`);
          write(buf.subarray(buf.length - half).toString('latin1'));
          return;
        }
      }
      const whole = new BodyWriter(write, label, contentType || '');
      whole.chunk(buf);
      whole.end();
    },
    // A BodyWriter to append chunks incrementally (e.g. an SSE response), or
    // null when the level records no bodies — streamResponse takes either.
    bodyWriter(label, contentType) {
      return level === 'headers' ? null : new BodyWriter(write, label, contentType || '', maxBodyBytes);
    },
    end() { if (!ended) { ended = true; ws.end('\n'); } },
  };
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

// Failures that say nothing about the ACCOUNT, only about the socket. Retrying
// can succeed where failing over cannot, and closing fast lets Node evict the
// dead socket so the client's retry reconnects cleanly. EPIPE joins the set as
// the write-side sibling of ECONNRESET.
//
// ECONNREFUSED sits here despite being arguably a property of the host. It is
// already unconditionally transient, so making it conditional converts every gap
// in that condition into a regression instead of leaving an unfixed case. One
// such gap was measurable before the other-host scan gated on selection's own
// eligibility predicate: a disabled account carrying its own `upstream` was
// never selected, never entered `ctx.tried`, and satisfied the condition
// indefinitely — a four-account fleet spent three accounts on a refused
// connection and answered rate_limit_error. That instance is closed; keeping
// ECONNREFUSED unconditional means any future gap stays a non-regression.
const SOCKET_TRANSIENT = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'TEAMCLAUDE_HEADERS_TIMEOUT', 'TEAMCLAUDE_BODY_TIMEOUT',
]);

// Failures that are a property of the HOST being dialled: name resolution and
// routing. The hostname has no per-account component, so every account produces
// the same failure, and walking the fleet spends an upstream call per account to
// learn the same thing. The client is then told its quota is exhausted because a
// name would not resolve.
//
// Conditional, because an account may name its own `upstream` for a third-party
// backend. Where an untried account would dial a different host, this failure
// says nothing about that one, and failing over is correct.
const HOST_TRANSIENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);

/**
 * Every error code a failure carries: its own, its `cause`'s, and its
 * children's. Node's global fetch puts the real error on `cause`, and the
 * happy-eyeballs dialer reports an all-addresses-failed connect as an
 * AggregateError that may carry no top-level code at all, with the reason
 * recorded once per address.
 */
function errorCodes(err) {
  const codes = [err?.code, err?.cause?.code];
  for (const child of err?.errors || []) codes.push(child?.code);
  for (const child of err?.cause?.errors || []) codes.push(child?.code);
  return codes.filter(Boolean);
}

/**
 * Should this upstream failure close the connection for the client to retry,
 * instead of being failed over to the next account?
 *
 * `otherHostAvailable` states whether an untried account would dial a different
 * host, which is what makes a host-scoped failure worth failing over. Exported
 * for its own tests.
 */
export function isTransientUpstreamError(err, { otherHostAvailable = false } = {}) {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const codes = errorCodes(err);
  if (codes.some(c => SOCKET_TRANSIENT.has(c))) return true;
  if (codes.some(c => HOST_TRANSIENT.has(c))) return !otherHostAvailable;
  // Read last, and only once no code has been found. Node's global fetch, which
  // `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH` selects, reports every failure with this
  // message and the real error on `.cause`; checking it earlier would answer for
  // the whole transport before the codes above were consulted, so a host-scoped
  // failure there would never reach its conditional arm.
  if (typeof err.message === 'string' && err.message.includes('fetch failed')) return true;
  return false;
}

export async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, useSx) {
  const maxRetries = accountManager.accounts.length;
  // This function is exported, so a caller may hand us a ctx built elsewhere.
  // The 401 path reads ctx.reauthed on every response; default it here rather
  // than trusting every construction site to include it.
  ctx.reauthed ??= new Set();
  // Same reason: a ctx built by an external caller carries no log settings.
  ctx.logLevel ??= DEFAULT_LOG_LEVEL;
  ctx.logMaxBodyBytes ??= DEFAULT_LOG_MAX_BODY_BYTES;
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;

  // Select account, skipping any already tried (and failed) this request.
  // The model scopes availability so a Fable-exhausted account is skipped only
  // for Fable requests (it still serves other models).
  // A pinned request (via /tc-acct/<name>) forces one exact account and never
  // rotates or fails over: once that account has been tried, `account` is null
  // and the caller gets the exhausted response rather than leaking to another.
  const account = ctx.pinnedIndex != null
    ? (ctx.tried.has(ctx.pinnedIndex) ? null : accountManager.accounts[ctx.pinnedIndex])
    : accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId);
  if (!account) {
    // Every candidate was refused by upstream (403). Waiting will not help — the
    // account needs attention, not a retry — so say so plainly rather than
    // reporting a rate limit. Not a 403 either: the client's own credential is
    // fine, and a 403 would make it drop its login over someone else's problem.
    //
    // Only when the refusals are the WHOLE story, though. If some accounts were
    // refused and others are merely out of quota, a reset will still serve this
    // request — so fall through to the retry-after/hold path below rather than
    // failing fast on the strength of one bad credential. Reporting 502 there
    // would turn a recoverable exhaustion into a hard error, and silently skip
    // the holdSeconds wait an unattended run depends on.
    const rejected = ctx.credentialRejected;
    const allRefused = rejected?.size > 0 && (ctx.pinnedIndex != null
      ? rejected.has(accountManager.accounts[ctx.pinnedIndex]?.name)
      : rejected.size === accountManager.accounts.length);
    if (allRefused) {
      const names = [...rejected].map(n => `"${n}"`).join(', ');
      ctx.status = 502;
      ctx.account = `(${[...rejected].join(', ')} refused)`;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `Upstream refused the credential for account ${names} (403). Check the account, then re-add it with: teamclaude login` },
        }));
      }
      return;
    }
    // A pinned request concerns exactly one account: don't compute a fleet-wide
    // retry-after or sleep on other accounts' windows — return immediately.
    if (ctx.pinnedIndex != null) {
      ctx.status = 429;
      ctx.account = '(pinned account unavailable)';
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Pinned account is unavailable (rate-limited, errored, or already tried). Retry shortly.' },
        }));
      }
      return;
    }
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);

    // Long-hold mode: hold the HTTP connection and poll until an account
    // recovers or the budget (holdSeconds) runs out. Claude Code waits for
    // the first response byte, so this is transparent to the client as long
    // as API_TIMEOUT_MS on the Claude Code side is large enough.
    if (ctx.holdBudgetMs > 0) {
      // Cap the per-poll sleep to 60s so a newly-available account (e.g. one
      // manually enabled or whose quota reset early) is picked up within a
      // minute instead of sleeping the full retryAfter (often 3600s).
      const waitMs = Math.min(retryAfter * 1000, ctx.holdBudgetMs, 60_000);
      ctx.holdBudgetMs -= waitMs;
      console.log(`[TeamClaude] All accounts exhausted — holding connection, retry in ${Math.ceil(waitMs / 1000)}s (${Math.ceil(ctx.holdBudgetMs / 1000)}s budget left)`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      if (clientGone(res)) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }

    const exhaustedRetries = ctx.exhaustedRetries || 0;
    if (exhaustedRetries < 1 && retryAfter <= INLINE_RETRY_AFTER_MAX_SECONDS) {
      ctx.exhaustedRetries = exhaustedRetries + 1;
      console.log(`[TeamClaude] All accounts exhausted — waiting ${retryAfter}s before retry`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      if (clientGone(res)) return;
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
  // Pin this session to the serving account (for affinity) and keep it "active"
  // in the running-sessions readout. Passive when distribution is off.
  accountManager.recordSession(ctx.sessionId, account.index);
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

  const upstreamUrl = `${account.upstream || upstream}${req.url}`;
  const method = req.method;

  // Strip orphaned tool_use / tool_result blocks so a client that compacted or
  // interrupted a turn can't wedge the session with Anthropic's non-retryable
  // 400 ("tool_use ids were found without tool_result blocks"). No-op (same
  // Buffer) for a well-formed body.
  let sendBody = sanitizeToolPairs(body, req.url, req.headers['content-type']);
  // Align the body's account_uuid (in metadata.user_id) with the account whose
  // token we're injecting (same-length patch; no-op if absent).
  if (account.accountUuid) sendBody = patchAccountUuid(sendBody, account.accountUuid);
  // Rewrite the model name for accounts that target a different upstream (e.g.
  // GLM), which uses different model identifiers than Anthropic.
  if (account.modelMap) sendBody = rewriteModel(sendBody, account.modelMap);
  // If the body changed length (sanitize or model rewrite), update Content-Length
  // so the upstream doesn't receive a mismatched framing and truncate or stall.
  if (sendBody !== body) headers['content-length'] = String(sendBody.length);

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => (logDir && ctx.logLevel !== 'off'
    ? (log ||= openRequestLog(logDir, reqId, { level: ctx.logLevel, maxBodyBytes: ctx.logMaxBodyBytes }))
    : null);
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
    // Storm control: pace requests onto a freshly-switched account so a failover
    // burst doesn't slam it all at once and cascade (issue #84). The slot is held
    // only until the response headers arrive — long enough to stagger the burst,
    // then released so streaming bodies don't tie up concurrency. Fail-open: a
    // client that disconnects while waiting just drops out.
    if (!await accountManager.admit(account.index, () => clientGone(res))) return;
    let upstreamRes;
    try {
      upstreamRes = await upstreamFetch(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
        redirect: 'manual',
      }, sx, route);
    } finally {
      accountManager.release(account.index);
    }

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // Any non-429 response is live proof a rate-limit hold no longer binds —
    // this is what lets a revalidation probe (a throttled account selected by
    // _selectProbe) clear its own hold and return the fleet to service.
    if (upstreamRes.status !== 429) accountManager.clearRateLimited(account.index);

    // Two kinds of 429 are handled differently below: a quota rejection rotates
    // to another account; a transient rate-limit throttle pauses + retries the
    // same account (never rotates — see #84).
    if (upstreamRes.status === 429) {
      // Clamp Retry-After to a sane window: missing/invalid falls back to 60s,
      // and out-of-range values are bounded to [1, 300]. A negative value would
      // otherwise bypass the wait cap — setTimeout returns immediately and a
      // pause/hold would be armed in the past.
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
        if (clientGone(res)) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }

      retryAfter = Math.min(Math.max(retryAfter, 1), 300);

      // sx.org failover: 429s are IP-based, so retry via the proxy's egress IP.
      // 'always' is already on sx; '429' switches direct→sx now and skips the
      // wait (a fresh IP isn't throttled). Also arm the sticky window for MITM.
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route;
      sx?.noteRateLimited(retryAfter);

      // This is a rate-limit 429 (per-minute throttle), NOT quota exhaustion —
      // quota rejection is handled above and is the only thing that rotates.
      // Do NOT switch accounts here: moving the burst to the next account just
      // throttles it too (thundering herd, #84) and discards this account's KV
      // cache. Instead PAUSE this account so concurrent requests wait in admit()
      // (capped, then released through a fresh ramp) instead of piling on, and
      // retry the SAME account. The pause never marks the account throttled, so
      // selection keeps choosing it.
      accountManager.pauseAccount(account.index, Math.min(retryAfter, RATE_LIMIT_ABSORB_MAX_SECONDS));

      // sx fresh-IP retry (still the same account) takes precedence over waiting.
      // Bounded by retryCount like the inline-wait path below, so a persistently
      // 429ing upstream can't loop forever through sx.
      if (switchingToSx && retryCount < maxRetries) {
        console.log(`[TeamClaude] 429 on "${account.name}" — retrying via sx.org (fresh egress IP)`);
        if (clientGone(res)) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // Absorb short waits inline on the same account — the client never sees the
      // 429. Bounded by retryCount (maxRetries = account count) so a persistently
      // rate-limited account can't loop forever tying up the connection.
      if (retryAfter <= RATE_LIMIT_ABSORB_MAX_SECONDS && retryCount < maxRetries) {
        console.log(`[TeamClaude] Rate-limit 429 on "${account.name}" — waiting ${retryAfter}s, retrying same account (no switch)`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        if (clientGone(res)) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // Longer retry-after (or retries exhausted): don't hold the connection and
      // don't rotate — surface the 429 with retry-after so the client backs off.
      // The pause above keeps other requests off this account meanwhile.
      console.log(`[TeamClaude] Rate-limit 429 on "${account.name}" — retry-after ${retryAfter}s over inline cap; returning 429 to client (no switch)`);
      ctx.status = 429;
      if (!res.headersSent && !clientGone(res)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `Rate limited; retry in ${retryAfter}s.` } }));
      }
      return;
    }

    // A 401 means the credential we injected was rejected. For an OAuth account
    // that usually means the access token was revoked BEFORE its clock expiry —
    // something else refreshed the same token family, so upstream reports it
    // revoked while it still looks fresh locally. ensureTokenFresh's expiry
    // check cannot see that (it only compares the clock), so the account would
    // otherwise keep serving a dead token until the token aged out, and every
    // request in between would surface a 401 to the client with no recovery.
    // Force one refresh and retry. If the refresh is itself rejected the refresh
    // token is dead too: ensureTokenFresh marks the account errored, and the
    // retry's status check rotates to another account. Bounded to one re-auth
    // per account per request, so a genuinely dead credential surfaces the 401
    // instead of looping.
    // A 403 ("Request not allowed") is upstream refusing THIS account outright —
    // not a stale token a refresh could fix, and not anything the client sent.
    // The client never sees the credential we inject, so it cannot act on the
    // rejection; Claude Code reads a 403 as "your session is dead", drops its
    // own login and asks for a re-login over an account problem it has no part
    // in. Skip the account for the rest of this request and fail over. With no
    // account left, the no-account branch reports a proxy error instead.
    if (upstreamRes.status === 403 && !res.headersSent) {
      await upstreamRes.body?.cancel();
      // A set, not a name: the no-account branch needs to tell "every account was
      // refused" (fail fast, nothing to wait for) from "this one was, others are
      // just out of quota" (still worth holding for a reset).
      (ctx.credentialRejected ??= new Set()).add(account.name);
      ctx.tried.add(account.index);
      console.error(`[TeamClaude] 403 on "${account.name}" — upstream refused the account credential`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if (upstreamRes.status === 401 && account.type === 'oauth' && account.refreshToken
        && retryCount < maxRetries && !ctx.reauthed.has(account.index)) {
      ctx.reauthed.add(account.index);
      await upstreamRes.body?.cancel();
      console.log(`[TeamClaude] 401 on "${account.name}" — token rejected; forcing refresh and retrying`);
      await accountManager.ensureTokenFresh(account.index, true);
      if (clientGone(res)) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
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
      if (l) { l.body('RESPONSE BODY', null); l.end(); }
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
      try {
        await streamResponse(upstreamRes.body, res, account.index, accountManager, bw);
      } finally {
        // Also on the failure path: without the note a capped body reads as a
        // stream that simply stopped, which is the other thing that happens here.
        bw?.end();
      }
      l?.end();
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, describeConnectError(err));

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    // Would failing over dial anywhere else? Only an untried account pointing at
    // a different `upstream` makes that true, and it is what decides whether a
    // name-resolution failure is worth retrying elsewhere.
    //
    // "Anywhere else" means an account that could actually serve THIS request:
    // selection gates on routes and the disabled flag, so a different-host
    // account this request can never legally route to gives failover nothing to
    // reach. The check reuses the manager's own eligibility predicate rather
    // than restating route logic — and deliberately not getActiveAccount, which
    // can arm the probe cooldown as a side effect. Hosts are compared by
    // hostname, so a port or path difference does not masquerade as a second
    // host.
    //
    // A pinned request never fails over at all: once the pinned account has
    // been tried, selection returns null and the caller sends the informative
    // pinned-unavailable 429. Counting a pin as "somewhere else to go" keeps a
    // host failure on that path instead of a bare reset.
    //
    // The advisor model is deliberately NOT part of the eligibility check:
    // when no account satisfies both models, getActiveAccount degrades to
    // executor-only routing, so failover reaches every executor-eligible
    // account. Gating on the advisor here would call a reachable healthy host
    // "nowhere to go" and reset a request that selection would have served.
    // The scan is deliberately blind to the probe fallback (a soft-exhausted
    // other-host account it rejects could still be probed) — conservative, and
    // self-healing: probes from other requests refresh the stale quota.
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
    const thisHost = hostOf(account.upstream || upstream);
    const otherHostAvailable = ctx.pinnedIndex != null || accountManager.accounts.some(a =>
      a.index !== account.index && !ctx.tried.has(a.index) &&
      hostOf(a.upstream || upstream) !== thisHost &&
      accountManager._isAvailable(a, ctx.model));
    const isTransient = isTransientUpstreamError(err, { otherHostAvailable });

    // Transient network errors (including a stale-socket headers/body timeout):
    // close the connection and let the client retry. Failing over to another
    // account would not help (the poisoned fetch pool is process-wide), but the
    // fast failure lets Node evict the dead socket so the retry reconnects
    // cleanly. If headers were already sent (a mid-stream body timeout), destroy
    // is the only option — the client sees a broken response and retries.
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
        error: { type: 'proxy_error', message: `Upstream error: ${describeConnectError(err)}` },
      }));
    } else if (!res.writableEnded) {
      // Error after headers were already sent (mid-stream) and it wasn't
      // classified transient: we can't send a status or fail over, and
      // streamResponse deliberately skipped res.end(). Destroy so the client
      // sees a broken response and retries instead of hanging on an open socket.
      res.destroy();
    }
  }
}

// Idle deadline for the RESPONSE BODY, complementing the headers timeout in
// upstream-fetch.js. The headers guard only covers time-to-first-byte; once
// headers arrive it is disarmed, so a network drop AFTER the stream starts would
// otherwise hang the read forever (the SSE completion just goes silent mid-way).
// This watchdog resets on every chunk, so a long but healthy stream is never
// cut — it fires only when the socket produces nothing for the whole window,
// converting a mid-stream hang into a fast failure that evicts the dead socket
// (reader.cancel destroys the underlying connection on both the direct-fetch and
// the sx-tunnel path, since both hand back a web ReadableStream). Override with
// TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS.
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 120_000;

function resolveBodyIdleTimeout() {
  const env = Number(process.env.TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS);
  return env > 0 ? env : DEFAULT_BODY_IDLE_TIMEOUT_MS;
}

// Race a single reader.read() against an inactivity deadline. Resolves to the
// read result, or rejects with a transient TEAMCLAUDE_BODY_TIMEOUT if no chunk
// arrives within `ms`. The pending read is abandoned on timeout; the caller
// cancels the reader (evicting the socket) in its finally block.
export function readWithIdleTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`upstream stream idle for ${ms}ms`);
      err.code = 'TEAMCLAUDE_BODY_TIMEOUT';
      reject(err);
    }, ms);
    timer.unref?.();
  });
  const read = reader.read();
  // If the timeout wins the race, `read` is abandoned; swallow any later
  // rejection so it can't surface as an unhandledRejection.
  read.catch(() => {});
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter) {
  const reader = webStream.getReader();
  const idleMs = resolveBodyIdleTimeout();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let errored = false;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs);
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (clientGone(res)) break;

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
          // Remove BOTH listeners when either fires: otherwise the un-fired one
          // (usually 'close') stays attached and accumulates one leaked listener
          // per backpressure cycle over a long SSE stream to a slow client.
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
        if (clientGone(res)) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } catch (err) {
    // A mid-stream idle timeout (or any read error) means the upstream went
    // silent after headers. Rethrow to the caller's transient handler, which
    // destroys the client connection so the truncated stream is NOT ended
    // cleanly (a clean res.end() would look like a complete response and
    // suppress the client's retry). reader.cancel() in finally evicts the socket.
    errored = true;
    throw err;
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs (and, on the
    // timeout path, to destroy the dead socket so the pool drops it).
    reader.cancel().catch(() => {});
    if (!errored && !res.writableEnded) res.end();
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

// Rewrite the `model` field in a JSON request body using a per-account map.
// Returns the original buffer unchanged if the model isn't in the map or the
// body isn't valid JSON, so non-messages endpoints pass through safely.
// Exported for tests.
export function rewriteModel(body, modelMap) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (obj.model && modelMap[obj.model]) {
      obj.model = modelMap[obj.model];
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
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
