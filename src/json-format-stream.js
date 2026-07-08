// Streaming JSON pretty-printer (no regex, no buffering of the whole body).
//
// Built on the same idea as the account_uuid patcher: walk the bytes once,
// tracking only enough state (nesting depth, in-string, escape) to know where
// we are, and re-emit with indentation as we go. This lets the request logger
// flush a readable body to disk *as it streams* — so when a request blocks
// mid-flight, the partial (pretty) body is already on disk and you can see how
// far it got. Bodies can be ~1M tokens, so we never hold more than the current
// chunk.
//
// Whitespace outside strings is dropped and re-inserted; strings (including any
// whitespace/escapes inside them) are copied verbatim. Operates on latin1 so a
// multi-byte UTF-8 sequence split across chunks is preserved byte-for-byte.
export class JsonStreamFormatter {
  constructor(indent = 2) {
    this.pad = ' '.repeat(indent);
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.freshContainer = false; // just opened { or [ — first element needs a newline+indent
  }

  nl(depth) { return '\n' + this.pad.repeat(depth); }

  // Feed a chunk; returns the formatted text for that chunk.
  push(buf) {
    const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (this.inStr) {
        out += ch;
        if (this.esc) this.esc = false;
        else if (ch === '\\') this.esc = true;
        else if (ch === '"') this.inStr = false;
        continue;
      }

      // Outside a string: collapse existing whitespace; we re-insert our own.
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;

      if (ch === '}' || ch === ']') {
        this.depth--;
        // Empty container: emit "{}" / "[]" with no inner newline.
        if (this.freshContainer) { this.freshContainer = false; out += ch; }
        else out += this.nl(this.depth) + ch;
        continue;
      }

      // Any other token. If it's the first token inside a just-opened
      // container, break the line and indent first.
      if (this.freshContainer) { out += this.nl(this.depth); this.freshContainer = false; }

      if (ch === '{' || ch === '[') { out += ch; this.depth++; this.freshContainer = true; continue; }
      if (ch === ',') { out += ',' + this.nl(this.depth); continue; }
      if (ch === ':') { out += ': '; continue; }
      if (ch === '"') { this.inStr = true; out += ch; continue; }
      out += ch; // number / true / false / null character
    }
    return out;
  }
}
