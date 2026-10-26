// Per-request provenance ring (T7) — evidence only, never routing authority.
//
// Snapshot purity: reads copy and never mutate ring/breaker state. Same doctrine
// as commits 503038d/d26c461 and the pure `_isAvailable` path in
// src/account-manager.js (status/serveable/TUI reads must not close circuits).

import { createWriteStream, renameSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

/** Exact allowlist — event constructor builds ONLY these keys. */
export const PROVENANCE_SAFE_FIELDS = Object.freeze([
  'seq',
  'ts',
  'request_id',
  'attempt',
  'final',
  'session_id',
  'method',
  'path',
  'requested_model',
  'advisor_model_requested',
  'advisor_degraded',
  'account',
  'account_index',
  'upstream_host',
  'mapped_model',
  'via_sx',
  'response_status',
  'response_reported_model',
  'outcome',
  'err_code',
  'usage',
  'timings',
  'stream',
  'log_file',
  // D3: thinking-stripped non-final events carry how many blocks were dropped.
  'count',
  // D8: request was forced onto one account via /tc-acct or MITM forcedPin.
  'pinned',
  // D9: selection-time skips ranked ahead of the chosen account (routed models).
  'skipped',
  'skipped_more',
]);

/** Defensive cap mirrored from account-manager SELECTION_SKIPPED_CAP. */
const SKIPPED_CAP = 8;

function sanitizeSkipped(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    if (item.a == null || item.r == null) continue;
    out.push({ a: String(item.a), r: String(item.r) });
    if (out.length >= SKIPPED_CAP) break;
  }
  return out.length ? out : null;
}

export const PROVENANCE_OUTCOMES = Object.freeze([
  'ok',
  'failover-upstream-5xx',
  'context-overflow-relay',
  'quota-429-rotate',
  'rate-429-inline-wait',
  'rate-429-surfaced',
  // R1: consecutive transient-429 cap exhausted → cooldown + rotate (non-final).
  'transient-429-cap',
  'transport-error',
  'client-disconnect',
  'stream-idle-timeout',
  'rejected-blocked',
  'rejected-collision',
  'rejected-pin-unservable',
  // Operator-disabled account named by /tc-acct or TC_ACCT — local 403, no egress.
  'rejected-pin-disabled',
  'exhausted-typed-429',
  'pinned-unavailable',
  'upstream-error-relayed',
  // Upstream #136: OAuth 401 forced-refresh retry (non-final; a new egress follows).
  'reauth-401-retry',
  // D3: ingress stripped foreign thinking/redacted_thinking before Anthropic egress.
  'thinking-stripped',
  // D7: POST /teamclaude/reload control event (routing-authority change).
  'config-reload',
  // D7: inference path refused a null/unparseable model under a configured route table.
  'rejected-null-model',
  // D10: deepseek thinking-mode 400 (content[].thinking absent) — countability only.
  'upstream-thinking-required',
  // D10: adapter 404 on /v1/messages/count_tokens — countability only.
  'count-tokens-unsupported',
]);

/**
 * D10: stable substring from deepseek adapter 400 when thinking mode is on but
 * content[].thinking blocks were not passed back. Exact match only — any doubt
 * falls through to upstream-error-relayed.
 */
export const UPSTREAM_THINKING_REQUIRED_MARKER =
  'The `content[].thinking` in the thinking mode must be passed back to the API';

/**
 * D10: classify a relayed upstream non-OK response into a specific outcome label.
 * Outcome labels only — does not change retry/relay/policy. Conservative:
 * unknown → `upstream-error-relayed`; 2xx → `ok`.
 *
 * @param {{ status: number, path?: string|null, pathClass?: string|null, body?: string|Buffer|null }} args
 * @returns {string}
 */
export function classifyUpstreamRelayOutcome({ status, path = null, pathClass = null, body = null } = {}) {
  if (Number.isFinite(status) && status >= 200 && status < 300) return 'ok';
  // 404 on count_tokens path (pathClass preferred; path sanitized as fallback).
  if (status === 404) {
    const isCountTokens = pathClass === 'count_tokens'
      || sanitizeProvenancePath(path) === '/v1/messages/count_tokens';
    if (isCountTokens) return 'count-tokens-unsupported';
  }
  // 400 whose body carries the exact deepseek thinking-required marker.
  if (status === 400 && body != null) {
    let text = null;
    if (typeof body === 'string') text = body;
    else if (Buffer.isBuffer(body)) {
      try { text = body.toString('utf8'); } catch { text = null; }
    }
    if (text != null && text.includes(UPSTREAM_THINKING_REQUIRED_MARKER)) {
      return 'upstream-thinking-required';
    }
  }
  return 'upstream-error-relayed';
}

