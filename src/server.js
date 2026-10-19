import http from 'node:http';
import { advisorDefinition, dispatchAdvisorRequest, runAdvisorBridge } from './advisor-bridge.js';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCerts, createConnectHandler } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { sanitizeToolPairs } from './tool-pair-sanitize.js';
import { foldSystemMessages } from './system-message-fold.js';
import { logBodyShape } from './body-shape-log.js';
import { normalizeGeminiArgonRequest } from './gemini-argon-compat.js';
import { shouldStripForeignThinking, stripThinkingBlocks } from './thinking-strip.js';
import { resolveHistoryFamily } from './rotation-ledger.js';
import { parseRequestModel, parseAdvisorModel } from './account-manager.js';
import { TopLevelFieldFinder, stripAdvisorModelField } from './model.js';
import { requestModelIds, blockedIdInSet, collisionIdInSet } from './model-namespace.js';
import { BodyWriter } from './request-log.js';
import { upstreamFetch } from './upstream-fetch.js';
import { tunnelTls } from './sx.js';
import { buildIdentity, PROCESS_STARTED_AT, registerBuildFeature } from './build-identity.js';
import { ProvenanceBuffer, classifyUpstreamRelayOutcome } from './provenance.js';
// Ensure the model-preflight layer's tag is registered even when the CLI entry
// has not been loaded (status via createProxyServer alone).
import './model-preflight.js';

registerBuildFeature('audit-b1-b6');
registerBuildFeature('ingress-collision-gate');
registerBuildFeature('serveable-availability');
registerBuildFeature('quota-admission-gate');
registerBuildFeature('sessions-endpoint');
registerBuildFeature('provenance-t7');
registerBuildFeature('rotation-gate');
registerBuildFeature('ingress-thinking-strip');
registerBuildFeature('fleet-agent-name');
registerBuildFeature('custom-advisor');

/** Path class for T5 last_request / ctx gating. */
export function classifySessionPath(url) {
  const path = (url || '').split('?')[0];
  if (path === '/v1/messages/count_tokens') return 'count_tokens';
  if (path === '/v1/messages') return 'messages';
  return 'other';}

/**
 * Fleet display name from the optional `x-fleet-agent` request header
 * (set by fleet launchers via ANTHROPIC_CUSTOM_HEADERS). DISPLAY-ONLY:
 * this value colors/labels the TUI activity stream and MUST NOT enter
 * rotation/quota/history-reset logic keyed by sessionId — two agents can
 * claim the same name after a bad handoff, so sessionId stays the key.
 * Sanitized to [A-Za-z0-9._-]{1,32}; returns null when absent/empty.
 */
export function sanitizeFleetAgent(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || typeof v !== 'string') return null;
  const clean = v.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
  return clean || null;
}

/** Semantic = POST /v1/messages or /v1/messages/count_tokens (not event_logging). */
export function isSemanticSessionRequest(method, url) {
  if ((method || '').toUpperCase() !== 'POST') return false;
  const cls = classifySessionPath(url);
  return cls === 'messages' || cls === 'count_tokens';
}

/** D7 path-aware half: inference = `/v1/messages` and any `/v1/messages/…` subpath.
 * Non-inference (e.g. `/api/eval/sdk-*`) must not regress on null-model traffic. */
export function isInferencePath(url) {
  const path = (url || '').split('?')[0];
  return path === '/v1/messages' || path.startsWith('/v1/messages/');
}

const SESSIONS_ABSENT = {
  awaiting_permission:
    'unobservable at proxy: client-side dialog, no request in flight — indistinguishable from idle; see client_hint seam',
  pane_binding:
    'proxy has no process/tmux visibility; session_id→pane join stays fleet-side',
  typed_draft: 'unsubmitted input never produces a request',
  // Fix #6: message_start input+cache excludes this turn's output.
  current_turn_output_tokens:
    'context_tokens is observed from message_start (input+cache_read+cache_creation) and lags by one turn\'s output, '
    + 'which occupies the window from the next turn; message_delta output_tokens are not added to the numerator',
  // Fix #5: count_tokens body is top-level {input_tokens} with no .usage wrapper.
  count_tokens_ctx:
    'count_tokens responses are excluded from ctx recording (top-level input_tokens, no usage/cache sum) — only /v1/messages usage is observed',
};


