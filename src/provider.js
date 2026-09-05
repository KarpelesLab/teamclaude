// Backend providers.
//
// TeamClaude was built around one upstream (Anthropic), so the things that
// differ per backend — which host to reach, how to present the account's
// credential, which request paths belong to it — were inlined at the call
// sites. Adding a second subscription backend (OpenAI's Codex) makes those the
// axis of variation, so they live here instead.
//
// This is deliberately NOT a translation layer. Each provider is a passthrough:
// the client speaks that provider's own protocol and the body is forwarded
// untouched. All that changes is which account's credential is injected, and
// where the request is sent. Converting between provider protocols would mean
// re-serialising tool calls, streaming events and cache breakpoints, which is
// exactly the fidelity loss this proxy exists to avoid.

/** Providers keyed by the value used in an account's `provider` field. */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    upstream: 'https://api.anthropic.com',
    // Anthropic pins the account inside the request body (metadata.user_id),
    // so the body rewrites apply here and only here.
    rewritesBody: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    // A Codex subscription authenticates against the ChatGPT backend, not the
    // API platform: the OAuth token is a ChatGPT token and api.openai.com
    // rejects it with "Missing scopes: api.responses.write".
    upstream: 'https://chatgpt.com',
    // OpenAI carries the account in a request header, so no body rewrite is
    // needed — and the Anthropic-specific tool-pair repair would be wrong to
    // apply to a Responses API body.
    rewritesBody: false,
  },
};

export const DEFAULT_PROVIDER = 'anthropic';

/**
 * The provider an account belongs to. Accounts written before providers
 * existed have no `provider` field and are Anthropic, so the default keeps
 * every existing config working untouched.
 */
export function providerOf(account) {
  const id = account?.provider;
  return (id && PROVIDERS[id]) ? id : DEFAULT_PROVIDER;
}

/** Whether `id` names a provider we know how to talk to. */
export function isKnownProvider(id) {
  return Object.hasOwn(PROVIDERS, id);
}

// Request paths that belong to Codex rather than Anthropic.
//
// The Codex CLI appends `/responses` and `/models` to whatever `base_url` it is
// given, so pointing it at `<proxy>/backend-api/codex` makes it emit exactly
// the paths the ChatGPT backend already expects. That keeps this a pure
// passthrough — the proxy forwards the path verbatim and never rewrites it —
// and it keeps the Codex namespace clearly separated from Anthropic's `/v1/*`.
const CODEX_PATHS = ['/backend-api/codex'];

/**
 * Which provider should serve a request path.
 *
 * This is what lets one port serve both CLIs: Claude Code posts to
 * `/v1/messages` and Codex to `/backend-api/codex/responses`, so the path alone
 * says which pool of accounts is eligible. No second listener, no
 * client-supplied hint that could disagree with the body.
 */
export function providerForPath(url) {
  const path = String(url || '').split('?')[0];
  return CODEX_PATHS.some(p => path === p || path.startsWith(`${p}/`))
    ? 'codex'
    : DEFAULT_PROVIDER;
}

/**
 * Put the account's credential on an outgoing request.
 *
 * Mutates `headers` in place, mirroring how the forward path already builds
 * them. Returns nothing: the caller owns the object.
 *
 * - Anthropic OAuth and Codex both use `Authorization: Bearer`.
 * - Anthropic API keys use `x-api-key`.
 * - Codex additionally needs `ChatGPT-Account-Id`, which is how OpenAI scopes
 *   a token to one ChatGPT account. It is the direct counterpart of the
 *   `account_uuid` that the Anthropic path patches into the request body —
 *   a header here, so no body rewrite is involved.
 */
export function applyAuthHeaders(headers, account) {
  const provider = providerOf(account);
  if (provider === 'codex') {
    headers['authorization'] = `Bearer ${account.credential}`;
    if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
    return;
  }
  if (account.type === 'oauth') {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }
}

/**
 * Upstream base URL for an account: its own override first, then the
 * provider's default, then the configured Anthropic upstream.
 *
 * The configured `upstream` stays the Anthropic default rather than a global
 * one, because it predates providers and existing configs set it meaning
 * "where Anthropic lives". Applying it to Codex would silently send OpenAI
 * traffic to an Anthropic host.
 */
export function upstreamFor(account, configuredUpstream) {
  if (account?.upstream) return account.upstream;
  const provider = providerOf(account);
  if (provider !== DEFAULT_PROVIDER) return PROVIDERS[provider].upstream;
  return configuredUpstream || PROVIDERS.anthropic.upstream;
}

/** Whether the Anthropic-only body rewrites apply to this account. */
export function rewritesBody(account) {
  return PROVIDERS[providerOf(account)].rewritesBody;
}
