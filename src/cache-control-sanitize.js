// Strip undocumented subfields from `cache_control` prompt-cache breakpoints so
// a body Claude Code legitimately sends validates on strict third-party
// upstreams.
//
// Claude Code sends `cache_control` subfields Anthropic accepts but strict
// Anthropic-compatible validators reject with a non-retryable 400 — breaking
// EVERY request once such an account is selected. Probed against a real strict
// backend (api.meta.ai): `scope` draws `unknown parameter`, and `ttl: 1h` draws
// `` `cache_control.ttl: 1h` is not supported``; bare `{type: ephemeral}` and
// `{type, ttl: 5m}` both return 200. So only `type` is forwarded: `ttl: 5m` is
// the default window and dropping it is lossless, while `ttl: 1h` must go. The
// one cost is a shorter cache window on backends that do support `1h` —
// requests still succeed. A `cache_control` left with no `type` is dropped
// rather than sent empty (an empty object is itself an extra input to a
// strict schema).
//
// This only ever REMOVES cache hints: dropping one can cost a cache hit, never
// correctness — the request means the same without it. A body with no unknown
// subfields is returned as the SAME Buffer instance (identity preserved), so the
// forwarder's `sendBody !== body` check keeps it a no-op with zero
// re-serialization cost on the hot path.

const MESSAGES_PATH = '/v1/messages';

// Every cache_control-bearing body contains this exact JSON substring. Without
// it there is nothing this pass could ever strip, so the (potentially
// multi-hundred-KB) JSON.parse is skipped — a cheap Buffer scan instead. A
// false positive (the literal text inside some string content) only costs an
// unnecessary parse that still returns the same Buffer, so it stays correct.
const CACHE_CONTROL_MARKER = Buffer.from('"cache_control"');

// The only cache_control subfield forwarded to a custom upstream. Anything
// else is either a strictly-rejected extension (`scope`, `ttl: 1h`) or the
// default window restated (`ttl: 5m`) — see above.
const KEPT_SUBFIELDS = new Set(['type']);

// Is this a JSON /v1/messages (or /v1/messages/count_tokens) request we can
// reason about? Everything else (token refreshes, GETs, non-JSON) is left alone.
function isMessagesRequest(url, contentType) {
  if (typeof url !== 'string' || !url.includes(MESSAGES_PATH)) return false;
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Strip undocumented `cache_control` subfields from a buffered /v1/messages body.
 *
 * @param {Buffer} body fully-buffered request body
 * @param {string} url req.url (only /v1/messages bodies are inspected)
 * @param {string} [contentType] the request's content-type header
 * @returns {Buffer} the original buffer when nothing needed stripping (or on any
 *   parse / shape surprise), else a re-serialized buffer with the unknown
 *   subfields removed.
 */
export function sanitizeCacheControl(body, url, contentType) {
  if (!Buffer.isBuffer(body) || body.length === 0) return body;
  if (!isMessagesRequest(url, contentType)) return body;
  // Fast path: no cache_control at all → nothing to strip, skip the parse.
  if (!body.includes(CACHE_CONTROL_MARKER)) return body;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // not JSON we can reason about — never break it
  }
  if (!isPlainObject(payload)) return body;

  try {
    const removed = stripUnknownSubfields(payload);
    if (!removed) return body;
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return body; // any surprise → forward the original untouched
  }
}

// Walk the parsed body, dropping undocumented cache_control subfields (and
// cache_control keys left empty by that). Returns the number of keys removed.
function stripUnknownSubfields(root) {
  let removed = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (isPlainObject(item) || Array.isArray(item)) stack.push(item);
      continue;
    }
    if (!isPlainObject(current)) continue;
    for (const key of Object.keys(current)) {
      const value = current[key];
      if (key === 'cache_control' && isPlainObject(value)) {
        for (const sub of Object.keys(value)) {
          if (!KEPT_SUBFIELDS.has(sub)) { delete value[sub]; removed++; }
        }
        if (Object.keys(value).length === 0) { delete current[key]; removed++; }
        else for (const sub of Object.values(value)) if (isPlainObject(sub) || Array.isArray(sub)) stack.push(sub);
        continue;
      }
      if (isPlainObject(value) || Array.isArray(value)) stack.push(value);
    }
  }
  return removed;
}