export const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
// Path prefix for the deprecated URL-based account pin (superseded by TC_ACCT).
const PIN_PREFIX = '/tc-acct/';
const INLINE_RETRY_AFTER_MAX_SECONDS = 15;
// How long the proxy will absorb a rate-limit 429's retry-after inline (waiting
// on the SAME account) before surfacing a 429 + retry-after to the client.
// After `transient429RotateAfter` consecutive transient-429s on one account
// (default 3; 0 = legacy never-rotate), the request cools that account down and
// rotates — see the transient-429 branch in forwardRequest (R1 / fugu-429).
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
  const provenance = new ProvenanceBuffer({
    size: config.provenance?.bufferSize ?? 512,
    filePath: config.provenance?.file ?? null,
    maxFileBytes: config.provenance?.maxFileBytes ?? (32 << 20),
  });

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  // --- no-forwarding hardening (opt-in; default OFF) ---
  // Closes the confused-deputy egress hole: a loopback caller is auth-exempt
  // (isLoopbackAddr), so ANY local process — including a sandbox handed a
  // bridge to this port — can ask the proxy to dial arbitrary destinations,
  // in BOTH modes (absolute-URI GET -> relayHttpForward, and CONNECT).
  // Hardening is destination-scoped, NOT a blanket ban: the MITM path needs
  // CONNECT to the upstream host to keep working, so that host stays allowed
  // and everything else is refused. Enable with proxy.noForwarding = true.
  const noForwarding = config.proxy?.noForwarding === true;
  const upstreamHost = (() => {
    try { return new URL(upstream).hostname; } catch { return 'api.anthropic.com'; }
  })();
  const forwardTargetAllowed = (hostname) => !noForwarding || hostname === upstreamHost;

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

      // Forward-proxy request (HTTP_PROXY): an absolute-form URL is a tool
      // proxying plain HTTP to some host. Account logic is only for hosts we
      // manage (the Anthropic upstream, which is HTTPS-only and never arrives
      // this way); forward anything else transparently instead of hijacking it.
      if (/^https?:\/\//i.test(req.url || '')) {
        if (noForwarding) {
          let host = null;
          try { host = new URL(req.url).hostname; } catch { /* malformed -> refuse */ }
          if (host === null || !forwardTargetAllowed(host)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'forbidden', message: 'Forward-proxying is disabled on this proxy' },
            }));
            return;
          }
        }
        relayHttpForward(req, res); return;
      }

      // Status endpoint. B19: routes[] may include `tiers` (configured fallback
      // structure). Field ABSENT when the route is untiered — not null, not [].
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        const status = accountManager.getStatus();
        const extra = hooks.getStatusExtra?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...extra, ...status, build: buildIdentity() }, null, 2));
        return;
      }

      // D2: shadow decision evidence ring — pure read, allowlisted fields.
      // Default limit = ring capacity (R0 lesson: smaller default hid newest half).
      if (req.method === 'GET' && (req.url === '/teamclaude/shadow-decisions'
          || (req.url || '').startsWith('/teamclaude/shadow-decisions?'))) {
        let limit;
        try {
          const u = new URL(req.url, 'http://localhost');
          const limRaw = u.searchParams.get('limit');
          if (limRaw != null && limRaw !== '') {
            const lim = Number(limRaw);
            if (Number.isFinite(lim) && lim > 0) limit = lim;
          }
        } catch { /* keep default = full ring */ }
        const snap = accountManager.getShadowDecisions(
          limit == null ? {} : { limit },
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          now: new Date().toISOString(),
          capacity: snap.capacity,
          size: snap.size,
          decisions: snap.decisions,
        }, null, 2));
        return;
      }

      // T7 provenance poll — pure read (copied slice; no cursor mutation).
      // Consumers reset their cursor when boot_epoch changes; head_seq < cursor
      // is a ring-overwrite hint only, not restart detection.
      // Default limit = ring size: snapshot walks oldest→newest from head_seq, so
      // a smaller default (historically 256 on a 512 ring) returned only the
      // oldest half and looked like a "frozen newest ts" under load (R0/fugu-429).
      if (req.method === 'GET' && (req.url === '/teamclaude/provenance'
          || (req.url || '').startsWith('/teamclaude/provenance?'))) {
        let since = 0;
        let limit = provenance.size;
        try {
          const u = new URL(req.url, 'http://localhost');
          since = Number(u.searchParams.get('since') || 0) || 0;
          const limRaw = u.searchParams.get('limit');
          if (limRaw != null && limRaw !== '') {
            const lim = Number(limRaw);
            if (Number.isFinite(lim) && lim > 0) limit = Math.min(1024, lim);
          }
        } catch { /* keep defaults */ }
        const snap = provenance.snapshot(since, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          now: new Date().toISOString(),
          boot_epoch: provenance.bootEpoch,
          head_seq: snap.head_seq,
          tail_seq: snap.tail_seq,
          buffer_size: provenance.size,
          events: snap.events,
        }, null, 2));
        return;
      }

      // Model-scoped availability for fleet preflight (fugu-nano 3s gate).
      // Executor id only — no body exists here; advisor-model callers pass the
      // executor id (or the advisor id when that is the decision they need).
      // Read-only: getServeable reuses pure _isAvailable (no breaker/probe/quota
      // mutation). B19: account rows may include `routeTier` from
      // AccountManager._costTierFor (same resolution as `rank`); omitted on
      // untiered routes; Infinity → null + routeTierNote.
      if (req.method === 'GET' && (req.url === '/teamclaude/serveable'
          || (req.url || '').startsWith('/teamclaude/serveable?'))) {
        let model = null;
        try {
          model = new URL(req.url, 'http://localhost').searchParams.get('model');
        } catch { /* malformed query → model stays null */ }
        const body = accountManager.getServeable(model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));
        return;
      }

      // T5 honest session-state — pure read; evidence Map only (routing pins
      // untouched). Exposes only proxy-observable facts with provenance labels.
      if (req.method === 'GET' && req.url === '/teamclaude/sessions') {
        const now = Date.now();
        const { sessions } = accountManager.getSessions(config, now);
        const build = buildIdentity();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          schema: 'teamclaude.sessions.v1',
          now: new Date(now).toISOString(),
          server: { startedAt: PROCESS_STARTED_AT, build },
          observed_since: PROCESS_STARTED_AT,
          sessions,
          absent: SESSIONS_ABSENT,
        }, null, 2));
        return;
      }

      // T2: fleet-side repair hand-back. Clears the session's served-family
      // ledger AFTER out-of-band transcript repair. Loopback-unauthenticated
      // under the existing control-endpoint trust model — loud log + counter
      // so erasure of safety evidence is never silent.
      const historyReset = (req.url || '').match(/^\/teamclaude\/session\/([^/]+)\/history-reset$/);
      if (req.method === 'POST' && historyReset) {
        const sessionId = decodeURIComponent(historyReset[1]);
        const cleared = accountManager.resetSessionHistory(sessionId);
        console.log(`[TeamClaude] history-reset: session ${sessionId.slice(0, 8)}… `
          + `(cleared=${!!cleared}) — ledger evidence erased; rotation legal again only if `
          + `fleet-side repair already removed foreign transcript artifacts`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cleared: !!cleared, sessionId }));
        return;
      }

      // Optional client-cooperation seam for awaiting_permission (T5). Never
      // fabricates sessions; never merges into `state`.
      if (req.method === 'POST' && req.url === '/teamclaude/session-hint') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let payload = null;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* invalid */ }
        const sessionId = payload?.session_id;
        const state = payload?.state;
        if (!sessionId || (state !== 'awaiting_permission' && state !== 'clear')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stored: false, reason: 'invalid-body' }));
          return;
        }
        const result = accountManager.sessionTracker.noteHint(sessionId, {
          state,
          at: new Date().toISOString(),
          source: payload.source || 'claude-hook',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Reload endpoint — re-sync accounts from config without a restart. This
      // is the headless equivalent of pressing 'R' in the TUI. Local control
      // only (no upstream calls); the auth gate above already applies.
      // D7: emit one config-reload provenance control event (routing-authority
      // change must be visible in the evidence stream).
      if (req.method === 'POST' && req.url === '/teamclaude/reload') {
        const emitReload = (responseStatus, errCode = null) => {
          if (!provenance) return;
          provenance.push({
            request_id: provenance.nextRequestId('b'),
            attempt: 0,
            final: true,
            outcome: 'config-reload',
            method: 'POST',
            path: '/teamclaude/reload',
            response_status: responseStatus,
            err_code: errCode,
            pinned: false,
          });
        };
        if (!hooks.reload) {
          emitReload(501);
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload not supported' }));
          return;
        }
        try {
          const added = await hooks.reload();
          emitReload(200);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, added: added || 0 }));
        } catch (err) {
          emitReload(500, err?.code != null ? String(err.code) : null);
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

  const forward = createProxyRequestListener({
    accountManager, upstream, logDir, hooks, sx, holdMs, config, provenance, listenerTag: 'b',
  });
  const server = http.createServer(requestHandler);

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
  server.on('connect', createConnectHandler({
    config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx, provenance,
  }));
  // Remote Control's real-time channel is a WebSocket, not a request/response
  // call — Node fires 'upgrade' for that handshake, never 'request', so it
  // needs its own listener (base-URL routing path; the MITM path wires the
  // same relayUpgrade onto its own terminating server in mitm.js).
  server.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, upstream, sx));

  return server;
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

  // Skip config-reload tombstones: a pin to a removed account must fail
  // clearly, never silently serve (D4c).
  const live = (a) => a && !a.retired;
  const at = (pick) => accounts.findIndex(a => live(a) && norm(pick(a)) === t);
  const qualified = accounts.findIndex(a => live(a) && a.accountUuid && a.orgUuid
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

/** True when `token` names a retired (config-removed) account tombstone. */
export function matchRetiredAccountPin(accountManager, token) {
  const accounts = accountManager.accounts || [];
  const norm = (s) => (s || '').trim().toLowerCase();
  const t = norm(token);
  if (!t) return null;
  const at = (pick) => accounts.findIndex(a => a?.retired && norm(pick(a)) === t);
  const qualified = accounts.findIndex(a => a?.retired && a.accountUuid && a.orgUuid
    && `${norm(a.accountUuid)}/${norm(a.orgUuid)}` === t);
  for (const i of [
    qualified,
    at(a => a.accountUuid),
    at(a => a.orgUuid),
    at(a => a.name),
    at(a => (a.name || '').split(' (')[0]),
  ]) if (i >= 0) return accounts[i];
  return null;
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
    console.error(`[TeamClaude] HTTP forward to ${target.host} failed:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  });
  res.on('close', () => upstreamReq.destroy());
  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

// Identity-bound Remote Control traffic must keep the client's own credential.
const CLIENT_CREDENTIAL_PATHS = [
  '/v1/code/', '/api/oauth/', '/api/frame/', '/v1/environments/',
  '/v1/sessions/', '/v2/session_ingress/', '/v2/ccr-sessions/',
];
function isClientCredentialPath(url) {
  const path = (url || '').split('?')[0];
  return CLIENT_CREDENTIAL_PATHS.some(p => path.startsWith(p) || path === p.slice(0, -1));
}

/** True only for the native Anthropic API root. Request transforms must classify
 * the same effective upstream URL that transport will dial: an account with no
 * per-account override can still inherit a custom top-level upstream. */
export function isNativeAnthropicUpstream(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:'
      && u.hostname.toLowerCase() === 'api.anthropic.com'
      && (u.port === '' || u.port === '443')
      && (u.pathname === '' || u.pathname === '/')
      && !u.search
      && !u.hash;
  } catch {
    return false;
  }
}

// Anthropic-native CONTROL PLANE. These are not inference: they describe the
// signed-in identity and what the org entitles it to. They must never ride the
// account rotation — a custom adapter upstream (codex/antigravity/deepseek)
// implements none of them and answers 404, which the client reads as "this
// model is not available" and then walks its whole fallbackModel chain down
// (2026-08-21 "Switched to X because Y is not available" cascade).
// Relayed with the CLIENT's own credential, like CLIENT_CREDENTIAL_PATHS: the
// answer must describe the user's real account, not whichever account rotation
// happened to pick.
const CONTROL_PLANE_PREFIXES = [
  '/api/claude_cli/',            // bootstrap: org model entitlements
  '/api/claude_code/',           // notification prefs & other client config
  '/api/oauth/',                 // identity/control plane: profile, usage, validate, …
];
const CONTROL_PLANE_EXACT = new Set(['/api/hello']);
export function isControlPlanePath(url) {
  const path = (url || '').split('?')[0];
  if (CONTROL_PLANE_EXACT.has(path)) return true;
  return CONTROL_PLANE_PREFIXES.some((p) => path.startsWith(p));
}

/** Hostname of account.upstream || default upstream — never a full URL. */
function provenanceUpstreamHost(account, defaultUpstream) {
  const raw = account?.upstream || defaultUpstream;
  if (!raw) return null;
  try { return new URL(raw).hostname; } catch {
    return String(raw).split('/')[0] || null;
  }
}

/** Same lookup rewriteModel uses — never re-parse sendBody. */
function provenanceMappedModel(account, requested) {
  if (requested == null) return null;
  return account?.modelMap?.[requested] ?? requested;
}

/** Emit one attempt-terminal provenance event. Marks ctx.provFinal when final. */
function emitProvenance(ctx, fields) {
  if (!ctx?.provenance || !ctx.requestId) return;
  if (fields.final) ctx.provFinal = true;
  const account = fields._account || null;
  const defaultUpstream = ctx.defaultUpstream;
  ctx.provenance.push({
    request_id: ctx.requestId,
    session_id: ctx.sessionId ?? null,
    method: ctx.method ?? null,
    path: ctx.path ?? null,
    requested_model: ctx.model ?? null,
    advisor_model_requested: ctx.advisorModelRequested ?? null,
    advisor_degraded: !!ctx.advisorDegraded,
    attempt: fields.attempt ?? ctx.attempt ?? 0,
    account: fields.account ?? (account?.name ?? ctx.account ?? null),
    account_index: fields.account_index ?? (account != null ? account.index : null),
    upstream_host: fields.upstream_host ?? (account ? provenanceUpstreamHost(account, defaultUpstream) : null),
    mapped_model: fields.mapped_model ?? (account
      ? provenanceMappedModel(account, ctx.model)
      : (ctx.model ?? null)),
    via_sx: fields.via_sx ?? !!ctx.viaSx,
    log_file: fields.log_file ?? ctx.logFile ?? null,
    usage: fields.usage ?? ctx.attemptRec?.usage,
    timings: fields.timings ?? {
      admit_ms: ctx.attemptRec?.admit_ms ?? null,
      headers_ms: ctx.attemptRec?.headers_ms ?? null,
      total_ms: fields.total_ms ?? ctx.attemptRec?.total_ms ?? null,
    },
    stream: fields.stream ?? !!ctx.attemptRec?.stream,
    response_reported_model: fields.response_reported_model ?? ctx.attemptRec?.response_reported_model ?? null,
    response_status: fields.response_status ?? null,
    outcome: fields.outcome,
    err_code: fields.err_code ?? null,
    final: !!fields.final,
    count: fields.count,
    // D8: same pin bit already on hooks.onRequestStart/End — never recompute from URL
    // (prefix is stripped before most emit sites run). forcedPin OR's into pinnedIndex.
    pinned: ctx.pinnedIndex != null,
    // D9: selection-time skips (set once per attempt after getActiveAccount).
    // Never invent here — pin / non-routed leave null. Not logged unbounded.
    skipped: fields.skipped !== undefined ? fields.skipped : ctx.selectionSkipped,
    skipped_more: fields.skipped_more !== undefined
      ? fields.skipped_more
      : ctx.selectionSkippedMore,
  });
}

/**
 * Build the core proxy request listener — buffer the body, then forward with
 * account selection + retry (forwardRequest). Shared by the base HTTP server and
 * the MITM's terminating h2/h1 server, so both get identical buffering, model-
 * aware routing, and retry-on-quota behavior. Control endpoints (status/reload)
 * and the proxy-API-key gate live in the base server's wrapper, not here.
 */
export function createProxyRequestListener({
  accountManager, upstream, logDir = null, hooks = {}, sx = null, holdMs = 0, config = {},
  forcedPin = null, provenance = null, listenerTag = 'b',
}) {
  let counter = 0;
  const listener = async (req, res) => {
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
      if (isClientCredentialPath(req.url)) { await relayStream(req, res, upstream, sx); return; }

      // Anthropic-native control plane (see CONTROL_PLANE_PREFIXES): startup
      // connectivity gate, org model entitlements, identity, usage. Relayed to
      // the default upstream with the client's own credential — never rotated.
      if (isControlPlanePath(req.url)) { await relayStream(req, res, upstream, sx); return; }

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
        const token = decodeURIComponent(afterPrefix.slice(0, tokenEnd));
        pinnedIndex = resolveAccountPin(accountManager, token);
        if (pinnedIndex == null) {
          // Unknown-pin 404 precedes provenance request_id assignment — out of
          // provenance scope (critique fix #2). Activity log still records it.
          // D4c: a pin naming a config-reload tombstone gets an explicit refusal
          // rather than the generic unknown-pin wording.
          const retired = matchRetiredAccountPin(accountManager, token);
          const pinMsg = retired
            ? `Account "${retired.name}" was removed from config (retired); pin refused`
            : `Unknown account pin "${token}"`;
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          const fleetAgent = sanitizeFleetAgent(req.headers['x-fleet-agent']);
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(${retired ? 'retired' : 'unknown'} pin: "${token}")`, status: 404, model: null, sessionId, fleetAgent, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: pinMsg } }));
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
          const retired = matchRetiredAccountPin(accountManager, forcedPin);
          const pinMsg = retired
            ? `Account "${retired.name}" was removed from config (retired); pin refused`
            : `Unknown account pin "${forcedPin}" (from TC_ACCT)`;
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          const fleetAgent = sanitizeFleetAgent(req.headers['x-fleet-agent']);
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(${retired ? 'retired' : 'unknown'} pin: "${forcedPin}")`, status: 404, model: null, sessionId, fleetAgent, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: pinMsg } }));
          return;
        }
      }

      const reqId = ++counter;
      // Composite id for BASE_URL vs CONNECT/MITM correlation (numeric reqId
      // alone collides across the two independent counters).
      const requestId = provenance && !isEventLog ? provenance.nextRequestId(listenerTag) : null;
      // Claude Code tags each session's requests with this header (present on
      // /v1/messages and count_tokens). Read from headers up front so it drives
      // session-aware routing (issue #109) and colors the TUI activity stream.
      const sessionId = req.headers['x-claude-code-session-id'] || null;
      // Display-only fleet name (see sanitizeFleetAgent); rides the same info
      // path to the hooks as sessionId but NEVER enters ctx / routing / quota.
      const fleetAgent = sanitizeFleetAgent(req.headers['x-fleet-agent']);
      if (!hideActivity) hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionId, fleetAgent, pinned: pinnedIndex != null });

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
      let body = Buffer.concat(bodyChunks);

      const model = modelFinder.done ? modelFinder.value : parseRequestModel(body);
      // An advisor request (Claude Code's advisor tool) carries a SECOND model
      // nested in tools[]; every request-path gate quantifies over the full id
      // set {model, advisorModel} — see requestModelIds in model-namespace.js.
      let advisorModel = parseAdvisorModel(body);
      const advisor = advisorDefinition(body);
      const bridgeNeeded = advisor && typeof advisor.model === 'string' && (config.customAdvisorBridge !== false)
        && accountManager.accounts.some(a => !a.disabled && !a.retired && !a.supportsAdvisorTools
          && !isNativeAnthropicUpstream(a.upstream || upstream)
          && (a.modelMap?.[model] || a.modelMap?.[advisor.model]
            || a.acceptsModels?.includes(model) || a.acceptsModels?.includes(advisor.model)))
        // Do not turn an executor-only adapter into an advisor backend. When
        // no declared advisor route is available, keep the existing degrade path.
        && accountManager.accounts.some(a => accountManager._isAvailable(a, advisor.model)
          && (a.modelMap?.[advisor.model] || a.acceptsModels?.includes(advisor.model)
            || (isNativeAnthropicUpstream(a.upstream || upstream) && /^claude-/.test(advisor.model))));
      if (req.method === 'POST' && classifySessionPath(req.url) === 'messages' && bridgeNeeded) {
        const executorUrl = pinnedIndex == null ? req.url
          : `${PIN_PREFIX}${encodeURIComponent(accountManager.accounts[pinnedIndex].name)}${req.url}`;
        accountManager.beginSession(sessionId, { semantic: true, pathClass: 'messages', model });
        try {
          await runAdvisorBridge({ body, res,
            execute: (payload, role, signal) => dispatchAdvisorRequest(listener, req, payload,
              role === 'executor' ? executorUrl : req.url, signal, { advisor: role === 'advisor' }),
            onAdvisor: (id, state) => console.log(`[TeamClaude] Advisor "${id}" ${state}`),
          });
        } finally { accountManager.endSession(sessionId, { semantic: true }); }
        if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url,
          account: '(advisor)', status: res.statusCode, model, sessionId, fleetAgent, pinned: pinnedIndex != null });
        return;
      }
      // Capture PRE-STRIP advisor id so G9 degrade remains visible in provenance.
      const advisorModelRequested = advisorModel;
      let advisorDegraded = false;

      const emitGate = (outcome, extra = {}) => {
        if (!provenance || !requestId) return;
        provenance.push({
          request_id: requestId,
          session_id: sessionId,
          method: req.method,
          path: req.url,
          requested_model: model,
          advisor_model_requested: advisorModelRequested,
          advisor_degraded: advisorDegraded,
          attempt: 0,
          final: true,
          outcome,
          ...extra,
          pinned: pinnedIndex != null,
        });
      };

      // D7 path-aware null-model refuse: with a configured route table, inference
      // paths must not fall through to _accountOwnsModel (B47). Non-inference
      // paths (e.g. /api/eval/sdk-*) keep today's null-model behavior.
      if (!model && pinnedIndex == null && accountManager._routesConfigured
          && isInferencePath(req.url)) {
        const message = 'Routed inference requires a model id — refusing null/unparseable model while a route table is configured.';
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message },
          }));
        }
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url, account: '(route-fail-closed)',
          status: 400, model: null, sessionId,
        });
        emitGate('rejected-null-model', { response_status: 400, account: '(route-fail-closed)' });
        return;
      }

      // Model blocklist (issue #116): reject when the EXECUTOR id is blocked.
      // An advisor-only hit strip-and-degrades (G9): never 400 the executor turn
      // over the auxiliary channel, and never egress the blocked advisor id.
      const blockHit = blockedIdInSet(config?.blockedModels, requestModelIds({ model, advisorModel }), { executor: model });
      if (blockHit?.role === 'executor') {
        if (sessionId && isSemanticSessionRequest(req.method, req.url)) {
          accountManager.sessionTracker.noteSemanticRejection(sessionId, {
            status: 400, reason: 'blocked-model', model, pathClass: classifySessionPath(req.url),
          });
        }
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Model "${model}" is blocked by teamclaude (matched "${blockHit.pattern}").` } }));
        }
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model, sessionId });
        emitGate('rejected-blocked', { response_status: 400, account: '(blocked)' });
        return;
      }
      if (blockHit?.role === 'advisor' && advisorModel) {
        body = stripAdvisorModelField(body);
        accountManager.noteAdvisorDegrade('blocked', advisorModel, blockHit.pattern);
        advisorModel = null;
        advisorDegraded = true;
      }
      // Account-name collision (T1): raw-BASE_URL clients bypass `teamclaude run`
      // preflight, so a request whose model id is really a configured ACCOUNT
      // name can egress verbatim and 404 (kimi-k3 incident class). Reject only
      // when routabilityOf can PROVE the collision — never guess-forward.
      // /tc-acct pins bypass selection, so the proof does not apply there.
      if (pinnedIndex == null) {
        const collisionHit = collisionIdInSet(
          config, requestModelIds({ model, advisorModel }), { executor: model },
        );
        if (collisionHit?.role === 'executor') {
          if (sessionId && isSemanticSessionRequest(req.method, req.url)) {
            accountManager.sessionTracker.noteSemanticRejection(sessionId, {
              status: 400, reason: 'account-name-collision', model, pathClass: classifySessionPath(req.url),
            });
          }
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: `Model "${collisionHit.id}" collides with configured account "${collisionHit.id}" and is not `
                  + 'routable as a model id. If you meant the account, pin it: /tc-acct or '
                  + `teamclaude run --account ${collisionHit.id}`,
              },
            }));
          }
          hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(collision)', status: 400, model, sessionId });
          emitGate('rejected-collision', { response_status: 400, account: '(collision)' });
          return;
        }
        if (collisionHit?.role === 'advisor' && advisorModel) {
          body = stripAdvisorModelField(body);
          accountManager.noteAdvisorDegrade('collision', advisorModel, collisionHit.id);
          advisorModel = null;
          advisorDegraded = true;
        }
      }
      // A /tc-acct pin intentionally bypasses route/quota/disabled selection,
      // but a closed adapter's finite model contract is not a preference. Reject
      // locally when the EXECUTOR is unservable. An advisor-only miss
      // strip-and-degrades (G9) so the pin still serves the executor turn.
      const pinnedAccount = pinnedIndex != null ? accountManager.accounts[pinnedIndex] : null;
      if (pinnedAccount && model && !accountManager._acceptsModel(pinnedAccount, model)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Pinned account "${pinnedAccount.name}" cannot translate model "${model}" to an accepted provider model.` } }));
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: pinnedAccount.name, status: 400, model, sessionId });
        emitGate('rejected-pin-unservable', {
          response_status: 400,
          account: pinnedAccount.name,
          account_index: pinnedAccount.index,
        });
        return;
      }
      if (pinnedAccount && advisorModel && !accountManager._acceptsModel(pinnedAccount, advisorModel)) {
        body = stripAdvisorModelField(body);
        accountManager.noteAdvisorDegrade('pin-unservable', advisorModel, pinnedAccount.name);
        advisorModel = null;
        advisorDegraded = true;
      }

      // T4 admission gate — typed quota errors, never 200-with-refusal.
      // Honest boundary: teamclaude can guarantee the TYPED-ERROR property only
      // for exhaustion it KNOWS about (its own quota/circuit/disabled/token
      // model, pre-egress). Rewriting an upstream's 200-with-refusal without
      // body-sniffing stays REJECTED (fragile; see wf_91df8b75 research).
      // When every account is known-unserveable for the EXECUTOR id for a
      // capacity reason, refuse here — never forward (that forward is where
      // 200-with-refusal enters and grades COMPLETED/EFFECT_UNKNOWN). Advisor
      // unavailability alone still degrades at selection time and must not trip
      // this gate. Config-only misses (all not-accepted / route-excluded) keep
      // the legacy null-selection 429 shape. Pins keep their dedicated path.
      if (pinnedIndex == null && accountManager.accounts.length
          && !accountManager.accounts.some(a => accountManager._isAvailable(a, model, null))) {
        const CAPACITY = new Set([
          'quota-exhausted', 'token-budget', 'circuit-open', 'probe-held', 'disabled', 'token-expired',
        ]);
        const reasons = accountManager.accounts.map(a => ({
          name: a.name,
          reason: accountManager._unavailableReason(a, model) || 'unavailable',
        }));
        if (reasons.some(r => CAPACITY.has(r.reason))) {
          if (sessionId && isSemanticSessionRequest(req.method, req.url)) {
            accountManager.sessionTracker.noteSemanticRejection(sessionId, {
              status: 429, reason: 'quota-admission', model, pathClass: classifySessionPath(req.url),
            });
          }
          const snap = accountManager.getServeable(model);
          let retryAfter = 60;
          if (snap.soonestResetAt) {
            const secs = Math.ceil((Date.parse(snap.soonestResetAt) - Date.now()) / 1000);
            if (Number.isFinite(secs)) retryAfter = Math.max(1, secs);
          }
          retryAfter = Math.min(3600, retryAfter);
          const detail = reasons.map(r => `${r.name}: ${r.reason}`).join('; ');
          const message = `No serveable account for "${model || '<default>'}" (${detail}). Retry in ${retryAfter}s.`;
          if (!res.headersSent) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'retry-after': String(retryAfter),
            });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message },
            }));
          }
          hooks.onRequestEnd?.(reqId, {
            method: req.method, path: req.url, account: '(none available)',
            status: 429, model, sessionId,
          });
          emitGate('exhausted-typed-429', { response_status: 429, account: '(none available)' });
          return;
        }
      }

      const pathClass = classifySessionPath(req.url);
      const semantic = isSemanticSessionRequest(req.method, req.url);
      // reauthed: upstream #136 401-retry bound (one forced refresh per account per request)
      const rotateRaw = config?.transient429RotateAfter;
      const transient429RotateAfter = rotateRaw === undefined || rotateRaw === null
        ? 3
        : Math.max(0, Number(rotateRaw) || 0);
      // D3: zero-config-inert — only an explicit true enables foreign-thinking strip.
      const ingressThinkingStrip = config?.ingressThinkingStrip === true;
      const ctx = {
        account: null, status: null, tried: new Set(), reauthed: new Set(), model, advisorModel,
        pinnedIndex, holdBudgetMs: holdMs, sessionId, pathClass, semantic,
        provenance: isEventLog ? null : provenance,
        requestId,
        advisorModelRequested,
        advisorDegraded,
        method: req.method,
        path: req.url,
        defaultUpstream: upstream,
        attempt: 0,
        viaSx: false,
        provFinal: false,
        logFile: null,
        attemptRec: null,
        transient429RotateAfter,
        transient429Counts: new Map(),
        ingressThinkingStrip,
        // D9: filled at selection; null means absent (pin / non-routed / none skipped).
        selectionSkipped: null,
        selectionSkippedMore: null,
      };
      // Hold the session "in flight" across the WHOLE request (incl. retries and
      // a multi-minute streaming completion) so it stays counted as active and
      // never expires mid-request. Semantic stamp/hint-clear only for /v1/messages*.
      accountManager.beginSession(sessionId, { semantic, pathClass, model });
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
        if (!ctx.provFinal) {
          emitProvenance(ctx, {
            final: true,
            outcome: 'upstream-error-relayed',
            response_status: ctx.status,
            err_code: err?.code ?? null,
          });
        }
      } finally {
        // Update last_request.account once selection is known (begin was pre-select).
        if (semantic && sessionId && ctx.account) {
          const ev = accountManager.sessionTracker.evidence.get(sessionId);
          if (ev?.lastRequest) ev.lastRequest.account = ctx.account;
        }
        accountManager.endSession(sessionId, { semantic });
        // Safety net: every reqId-assigned request emits ≥1 terminal event.
        if (ctx.provenance && ctx.requestId && !ctx.provFinal) {
          const st = ctx.status;
          let outcome = 'client-disconnect';
          if (st != null && st >= 200 && st < 300) outcome = 'ok';
          else if (st === 429) outcome = 'exhausted-typed-429';
          else if (st != null && st >= 400) outcome = 'upstream-error-relayed';
          emitProvenance(ctx, { final: true, outcome, response_status: st });
        }
        if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status, model: ctx.model, sessionId, fleetAgent, pinned: ctx.pinnedIndex != null });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };
  return listener;
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
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
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
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control WebSocket relay error:', err.message);
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
    filename,
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
  // This function is exported, so a caller may hand us a ctx built elsewhere.
  // The 401 path reads ctx.reauthed on every response; default it here rather
  // than trusting every construction site to include it.
  ctx.reauthed ??= new Set();
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;
  ctx.viaSx = route;

  // Select account, skipping any already tried (and failed) this request.
  // The model scopes availability so a Fable-exhausted account is skipped only
  // for Fable requests (it still serves other models).
  // A pinned request (via /tc-acct/<name>) forces one exact account and never
  // rotates or fails over: once that account has been tried, `account` is null
  // and the caller gets the exhausted response rather than leaking to another.
  const account = ctx.pinnedIndex != null
    ? (ctx.tried.has(ctx.pinnedIndex) ? null : accountManager.accounts[ctx.pinnedIndex])
    : accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId);
  // D9: capture eligibility skips AT SELECTION TIME (pure read). Pin bypasses
  // selection → leave null (pinned:true already explains). Does not alter pick.
  if (account && ctx.pinnedIndex == null) {
    const sk = accountManager.selectionSkippedAhead(account, ctx.model, ctx.advisorModel);
    ctx.selectionSkipped = sk.skipped ?? null;
    ctx.selectionSkippedMore = sk.skipped_more ?? null;
  } else {
    ctx.selectionSkipped = null;
    ctx.selectionSkippedMore = null;
  }
  if (!account) {
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
      emitProvenance(ctx, {
        final: true, outcome: 'pinned-unavailable', response_status: 429,
        account: ctx.account, attempt: ctx.attempt || 0,
      });
      return;
    }

    // T2 rotation gate: typed 409 at the TOP of the null-account branch —
    // strictly BEFORE holdBudgetMs sleep and exhaustedRetries inline wait.
    // Recompute gate-blocked model-scoped against _isAvailable; otherwise a
    // blocked session hangs holdSeconds then gets the forbidden lying 429.
    const gateRefusal = accountManager.rotationGateRefusal?.(
      ctx.sessionId, ctx.model, ctx.advisorModel, ctx.tried);
    if (gateRefusal) {
      const id8 = (ctx.sessionId || '').slice(0, 8);
      const families = gateRefusal.families.join(',') || '?';
      const blockedNames = gateRefusal.blockedAccounts;
      const msg = `Session ${id8} history contains artifacts from family `
        + `"${gateRefusal.families[0] || '?'}" not accepted by the only serveable `
        + `account(s) [${blockedNames.join(', ')}] for model ${ctx.model || '?'}. `
        + `Start a new session, pin an account (/tc-acct <name>), or clear the `
        + `ledger after fleet-side repair (POST /teamclaude/session/<id>/history-reset).`;
      console.log(`[TeamClaude] Rotation gate: session ${id8} (families: ${families}) `
        + `blocked from "${blockedNames.join(',')}" — history incompatible`);
      accountManager.rotationLedger.noteRefusal();
      ctx.status = 409;
      ctx.account = '(history-gate)';
      if (!res.headersSent) {
        res.writeHead(409, {
          'Content-Type': 'application/json',
          'x-teamclaude-refusal': 'session-history-incompatible',
        });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: msg },
        }));
      }
      // Do NOT call hooks.onRequestEnd here — the request listener's `finally`
      // owns the single terminal lifecycle event. An inner call double-fired
      // provenance/UI consumers for every gate refusal.
      emitProvenance(ctx, {
        final: true, outcome: 'session-history-incompatible', response_status: 409,
        account: ctx.account, attempt: ctx.attempt || 0,
      });
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
      if (res.destroyed) {
        emitProvenance(ctx, { final: true, outcome: 'client-disconnect', attempt: ctx.attempt || 0 });
        return;
      }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }

    const exhaustedRetries = ctx.exhaustedRetries || 0;
    if (exhaustedRetries < 1 && retryAfter <= INLINE_RETRY_AFTER_MAX_SECONDS) {
      ctx.exhaustedRetries = exhaustedRetries + 1;
      console.log(`[TeamClaude] All accounts exhausted — waiting ${retryAfter}s before retry`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      if (res.destroyed) {
        emitProvenance(ctx, { final: true, outcome: 'client-disconnect', attempt: ctx.attempt || 0 });
        return;
      }
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
    emitProvenance(ctx, {
      final: true, outcome: 'exhausted-typed-429', response_status: 429,
      account: ctx.account, attempt: ctx.attempt || 0,
    });
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
  // A pin is an explicit bypass of rotation (D8): never rotate an errored pin
  // onto another account — fall through and attempt (or surface) this one.
  if (account.status === 'error' && retryCount < maxRetries && ctx.pinnedIndex == null) {
    accountManager.releaseCircuitProbe(account.index);
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

  const effectiveUpstream = account.upstream || upstream;
  const upstreamUrl = `${effectiveUpstream}${req.url}`;
  const customUpstream = !isNativeAnthropicUpstream(effectiveUpstream);
  const method = req.method;

  // Strip orphaned tool_use / tool_result blocks so a client that compacted or
  // interrupted a turn can't wedge the session with Anthropic's non-retryable
  // 400 ("tool_use ids were found without tool_result blocks"). No-op (same
  // Buffer) for a well-formed body.
  // Move role:"system" entries out of messages[] into top-level `system`
  // (Anthropic 400s on them: "use the top-level 'system' parameter"). Runs
  // first so the tool-pair pass sees the real message list. Same Buffer when
  // there is nothing to move.
  const shapeMeta = { reqId, account: account.name, model: ctx.model };
  logBodyShape('ingress', body, shapeMeta);
  const folded = foldSystemMessages(body, req.url, req.headers['content-type']);
  logBodyShape('after-system-fold', folded.body, shapeMeta);
  if (folded.count > 0) {
    emitProvenance(ctx, {
      _account: account,
      final: false,
      outcome: 'system-message-folded',
      count: folded.count,
      attempt: ctx.attempt || 0,
    });
  }
  let sendBody = sanitizeToolPairs(folded.body, req.url, req.headers['content-type']);
  logBodyShape('after-tool-pair-sanitize', sendBody, shapeMeta);
  sendBody = normalizeGeminiArgonRequest(sendBody, {
    model: account.modelMap?.[ctx.model] || ctx.model,
    native: !customUpstream,
  });
  // D3: when rotating onto Anthropic after a foreign family served this
  // session, drop thinking/redacted_thinking so Anthropic does not 400 on
  // foreign signatures. Ledger-based; empty ledger ⇒ inert.
  if (ctx.ingressThinkingStrip) {
    const targetFamily = account.historyFamily || resolveHistoryFamily(account);
    const servedFamilies = accountManager.rotationLedger?.familiesOf(ctx.sessionId) || [];
    if (shouldStripForeignThinking({
      enabled: true,
      targetFamily,
      servedFamilies,
    })) {
      const stripped = stripThinkingBlocks(sendBody, req.url, req.headers['content-type']);
      if (stripped.count > 0) {
        sendBody = stripped.body;
        emitProvenance(ctx, {
          _account: account,
          final: false,
          outcome: 'thinking-stripped',
          count: stripped.count,
          attempt: ctx.attempt || 0,
        });
      }
    }
  }
  // Align the body's account_uuid (in metadata.user_id) with the account whose
  // token we're injecting (same-length patch; no-op if absent).
  if (account.accountUuid) sendBody = patchAccountUuid(sendBody, account.accountUuid);
  // Rewrite the model name for accounts that target a different upstream (e.g.
  // GLM), which uses different model identifiers than Anthropic. Advisor
  // tools[].model walks the same map; on a custom upstream an unmapped advisor
  // id is stripped (never egressed verbatim) — G9 strip-and-degrade. Custom
  // upstreams also cannot accept the advisor tool *type* (codex-shaped tool
  // enums reject `advisor_20260301` with a 400), so the whole advisor tool is
  // dropped there — with or without a modelMap (e.g. codex-gpt56 → local
  // anthropic-proxy has no modelMap but still must not egress the variant).
  // A custom provider that implements the beta tool can opt in explicitly with
  // supportsAdvisorTools:true; custom effective upstreams default closed. The
  // classification uses the same effective URL as transport so an account that
  // inherits a custom top-level upstream cannot bypass the compatibility gate.
  if (account.modelMap || customUpstream) {
    sendBody = rewriteModel(sendBody, account.modelMap || {}, {
      stripUnmappedAdvisor: customUpstream && !account.supportsAdvisorTools,
      dropAdvisorTools: customUpstream && !account.supportsAdvisorTools,
      onAdvisorStrip: (id) => {
        accountManager.noteAdvisorDegrade('unmapped', id, account.name);
        ctx.advisorDegraded = true;
      },
      onAdvisorDrop: (id) => {
        accountManager.noteAdvisorDegrade('unsupported-tool', id, account.name);
        ctx.advisorDegraded = true;
      },
    });
  }
  // Custom upstreams that cannot parse a `pattern` escape reject the WHOLE request
  // (DeepSeek: `"^[^\\0]*$" is not a "regex"`), so sanitize tool schemas before
  // egress. Gated on customUpstream — native Anthropic accepts the guard as-is.
  if (customUpstream && sendBody.length > 0) {
    sendBody = stripUnparseablePatterns(sendBody);
  }

  // Content-Length must match the bytes we actually send. Gate-time advisor
  // strip, sanitize, uuid patch, and model rewrite can all change the length
  // relative to the client's original header — always recompute from sendBody.
  if (!['GET', 'HEAD'].includes(method)) {
    headers['content-length'] = String(sendBody.length);
  }
  // Last stage: the exact bytes that go to the upstream on this attempt.
  logBodyShape('final-egress', sendBody, shapeMeta);

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => {
    if (!logDir) return null;
    if (!log) {
      log = openRequestLog(logDir, reqId);
      ctx.logFile = log.filename;
    }
    return log;
  };
  const logRequestHead = () => {
    const l = getLog();
    if (!l || reqLogged) return;
    reqLogged = true;
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    if (safeHeaders['authorization']) safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    l.write(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`);
    // Record the POST-rewrite sendBody — exactly what egresses. Logging the
    // pre-rewrite `body` here would falsely show a dropped advisor tool as
    // still present (2026-09-01 audit finding: logs claimed advisor egress on
    // requests where dropAdvisorTools had spliced it off).
    if (sendBody.length > 0) l.body('REQUEST BODY', sendBody, req.headers['content-type']);
  };

  try {
    // Storm control: pace requests onto a freshly-switched account so a failover
    // burst doesn't slam it all at once and cascade (issue #84). The slot is held
    // only until the response headers arrive — long enough to stagger the burst,
    // then released so streaming bodies don't tie up concurrency. Fail-open: a
    // client that disconnects while waiting just drops out.
    const admitT0 = Date.now();
    if (!await accountManager.admit(account.index, () => res.destroyed)) {
      accountManager.releaseCircuitProbe(account.index);
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome: 'client-disconnect',
        attempt: ctx.attempt || 0,
        timings: { admit_ms: Date.now() - admitT0, headers_ms: null, total_ms: Date.now() - admitT0 },
      });
      return;
    }
    const admitMs = Date.now() - admitT0;
    let upstreamRes;
    // Attempt increments exactly once per upstream EGRESS (not per recursion).
    ctx.attempt = (ctx.attempt || 0) + 1;
    const attemptStartedAt = Date.now();
    ctx.attemptRec = {
      usage: { input: null, output: null },
      response_reported_model: null,
      stream: false,
      admit_ms: admitMs,
      headers_ms: null,
      total_ms: null,
      startedAt: attemptStartedAt,
    };
    try {
      upstreamRes = await upstreamFetch(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
        redirect: 'manual',
      }, sx, route);
      ctx.attemptRec.headers_ms = Date.now() - attemptStartedAt;
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
    //
    // Handled BEFORE custom-upstream breaker scoring: a 401 is an auth event,
    // not provider health (must not open the circuit, and must not be scored as
    // a success that falsely "heals" a half-open probe). The recursive retry is
    // a NEW selection/egress — release the half-open probe claim first (RF-1),
    // mirroring the status==='error' retry path.
    if (upstreamRes.status === 401 && account.type === 'oauth' && account.refreshToken
        && retryCount < maxRetries && !ctx.reauthed.has(account.index)) {
      ctx.reauthed.add(account.index);
      await upstreamRes.body?.cancel();
      accountManager.releaseCircuitProbe(account.index);
      emitProvenance(ctx, {
        _account: account,
        final: false,
        outcome: 'reauth-401-retry',
        response_status: 401,
        attempt: ctx.attempt,
        timings: {
          admit_ms: admitMs,
          headers_ms: ctx.attemptRec.headers_ms,
          total_ms: Date.now() - attemptStartedAt,
        },
      });
      console.log(`[TeamClaude] 401 on "${account.name}" — token rejected; forcing refresh and retrying`);
      await accountManager.ensureTokenFresh(account.index, true);
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // Custom-adapter health is account-specific. A locally supervised adapter
    // returning any 5xx means THIS provider path is unhealthy, unlike an
    // arbitrary model/client 4xx (never retry) or Anthropic's quota/rate 429
    // (handled below). Open its circuit and try another eligible account before
    // any response headers reach the client. The response body is discarded so
    // the underlying socket returns to the pool cleanly. (A bare 500 used to be
    // scored as provider *health*, which reset consecutiveFailures and pinned
    // the 2s→60s backoff at its floor.)
    if (account.upstream && upstreamRes.status >= 500) {
      accountManager.noteProviderResult(account.index, {
        ok: false, status: upstreamRes.status, latencyMs: Date.now() - attemptStartedAt,
      });
      // D8/D11: a pin bypasses rotation — do not mark tried + recurse (that
      // collapses into a misleading 429 pinned-unavailable). Relay the real 5xx.
      if (retryCount < maxRetries && !res.headersSent && ctx.pinnedIndex == null) {
        await upstreamRes.body?.cancel();
        console.log(`[TeamClaude] Custom upstream ${upstreamRes.status} on "${account.name}" — circuit open, failing over`);
        emitProvenance(ctx, {
          _account: account,
          final: false,
          outcome: 'failover-upstream-5xx',
          response_status: upstreamRes.status,
          attempt: ctx.attempt,
          timings: {
            admit_ms: admitMs,
            headers_ms: ctx.attemptRec.headers_ms,
            total_ms: Date.now() - attemptStartedAt,
          },
        });
        ctx.tried.add(account.index);
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }
      // Fall through: retries exhausted, pinned, or headersSent — relay as upstream-error.
    } else if (account.upstream) {
      // Reachable provider. A 4xx may be a bad request/model and remains
      // non-retryable, but it proves the adapter path itself is healthy.
      accountManager.noteProviderResult(account.index, {
        ok: true, status: upstreamRes.status, latencyMs: Date.now() - attemptStartedAt,
      });
    }

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
      // D8/D11: pin → never rotate; fall through to surface the real 429.
      if ((generalRejected || fableRejected) && retryCount < maxRetries && ctx.pinnedIndex == null) {
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
        emitProvenance(ctx, {
          _account: account,
          final: false,
          outcome: 'quota-429-rotate',
          response_status: 429,
          attempt: ctx.attempt,
          timings: {
            admit_ms: admitMs,
            headers_ms: ctx.attemptRec.headers_ms,
            total_ms: Date.now() - attemptStartedAt,
          },
        });
        ctx.tried.add(account.index);
        if (res.destroyed) {
          emitProvenance(ctx, {
            _account: account, final: true, outcome: 'client-disconnect', attempt: ctx.attempt,
          });
          return;
        }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }

      retryAfter = Math.min(Math.max(retryAfter, 1), 300);

      // sx.org failover: 429s are IP-based, so retry via the proxy's egress IP.
      // 'always' is already on sx; '429' switches direct→sx now and skips the
      // wait (a fresh IP isn't throttled). Also arm the sticky window for MITM.
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route;
      sx?.noteRateLimited(retryAfter);

      // Transient rate-limit 429 (per-minute throttle), NOT quota exhaustion.
      // Default: pause + retry the SAME account (#84 — don't move the burst).
      // R1: after N consecutive transient-429s on this (request, account)
      // (config transient429RotateAfter, default 3; 0 = legacy never-rotate),
      // cool the account down and rotate like the quota-rejection path — but
      // only when another eligible candidate exists (single-candidate keeps
      // wait-retry).
      accountManager.pauseAccount(account.index, Math.min(retryAfter, RATE_LIMIT_ABSORB_MAX_SECONDS));

      ctx.transient429Counts ??= new Map();
      const consec = (ctx.transient429Counts.get(account.index) || 0) + 1;
      ctx.transient429Counts.set(account.index, consec);
      const rotateAfter = ctx.transient429RotateAfter ?? 3;

      const waitTimings = {
        admit_ms: admitMs,
        headers_ms: ctx.attemptRec.headers_ms,
        total_ms: Date.now() - attemptStartedAt,
      };
      emitProvenance(ctx, {
        _account: account,
        final: false,
        outcome: 'rate-429-inline-wait',
        response_status: 429,
        attempt: ctx.attempt,
        via_sx: route,
        timings: waitTimings,
      });

      // D8/D11: pin → never rotate onto another account.
      if (rotateAfter > 0 && consec >= rotateAfter && retryCount < maxRetries && ctx.pinnedIndex == null) {
        const exclude = new Set(ctx.tried);
        exclude.add(account.index);
        const next = accountManager.getActiveAccount(
          exclude, ctx.model, ctx.advisorModel, ctx.sessionId,
        );
        if (next) {
          const cooldown = Math.max(retryAfter, 60);
          console.log(`[TeamClaude] Rate-limit 429 on "${account.name}" — ${consec} consecutive transient-429s `
            + `(cap ${rotateAfter}); cooling ${cooldown}s and switching account`);
          accountManager.markRateLimited(account.index, cooldown);
          emitProvenance(ctx, {
            _account: account,
            final: false,
            outcome: 'transient-429-cap',
            response_status: 429,
            attempt: ctx.attempt,
            timings: waitTimings,
          });
          ctx.tried.add(account.index);
          if (res.destroyed) {
            emitProvenance(ctx, {
              _account: account, final: true, outcome: 'client-disconnect', attempt: ctx.attempt,
            });
            return;
          }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
        }
        // No next candidate — fall through to same-account wait / surface.
      }

      // sx fresh-IP retry (still the same account) takes precedence over waiting.
      // Bounded by retryCount like the inline-wait path below, so a persistently
      // 429ing upstream can't loop forever through sx.
      if (switchingToSx && retryCount < maxRetries) {
        console.log(`[TeamClaude] 429 on "${account.name}" — retrying via sx.org (fresh egress IP)`);
        if (res.destroyed) {
          emitProvenance(ctx, {
            _account: account, final: true, outcome: 'client-disconnect', attempt: ctx.attempt,
          });
          return;
        }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // Absorb short waits inline on the same account — the client never sees the
      // 429. Bounded by retryCount (maxRetries = account count) so a persistently
      // rate-limited account can't loop forever tying up the connection.
      if (retryAfter <= RATE_LIMIT_ABSORB_MAX_SECONDS && retryCount < maxRetries) {
        console.log(`[TeamClaude] Rate-limit 429 on "${account.name}" — waiting ${retryAfter}s, retrying same account (no switch)`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        if (res.destroyed) {
          emitProvenance(ctx, {
            _account: account, final: true, outcome: 'client-disconnect', attempt: ctx.attempt,
          });
          return;
        }
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, nextUseSx);
      }

      // Longer retry-after (or retries exhausted): don't hold the connection and
      // don't rotate — surface the 429 with retry-after so the client backs off.
      // The pause above keeps other requests off this account meanwhile.
      console.log(`[TeamClaude] Rate-limit 429 on "${account.name}" — retry-after ${retryAfter}s over inline cap; returning 429 to client (no switch)`);
      ctx.status = 429;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `Rate limited; retry in ${retryAfter}s.` } }));
      }
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome: 'rate-429-surfaced',
        response_status: 429,
        attempt: ctx.attempt,
        timings: {
          admit_ms: admitMs,
          headers_ms: ctx.attemptRec.headers_ms,
          total_ms: Date.now() - attemptStartedAt,
        },
      });
      return;
    }

    // Log the request head (once) followed by the response headers, streaming
    // to disk from here on.
    logRequestHead();
    getLog()?.write(`\n\n=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);

    ctx.status = upstreamRes.status;

    // T2: mark served family ONLY on successful /v1/messages (path-exact;
    // count_tokens excluded — adds no transcript artifact). Never at request
    // start: a failed failover must not self-mark.
    if (upstreamRes.status < 300 && ctx.pathClass === 'messages' && ctx.sessionId) {
      accountManager.noteServedFamily?.(ctx.sessionId, account.index);
    } else if (
      upstreamRes.status >= 400 && upstreamRes.status < 500 && upstreamRes.status !== 429
      && ctx.pathClass === 'messages'
      && Array.isArray(account.acceptsHistoryFamilies)
      && ctx.sessionId
    ) {
      // Gate-miss smoke alarm (option (c) demoted to telemetry): a strict tier
      // 4xx'd a messages request — append the session's known family set.
      const known = accountManager.rotationLedger?.familiesOf(ctx.sessionId) || [];
      console.log(`[TeamClaude] Strict-tier ${upstreamRes.status} on "${account.name}" `
        + `for session ${(ctx.sessionId || '').slice(0, 8)} `
        + `(ledger families: ${known.join(',') || 'none'}) — gate-miss telemetry`);
    }

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

    // D10: path-based labels (count-tokens-unsupported) need no body; body-based
    // labels (upstream-thinking-required) refine after the non-stream buffer.
    // Empty/stream paths pass body:null → conservative fall-through.
    const classifyRelay = (body = null) => classifyUpstreamRelayOutcome({
      status: upstreamRes.status,
      path: ctx.path,
      pathClass: ctx.pathClass,
      body,
    });

    if (!upstreamRes.body) {
      const l = getLog();
      if (l) { l.write('\n\n=== RESPONSE BODY ===\n(empty)'); l.end(); }
      res.end();
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome: classifyRelay(null),
        response_status: upstreamRes.status,
        attempt: ctx.attempt,
        stream: false,
        timings: {
          admit_ms: admitMs,
          headers_ms: ctx.attemptRec.headers_ms,
          total_ms: Date.now() - attemptStartedAt,
        },
      });
      return;
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming) {
      // Stream each chunk straight to the log as it is relayed — never hold the
      // whole (potentially ~1M-token) SSE body in memory.
      const l = getLog();
      const bw = l ? l.bodyWriter('RESPONSE BODY (streamed)', contentType) : null;
      ctx.attemptRec.stream = true;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, bw, {
        sessionId: ctx.sessionId,
        model: ctx.model,
        pathClass: ctx.pathClass,
      }, ctx.attemptRec);
      l?.end();
      // R2: sliding-window budget from already-parsed attempt usage (no re-parse).
      accountManager.recordTokenBudget(account.index, ctx.attemptRec.usage);
      // Stream: no full body — thinking-required falls through; path labels still apply.
      const relayOutcome = classifyRelay(null);
      const outcome = res.destroyed ? 'client-disconnect' : relayOutcome;
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome,
        response_status: upstreamRes.status,
        attempt: ctx.attempt,
        stream: true,
        response_reported_model: ctx.attemptRec.response_reported_model,
        usage: ctx.attemptRec.usage,
        timings: {
          admit_ms: admitMs,
          headers_ms: ctx.attemptRec.headers_ms,
          total_ms: Date.now() - attemptStartedAt,
        },
      });
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager, {
        sessionId: ctx.sessionId,
        model: ctx.model,
        pathClass: ctx.pathClass,
      }, ctx.attemptRec);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
      // R2: sliding-window budget from already-parsed attempt usage (no re-parse).
      accountManager.recordTokenBudget(account.index, ctx.attemptRec.usage);
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome: classifyRelay(buf),
        response_status: upstreamRes.status,
        attempt: ctx.attempt,
        stream: false,
        response_reported_model: ctx.attemptRec.response_reported_model,
        usage: ctx.attemptRec.usage,
        timings: {
          admit_ms: admitMs,
          headers_ms: ctx.attemptRec.headers_ms,
          total_ms: Date.now() - attemptStartedAt,
        },
      });
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    // h250 2026-10-15: a corrupted TLS record ("bad record mac", seen ~10-40% of
    // large uploads from a Hyper-V-bridged Wi-Fi host) is a property of THIS
    // connection, not of the account. Retry the same request on a fresh
    // connection WITHOUT marking the account tried, so routing picks the same
    // (best) account again instead of failing over to a pay-per-use key or a
    // different model provider. Out of retries -> handled as transient below.
    const isTlsCorruption = err instanceof Error &&
      ((typeof err.code === 'string' && /^ERR_SSL_(SSLV3_ALERT_BAD_RECORD_MAC|DECRYPTION_FAILED|BAD_RECORD_MAC|WRONG_VERSION_NUMBER)/.test(err.code)) ||
        /bad record mac|decryption failed or bad record mac/i.test(err.message || '') ||
        /bad record mac/i.test(String(err.cause?.message || '')));
    if (isTlsCorruption && retryCount < maxRetries && !res.headersSent && ctx.pinnedIndex == null) {
      console.log(`[TeamClaude] TLS record corruption on "${account.name}" — retrying same route on a fresh connection (attempt ${retryCount + 1}/${maxRetries}, no account switch)`);
      emitProvenance(ctx, {
        _account: account,
        final: false,
        outcome: 'tls-corruption-retry',
        attempt: ctx.attempt || 0,
        err_code: err?.code ?? null,
      });
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    const isTransient = err instanceof Error &&
      (err.code === 'TEAMCLAUDE_HEADERS_TIMEOUT' || err.code === 'TEAMCLAUDE_BODY_TIMEOUT' ||
        err.name === 'TimeoutError' || err.name === 'AbortError' ||
        err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT' ||
        isTlsCorruption);

    const errOutcome = err?.code === 'TEAMCLAUDE_BODY_TIMEOUT'
      ? 'stream-idle-timeout'
      : 'transport-error';

    // A custom loopback/provider adapter is an independent failure domain. A
    // connection error to its own upstream is NOT a poisoned process-wide
    // Anthropic socket pool: open that account's circuit and try the next route
    // candidate before headers. Real Anthropic keeps the established destroy +
    // client-retry behavior below.
    // D8/D11: pinned → never rotate; surface the real transport error below.
    if (isTransient && account.upstream && retryCount < maxRetries && !res.headersSent
        && ctx.pinnedIndex == null) {
      accountManager.noteProviderResult(account.index, { ok: false, error: err.message });
      emitProvenance(ctx, {
        _account: account,
        final: false,
        outcome: errOutcome,
        attempt: ctx.attempt || 0,
        err_code: err?.code ?? null,
      });
      ctx.tried.add(account.index);
      console.log(`[TeamClaude] Custom upstream transport failure on "${account.name}" — circuit open, failing over`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // Transient network errors (including a stale-socket headers/body timeout):
    // close the connection and let the client retry. Failing over to another
    // account would not help (the poisoned fetch pool is process-wide), but the
    // fast failure lets Node evict the dead socket so the retry reconnects
    // cleanly. If headers were already sent (a mid-stream body timeout), destroy
    // is the only option — the client sees a broken response and retries.
    //
    // Pinned custom-upstream transport failures are NOT a poisoned Anthropic
    // pool: return a typed 502 naming the real error instead of destroy (or the
    // pre-fix misleading 429 pinned-unavailable).
    if (isTransient) {
      if (ctx.pinnedIndex != null && account.upstream && !res.headersSent && !res.destroyed) {
        accountManager.noteProviderResult(account.index, { ok: false, error: err.message });
        ctx.status = 502;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
        }));
        emitProvenance(ctx, {
          _account: account,
          final: true,
          outcome: errOutcome,
          response_status: 502,
          attempt: ctx.attempt || 0,
          err_code: err?.code ?? null,
        });
        return;
      }
      emitProvenance(ctx, {
        _account: account,
        final: true,
        outcome: errOutcome,
        attempt: ctx.attempt || 0,
        err_code: err?.code ?? null,
      });
      res.destroy();
      return;
    }

    // Any other thrown error is a transport/stream failure, NOT proof the
    // account's credentials are bad — a bad credential comes back as a 401
    // *response*, never a throw. So don't sideline the account (that would drop
    // a healthy account from rotation until a credential change). Instead skip
    // it for the rest of THIS request only and fail over to another account.
    // D8/D11: pinned → never rotate; fall through to the typed 502 below.
    if (retryCount < maxRetries && !res.headersSent && ctx.pinnedIndex == null) {
      emitProvenance(ctx, {
        _account: account,
        final: false,
        outcome: 'transport-error',
        attempt: ctx.attempt || 0,
        err_code: err?.code ?? null,
      });
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
    } else if (!res.writableEnded) {
      // Error after headers were already sent (mid-stream) and it wasn't
      // classified transient: we can't send a status or fail over, and
      // streamResponse deliberately skipped res.end(). Destroy so the client
      // sees a broken response and retries instead of hanging on an open socket.
      res.destroy();
    }
    emitProvenance(ctx, {
      _account: account,
      final: true,
      outcome: 'upstream-error-relayed',
      response_status: 502,
      attempt: ctx.attempt || 0,
      err_code: err?.code ?? null,
    });
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
 * `sessionCtx` (optional): { sessionId, model, pathClass } for T5 ctx recording.
 * `attemptRec` (optional): mutable T7 attempt record for reported model + usage.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter, sessionCtx = null, attemptRec = null) {
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
        parseSSEUsage(event, accountIndex, accountManager, sessionCtx, attemptRec);
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
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager, sessionCtx, attemptRec);
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

function parseSSEUsage(event, accountIndex, accountManager, sessionCtx = null, attemptRec = null) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message) {
      if (attemptRec && data.message.model != null) {
        attemptRec.response_reported_model = data.message.model;
      }
      if (data.message.usage) {
        const u = data.message.usage;
        accountManager.updateUsage(accountIndex, u.input_tokens, 0);
        if (attemptRec) {
          attemptRec.usage = attemptRec.usage || { input: null, output: null };
          attemptRec.usage.input = u.input_tokens ?? attemptRec.usage.input;
        }
        // T5: observed window occupancy = input + cache_read + cache_creation.
        // Excludes current-turn output (see absent.current_turn_output_tokens).
        if (sessionCtx?.sessionId && sessionCtx.pathClass !== 'count_tokens') {
          const contextTokens = (u.input_tokens || 0)
            + (u.cache_read_input_tokens || 0)
            + (u.cache_creation_input_tokens || 0);
          accountManager.sessionTracker.noteUsage(
            sessionCtx.sessionId,
            sessionCtx.model,
            contextTokens,
            { pathClass: sessionCtx.pathClass || 'messages' },
          );
        }
      }
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
      if (attemptRec) {
        attemptRec.usage = attemptRec.usage || { input: null, output: null };
        attemptRec.usage.output = data.usage.output_tokens ?? attemptRec.usage.output;
      }
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager, sessionCtx = null, attemptRec = null) {
  try {
    const json = JSON.parse(buffer.toString());
    if (attemptRec && json.model != null) {
      attemptRec.response_reported_model = json.model;
    }
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
      if (attemptRec) {
        attemptRec.usage = {
          input: json.usage.input_tokens ?? null,
          output: json.usage.output_tokens ?? null,
        };
      }
      // Non-stream /v1/messages: same observed sum; count_tokens excluded.
      if (sessionCtx?.sessionId && sessionCtx.pathClass !== 'count_tokens') {
        const u = json.usage;
        const contextTokens = (u.input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
          + (u.cache_creation_input_tokens || 0);
        accountManager.sessionTracker.noteUsage(
          sessionCtx.sessionId,
          sessionCtx.model,
          contextTokens,
          { pathClass: sessionCtx.pathClass || 'messages' },
        );
      }
    }
    // count_tokens is top-level {input_tokens} with no .usage — deliberately
    // NOT recorded into ctx (absent.count_tokens_ctx).
  } catch {
    // not JSON or no usage
  }
}

// Rewrite model ids in a JSON request body using a per-account map. Walks both
// the executor `model` and any advisor tools[].model. Returns the original
// buffer when nothing changes (or the body isn't JSON). `stripUnmappedAdvisor`
// preserves the legacy G9 behavior: an advisor id absent from the map has its
// `model` field dropped. `dropAdvisorTools` removes the whole advisor tool for
// custom upstreams whose tool enum does not recognize Claude Code's beta
// `advisor_20260301` variant. The Content-Length update at the write site
// already handles either size change.
// Exported for tests.
// Custom-upstream tool-schema compatibility (2026-09-18).
// Some third-party Anthropic-compatible backends PARSE a schema's `pattern` value
// as a regular expression and reject escapes their regex engine does not
// implement. DeepSeek rejects Claude Code's NUL-guard `^[^\0]*$` with
//   Invalid schema for function 'Artifact': "^[^\\0]*$" is not a "regex"  (400)
// which kills EVERY tool-bearing Claude Code turn on that route — the client
// surfaces it as a Fable error, falls back to Sonnet 5, and fails identically
// because both map to the same backend. Diagnosed live 2026-09-18 when bene-6's
// successor turn died ~90s after its handoff.
// We drop ONLY the patterns the backend provably cannot parse (`\0` escapes) —
// every other keyword, including other `pattern`s, is preserved, so the tool
// definition stays as close to the client's as the upstream allows. Native
// Anthropic upstreams accept the guard and are never touched (see the
// customUpstream gate at the call site).
// Exported for tests.
export function stripUnparseablePatterns(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    let changed = false;
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (typeof node.pattern === 'string' && node.pattern.includes('\\0')) {
        delete node.pattern;
        changed = true;
      }
      for (const v of Object.values(node)) walk(v);
    };
    if (Array.isArray(obj.tools)) walk(obj.tools);
    if (changed) return Buffer.from(JSON.stringify(obj), 'utf8');
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

export function rewriteModel(body, modelMap, {
  stripUnmappedAdvisor = false,
  dropAdvisorTools = false,
  normalizeAdvisorHistory = false,
  onAdvisorStrip = null,
  onAdvisorDrop = null,
} = {}) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    let changed = false;
    if (obj.model && modelMap[obj.model]) {
      obj.model = modelMap[obj.model];
      changed = true;
    }
    if (Array.isArray(obj.tools)) {
      for (let i = 0; i < obj.tools.length; ) {
        const t = obj.tools[i];
        if (!t || typeof t !== 'object' || typeof t.type !== 'string' || !/^advisor/i.test(t.type)) {
          i += 1;
          continue;
        }
        // Custom upstream (codex-shaped backend — e.g. sakana / api.sakana.ai,
        // or the local anthropic-proxy / deepseek-adapter relays): the advisor
        // tool *variant itself* is not in the backend's tool enum. Egressing
        // `type: "advisor_20260301"` 400s with "unknown variant
        // `advisor_20260301`, expected `web_search_20250305` or
        // `web_search_20260209`" (fleet incident 2026-08-21, recurrences killed
        // turns across ai-scientist/tc-fugu). The tool is a Claude-Code beta
        // feature (second-model routing) with no meaning for a third-party
        // backend, so drop the whole tool — not just its model (G9 completion).
        if (dropAdvisorTools) {
          obj.tools.splice(i, 1);
          changed = true;
          onAdvisorDrop?.(typeof t.model === 'string' && t.model ? t.model : t.type);
          continue; // next element shifted into index i — do not advance
        }
        if (typeof t.model !== 'string' || !t.model) {
          i += 1;
          continue;
        }
        if (modelMap[t.model]) {
          t.model = modelMap[t.model];
          changed = true;
        } else if (stripUnmappedAdvisor) {
          const stripped = t.model;
          delete t.model;
          changed = true;
          onAdvisorStrip?.(stripped);
        }
        i += 1;
      }
    }
    // Adapt only this outbound copy: a later native retry needs the original
    // server-tool history, including its encrypted advisor results, unchanged.
    // Pairs are linked within one assistant content array by
    // server_tool_use.id == advisor_tool_result.tool_use_id (NOT the ordinary
    // assistant-call/next-user-result pattern), so they are removed together.
    if ((dropAdvisorTools || normalizeAdvisorHistory) && Array.isArray(obj.messages)) {
      const advisorIds = new Set();
      for (const message of obj.messages) {
        if (!Array.isArray(message?.content)) continue;
        for (const block of message.content) {
          if (block?.type === 'advisor_tool_result' && block.tool_use_id) advisorIds.add(block.tool_use_id);
          if (block?.type === 'server_tool_use' && block.name === 'advisor' && block.id) advisorIds.add(block.id);
        }
      }
      for (const message of obj.messages) {
        if (!Array.isArray(message?.content)) continue;
        const content = [];
        let removed = false;
        for (const block of message.content) {
          if (block?.type === 'server_tool_use' && (block.name === 'advisor' || advisorIds.has(block.id))) {
            removed = true;
            continue;
          }
          if (block?.type !== 'advisor_tool_result') { content.push(block); continue; }
          removed = true;
          // Only the documented plaintext result is readable. Never stringify
          // encrypted_content, error objects, or unknown variants as invented
          // reasoning; the marker states only that history was dropped.
          const result = block.content;
          if (result?.type === 'advisor_result' && typeof result.text === 'string' && result.text.trim()) {
            content.push({ type: 'text', text: '[Historical advisor result]\n' + result.text });
          } else {
            content.push({ type: 'text', text: '[Historical advisor result unavailable on this backend.]' });
          }
        }
        if (removed) {
          message.content = content.length ? content : [{ type: 'text', text: '[Historical advisor call result omitted on this backend.]' }];
          changed = true;
        }
      }
    }
    if (changed) return Buffer.from(JSON.stringify(obj), 'utf8');
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
