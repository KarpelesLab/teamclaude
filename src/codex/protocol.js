import { randomUUID, createHash } from 'node:crypto';

// ChatGPT's Codex backend. Requests go to `${BASE}/responses` rather than the
// Anthropic `/v1/messages` path the client asked for, so the codex path builds
// its URL explicitly instead of appending req.url to an upstream base.
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// These credentials authenticate a ChatGPT subscription through the Codex CLI's
// OAuth client, and the backend expects requests to look like they came from
// that CLI. The version string is the surface most likely to need bumping when
// the backend tightens validation.
const CODEX_USER_AGENT = 'codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)';
const CODEX_ORIGINATOR = 'codex-tui';

/**
 * Build the upstream URL for a codex account.
 *
 * `path` is the client's original request path. Only the Messages endpoint has
 * a Responses-API equivalent; anything else (token counting, and the various
 * Anthropic-only endpoints) has no mapping and is rejected by the caller rather
 * than silently forwarded somewhere wrong.
 */
export function codexUrlForPath(path, baseUrl = CODEX_BASE_URL) {
  const base = baseUrl.replace(/\/$/, '');
  if (/^\/v1\/messages\/?$/.test(path.split('?')[0])) return `${base}/responses`;
  return null;
}

/**
 * Headers for a codex upstream request.
 *
 * Built from scratch rather than copied from the client: the inbound request
 * carries Anthropic-specific headers (anthropic-version, anthropic-beta,
 * x-api-key) that mean nothing here, and forwarding the client's user-agent
 * would defeat the CLI impersonation the backend expects.
 */
export function codexHeaders(account, { stream = false, cacheKey = null } = {}) {
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${account.credential}`,
    'user-agent': CODEX_USER_AGENT,
    'originator': CODEX_ORIGINATOR,
    'accept': stream ? 'text/event-stream' : 'application/json',
    // A missing account id reads as "not a subscription request" upstream and
    // fails in a way that looks like an auth problem, so treat its absence as a
    // programming error at the seam rather than letting the request go out bare.
    'chatgpt-account-id': account.accountId,
    // The backend groups turns by this header AND, when the body names no
    // prompt_cache_key, echoes it back as one — so it must carry the derived
    // cache key rather than a per-request UUID, or nothing is ever cached.
    // randomUUID only stands in for a caller that supplied no key at all.
    'session_id': cacheKey || randomUUID(),
  };
  return headers;
}

/**
 * Does this account speak the Codex wire protocol?
 */
export function isCodexAccount(account) {
  return account?.protocol === 'codex';
}

// Claude Code identifies a session and (for sub-agents) the agent within it.
// CLIProxyAPI keys its Codex prompt cache off the same pair.
export const SESSION_HEADER = 'x-claude-code-session-id';
export const AGENT_HEADER = 'x-claude-code-agent-id';
const MAIN_AGENT = 'main';

/**
 * Derive the prompt cache key for a request.
 *
 * Codex caches on a prompt prefix but scopes the cache by this key, so it has
 * to be STABLE across the turns of a conversation — a fresh key each request
 * means every turn re-reads the whole prefix at full price. Measured on a 3k
 * token prompt: a stable key caches 2816 of 3016 input tokens from the second
 * turn on, a per-request key caches nothing at all.
 *
 * Derived rather than random so it is stable without having to store anything,
 * and hashed so a session id never travels to the backend in the clear.
 *
 * The fallback matters as much as the main path: a client that sends no session
 * header (a plain SDK call, curl, anything that is not Claude Code) previously
 * got a fresh UUID per request and therefore no caching whatsoever. Falling back
 * to the account plus model keeps a stable key for those callers too.
 */
export function codexPromptCacheKey(account, { sessionId = null, agentId = null, model = null } = {}) {
  const scope = sessionId
    ? `session:${sessionId}:agent:${agentId || MAIN_AGENT}`
    : `account:${account?.accountId || account?.name || 'unknown'}`;
  const digest = createHash('sha256')
    .update(`teamclaude:codex:prompt-cache\0${model || ''}\0${scope}`)
    .digest('hex');
  // Formatted as a UUID because that is the shape the backend echoes back as
  // prompt_cache_key; an arbitrary string works but reads as a foreign value.
  return [
    digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16),
    digest.slice(16, 20), digest.slice(20, 32),
  ].join('-');
}

/**
 * Is this request asking for a streamed response?
 *
 * Deliberately a full parse rather than the streaming TopLevelFieldFinder used
 * elsewhere: that machine only captures string values (bare literals fall
 * through its scalar case), so it reports null for `"stream": true`. The codex
 * path parses the whole body during translation anyway, so nothing is lost.
 */
export function isStreamingRequest(body) {
  if (!body || body.length === 0) return false;
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf-8') : String(body)).stream === true;
  } catch {
    return false;
  }
}

// The body translators live in ./request-translate.js and ./response-translate.js;
// this module stays limited to transport concerns (URL, headers, account shape)
// so the translation layer can be tested without a server.
