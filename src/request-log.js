// Streaming body writer for the request logger (used by the reverse-proxy /
// MITM forward path in server.js). JSON bodies are pretty-printed on the fly via
// a streaming state machine (src/json-format-stream.js) — never buffered whole,
// so even ~1M-token bodies cost only the current chunk, and a request that
// blocks mid-stream leaves its partial (readable) body on disk so you can see
// exactly how far it got. No size caps.

import { JsonStreamFormatter } from './json-format-stream.js';

// Tracks how one direction's body is written: decide formatter-vs-raw on the
// first chunk (event-stream → raw; otherwise pretty-print if it looks like JSON,
// i.e. the first non-whitespace byte is { or [). Writes the section header once.
export class BodyWriter {
  constructor(write, label, contentType) {
    this.write = write;
    this.label = label;
    this.isStream = /event-stream/.test(contentType);
    this.decided = false;
    this.fmt = null;
    this.headerWritten = false;
  }
  chunk(buf) {
    if (!buf.length) return;
    if (!this.headerWritten) { this.write(`\n\n=== ${this.label} ===\n`); this.headerWritten = true; }
    if (!this.decided) {
      const first = buf.toString('latin1').trimStart()[0];
      if (!this.isStream && (first === '{' || first === '[')) this.fmt = new JsonStreamFormatter();
      this.decided = true;
    }
    this.write(this.fmt ? this.fmt.push(buf) : buf.toString('latin1'));
  }
}
