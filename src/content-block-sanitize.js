// Drop configured content-block types from `messages[].content[]` so a body
// Claude Code legitimately sends validates on a strict third-party upstream.
//
// Claude Code announces tools that appear after the first request with
// `tool_addition` / `tool_removal` blocks in a mid-conversation message.
// Anthropic accepts them; a strict Anthropic-compatible validator answers a
// non-retryable 400. The block stays in the history, so every later turn of that
// conversation fails too, not just the one that introduced it. Which block types
// a backend rejects is that backend's business, so nothing is dropped by
// default: the operator lists them per account as
// `stripRequestFields: ["content.tool_addition", "content.tool_removal"]`, the
// same opt-in every other body rewrite keyed on `upstream` has.
//
// Only `messages[].content[]` is walked. A `type` of the same name deeper down —
// a `tool_use.input` the model emitted, a `tool_result` payload — is data, and
// rewriting it would change a tool call.
//
// A body with nothing to strip is returned as the SAME Buffer instance, so the
// forwarder's `sendBody !== body` check keeps it a no-op with zero
// re-serialization cost on the hot path.

import { isMessagesRequest, isPlainObject } from './cache-control-sanitize.js';

const TYPE_PREFIX = 'content.';

/**
 * The content-block types an account's `stripRequestFields` asks to drop: every
 * entry of the form `content.<type>`.
 * @param {unknown} stripRequestFields
 */
export function contentBlockTypesToStrip(stripRequestFields) {
  const out = new Set();
  if (!Array.isArray(stripRequestFields)) return out;
  for (const f of stripRequestFields) {
    if (typeof f === 'string' && f.startsWith(TYPE_PREFIX) && f.length > TYPE_PREFIX.length) {
      out.add(f.slice(TYPE_PREFIX.length));
    }
  }
  return out;
}

/**
 * Drop content blocks of the given types from a buffered /v1/messages body.
 *
 * @param {Buffer} body fully-buffered request body
 * @param {string} url req.url (only /v1/messages bodies are inspected)
 * @param {string|undefined} contentType the request's content-type header
 * @param {Iterable<string>} types block types to drop (e.g. `tool_addition`)
 * @returns {Buffer} the original buffer when nothing needed dropping (or on any
 *   parse / shape surprise), else a re-serialized buffer without those blocks.
 */
export function sanitizeContentBlocks(body, url, contentType, types) {
  const drop = types instanceof Set ? types : new Set(types || []);
  if (drop.size === 0) return body;
  if (!Buffer.isBuffer(body) || body.length === 0) return body;
  if (!isMessagesRequest(url, contentType)) return body;
  // Fast path: a block of a listed type puts its quoted name in the body, so
  // without any of them the (potentially multi-hundred-KB) parse is skipped.
  if (![...drop].some(t => body.includes(JSON.stringify(t)))) return body;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // not JSON we can reason about — never break it
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.messages)) return body;

  try {
    if (!dropFromMessages(payload, drop)) return body;
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return body; // any surprise → forward the original untouched
  }
}

/**
 * @param {any} payload
 * @param {Set<string>} drop
 * @returns {boolean} whether anything was removed
 */
function dropFromMessages(payload, drop) {
  let changed = false;
  payload.messages = payload.messages.filter((/** @type {any} */ message) => {
    if (!isPlainObject(message) || !Array.isArray(message.content)) return true;
    /** @type {any} */
    let orphanedBreakpoint;
    const kept = message.content.filter((/** @type {any} */ block) => {
      if (!isPlainObject(block) || !drop.has(block.type)) return true;
      if (block.cache_control) orphanedBreakpoint = block.cache_control;
      return false;
    });
    if (kept.length === message.content.length) return true;
    changed = true;
    // Claude Code hangs the message's cache breakpoint on its LAST block, which
    // is one of the blocks leaving. Losing it costs the cache hit for the whole
    // prefix on every later turn, so it moves to the last block that stays.
    const last = kept[kept.length - 1];
    if (orphanedBreakpoint && isPlainObject(last) && !last.cache_control) last.cache_control = orphanedBreakpoint;
    message.content = kept;
    // An empty content array is itself a 400 on the backends this exists for.
    return kept.length > 0;
  });
  return changed;
}
