import { codexHeaders, CODEX_BASE_URL } from './protocol.js';

// The Codex model catalog, fetched from the backend and translated into the
// shape Anthropic's /v1/models returns.
//
// This is what lets Claude Code list GPT models in its own picker: with
// CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY set, it reads /v1/models from the
// gateway at startup and offers whatever comes back. Serving the codex models
// there means selecting one is a first-class choice rather than something you
// have to disguise as a Claude model via modelMap.

// The catalog endpoint requires a client_version query parameter and 400s
// without one; the value only has to parse, not match any released build.
const CLIENT_VERSION = '0.146.0';

// The catalog changes on the order of model launches, so a long TTL is fine.
// It is refreshed lazily on the next request after it lapses.
const CACHE_TTL_MS = 60 * 60_000;

// Models Codex serves natively. Used for routing rather than the fetched
// catalog on purpose: selection has to work before any catalog fetch has
// happened (and when the fetch fails), and a request naming an unknown gpt-*
// model is better rejected by the backend than mis-routed to Anthropic.
const NATIVE_MODEL_PATTERN = /^(gpt-|codex-|o\d)/i;

/**
 * Does this model name belong to Codex rather than Anthropic?
 *
 * Deliberately a name test, not a catalog lookup — see NATIVE_MODEL_PATTERN.
 */
export function isCodexNativeModel(model) {
  return typeof model === 'string' && NATIVE_MODEL_PATTERN.test(model.trim());
}

/**
 * Translate one catalog entry into an Anthropic /v1/models entry.
 *
 * Claude Code reads `id` and `display_name` for the picker; the capability
 * block is filled in from what the catalog reports so an effort a model cannot
 * serve isn't advertised as available.
 */
export function codexModelToAnthropic(entry, createdAt) {
  const id = entry.slug || entry.id;
  if (!id) return null;

  const efforts = (entry.supported_reasoning_levels || [])
    .map(l => l && l.effort)
    .filter(Boolean);

  const effort = { supported: efforts.length > 0 };
  for (const level of efforts) effort[level] = { supported: true };

  return {
    type: 'model',
    id,
    display_name: entry.display_name || id,
    created_at: createdAt,
    ...(entry.context_window ? { max_input_tokens: entry.context_window } : {}),
    capabilities: {
      effort,
      // Codex reasons internally but is not asked for summaries, so no thinking
      // blocks come back; advertising thinking support would be a lie the client
      // would act on.
      thinking: { supported: false },
      image_input: { supported: true },
      structured_outputs: { supported: true },
    },
    // Not part of Anthropic's schema — a marker so a caller can tell where an
    // entry came from without re-testing the name.
    _codex: true,
  };
}

const cache = new Map(); // accountId -> { at, models }

/**
 * Fetch the Codex model catalog for an account, as Anthropic-format entries.
 *
 * Returns [] rather than throwing: this feeds a model listing, and a listing
 * that loses its Claude models because a ChatGPT token expired would be worse
 * than one missing its GPT models.
 */
export async function fetchCodexModels(account, { now = Date.now(), fetchImpl = fetch } = {}) {
  const key = account?.accountId || account?.name || 'default';
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.models;

  try {
    const headers = codexHeaders(account, { stream: false });
    // The catalog is a plain GET; drop the streaming Accept the request path uses.
    headers['accept'] = 'application/json';
    delete headers['content-type'];

    const base = (account.upstream || CODEX_BASE_URL).replace(/\/$/, '');
    const res = await fetchImpl(`${base}/models?client_version=${CLIENT_VERSION}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel?.();
      return hit ? hit.models : [];
    }

    const data = await res.json();
    const entries = Array.isArray(data?.models) ? data.models : [];
    // One timestamp for the batch: the catalog carries no per-model release
    // date, and the field is required by the schema Claude Code parses.
    const createdAt = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
    const models = entries.map(e => codexModelToAnthropic(e, createdAt)).filter(Boolean);

    cache.set(key, { at: now, models });
    return models;
  } catch {
    return hit ? hit.models : [];
  }
}

/** Drop cached catalogs — used by tests and after an account set changes. */
export function clearCodexModelCache() {
  cache.clear();
}
