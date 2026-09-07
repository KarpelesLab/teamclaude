// Rewrite the request body's account_uuid to match the account whose token we
// inject. Claude Code puts the logged-in account's UUID inside `metadata.user_id`
// (a stringified JSON) of /v1/messages; under rotation that would disagree with
// the injected token.
//
// This is a STREAMING, byte-exact JSON state machine — no regex, no whole-body
// buffering — so it handles arbitrarily large bodies fed in chunks. It tracks
// JSON structure (container stack, current key, in-string/escape) to find the
// `metadata.user_id` string value, and only inside that value does it look for
// the `account_uuid` field and overwrite its 36-char value with the new UUID
// (same length → no content-length/flow-control changes). A stray `account_uuid`
// elsewhere in the body (user content, tool results) is never touched.

// Byte sequence of `account_uuid":"` as it appears INSIDE the (escaped) user_id
// string: account_uuid \ " : \ "
const PREFIX = Buffer.from('account_uuid\\":\\"', 'latin1');
const CANONICAL_METADATA_USER_ID = Buffer.from('"metadata":{"user_id":"', 'latin1');
let lastSlowFallbackWarning = 0;

function hasOuterStringEndBefore(buf, start, limit) {
  let at = start;
  while ((at = buf.indexOf(0x22, at)) >= 0 && at < limit) {
    let slashes = 0;
    for (let i = at - 1; i >= start && buf[i] === 0x5c; i--) slashes++;
    if (slashes % 2 === 0) return true;
    at++;
  }
  return false;
}

export class AccountUuidPatcher {
  constructor(newUuid) {
    this.newUuid = (typeof newUuid === 'string' && newUuid.length === 36) ? Buffer.from(newUuid, 'latin1') : null;
    this.frames = [];          // container stack: { container:'obj'|'arr', name, key, awaitingKey }
    this.inStr = false;
    this.esc = false;
    this.readingKey = false;
    this.keyBuf = [];
    this.target = false;       // inside the metadata.user_id string value
    this.matchPos = 0;         // PREFIX match progress (within target)
    this.uuidRemaining = 0;    // value bytes left to overwrite
    this.done = false;         // patched the one account_uuid already
    this.changed = false;
  }

  /** Feed a chunk; returns a same-length chunk (patched in place). */
  push(chunk) {
    if (!this.newUuid || this.done) return chunk;
    const out = Buffer.from(chunk);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.#byte(out[i]);
      if (this.done) break; // rest passes through unchanged
    }
    return out;
  }

  #top() { return this.frames[this.frames.length - 1]; }

  #byte(b) {
    if (this.target) return this.#targetByte(b);

    if (this.inStr) {
      if (this.esc) { this.esc = false; if (this.readingKey) this.keyBuf.push(b); return b; }
      if (b === 0x5c) { this.esc = true; return b; }             // backslash
      if (b === 0x22) {                                          // end of string
        this.inStr = false;
        if (this.readingKey) { this.#top().key = Buffer.from(this.keyBuf).toString('latin1'); this.keyBuf = []; this.readingKey = false; }
        return b;
      }
      if (this.readingKey) this.keyBuf.push(b);
      return b;
    }

    const top = this.#top();
    switch (b) {
      case 0x7b: this.frames.push({ container: 'obj', name: top ? top.key : null, key: null, awaitingKey: true }); break; // {
      case 0x5b: this.frames.push({ container: 'arr', name: top ? top.key : null, key: null, awaitingKey: false }); break; // [
      case 0x7d: case 0x5d: this.frames.pop(); break;            // } ]
      case 0x3a: if (top) top.awaitingKey = false; break;        // : (key → value)
      case 0x2c: if (top && top.container === 'obj') top.awaitingKey = true; break; // ,
      case 0x22:                                                 // string start
        if (top && top.container === 'obj' && top.awaitingKey) {
          this.readingKey = true; this.keyBuf = []; this.inStr = true; this.esc = false;
        } else {
          this.inStr = true; this.esc = false; this.readingKey = false;
          if (top && top.container === 'obj' && top.name === 'metadata' && top.key === 'user_id' && this.frames.length === 2) {
            this.target = true; this.matchPos = 0; this.uuidRemaining = 0;
          }
        }
        break;
      default: break; // scalars / whitespace
    }
    return b;
  }

  // Inside the metadata.user_id string value: stream-match the account_uuid key
  // and overwrite its 36-byte value. Detect the (unescaped) closing quote to exit.
  #targetByte(b) {
    if (this.uuidRemaining > 0) {
      const outByte = this.newUuid[this.newUuid.length - this.uuidRemaining];
      this.uuidRemaining--;
      if (outByte !== b) this.changed = true;
      if (this.uuidRemaining === 0) this.done = true; // only one account_uuid per body
      return outByte;
    }
    if (this.esc) { this.esc = false; this.#match(b); return b; }
    if (b === 0x5c) { this.esc = true; this.#match(b); return b; }
    if (b === 0x22) { this.target = false; this.matchPos = 0; return b; } // end of user_id value
    this.#match(b);
    return b;
  }

  #match(b) {
    if (b === PREFIX[this.matchPos]) {
      this.matchPos++;
      if (this.matchPos === PREFIX.length) { this.uuidRemaining = 36; this.matchPos = 0; }
    } else {
      this.matchPos = (b === PREFIX[0]) ? 1 : 0; // PREFIX has no internal repeat of its first byte
    }
  }
}

