// Drop orphaned tool_use / tool_result blocks from an Anthropic /v1/messages
// request body so a client that compacted or interrupted a turn can't wedge the
// session with Anthropic's non-retryable 400:
//
//   messages.N: `tool_use` ids were found without `tool_result` blocks
//   immediately after: toolu_XXXX. Each `tool_use` block must have a
//   corresponding `tool_result` block in the next message.
//
// Anthropic enforces this POSITIONALLY: every tool_use block in an assistant
// message must be answered by a matching tool_result in the IMMEDIATELY FOLLOWING
// message, and every tool_result must be grounded by a tool_use in the message
// right before it. A client that summarizes ("compacts") a long conversation or
// gets an in-flight tool call interrupted can break that in two ways:
//   1. the counterpart is dropped entirely (a tool_use with no result), or
//   2. the pair is SEPARATED — both blocks survive but other messages slip
//      between them, so the result is no longer "immediately after".
// Whole-body pairing (does the id exist somewhere?) misses case 2 — that is the
// bug that let the 400 through. This checks the true neighbor instead.
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

// Ids of the tool_use blocks in a message (empty for a non-array / absent message).
function toolUseIds(msg) {
  const ids = new Set();
  if (msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && typeof b === 'object' && b.type === 'tool_use' && typeof b.id === 'string') ids.add(b.id);
    }
  }
  return ids;
}

// tool_use_ids referenced by the tool_result blocks in a message.
function toolResultIds(msg) {
  const ids = new Set();
  if (msg && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && typeof b === 'object' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.add(b.tool_use_id);
    }
  }
  return ids;
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

// When pruning empties whole messages, two same-role messages can end up adjacent
// (a user turn that held only an orphaned tool_result is removed, leaving the
// assistant turns on either side touching). Anthropic requires roles to alternate,
// so coalesce same-role neighbors by concatenating their content.
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

// One pruning pass over the array. Strips positionally-unpaired blocks, drops any
// message it empties, and (only when it dropped something) coalesces same-role
// neighbors so roles still alternate. Returns the possibly-new array plus whether
// it changed anything. Mutates the `content` arrays of the (already-cloned) input.
function pruneOnce(messages) {
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const answeredByNext = toolResultIds(messages[i + 1]); // results that answer THIS msg's tool_use
    const groundedByPrev = toolUseIds(messages[i - 1]); // tool_use that grounds THIS msg's tool_result
    const kept = [];
    for (const b of msg.content) {
      if (b && typeof b === 'object') {
        // A tool_use whose result is not in the immediately following message.
        if (b.type === 'tool_use' && typeof b.id === 'string' && !answeredByNext.has(b.id)) {
          changed = true;
          continue;
        }
        // A tool_result whose tool_use is not in the immediately preceding message.
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !groundedByPrev.has(b.tool_use_id)) {
          changed = true;
          continue;
        }
      }
      kept.push(b);
    }
    if (kept.length !== msg.content.length) msg.content = kept;
  }

  let droppedAny = false;
  const kept = [];
  for (const msg of messages) {
    if (msg && Array.isArray(msg.content) && msg.content.length === 0) {
      changed = true;
      droppedAny = true;
      continue;
    }
    kept.push(msg);
  }

  const result = droppedAny ? coalesceSameRole(kept) : kept;
  if (result.length !== kept.length) changed = true;
  return { messages: result, changed };
}

// Repeat pruning to a fixed point: dropping a message shifts adjacency, which can
// expose a new positional orphan (the cascade), so one pass is not enough. Each
// pass only removes, so this terminates. Returns the new array, or null if the
// body was already valid (so the caller can forward the original bytes untouched).
function pruneOrphans(messages) {
  let current = messages;
  let everChanged = false;
  for (let guard = 0; guard < 1000; guard++) {
    const { messages: next, changed } = pruneOnce(current);
    current = next;
    if (!changed) break;
    everChanged = true;
  }
  return everChanged ? current : null;
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
