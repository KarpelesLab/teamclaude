// End-user identity stamping for upstream requests (IPM fork).
//
// Anthropic asks services that serve several end users under one credential to
// pass a stable per-user identifier in `metadata.user_id` for abuse detection.
// Through the gateway every request rides a seat's token, and what the body
// carries identifies the machine (Claude Code's device_id) but not the person:
// two users on one seat are indistinguishable, and a reinstall reads as a new
// user. The client key name is the stable per-person identity here — names are
// immutable in the console — so its hash is stamped into the user_id JSON.
//
// Hashed, never the name: user_id must not carry PII, and the console's
// fingerprints follow the same rule. Requests without a client key (the shared
// admin key, key-less loopback) go unstamped. Any structural doubt returns the
// body untouched: a request is never broken to stamp it.

import { createHash } from 'node:crypto';

/**
 * The stable per-user tag: `u_` + 16 hex of sha256 of the normalized client
 * key name (trimmed, lowercased — the same normalization client routes use).
 * @param {string} clientName
 * @returns {string}
 */
export function gatewayUserTag(clientName) {
  return 'u_' + createHash('sha256').update(String(clientName).trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Where `metadata.user_id` lives in a Messages request body, found with a
 * single-pass JSON state machine — never a full-body parse: bodies run to
 * several MB of conversation and this runs on every request.
 *
 * @typedef {{ kind: 'userId', start: number, end: number }
 *   | { kind: 'metadata', insertAt: number }
 *   | { kind: 'toplevel', closeAt: number }
 *   | null} UserIdSpan
 *
 * `userId`: [start, end) are the string indices of the ESCAPED content of the
 * user_id string value. `metadata`: a metadata object with no string user_id —
 * insertAt sits just after its opening brace. `toplevel`: no metadata key at
 * all, closeAt is the top-level object's closing brace.
 *
 * @param {string} text  the request body as a string
 * @returns {UserIdSpan}
 */
export function findUserIdSpan(text) {
  /** @type {{ type: 'obj'|'arr', expecting: 'key'|'colon'|'value'|'comma', key: string|null, isMeta: boolean }[]} */
  const stack = [];
  let inStr = false, esc = false, keyBuf = '';
  /** @type {UserIdSpan & { kind: 'userId' } | null} */
  let span = null;
  /** @type {number|null} */
  let metaInsertAt = null;
  let userIdNotString = false;
  // A top-level `metadata` key was seen whatever its value's shape: only an
  // OBJECT metadata earns an insertion point; any other shape is doubt.
  let metadataSeen = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') {
        inStr = false;
        const top = stack[stack.length - 1];
        if (top?.type === 'obj' && top.expecting === 'key') {
          // A key just closed.
          top.key = keyBuf;
          if (stack.length === 1 && keyBuf === 'metadata') metadataSeen = true;
          top.expecting = 'colon';
          keyBuf = '';
        } else if (top && (top.expecting === 'value' || top.type === 'arr')) {
          // A string value just closed.
          if (span && top.type === 'obj' && top.isMeta && top.key === 'user_id') span.end = i;
          top.expecting = 'comma';
        }
        continue;
      }
      if (stack[stack.length - 1]?.expecting === 'key') keyBuf += c;
      continue;
    }
    const top = stack[stack.length - 1];
    if (c === '"') {
      inStr = true;
      if (top?.type === 'obj' && top.expecting === 'key') keyBuf = '';
      else if (top?.type === 'obj' && top.expecting === 'value' && top.isMeta && top.key === 'user_id') {
        span = { kind: 'userId', start: i + 1, end: -1 };
      }
      continue;
    }
    if (c === '{' || c === '[') {
      // Only an OBJECT metadata value earns an insertion point (a user_id key
      // can be added to it); a metadata array or primitive is just doubt.
      const isMeta = c === '{' && top?.type === 'obj' && top.expecting === 'value' && top.key === 'metadata' && stack.length === 1;
      if (isMeta) metaInsertAt = i + 1;
      stack.push({ type: c === '{' ? 'obj' : 'arr', expecting: c === '{' ? 'key' : 'value', key: null, isMeta });
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      // After any closed container the parent — array OR object — expects a
      // comma or its own close next. Scoping this to objects once let a `,`
      // inside a multi-element array fall through to the primitive consumer,
      // which swallowed the next element's opening brace and miscounted every
      // depth from then on (the v1 incident: insertions landing inside
      // system/messages blocks).
      if (stack.length > 0) stack[stack.length - 1].expecting = 'comma';
      if (stack.length === 0 && c === '}') {
        // The top-level object's closing brace ends the document. A metadata
        // object that closed without a string user_id keeps its insert point;
        // a metadata key of any other shape is structural doubt.
        if (span) return span.end === -1 ? null : span;
        if (userIdNotString) return null;
        if (metaInsertAt != null) return { kind: 'metadata', insertAt: metaInsertAt };
        if (metadataSeen) return null;
        return { kind: 'toplevel', closeAt: i };
      }
      continue;
    }
    if (top?.type === 'obj' && top.expecting === 'colon' && c === ':') { top.expecting = 'value'; continue; }
    if (top?.expecting === 'comma' && c === ',') {
      if (top.type === 'obj') { top.expecting = 'key'; top.key = null; }
      else top.expecting = 'value';
      continue;
    }
    // A primitive (number, true, false, null) where a value is expected:
    // consume it to its delimiter. If that value is metadata.user_id, the
    // field is not a string and not ours to rewrite.
    if (top?.expecting === 'value' && !/\s/.test(c)) {
      if (top.type === 'obj' && top.isMeta && top.key === 'user_id') userIdNotString = true;
      while (i + 1 < text.length && text[i + 1] !== ',' && text[i + 1] !== '}' && text[i + 1] !== ']') i++;
      top.expecting = 'comma';
      continue;
    }
  }
  return null;
}

