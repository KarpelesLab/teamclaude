// Which CONVERSATION a request belongs to, for session-aware routing.
//
// `distributeSessions` pins a session to one account so the prompt cache it
// builds there survives, and spreads new sessions across the fleet. Both halves
// were keyed on the client's session id — `x-claude-code-session-id`. That
// header names a CLIENT SESSION, not a conversation, and the two stopped being
// the same thing once clients started fanning out: one Claude Code session
// emits ONE id for its own turns and for every subagent it launches. A fan-out
// therefore arrives as N concurrent requests wearing one tag, and the pin holds
// all N on one account, where they queue behind its concurrency ceiling while
// equal-priority siblings sit idle — the funnelling of issue #109, re-entered
// through the tag rather than through rotation.
//
// They gain nothing in exchange. The pin buys prompt-cache reuse, and an
// ordinary subagent starts a context of its own — its own system prompt, its
// own tools, its own transcript — so it shares no cache with its siblings or
// with its parent.
//
// A subagent FORKED from its parent's context is the exception, and the key
// handles it by saying nothing special about it: such a fork is sent with its
// parent's messages ahead of its own task, so its opening IS its parent's
// opening, it keys the same, and it lands on the account already holding the
// cache it inherited. Which is correct rather than a miss — those agents really
// do share a prefix, so co-locating them is what preserves it. A fan-out of
// forks concentrates for that reason, and one of fresh subagents spreads.
//
// So a conversation is identified by the thing the prompt cache is itself keyed
// on — the start of the request, and in practice its first message. Read the
// key as "the identity of the cached prefix", which is what makes it safe:
//
//   - A conversation cannot be split off its own cache. If the first message
//     changes, the cached prefix changed with it, so there was no cache left on
//     that account to preserve and re-pinning costs nothing. A client that
//     rewrites or trims its history from the front re-keys constantly and loses
//     nothing, because it invalidated its own cache each time it did so. A
//     `/compact` is exactly this case.
//   - A collision is harmless. Two conversations that open identically share a
//     key, so they share an account and each keeps its own cache. Nothing is
//     lost; only the load spreading is a shade coarser.
//
// WHY THE FIRST MESSAGE AND NOT THE SYSTEM PROMPT. Measured against Claude Code
// (a parent and three parallel subagents): the three siblings carried byte
// identical system prompts AND byte-identical tool definitions, and differed
// only in their first message. Keying on the system prompt would have left the
// fan-out funnelled exactly as before.
//
// WHY THE RAW BYTES. `cache_control` markers move between turns, and a marker
// moving onto or off the first message would change this digest while the
// cached content did not. Measured across a conversation growing from 2 to 17
// messages: Claude Code's markers sit on the system blocks and ride the trailing
// messages, never touching the first one, and the digest held for every request.
// A client that did mark its first message would re-key once, on the turn the
// marker moved off, and be stable afterwards — one cache miss, not a churn —
// which does not pay for parsing the body to normalise it away.
import { createHash } from 'node:crypto';

// How much of a conversation's opening is read. A first message can carry a
// pasted file — bodies are allowed up to 64 MiB, and `proxy.maxBodyBytes: 0`
// lifts even that — and neither the scan nor the hash may scale with it, or the
// cost of ROUTING a request would be set by how much the client pasted into it.
// So the walk stops here too, not just the digest.
//
// Two openings that agree over this much collide, which is the harmless case
// above. Past the bound they collide whatever their length, since an opening
// the scan never reached the end of has no length to tell them apart by.
export const MAX_CONVERSATION_BYTES = 64 * 1024;

// 132 bits of SHA-256. Long enough that a collision within one session's live
// conversations is not a thing that happens, short enough to read in a log line
// beside the session id.
const DIGEST_CHARS = 22;

// The separator between the session id and the digest. Outside the character
// set `clientSessionId` admits (`[A-Za-z0-9._-]`), so a session id can never
// spell a composite key itself.
const SEPARATOR = '/';

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * The byte range of the first element of the top-level `messages` array, or
 * null when the body has no such array or it is empty.
 *
 * Scans rather than parses. The body is held whole by the time a request picks
 * an account, so this could call JSON.parse — but that materialises the entire
 * message list, tools and system prompt as objects on every request, to read
 * one slice of it. This walks the bytes to that slice and stops, allocating
 * nothing, and it cannot throw on a body that is not the JSON we expect: a
 * truncated or foreign body simply yields no range.
 *
 * Checked against JSON.parse over 40k generated bodies; they agree everywhere
 * but one, and it is deliberate. A body carrying the top-level key `messages`
 * TWICE is parsed as its last occurrence and scanned as its first, because
 * stopping at the first is what lets this walk end early. Two such bodies
 * differing only in the list that counts therefore share a key — the harmless
 * collision above. The reverse also holds, and is the reason to state this
 * rather than bury it: a client that changed the copy nobody reads would re-key
 * a conversation whose cache had not moved. No client sends the key twice at
 * all, let alone edits the dead one, so this buys its early exit cheaply.
 *
 * @param {Buffer} body
 * @returns {[number, number]|null}
 */