/** One-shot convenience (whole-buffer); returns the same instance if unchanged. */
export function patchAccountUuid(buf, newUuid) {
  if (typeof newUuid !== 'string' || newUuid.length !== 36) return buf;
  // Most proxied request bodies do not carry this optional metadata at all.
  // A native scan can prove the rewrite is a no-op without walking every JSON
  // key in JavaScript.
  if (!buf.includes(PREFIX)) return buf;
  let fallbackReason = 'noncanonical-metadata';
  // Claude Code emits compact JSON with this structural key sequence. Quotes
  // inside prompt strings are escaped, so the unescaped sequence cannot be a
  // user-content false positive. Native Buffer searches skip the potentially
  // multi-megabyte messages array without executing JavaScript once per byte.
  const metadataAt = buf.indexOf(CANONICAL_METADATA_USER_ID);
  if (metadataAt >= 0 && buf.indexOf(CANONICAL_METADATA_USER_ID, metadataAt + 1) < 0) {
    const valueStart = metadataAt + CANONICAL_METADATA_USER_ID.length;
    const prefixAt = buf.indexOf(PREFIX, valueStart);
    if (prefixAt >= valueStart && !hasOuterStringEndBefore(buf, valueStart, prefixAt)) {
      const uuidAt = prefixAt + PREFIX.length;
      const oldUuid = buf.toString('latin1', uuidAt, uuidAt + 36);
      if (oldUuid.length === 36) {
        if (oldUuid === newUuid) return buf;
        const out = Buffer.from(buf);
        out.write(newUuid, uuidAt, 36, 'latin1');
        return out;
      }
    }
  }
  // Whole request bodies are already buffered by the retry layer. Let V8's
  // native JSON parser validate the exact metadata value, then locate that
  // serialized string with native Buffer searches. This avoids calling the JS
  // byte-state-machine once per byte/key across multi-megabyte conversations.
  // If the value is encoded unusually or appears more than once, retain the
  // structural streaming patcher as the conservative compatibility fallback.
  try {
    const outer = JSON.parse(Buffer.from(buf).toString('utf8'));
    const userId = outer?.metadata?.user_id;
    if (typeof userId === 'string') {
      fallbackReason = 'ambiguous-serialization';
      const serialized = Buffer.from(JSON.stringify(userId), 'utf8');
      const valueAt = buf.indexOf(serialized);
      const uniqueValue = valueAt >= 0 && buf.indexOf(serialized, valueAt + 1) < 0;
      const prefixAt = serialized.indexOf(PREFIX);
      const uniquePrefix = prefixAt >= 0 && serialized.indexOf(PREFIX, prefixAt + 1) < 0;
      const uuidAt = prefixAt + PREFIX.length;
      const oldUuid = serialized.toString('latin1', uuidAt, uuidAt + 36);
      if (valueAt < 0) fallbackReason = 'serialized-value-not-found';
      else if (!uniqueValue) fallbackReason = 'serialized-value-duplicate';
      else if (prefixAt < 0) fallbackReason = 'uuid-prefix-not-found';
      else if (!uniquePrefix) fallbackReason = 'uuid-prefix-duplicate';
      else if (oldUuid.length !== 36) fallbackReason = 'account-id-not-36-bytes';
      if (uniqueValue && uniquePrefix && oldUuid.length === 36) {
        if (oldUuid === newUuid) return buf;
        const out = Buffer.from(buf);
        out.write(newUuid, valueAt + uuidAt, 36, 'latin1');
        return out;
      }
    }
  } catch { /* malformed/unusual JSON: preserve the exact structural fallback */ }
  const fallbackStarted = Date.now();
  const p = new AccountUuidPatcher(newUuid);
  const out = p.push(buf);
  const fallbackMs = Date.now() - fallbackStarted;
  if (fallbackMs >= 100 && Date.now() - lastSlowFallbackWarning >= 60_000) {
    lastSlowFallbackWarning = Date.now();
    console.error(`[TeamClaude] Slow account UUID rewrite fallback: ${fallbackMs}ms, ${buf.length} bytes, reason=${fallbackReason}`);
  }
  return p.changed ? out : buf;
}
