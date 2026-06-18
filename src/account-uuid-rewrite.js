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
  const p = new AccountUuidPatcher(newUuid);
  const out = p.push(buf);
  return p.changed ? out : buf;
}
