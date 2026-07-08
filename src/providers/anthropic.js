// Anthropic (Claude) provider definition — the single source of truth for every
// Anthropic-specific endpoint, host, and OAuth constant teamclaude relies on.
// Historically these were scattered as string literals across oauth.js, mitm.js,
// server.js, config.js and index.js; centralizing them here is the first step of
// the provider abstraction that lets a second provider (e.g. OpenAI/Codex) plug
// in alongside without touching the core relay/rotation machinery.

// The upstream origin requests are forwarded to (also the CONNECT host the MITM
// proxy terminates + rewrites).
const UPSTREAM_BASE = 'https://api.anthropic.com';
const API_HOST = 'api.anthropic.com';

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
};

export default anthropic;
