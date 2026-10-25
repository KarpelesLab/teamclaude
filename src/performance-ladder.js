// Performance order for substituting a model when the requested id has no
// serveable account. Best first. Kimi Code (quality) sits above Kimi Code
// HighSpeed: a Sol/Fable miss degrades to Code before HighSpeed.
//
// Walk worse rungs first so a live session degrades instead of spending a
// better model's quota. If nothing worse can serve, walk upward. Callers
// decide what "can serve" means (route, blocklist, disabled, quota).

export const DEFAULT_PERFORMANCE_LADDER = Object.freeze([
  'claude-opus-5-5',
  'gpt-6-astra',
  'kimi-k3',
  'gemini-4-argon',
  'claude-fable-5-1',
  'gpt-6.1-sol',
  'kimi-k2.8-code',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'claude-sonnet-5-5',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'gemini-3.8-flash',
  'claude-haiku-4-5',
  'gpt-5.6-terra',
  'gpt-6-luna',
]);

// Picker aliases and the names the operator used, onto a ladder rung.
const ALIASES = Object.freeze({
  'opus': 'claude-opus-5-5',
  'claude-opus-5-5-ultra': 'claude-opus-5-5',
  'claude-opus-5-5-high': 'claude-opus-5-5',
  'claude-opus-5': 'claude-opus-5-5',
  'fable': 'claude-fable-5-1',
  'claude-fable-5': 'claude-fable-5-1',
  'sonnet': 'claude-sonnet-5-5',
  'sonnet5': 'claude-sonnet-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5-ultra': 'claude-sonnet-5-5',
  'claude-sonnet-5-5-high': 'claude-sonnet-5-5',
  'haiku': 'claude-haiku-4-5',
  'claude-haiku-5-5': 'claude-haiku-4-5',
  'gpt-6-terra': 'gpt-5.6-terra',
  'kimi': 'kimi-k3',
  'kimi-pro-3.1': 'kimi-k3',
  'kimi-code': 'kimi-k2.8-code',
  'kimi-code-highspeed': 'kimi-k2.7-code-highspeed',
  'kimi-k2.7-code-high-speed': 'kimi-k2.7-code-highspeed',
  'deepseek-v4.1-flash-1017': 'deepseek-v4-flash',
  'deepseek-v4.1-flash': 'deepseek-v4-flash',
  'gemini-4-argo': 'gemini-4-argon',
  'gemini-3.8-falsh': 'gemini-3.8-flash',
});

export function normalizeLadder(ladder) {
  const src = Array.isArray(ladder) && ladder.length ? ladder : DEFAULT_PERFORMANCE_LADDER;
  const out = [];
  const seen = new Set();
  for (const id of src) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function ladderIndex(model, ladder, aliases = ALIASES) {
  const raw = String(model || '');
  const bare = raw.replace(/\[\d+m\]$/, '');
  const id = aliases[raw] || aliases[bare] || bare;
  return ladder.indexOf(id);
}

/** Exclusive routes (gpt → codex-gpt56) must not hop to another route's id. */
export function exclusiveRouteHopAllowed(from, to, routeOf) {
  if (typeof routeOf !== 'function') return true;
  const src = routeOf(from);
  if (!src) return true;
  return routeOf(to) === src;
}

/**
 * Next model to try when `model` cannot be served.
 * `canServe(id)` is caller-defined and must be pure.
 * opts.skip: ids already attempted (including the original).
 */
export function nextServeableModel(model, ladder, canServe, opts = {}) {
  const rows = normalizeLadder(ladder);
  const skip = opts.skip || null;
  const aliases = opts.aliases || ALIASES;
  const idx = ladderIndex(model, rows, aliases);
  if (idx < 0) return null;
  const usable = (id) => id && id !== model && !(skip && skip.has(id)) && !!canServe(id);
  for (let i = idx + 1; i < rows.length; i++) {
    if (usable(rows[i])) return rows[i];
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (usable(rows[i])) return rows[i];
  }
  return null;
}

/** Rewrite the top-level messages `model` field. Non-JSON bodies pass through. */
export function replaceRequestModel(body, model) {
  try {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || typeof obj.model !== 'string') return body;
    obj.model = model;
    return Buffer.from(JSON.stringify(obj));
  } catch {
    return body;
  }
}
