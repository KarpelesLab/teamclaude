// Anthropic (Claude) provider definition — the single source of truth for every
// Anthropic-specific endpoint, host, and OAuth constant teamclaude relies on.
// Historically these were scattered as string literals across oauth.js, mitm.js,
// server.js, config.js and index.js; centralizing them here is the first step of
// the provider abstraction that lets a second provider (e.g. OpenAI/Codex) plug
// in alongside without touching the core relay/rotation machinery.

import { patchAccountUuid } from '../account-uuid-rewrite.js';

// The upstream origin requests are forwarded to (also the CONNECT host the MITM
// proxy terminates + rewrites).
const UPSTREAM_BASE = 'https://api.anthropic.com';
const API_HOST = 'api.anthropic.com';

// Rewrite the `model` field in a JSON request body using a per-account map.
// Returns the original buffer unchanged if the model isn't in the map or the
// body isn't valid JSON, so non-messages endpoints pass through safely. Used for
// accounts whose upstream (e.g. a GLM-compatible backend) names models
// differently than Anthropic. Exported (and re-exported from server.js) for tests.
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

export const anthropic = {
  id: 'anthropic',
  label: 'Claude',

  // Default upstream origin; a per-account/config `upstream` may override it.
  upstreamBase: UPSTREAM_BASE,

  // Hosts this provider owns. Used by the MITM host router to decide which
  // CONNECT targets to terminate + rewrite (vs. blind-tunnel).
  hosts: [API_HOST],
  matchHost(host) {
    return this.hosts.includes(host);
  },

  // OAuth (extracted from Claude Code). Authorization-code + PKCE login, and a
  // refresh-token grant; both post JSON to `tokenUrl`.
  oauth: {
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    // Zero-spend endpoints used to enrich/probe an account.
    profileUrl: `${UPSTREAM_BASE}/api/oauth/profile`,
    usageUrl: `${UPSTREAM_BASE}/api/oauth/usage`,
    // Where the browser is sent after a successful CLI login so the tab lands on
    // a friendly page instead of a bare localhost redirect.
    successRedirect: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  },

  // ── per-request behavior (used by the forward path in server.js) ──────────

  // Inject the account's credential. OAuth accounts get a Bearer token; API-key
  // accounts get x-api-key. (The relay's header-copy loop already strips the
  // client's own x-api-key before this runs.)
  injectAuth(headers, account) {
    if (account.type === 'oauth') headers['authorization'] = `Bearer ${account.credential}`;
    else headers['x-api-key'] = account.credential;
  },

  // Align the request body with the account whose token we inject: patch
  // account_uuid (metadata.user_id; same-length, no-op if absent) and remap the
  // model name for third-party upstreams. Returns the original buffer unchanged
  // when nothing applies (caller compares by identity to fix Content-Length).
  rewriteBody(body, account) {
    let out = account.accountUuid ? patchAccountUuid(body, account.accountUuid) : body;
    if (account.modelMap) out = rewriteModel(out, account.modelMap);
    return out;
  },

  // Collect this provider's rate-limit response headers into a plain object, fed
  // to AccountManager.updateQuota to learn utilization passively from traffic.
  rateLimitHeaders(headers) {
    const out = {};
    for (const [key, value] of headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) out[key] = value;
    }
    return out;
  },

  // Classify a 429 from the unified rate-limit statuses. `quotaExhausted` means a
  // durable bucket is spent → rotate to another account. `modelScoped` means the
  // exhaustion is for the current model's weekly bucket only (Fable), so the
  // account stays usable for other models and must not be throttled wholesale.
  classify429(rateLimitHeaders) {
    const rl = rateLimitHeaders;
    const generalRejected = rl['anthropic-ratelimit-unified-5h-status'] === 'rejected'
      || rl['anthropic-ratelimit-unified-7d-status'] === 'rejected';
    const modelScoped = rl['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected' && !generalRejected;
    return { quotaExhausted: generalRejected || modelScoped, modelScoped };
  },

  // Passive token accounting. Both an SSE event object and a non-stream JSON body
  // carry a `usage` object; return { input, output } deltas, or null if absent.
  parseUsageEvent(data) {
    if (data.type === 'message_start' && data.message?.usage) return { input: data.message.usage.input_tokens || 0, output: 0 };
    if (data.type === 'message_delta' && data.usage) return { input: 0, output: data.usage.output_tokens || 0 };
    return null;
  },
  parseUsageBody(json) {
    if (json.usage) return { input: json.usage.input_tokens || 0, output: json.usage.output_tokens || 0 };
    return null;
  },
};

export default anthropic;
