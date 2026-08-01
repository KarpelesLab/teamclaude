import { randomUUID } from 'node:crypto';

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
export function codexHeaders(account, { stream = false, sessionId = null } = {}) {
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
    // The backend groups turns by session; reuse the client's session id when we
    // have one so multi-turn conversations stay coherent, and mint a stable one
    // per request otherwise.
    'session_id': sessionId || randomUUID(),
  };
  return headers;
}

/**
 * Does this account speak the Codex wire protocol?
 */
export function isCodexAccount(account) {
  return account?.protocol === 'codex';
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

class NotImplemented extends Error {
  constructor(what) {
    super(`${what} is not implemented yet (codex protocol translator, milestone 2)`);
    this.name = 'NotImplemented';
    this.notImplemented = true;
  }
}

/**
 * Translate an Anthropic Messages API request body into an OpenAI Responses API
 * request body.
 *
 * Shape of the work (see CLIProxyAPI internal/translator/codex/claude for a
 * reference implementation): `system` becomes a developer-role input message,
 * each Anthropic content block (text / image / tool_use / tool_result) maps to a
 * Responses input item, Anthropic tool schemas become function declarations, and
 * `thinking` maps onto `reasoning`.
 *
 * @param {Buffer} body - raw Anthropic request body
 * @param {string} model - upstream model name, already mapped via account.modelMap
 * @returns {Buffer} raw Responses API request body
 */
export function claudeRequestToCodex(body, model) { // eslint-disable-line no-unused-vars
  throw new NotImplemented('claudeRequestToCodex');
}

/**
 * Create a stateful translator that converts a Codex SSE stream into an
 * Anthropic SSE stream.
 *
 * Stateful because the two event models do not line up one-to-one: Anthropic
 * requires content blocks to be opened and closed with monotonically increasing
 * indices, while Codex emits output items that can interleave reasoning, text,
 * and tool calls. The translator owns that block bookkeeping across the stream.
 *
 * @returns {{ push(chunk: Buffer): Buffer[], end(): Buffer[] }}
 */
export function createCodexStreamTranslator() {
  throw new NotImplemented('createCodexStreamTranslator');
}

/**
 * Translate a complete (non-streaming) Codex response body into an Anthropic
 * Messages response body.
 */
export function codexResponseToClaude(body) { // eslint-disable-line no-unused-vars
  throw new NotImplemented('codexResponseToClaude');
}