const SAFE_SET = new Set(PROVENANCE_SAFE_FIELDS);
const PATH_CAP = 128;

/**
 * Path hygiene in the constructor (not an ingress assumption): MITM attaches the
 * shared listener with no absolute-form guard (mitm.js → createProxyRequestListener),
 * so req.url may be an absolute-form URL or carry a query string.
 */
export function sanitizeProvenancePath(raw) {
  if (raw == null) return null;
  let s = String(raw);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname || '/';
    } catch {
      s = s.replace(/^https?:\/\/[^/]*/i, '') || '/';
    }
  }
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  if (s.length > PATH_CAP) s = s.slice(0, PATH_CAP);
  return s;
}

function sanitizeUsage(u) {
  if (!u || typeof u !== 'object') return { input: null, output: null };
  return {
    input: Number.isFinite(u.input) ? u.input : (Number.isFinite(u.input_tokens) ? u.input_tokens : null),
    output: Number.isFinite(u.output) ? u.output : (Number.isFinite(u.output_tokens) ? u.output_tokens : null),
  };
}

function sanitizeTimings(t) {
  if (!t || typeof t !== 'object') return { admit_ms: null, headers_ms: null, total_ms: null };
  const n = (v) => (Number.isFinite(v) ? v : null);
  return { admit_ms: n(t.admit_ms), headers_ms: n(t.headers_ms), total_ms: n(t.total_ms) };
}

/**
 * Allowlist-by-construction: only named scalars; no object spread from req/res.
 * Extra keys on `fields` are dropped.
 */
export function buildProvenanceEvent(fields, { seq, ts }) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const evt = {
    seq,
    ts,
    request_id: src.request_id == null ? null : String(src.request_id),
    attempt: Number.isFinite(src.attempt) ? src.attempt : 0,
    final: !!src.final,
    session_id: src.session_id == null ? null : String(src.session_id),
    method: src.method == null ? null : String(src.method),
    path: sanitizeProvenancePath(src.path),
    requested_model: src.requested_model == null ? null : String(src.requested_model),
    advisor_model_requested: src.advisor_model_requested == null ? null : String(src.advisor_model_requested),
    advisor_degraded: !!src.advisor_degraded,
    account: src.account == null ? null : String(src.account),
    account_index: Number.isFinite(src.account_index) ? src.account_index : null,
    upstream_host: src.upstream_host == null ? null : String(src.upstream_host),
    mapped_model: src.mapped_model == null ? null : String(src.mapped_model),
    via_sx: !!src.via_sx,
    response_status: Number.isFinite(src.response_status) ? src.response_status : null,
    response_reported_model: src.response_reported_model == null ? null : String(src.response_reported_model),
    outcome: src.outcome == null ? null : String(src.outcome),
    // Node err.code only — never err.message (may embed URLs/body fragments).
    err_code: src.err_code == null ? null : String(src.err_code),
    usage: sanitizeUsage(src.usage),
    timings: sanitizeTimings(src.timings),
    stream: !!src.stream,
    log_file: src.log_file == null ? null : basename(String(src.log_file)),
    count: Number.isFinite(src.count) ? src.count : null,
    pinned: !!src.pinned,
    skipped: sanitizeSkipped(src.skipped),
    skipped_more: (Number.isFinite(src.skipped_more) && src.skipped_more > 0)
      ? Math.floor(src.skipped_more)
      : null,
  };
  // Tripwire: drop anything that slipped past the named assign above.
  for (const k of Object.keys(evt)) {
    if (!SAFE_SET.has(k)) delete evt[k];
  }
  return evt;
}

/**
 * Fixed ring of provenance events + optional append-only JSONL sink.
 * `nextRequestId(tag)` disambiguates base ('b') vs MITM ('m') numeric counters.
 */
export class ProvenanceBuffer {
  constructor({
    size = 512,
    filePath = null,
    maxFileBytes = 32 << 20,
    now = () => Date.now(),
  } = {}) {
    this.size = Math.max(1, size | 0);
    this._now = now;
    this.bootEpoch = now().toString(36);
    this._buf = new Array(this.size);
    this._count = 0;
    this._nextSeq = 1;
    this._tagCounters = { b: 0, m: 0 };

    this._filePath = filePath || null;
    this._maxFileBytes = Math.max(1024, maxFileBytes | 0);
    this._bytesWritten = 0;
    this._stream = null;
    this._rotating = false;
    this._pending = [];
    this._sinkDisabled = false;
    if (this._filePath) this._openSink();
  }

