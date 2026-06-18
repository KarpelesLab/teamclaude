// Per-request logging for the MITM relay (parity with the reverse-proxy path's
// --log-to). One tap per CONNECT/connection (h2 stream ids restart per
// connection, so taps must not be shared); it accumulates request/response
// headers + (capped) bodies per stream and writes one file when the stream ends.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const REQ_CAP = 64 * 1024;
const RES_CAP = 16 * 1024;
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

function bodySection(label, buf, total, cap) {
  if (!buf.length) return `=== ${label} ===\n(empty)`;
  if (total <= cap) {
    try { return `=== ${label} ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`; } catch { /* not json */ }
  }
  const note = total > cap ? ` (${total} bytes, truncated)` : ` (${total} bytes)`;
  return `=== ${label}${note} ===\n${buf.toString('utf-8').slice(0, cap)}`;
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
    if (!r) { r = { reqFields: null, reqHead: null, reqBody: [], reqLen: 0, resFields: null, resBody: [], resLen: 0, written: false }; recs.set(id, r); }
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
    if (r.reqLen) s.push(bodySection('REQUEST BODY', Buffer.concat(r.reqBody), r.reqLen, REQ_CAP));
    if (r.resFields) s.push(`=== RESPONSE ${get(r.resFields, ':status')} ===\n${fmtFields(r.resFields, { pseudo: false })}`);
    if (r.resLen) s.push(bodySection('RESPONSE BODY', Buffer.concat(r.resBody), r.resLen, RES_CAP));
    if (!s.length) return;
    const file = join(logDir, `${stamp()}_mitm_${String(++seq).padStart(5, '0')}.log`);
    writeFile(file, s.join('\n\n'), 'utf-8').catch(() => {});
  }

  return {
    req(id, fields) { rec(id).reqFields = fields; },
    reqHead(id, text) { rec(id).reqHead = text; },
    reqData(id, buf) { const r = rec(id); if (r.reqLen < REQ_CAP) { r.reqBody.push(buf); r.reqLen += buf.length; } },
    res(id, fields) { rec(id).resFields = fields; },
    resData(id, buf) { const r = rec(id); if (r.resLen < RES_CAP) { r.resBody.push(buf); r.resLen += buf.length; } },
    end(id) { const r = recs.get(id); if (r) { recs.delete(id); write(r); } },
  };
}
