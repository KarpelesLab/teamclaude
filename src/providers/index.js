// Provider registry. A "provider" bundles everything specific to one upstream
// service (Anthropic/Claude today; OpenAI/Codex next): its hosts, OAuth config,
// and — as the abstraction grows — auth injection, quota parsing, and 429
// classification. The core relay/rotation code stays provider-agnostic and
// resolves the right provider per request (by host) or per account (by id).

import { anthropic } from './anthropic.js';

export const DEFAULT_PROVIDER_ID = 'anthropic';

const PROVIDERS = {
  [anthropic.id]: anthropic,
};

/** Look up a provider by id, falling back to the default (never returns null). */
export function providerById(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER_ID];
}

/** The provider that owns `host` (e.g. from a CONNECT target), or null. */
export function providerForHost(host) {
  if (!host) return null;
  return Object.values(PROVIDERS).find((p) => p.matchHost(host)) || null;
}

/** The provider that owns an upstream origin URL, or null if unrecognized. */
export function providerForUpstream(upstream) {
  try {
    return providerForHost(new URL(upstream).hostname);
  } catch {
    return null;
  }
}

export { PROVIDERS };
