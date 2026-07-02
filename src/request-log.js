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

// `accountName` may be a fixed string or, since one tunnel can now serve several
// accounts (per-request rotation), a resolver (id) => name that names the account
// THAT request actually used.
function resolveName(accountName, id) {
  return (typeof accountName === 'function' ? accountName(id) : accountName) || '';
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
      const acct = resolveName(accountName, id);
      r.write(`=== REQUEST (h2${acct ? `, account: ${acct}` : ''}) ===\n${get(fields, ':method')} ${get(fields, ':path')}\n${fmtFields(fields, { pseudo: false })}`);
      r.reqBody = new BodyWriter(r.write, 'REQUEST BODY', ctOfFields(fields));
    },
    reqHead(id, text) {
      const r = rec(id);
      const acct = resolveName(accountName, id);
      r.write(`=== REQUEST (h1${acct ? `, account: ${acct}` : ''}) ===\n${maskHeadText(text).trimEnd()}`);
      r.reqBody = new BodyWriter(r.write, 'REQUEST BODY', ctOfHead(text));
    },
    reqData(id, buf) { rec(id).reqBody?.chunk(buf); },
    res(id, fields) {
      const r = rec(id);
      r.write(`\n\n=== RESPONSE ${get(fields, ':status')} ===\n${fmtFields(fields, { pseudo: false })}`);
      r.resBody = new BodyWriter(r.write, 'RESPONSE BODY', ctOfFields(fields));
    },
    resHead(id, text) {
      const r = rec(id);
      const status = (text.split('\r\n')[0].split(' ')[1]) || '';
      r.write(`\n\n=== RESPONSE ${status} (h1) ===\n${maskHeadText(text).trimEnd()}`);
      r.resBody = new BodyWriter(r.write, 'RESPONSE BODY', ctOfHead(text));
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

let activitySeq = 0; // module-global so TUI ids are unique across MITM connections

// A tap (same interface as makeMitmTap) that, instead of writing to disk,
// translates each relayed request's lifecycle into the server's TUI hooks —
// so MITM traffic shows up in the live activity feed like reverse-proxy traffic.
// Relay-local ids (h2 stream ids / h1 request ids restart per connection) are
// mapped to globally-unique string ids ("m<n>") so they never collide with the
// reverse-proxy's numeric ids or with each other across connections.
export function makeActivityTap(hooks, accountName = '') {
  if (!hooks || (!hooks.onRequestStart && !hooks.onRequestEnd)) return null;
  const ids = new Map(); // relay-local id -> { gid, method, path, status }

  function start(localId, method, path) {
    const gid = `m${++activitySeq}`;
    const acct = resolveName(accountName, localId);
    ids.set(localId, { gid, method, path, status: null, account: acct });
    hooks.onRequestStart?.(gid, { method, path });
    if (acct) hooks.onRequestRouted?.(gid, { account: acct });
  }

  return {
    req(id, fields) { start(id, get(fields, ':method'), get(fields, ':path')); },
    reqHead(id, text) {
      const parts = text.split('\r\n')[0].split(' ');
      start(id, (parts[0] || '').toUpperCase(), parts[1] || '');
    },
    reqData() {},
    res(id, fields) { const r = ids.get(id); if (r) r.status = get(fields, ':status'); },
    resHead(id, text) { const r = ids.get(id); if (r) r.status = text.split('\r\n')[0].split(' ')[1] || ''; },
    resData() {},
    end(id) {
      const r = ids.get(id);
      if (!r) return;
      ids.delete(id);
      hooks.onRequestEnd?.(r.gid, { method: r.method, path: r.path, account: r.account, status: r.status });
    },
  };
}

// Fan one relay's tap callbacks out to several taps (disk + TUI activity).
// Returns null if none are live, the single tap if only one is, else a proxy.
export function combineTaps(...taps) {
  const live = taps.filter(Boolean);
  if (live.length <= 1) return live[0] || null;
  const fan = (m) => (...a) => { for (const t of live) t[m]?.(...a); };
  return {
    req: fan('req'), reqHead: fan('reqHead'), reqData: fan('reqData'),
    res: fan('res'), resHead: fan('resHead'), resData: fan('resData'), end: fan('end'),
  };
}
