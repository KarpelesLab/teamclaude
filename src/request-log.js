// Streaming body writer for the request logger (used by the reverse-proxy /
// MITM forward path in server.js). JSON bodies are pretty-printed on the fly via
// a streaming state machine (src/json-format-stream.js) — never buffered whole,
// so even ~1M-token bodies cost only the current chunk, and a request that
// blocks mid-stream leaves its partial (readable) body on disk so you can see
// exactly how far it got. A body longer than the caller's cap is truncated
// rather than dropped, so the log stays bounded without losing the request.

import { JsonStreamFormatter } from './json-format-stream.js';

export const truncationNote = (bytes) => `... truncated ${bytes} bytes ...`;

// Tracks how one direction's body is written: decide formatter-vs-raw on the
// first chunk (event-stream → raw; otherwise pretty-print if it looks like JSON,
// i.e. the first non-whitespace byte is { or [). Writes the section header once.
export class BodyWriter {
  constructor(write, label, contentType, maxBytes = 0) {
    this.write = write;
    this.label = label;
    this.isStream = /event-stream/.test(contentType);
    this.decided = false;
    this.fmt = null;
    this.headerWritten = false;
    // Counted in body bytes rather than bytes written: the cap answers how much
    // of the body is kept, and pretty-printing expands whatever it keeps.
    this.remaining = maxBytes > 0 ? maxBytes : Infinity;
    this.dropped = 0;
  }
  chunk(buf) {
    if (!buf.length) return;
    if (this.remaining <= 0) { this.dropped += buf.length; return; }
    if (!this.headerWritten) { this.write(`\n\n=== ${this.label} ===\n`); this.headerWritten = true; }
    if (!this.decided) {
      const first = buf.toString('latin1').trimStart()[0];
      if (!this.isStream && (first === '{' || first === '[')) this.fmt = new JsonStreamFormatter();
      this.decided = true;
    }
    const kept = buf.length <= this.remaining ? buf : buf.subarray(0, this.remaining);
    this.dropped += buf.length - kept.length;
    this.remaining -= kept.length;
    this.write(this.fmt ? this.fmt.push(kept) : kept.toString('latin1'));
  }
  // A body arriving in chunks is truncated from the head only. A tail would need
  // a ring buffer per in-flight stream, so the cost would scale with concurrency
  // rather than with one chunk, and the ring would only reach the file at end():
  // a stream that hangs would lose it, while what is written stays durable.
  end() {
    if (this.dropped > 0) this.write(`\n${truncationNote(this.dropped)}\n`);
  }
}
