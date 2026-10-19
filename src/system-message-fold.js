// Move role:"system" entries out of `messages` and into the top-level `system`
// field of an Anthropic /v1/messages request body.
//
// Claude Code 2.1.302 sometimes sends a request whose messages[0] is
// {"role":"system", ...} (the "<total_tokens>" note). The real Anthropic API
// rejects that with a non-retryable 400:
//
//   messages.0: use the top-level 'system' parameter for the initial system prompt
//
// and it rejects a role:"system" entry anywhere else in the array too. Folding
// the text into the top-level `system` field is accepted (verified 200). Doing it
// here, in the one place every request is forwarded from, fixes it for every
// upstream (native Anthropic and custom alike).
//
// Rules:
//   - Every role:"system" entry is removed; the order of the other messages is
//     kept. Their text is appended to `system` in the order they appeared.
//   - `system` keeps its shape: absent/null -> string, string -> string joined
//     with "\n\n", array -> extra {"type":"text","text":...} blocks appended.
//     Existing blocks (and their cache_control) are left as they are; no new
//     cache_control is added.
//   - A system message's content may be a string or an array of blocks; only
//     text blocks are taken.
//   - A body with no role:"system" message is returned as the SAME Buffer
//     (never re-serialized), so it is byte-for-byte unchanged. Anything we can't
//     parse or don't recognize is also returned unchanged.

const MESSAGES_PATH = '/v1/messages';

// Cheap pre-check so the common case (no system-role message) skips JSON.parse.
// Claude Code sends compact JSON; the spaced form covers pretty-printing clients.
// A false positive (this text inside some string) only costs a parse that then
// finds nothing and returns the same Buffer.
const MARKERS = [Buffer.from('"role":"system"'), Buffer.from('"role": "system"')];

function isMessagesRequest(url, contentType) {
  if (typeof url !== 'string' || !url.includes(MESSAGES_PATH)) return false;
  if (contentType && !/json/i.test(contentType)) return false;
  return true;
}

// Text pieces of one system message (string content, or the text blocks of an
// array content). Empty strings are skipped.
function textsOf(content) {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text) out.push(b.text);
  }
  return out;
}

/**
 * @param {Buffer} body request body
 * @param {string} url request url
 * @param {string} [contentType]
 * @returns {{ body: Buffer, count: number }} count = system messages moved
 */
export function foldSystemMessages(body, url, contentType) {
  const unchanged = { body, count: 0 };
  if (!Buffer.isBuffer(body) || body.length === 0) return unchanged;
  if (!isMessagesRequest(url, contentType)) return unchanged;
  if (!MARKERS.some((m) => body.includes(m))) return unchanged;

  let obj;
  try { obj = JSON.parse(body.toString('utf8')); } catch { return unchanged; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) return unchanged;

  const sys = obj.system;
  if (!(sys === undefined || sys === null || typeof sys === 'string' || Array.isArray(sys))) return unchanged;

  const kept = [];
  const texts = [];
  let count = 0;
  for (const m of obj.messages) {
    if (m && typeof m === 'object' && m.role === 'system') {
      count++;
      texts.push(...textsOf(m.content));
    } else {
      kept.push(m);
    }
  }
  if (count === 0) return unchanged;

  obj.messages = kept;
  if (texts.length) {
    if (Array.isArray(sys)) {
      obj.system = [...sys, ...texts.map((text) => ({ type: 'text', text }))];
    } else {
      obj.system = [...(typeof sys === 'string' && sys ? [sys] : []), ...texts].join('\n\n');
    }
  }
  return { body: Buffer.from(JSON.stringify(obj), 'utf8'), count };
}