/**
 * The spliced body must parse as JSON and carry the tag at the top level —
 * `metadata.user_id` containing the tag — or the ORIGINAL body is returned.
 * This is the net under the span finder: a wrong span can no longer corrupt a
 * request, it can only skip the stamp. The full parse runs only on a splice,
 * never on the unstamped path.
 * @param {string} stamped
 * @param {Buffer} original
 * @param {string} tag
 * @returns {Buffer}
 */
function validated(stamped, original, tag) {
  try {
    const parsed = JSON.parse(stamped);
    const inner = JSON.parse(parsed?.metadata?.user_id);
    if (inner?.gateway_user === tag) return Buffer.from(stamped, 'utf8');
  } catch { /* fall through to the original */ }
  return original;
}

/**
 * Stamp the gateway user's tag into `metadata.user_id`, preserving everything
 * else — device_id, session id, account_uuid. Idempotent: a body already
 * carrying this user's tag comes back unchanged.
 *
 * @param {Buffer} body
 * @param {string} clientName
 * @returns {Buffer} the stamped body, or the original on any structural doubt
 */
export function stampGatewayUser(body, clientName) {
  const tag = gatewayUserTag(clientName);
  const text = Buffer.from(body).toString('utf8');
  const span = findUserIdSpan(text);
  try {
    if (!span) return body;
    if (span.kind === 'userId') {
      // The value is an escaped stringified JSON: unescape by wrapping in
      // quotes and parsing, then parse the inner document.
      const inner = JSON.parse(JSON.parse(`"${text.slice(span.start, span.end)}"`));
      if (inner.gateway_user === tag) return body;
      inner.gateway_user = tag;
      const reescaped = JSON.stringify(JSON.stringify(inner)).slice(1, -1);
      return validated(text.slice(0, span.start) + reescaped + text.slice(span.end), body, tag);
    }
    const userIdJson = JSON.stringify(JSON.stringify({ gateway_user: tag }));
    if (span.kind === 'metadata') {
      const insertion = `"user_id":${userIdJson},`;
      return validated(text.slice(0, span.insertAt) + insertion + text.slice(span.insertAt), body, tag);
    }
    // No metadata key at all: add one at the end of the top-level object.
    const insertion = `,"metadata":{"user_id":${userIdJson}}`;
    return validated(text.slice(0, span.closeAt) + insertion + text.slice(span.closeAt), body, tag);
  } catch {
    return body;
  }
}