function firstMessageRange(body) {
  const stack = [];         // container stack: true=object, false=array
  let depth = 0;
  let inString = false;
  let escaped = false;
  let awaitingKey = false;
  let keyStart = -1;
  let key = null;
  let arrayDepth = -1;      // depth INSIDE the messages array, -1 until found
  let start = -1;           // first byte of element 0

  // The element ends at its own last byte, not where the delimiter after it
  // begins. A pretty-printed body puts a newline and an indent between the two
  // on the turn where element 0 is the ONLY element (it ends at the array's
  // `]`), and none at all on every later turn (it ends at a `,` sitting tight
  // against the closing brace). Digesting that gap would make turn one differ
  // from turn two — a conversation split off its own cache, which is the one
  // thing this key may never do. Leading whitespace is already excluded, since
  // `start` is only taken on a non-whitespace byte.
  const upTo = (/** @type {number} */ to) => {
    while (to > start && WHITESPACE.has(body[to - 1])) to--;
    return /** @type {[number, number]} */ ([start, to]);
  };

  for (let i = 0; i < body.length; i++) {
    // Past the bound the opening is taken as it stands. Returned from inside the
    // walk rather than by clamping the range at the end, because the point is
    // not to read the rest of it.
    if (start >= 0 && i - start >= MAX_CONVERSATION_BYTES) return [start, start + MAX_CONVERSATION_BYTES];
    const b = body[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (b === 0x5c) { escaped = true; continue; }            // backslash
      if (b === 0x22) {                                        // closing quote
        inString = false;
        if (keyStart >= 0) { key = body.toString('utf8', keyStart, i); keyStart = -1; }
        // A bare string element — the whole of element 0, ending here.
        else if (start >= 0 && depth === arrayDepth) return upTo(i + 1);
      }
      continue;
    }

    // Element 0 opens at the first non-whitespace byte inside the array, unless
    // that byte closes an empty array.
    if (arrayDepth >= 0 && start < 0 && depth === arrayDepth && !WHITESPACE.has(b)) {
      if (b === 0x5d) return null;                             // `messages: []`
      start = i;
    }

    switch (b) {
      case 0x7b:                                               // {
        stack.push(true); depth++; awaitingKey = true; key = null;
        break;
      case 0x5b:                                               // [
        stack.push(false); depth++; awaitingKey = false;
        // Depth 2 and no array found yet: the value of a `messages` key at the
        // ROOT. A `messages` nested inside a tool's input schema sits deeper and
        // is not mistaken for the message list.
        if (arrayDepth < 0 && depth === 2 && key === 'messages') arrayDepth = depth;
        break;
      case 0x7d:                                               // }
      case 0x5d:                                               // ]
        stack.pop(); depth--; key = null;
        // Element 0 closing, either on its own `}` or on the `]` of a list that
        // holds nothing else. The `]` is not part of the element; the `}` is.
        if (start >= 0 && depth < arrayDepth) return upTo(b === 0x5d ? i : i + 1);
        if (depth === 0) return null;                          // root closed, no message list
        break;
      case 0x3a: awaitingKey = false; break;                   // :
      case 0x2c:                                               // ,
        if (start >= 0 && depth === arrayDepth) return upTo(i);
        awaitingKey = stack[stack.length - 1] === true;
        break;
      case 0x22:                                               // "
        inString = true;
        if (awaitingKey && stack[stack.length - 1]) keyStart = i + 1;
        break;
      default: break;
    }
  }
  return null;
}

/**
 * A digest of the conversation's opening, or null when the body names none —
 * a body that is not a message list at all (the Responses shape a translating
 * sidecar sends carries `input`/`instructions`), an empty list, or anything
 * unparseable. A null is not a failure: routing falls back to the session id
 * alone, which is what it keyed on before.
 *
 * @param {Buffer|null} body
 * @returns {string|null}
 */
export function conversationDigest(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  const range = firstMessageRange(body);
  if (!range) return null;
  const [from, to] = range;
  return createHash('sha256')
    .update(body.subarray(from, to))
    // The length goes in beside the bytes so an opening cannot be confused with
    // a different one that merely starts the same way.
    .update(`|${to - from}`)
    .digest('base64url')
    .slice(0, DIGEST_CHARS);
}

/**
 * The key session-aware routing pins on: the client's session id, narrowed to
 * the conversation within it. Falls back to the bare session id when the body
 * named no conversation, so a request that cannot be placed more precisely
 * routes exactly as it did before.
 *
 * Takes the digest rather than the body so a caller that also wants to REPORT
 * the conversation — the per-session readout names it beside the session — has
 * it in hand without digesting the same body twice. This module stays the only
 * place that knows how the two halves are spelled.
 *
 * @param {string|null} sessionId  from `clientSessionId`, already validated
 * @param {string|null} digest     from `conversationDigest`
 * @returns {string|null}
 */
export function pinKeyFor(sessionId, digest) {
  if (!sessionId) return null;
  return digest ? `${sessionId}${SEPARATOR}${digest}` : sessionId;
}
