// Drop configured subfields from `cache_control` prompt-cache breakpoints so a
// body Claude Code legitimately sends validates on a strict third-party
// upstream.
//
// Claude Code sends `cache_control` subfields (`scope`, and `ttl: "1h"`) that
// Anthropic accepts but some strict Anthropic-compatible validators reject with
// a non-retryable 400 (`unknown parameter system.cache_control.scope`), which
// breaks EVERY request once such an account is selected. Which subfields a
// given backend rejects is that backend's business — `ttl` is documented by
// Anthropic and a mirror that honours `"1h"` must keep it — so nothing is
// dropped by default: the operator lists the subfields per account as
// `stripRequestFields: ["cache_control.scope"]`, the same opt-in every other
// body rewrite keyed on `upstream` has.
//
// Only the documented breakpoint positions are walked: the root, `system[]`,
// `messages[].content[]` (and a `tool_result` block's own `content[]`), and
// `tools[]`. A `cache_control` key anywhere else — inside a `tool_use.input`
// the model already emitted, a `tool_result` payload, `metadata` — is data,
// not a cache hint, and rewriting it would change a tool call.
//
// This only ever REMOVES cache hints: dropping one can cost a cache hit, never
// correctness. A body with nothing to strip is returned as the SAME Buffer
// instance, so the forwarder's `sendBody !== body` check keeps it a no-op with
// zero re-serialization cost on the hot path.

const MESSAGES_PATH = '/v1/messages';

// Every cache_control-bearing body contains this exact JSON substring. Without
// it there is nothing this pass could ever strip, so the (potentially
// multi-hundred-KB) JSON.parse is skipped — a cheap Buffer scan instead. A
// false positive (the literal text inside some string content) only costs an
// unnecessary parse that still returns the same Buffer, so it stays correct.
const CACHE_CONTROL_MARKER = Buffer.from('"cache_control"');

const SUBFIELD_PREFIX = 'cache_control.';

/**
 * The `cache_control` subfields an account's `stripRequestFields` asks to drop:
 * every entry of the form `cache_control.<name>`. Top-level entries are the
 * forwarder's `stripBodyFields` business and are ignored here.
 */
export function cacheControlSubfieldsToStrip(stripRequestFields) {
  const out = new Set();
  if (!Array.isArray(stripRequestFields)) return out;
  for (const f of stripRequestFields) {
    if (typeof f === 'string' && f.startsWith(SUBFIELD_PREFIX) && f.length > SUBFIELD_PREFIX.length) {
      out.add(f.slice(SUBFIELD_PREFIX.length));
    }
  }
  return out;
}

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
 * Strip the given `cache_control` subfields from a buffered /v1/messages body.
 *
 * @param {Buffer} body fully-buffered request body
 * @param {string} url req.url (only /v1/messages bodies are inspected)
 * @param {string} [contentType] the request's content-type header
 * @param {Iterable<string>} subfields subfield names to drop (e.g. `scope`)
 * @returns {Buffer} the original buffer when nothing needed stripping (or on any
 *   parse / shape surprise), else a re-serialized buffer with those subfields
 *   removed.
 */
export function sanitizeCacheControl(body, url, contentType, subfields) {
  const drop = subfields instanceof Set ? subfields : new Set(subfields || []);
  if (drop.size === 0) return body;
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
    const removed = stripAtDocumentedPositions(payload, drop);
    if (!removed) return body;
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return body; // any surprise → forward the original untouched
  }
}

// Drop `drop` subfields from `holder.cache_control` (and the key itself when
// nothing is left — an empty object is itself an extra input to a strict
// schema). Returns the number of keys removed.
function stripOn(holder, drop) {
  if (!isPlainObject(holder) || !isPlainObject(holder.cache_control)) return 0;
  const cc = holder.cache_control;
  let removed = 0;
  for (const sub of Object.keys(cc)) {
    if (drop.has(sub)) { delete cc[sub]; removed++; }
  }
  if (Object.keys(cc).length === 0) { delete holder.cache_control; removed++; }
  return removed;
}

// The documented breakpoint positions, and nothing else (see the header).
function stripAtDocumentedPositions(root, drop) {
  let removed = stripOn(root, drop);
  if (Array.isArray(root.system)) for (const block of root.system) removed += stripOn(block, drop);
  if (Array.isArray(root.tools)) for (const tool of root.tools) removed += stripOn(tool, drop);
  if (Array.isArray(root.messages)) {
    for (const message of root.messages) {
      if (!isPlainObject(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        removed += stripOn(block, drop);
        // A tool_result's own content blocks are breakpoint positions too; its
        // payload (a string, or whatever the tool returned) is not.
        if (isPlainObject(block) && block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const inner of block.content) removed += stripOn(inner, drop);
        }
      }
    }
  }
  return removed;
}
