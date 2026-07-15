// Drop orphaned tool_use / tool_result blocks from an Anthropic /v1/messages
// request body so a client that compacted or interrupted a turn can't wedge the
// session with Anthropic's non-retryable 400:
//
//   messages.N: `tool_use` ids were found without `tool_result` blocks
//   immediately after: toolu_XXXX. Each `tool_use` block must have a
//   corresponding `tool_result` block in the next message.
//
// Anthropic requires every tool_use block to be answered by a matching
// tool_result in the next message. When a client summarizes ("compacts") a long
// conversation or an in-flight tool call is interrupted, the slice can split
// that pair, leaving a tool_use with no result (or a tool_result whose tool_use
// was cut). Anthropic then rejects the whole conversation and every follow-up in
// that session fails too, so the session is stuck until the client is rewound.
//
// The proxy already buffers and rewrites the body (account_uuid, model map), so
// it is the natural single place to normalize this for every client that routes
// through it. This pass only ever REMOVES provably-unpaired blocks; it never
// fabricates a tool_result the model would reason over. A well-formed body is
// returned as the SAME Buffer instance (identity preserved), so the forwarder's
// `sendBody !== body` check keeps it a no-op with zero cost on the hot path.

const MESSAGES_PATH = '/v1/messages';

// Is this a JSON /v1/messages (or /v1/messages/count_tokens) request we can
// reason about? Everything else (token refreshes, GETs, non-JSON) is left alone.
function isMessagesRequest(url, contentType) {
  if (typeof url !== 'string' || !url.includes(MESSAGES_PATH)) return false;
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

// Normalize a message's `content` to a block array so same-role messages can be
// merged losslessly. Anthropic accepts a single-text-block array as equivalent
// to a plain string, so this never changes meaning. Returns null for shapes we
// don't recognize (caller then declines to merge rather than risk corruption).
function toBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return null;
}

// After whole messages are dropped, two same-role messages can end up adjacent
// (e.g. a user turn that held only an orphaned tool_result is removed, leaving
// the assistant turns on either side touching). Anthropic requires roles to
// alternate, so coalesce any same-role neighbors by concatenating their content.
// This is a no-op when nothing is adjacent, so it is always safe to run.
function coalesceSameRole(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && msg && prev.role && prev.role === msg.role) {
      const a = toBlocks(prev.content);
      const b = toBlocks(msg.content);
      if (a && b) {
        out[out.length - 1] = { ...prev, content: [...a, ...b] };
        continue;
      }
    }
    out.push(msg);
  }
  return out;
}

// Returns a new messages array with orphans pruned, or null if nothing changed.
function pruneOrphans(messages) {
  // Whole-body pairing. In practice the only breakage clients produce is a
  // MISSING counterpart (an interrupted tail, or a compaction slice that split a
  // pair), never a reordered one, so pairing across the whole body catches every
  // real orphan class without ever un-pairing a valid adjacent pair.
  const useIds = new Set(); // ids of every tool_use block present
  const resultIds = new Set(); // tool_use_ids referenced by every tool_result
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') useIds.add(block.id);
      else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resultIds.add(block.tool_use_id);
    }
  }

  let mutated = false;
  let droppedMessage = false;
  const out = [];
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const kept = [];
    for (const block of msg.content) {
      if (block && typeof block === 'object') {
        // Drop a tool_use whose result is nowhere in the body.
        if (block.type === 'tool_use' && typeof block.id === 'string' && !resultIds.has(block.id)) {
          mutated = true;
          continue;
        }
        // Drop a tool_result whose tool_use is nowhere in the body.
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !useIds.has(block.tool_use_id)) {
          mutated = true;
          continue;
        }
      }
      kept.push(block);
    }
    if (kept.length === 0) {
      // The message held only orphan block(s); an all-orphan message is itself
      // orphaned and Anthropic rejects empty content, so drop the whole message.
      mutated = true;
      droppedMessage = true;
      continue;
    }
    out.push(kept.length !== msg.content.length ? { ...msg, content: kept } : msg);
  }

  if (!mutated) return null;
  return droppedMessage ? coalesceSameRole(out) : out;
}

/**
 * Strip orphaned tool_use / tool_result blocks from a buffered /v1/messages body.
 *
 * @param {Buffer} body fully-buffered request body
 * @param {string} url req.url (only /v1/messages bodies are inspected)
 * @param {string} [contentType] the request's content-type header
 * @returns {Buffer} the original buffer when nothing was unpaired (or on any
 *   parse / shape surprise), else a re-serialized buffer with orphans removed.
 */
export function sanitizeToolPairs(body, url, contentType) {
  if (!Buffer.isBuffer(body) || body.length === 0) return body;
  if (!isMessagesRequest(url, contentType)) return body;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // not JSON we can reason about — never break it
  }
  if (!payload || !Array.isArray(payload.messages)) return body;

  try {
    const pruned = pruneOrphans(payload.messages);
    if (!pruned) return body;
    payload.messages = pruned;
    return Buffer.from(JSON.stringify(payload), 'utf8');
  } catch {
    return body; // any surprise → forward the original untouched
  }
}