  /** Composite id: `<bootEpoch>-<tag>-<n>` with tag ∈ {b, m}. */
  nextRequestId(tag) {
    if (tag !== 'b' && tag !== 'm') {
      throw new TypeError(`provenance listener tag must be 'b' or 'm', got ${tag}`);
    }
    const n = ++this._tagCounters[tag];
    return `${this.bootEpoch}-${tag}-${n}`;
  }

  push(fields) {
    const seq = this._nextSeq++;
    const ts = new Date(this._now()).toISOString();
    const evt = buildProvenanceEvent(fields, { seq, ts });
    this._buf[(this._count++) % this.size] = evt;
    this._appendJsonl(evt);
    return evt;
  }

  /**
   * Pure read: copied ascending slice of events with seq > since.
   * No server-side cursor; never mutates the ring.
   * Default limit is the ring size so a naked poll cannot omit the newest
   * half (R0: limit=256 on size=512 looked like a frozen newest ts).
   */
  snapshot(since = 0, limit = undefined) {
    const lim = Math.max(0, Math.min(
      Number(limit == null ? this.size : limit) || 0,
      this.size,
    ));
    const sinceN = Number.isFinite(Number(since)) ? Number(since) : 0;
    if (this._count === 0) {
      return { head_seq: 0, tail_seq: 0, events: [] };
    }
    const tail_seq = this._nextSeq - 1;
    const head_seq = Math.max(1, this._count - this.size + 1);
    // head_seq < consumer cursor is a ring-overwrite hint only — NOT restart
    // detection (consumers reset on boot_epoch change).
    const events = [];
    const start = Math.max(head_seq, sinceN + 1);
    for (let s = start; s <= tail_seq && events.length < lim; s++) {
      const slot = this._buf[(s - 1) % this.size];
      events.push(copyEvent(slot));
    }
    return { head_seq, tail_seq, events };
  }

  _openSink() {
    try {
      this._stream = createWriteStream(this._filePath, { flags: 'a' });
      this._stream.on('error', (err) => {
        console.error(`[TeamClaude] provenance JSONL sink error: ${err.code || err.message}`);
        this._sinkDisabled = true;
        try { this._stream?.destroy(); } catch { /* gone */ }
        this._stream = null;
      });
      this._bytesWritten = 0;
    } catch (err) {
      console.error(`[TeamClaude] provenance JSONL open failed: ${err.code || err.message}`);
      this._sinkDisabled = true;
      this._stream = null;
    }
  }

  _appendJsonl(evt) {
    if (!this._filePath || this._sinkDisabled) return;
    if (this._rotating) {
      this._pending.push(evt);
      return;
    }
    const line = `${JSON.stringify(evt)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this._stream && this._bytesWritten + bytes > this._maxFileBytes) {
      this._rotateAndFlush(line, bytes);
      return;
    }
    this._writeLine(line, bytes);
  }

  _writeLine(line, bytes) {
    if (!this._stream || this._sinkDisabled) return;
    try {
      this._stream.write(line);
      this._bytesWritten += bytes;
    } catch (err) {
      console.error(`[TeamClaude] provenance JSONL write failed: ${err.code || err.message}`);
      this._sinkDisabled = true;
    }
  }

  /**
   * One-generation rotation: rename to `<file>.1`, reopen. Events during the
   * rename+reopen window are queued (never dropped from the durable sink).
   * File consumers MUST partition by request_id bootEpoch prefix — seq resets
   * per boot within one append-mode file.
   */
  _rotateAndFlush(line, bytes) {
    this._rotating = true;
    try {
      try { this._stream?.end(); } catch { /* ignore */ }
      this._stream = null;
      const rotated = `${this._filePath}.1`;
      try {
        if (existsSync(rotated)) {
          // replace previous .1
        }
        renameSync(this._filePath, rotated);
      } catch (err) {
        // First write or missing file — reopen fresh.
        if (err.code !== 'ENOENT') {
          console.error(`[TeamClaude] provenance JSONL rotate failed: ${err.code || err.message}`);
        }
      }
      this._openSink();
      this._writeLine(line, bytes);
      const queued = this._pending.splice(0);
      for (const e of queued) {
        const qline = `${JSON.stringify(e)}\n`;
        this._writeLine(qline, Buffer.byteLength(qline));
      }
    } finally {
      this._rotating = false;
    }
  }
}

function copyEvent(evt) {
  return {
    ...evt,
    usage: evt.usage ? { ...evt.usage } : { input: null, output: null },
    timings: evt.timings ? { ...evt.timings } : { admit_ms: null, headers_ms: null, total_ms: null },
    // D9: deep-copy skipped rows so snapshot mutation cannot corrupt the ring.
    skipped: Array.isArray(evt.skipped)
      ? evt.skipped.map(row => ({ a: row.a, r: row.r }))
      : (evt.skipped ?? null),
  };
}
