// Per-request logging for the MITM relay (parity with the reverse-proxy path's
// --log-to). One tap per CONNECT/connection (h2 stream ids restart per
// connection, so taps must not be shared).
//
// Logs STREAM to disk as the request/response flow: the file is opened and the
// request head written the moment headers arrive, and every body chunk is
// appended as it is relayed. JSON bodies are pretty-printed on the fly via a
// streaming state machine (src/json-format-stream.js) — never buffered whole,
// so even ~1M-token bodies cost only the current chunk, and a request that
// blocks mid-stream leaves its partial (readable) body on disk so you can see
// exactly how far it got. Auth/x-api-key are masked. No size caps.

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStreamFormatter } from './json-format-stream.js';

let seq = 0; // module-global so filenames are unique across connections

function maskValue(name, val) {
  const n = name.toLowerCase();
  if (n === 'authorization') return val.slice(0, 20) + '...';
  if (n === 'x-api-key') return val.slice(0, 15) + '...';
  return val;
}

function fmtFields(fields, { pseudo = true } = {}) {
  return fields
    .filter((f) => pseudo || !f.name.toString().startsWith(':'))
    .map((f) => { const n = f.name.toString(); return `  ${n}: ${maskValue(n, f.value.toString())}`; })
    .join('\n');
}

function get(fields, name) {
  const f = fields.find((x) => x.name.toString() === name);
  return f ? f.value.toString() : '';
}

function maskHeadText(text) {
  return text.split('\r\n').map((line) => {
    const lower = line.toLowerCase();
    if (lower.startsWith('authorization:')) return 'authorization: ' + line.slice(14).trim().slice(0, 20) + '...';
    if (lower.startsWith('x-api-key:')) return 'x-api-key: ...';
    return line;
  }).join('\r\n');
}

// content-type from an h2 field list / an h1 head text (lowercased, or '').
function ctOfFields(fields) {
  const f = fields.find((x) => x.name.toString().toLowerCase() === 'content-type');
  return f ? f.value.toString().toLowerCase() : '';
}
function ctOfHead(text) {
  const line = text.split('\r\n').find((l) => l.toLowerCase().startsWith('content-type:'));
  return line ? line.slice(line.indexOf(':') + 1).trim().toLowerCase() : '';
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

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

export function makeMitmTap(logDir, accountName = '') {
  if (!logDir) return null;
  mkdir(logDir, { recursive: true }).catch(() => {});
  const recs = new Map();

  function open() {
    const file = join(logDir, `${stamp()}_mitm_${String(++seq).padStart(5, '0')}.log`);
    const ws = createWriteStream(file, { flags: 'a' });
    ws.on('error', () => {});
    return ws;
  }

  function rec(id) {
    let r = recs.get(id);
    if (!r) {
      r = { ws: open(), reqBody: null, resBody: null, ended: false };
      // Write strings as latin1 so a body's original bytes (which the formatter
      // and raw path pass through 1:1 as latin1) round-trip exactly — writing as
      // utf8 would re-encode bytes >127 and corrupt non-ASCII content.
      r.write = (s) => { if (!r.ended && s) r.ws.write(Buffer.from(String(s), 'latin1')); };
      recs.set(id, r);
    }
    return r;
  }

  return {
    req(id, fields) {
      const r = rec(id);
      r.write(`=== REQUEST (h2${accountName ? `, account: ${accountName}` : ''}) ===\n${get(fields, ':method')} ${get(fields, ':path')}\n${fmtFields(fields, { pseudo: false })}`);
      r.reqBody = new BodyWriter(r.write, 'REQUEST BODY', ctOfFields(fields));
    },
    reqHead(id, text) {
      const r = rec(id);
      r.write(`=== REQUEST (h1${accountName ? `, account: ${accountName}` : ''}) ===\n${maskHeadText(text).trimEnd()}`);
      r.reqBody = new BodyWriter(r.write, 'REQUEST BODY', ctOfHead(text));
    },
    reqData(id, buf) { rec(id).reqBody?.chunk(buf); },
    res(id, fields) {
      const r = rec(id);
      r.write(`\n\n=== RESPONSE ${get(fields, ':status')} ===\n${fmtFields(fields, { pseudo: false })}`);
      r.resBody = new BodyWriter(r.write, 'RESPONSE BODY', ctOfFields(fields));
    },
    resData(id, buf) { rec(id).resBody?.chunk(buf); },
    end(id) {
      const r = recs.get(id);
      if (!r) return;
      recs.delete(id);
      if (!r.ended) { r.ended = true; r.ws.end('\n'); }
    },
  };
}
