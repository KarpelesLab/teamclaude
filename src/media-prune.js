// Custom (non-Anthropic) hops re-send every image/PDF as inline base64 on
// every turn. Native Anthropic prompt-caches the prefix, so the same
// conversation stays well under Claude Code's 32MB request-body cap. On
// Antigravity / gpt-6-astra / OpenAI-compat, the bytes accumulate until:
//   1. the client aborts with "Request too large (max 32MB)", or
//   2. /compact itself fails with "attached media exceeds size limits"
//      because the compact call still carries the PDFs/screenshots.
//
// This pass keeps only the newest base64 image/document blocks that fit a
// byte budget (default 8MB, well under 32MB) and replaces the rest with a
// short text placeholder. Native Anthropic is never rewritten (cache). A
// well-formed body under the budget, or with no media, is returned as the
// SAME Buffer (identity preserved), matching tool-pair-sanitize.

const MESSAGES_PATH = '/v1/messages';
const IMAGE_MARKER = Buffer.from('"image"');
const DOCUMENT_MARKER = Buffer.from('"document"');

export const DEFAULT_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;

function isMessagesRequest(url, contentType) {
  if (typeof url !== 'string' || !url.includes(MESSAGES_PATH)) return false;
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

function mediaBudgetFromEnv(env = process.env) {
  const raw = env.TEAMCLAUDE_MEDIA_BUDGET_BYTES;
  if (raw == null || raw === '') return DEFAULT_MEDIA_BUDGET_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MEDIA_BUDGET_BYTES;
  return Math.floor(n);
}

function isInlineMedia(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type !== 'image' && block.type !== 'document') return false;
  const src = block.source;
  if (!src || typeof src !== 'object') return false;
  if (src.type !== 'base64') return false;
  return typeof src.data === 'string' && src.data.length > 0;
}

function visitBlocks(blocks, acc, msgIndex) {
  if (!Array.isArray(blocks)) return;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') continue;
    if (isInlineMedia(b)) {
      acc.push({
        blocks,
        index: i,
        bytes: b.source.data.length,
        kind: b.type,
        mediaType: typeof b.source.media_type === 'string' ? b.source.media_type : b.type,
        msgIndex,
      });
    }
    if (b.type === 'tool_result') visitBlocks(b.content, acc, msgIndex);
  }
}

function placeholder(item) {
  const kb = Math.max(1, Math.round(item.bytes / 1024));
  return {
    type: 'text',
    text: `[omitted ${item.kind} ${item.mediaType}, ${kb}KB — stripped by teamclaude media-prune so the request stays under Claude Code's 32MB limit]`,
  };
}

/**
 * Drop older inline image/document base64 from a /v1/messages body.
 *
 * @returns {{body: Buffer, count: number, bytes: number}}
 *   `body` is the original Buffer when nothing changed.
 */
export function pruneHistoricalMedia(body, url, contentType, opts = {}) {
  const empty = { body, count: 0, bytes: 0 };
  if (!Buffer.isBuffer(body) || body.length === 0) return empty;
  if (opts.enabled === false) return empty;
  if (!isMessagesRequest(url, contentType)) return empty;

  const budget = Number.isFinite(opts.budgetBytes)
    ? Math.max(0, Math.floor(opts.budgetBytes))
    : mediaBudgetFromEnv(opts.env || process.env);
  if (budget === 0) return empty;
  // Whole body under the budget ⇒ media (a subset) cannot exceed it.
  if (body.length <= budget) return empty;
  if (!body.includes(IMAGE_MARKER) && !body.includes(DOCUMENT_MARKER)) return empty;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return empty;
  }
  if (!payload || !Array.isArray(payload.messages)) return empty;

  const acc = [];
  try {
    for (let m = 0; m < payload.messages.length; m++) {
      visitBlocks(payload.messages[m]?.content, acc, m);
    }
  } catch {
    return empty;
  }
  if (acc.length === 0) return empty;

  // Newest first: later messages, then later blocks inside a message.
  const order = acc.map((item, i) => ({ item, i }));
  order.sort((a, b) => {
    if (b.item.msgIndex !== a.item.msgIndex) return b.item.msgIndex - a.item.msgIndex;
    if (b.item.index !== a.item.index) return b.item.index - a.item.index;
    return b.i - a.i;
  });

  let kept = 0;
  const drop = [];
  for (const { item } of order) {
    if (kept + item.bytes <= budget) {
      kept += item.bytes;
    } else {
      drop.push(item);
    }
  }
  if (drop.length === 0) return empty;

  try {
    let bytes = 0;
    for (const item of drop) {
      item.blocks[item.index] = placeholder(item);
      bytes += item.bytes;
    }
    return {
      body: Buffer.from(JSON.stringify(payload), 'utf8'),
      count: drop.length,
      bytes,
    };
  } catch {
    return empty;
  }
}

export { isMessagesRequest, mediaBudgetFromEnv, isInlineMedia };
