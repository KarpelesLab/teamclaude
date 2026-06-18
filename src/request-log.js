// Per-request logging for the MITM relay (parity with the reverse-proxy path's
// --log-to). One tap per CONNECT/connection (h2 stream ids restart per
// connection, so taps must not be shared); it accumulates request/response
// headers + (capped) bodies per stream and writes one file when the stream ends.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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

// Log the WHOLE body — AI requests can carry the full conversation (up to ~1M
// tokens), so never truncate. JSON is pretty-printed; anything else is verbatim.
function bodySection(label, buf) {
  if (!buf.length) return `=== ${label} ===\n(empty)`;
  try { return `=== ${label} ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`; } catch { /* not json */ }
  return `=== ${label} (${buf.length} bytes) ===\n${buf.toString('utf-8')}`;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function makeMitmTap(logDir, accountName = '') {
  if (!logDir) return null;
  mkdir(logDir, { recursive: true }).catch(() => {});
  const recs = new Map();
  const rec = (id) => {
    let r = recs.get(id);
    if (!r) { r = { reqFields: null, reqHead: null, reqBody: [], resFields: null, resBody: [], written: false }; recs.set(id, r); }
    return r;
  };

  function write(r) {
    if (r.written) return;
    r.written = true;
    const s = [];
    if (r.reqFields) {
      s.push(`=== REQUEST (h2${accountName ? `, account: ${accountName}` : ''}) ===\n${get(r.reqFields, ':method')} ${get(r.reqFields, ':path')}\n${fmtFields(r.reqFields, { pseudo: false })}`);
    } else if (r.reqHead) {
      s.push(`=== REQUEST (h1${accountName ? `, account: ${accountName}` : ''}) ===\n${maskHeadText(r.reqHead).trimEnd()}`);
    }
    if (r.reqBody.length) s.push(bodySection('REQUEST BODY', Buffer.concat(r.reqBody)));
    if (r.resFields) s.push(`=== RESPONSE ${get(r.resFields, ':status')} ===\n${fmtFields(r.resFields, { pseudo: false })}`);
    if (r.resBody.length) s.push(bodySection('RESPONSE BODY', Buffer.concat(r.resBody)));
    if (!s.length) return;
    const file = join(logDir, `${stamp()}_mitm_${String(++seq).padStart(5, '0')}.log`);
    writeFile(file, s.join('\n\n'), 'utf-8').catch(() => {});
  }

  return {
    req(id, fields) { rec(id).reqFields = fields; },
    reqHead(id, text) { rec(id).reqHead = text; },
    reqData(id, buf) { rec(id).reqBody.push(buf); },
    res(id, fields) { rec(id).resFields = fields; },
    resData(id, buf) { rec(id).resBody.push(buf); },
    end(id) { const r = recs.get(id); if (r) { recs.delete(id); write(r); } },
  };
}
