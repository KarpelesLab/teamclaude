// Custom (non-Anthropic) upstreams sometimes answer with a tool call written
// as TEXT instead of a real tool_use block — Gemini Argon
// `call:default_api:Bash{...}`, OpenRouter-free Dots `<dots_function_call>`,
// MiniMax/Qwen `<invoke>` / `<command-name>` XML. stop_reason is end_turn, so
// Claude Code runs nothing and the agent sits idle.
//
// Official OpenRouter Claude Code path is Anthropic Skin at
// https://openrouter.ai/api and is only guaranteed with Anthropic 1P. The
// fleet's `openrouter/free` hop is OpenAI-compat via CLIProxyAPI, so this
// module is the durable bridge: turn an unambiguous plaintext call into a
// real tool_use. Anything doubtful is left byte-identical.
//
// Scope (all must hold, otherwise no rewrite):
//   - custom (non-Anthropic) upstream, /v1/messages, HTTP 200
//   - the reply has no tool_use / server_tool_use block and stop_reason is end_turn
//   - the LAST content block is text; that text is exactly one call, OR (XML
//     only) a call glued to the end of optional prose
//   - the tool is in the request's `tools` list and the args fit its schema
import { randomBytes } from 'node:crypto';

const ARGON_MODEL_RE = /^gemini-4-argon(?:$|[-\[])/;
const MARK = 'call:default_api:';
const HEAD_RE = /^call:default_api:([A-Za-z0-9_.\-]+)\{/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const CALL_PREFIXES = [
  MARK,
  '<dots_function_call',
  '<command-name>',
  '<invoke',
  '<tool_call>',
  '<function_calls>',
  '<minimax:tool_call',
];

export function isGeminiArgonModel(model) {
  return typeof model === 'string' && ARGON_MODEL_RE.test(model);
}

function newToolUseId() {
  const bytes = randomBytes(24);
  let s = 'toolu_';
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

/** Map of tool name -> input_schema from a request body (Buffer|string|object). */
export function toolsFromRequestBody(body) {
  let obj = body;
  try {
    if (Buffer.isBuffer(body)) obj = JSON.parse(body.toString('utf8'));
    else if (typeof body === 'string') obj = JSON.parse(body);
  } catch { return null; }
  if (!obj || !Array.isArray(obj.tools)) return null;
  const map = new Map();
  for (const t of obj.tools) {
    if (t && typeof t.name === 'string' && t.input_schema && typeof t.input_schema === 'object') {
      map.set(t.name, t.input_schema);
    }
  }
  return map.size ? map : null;
}

function lookupTool(tools, name) {
  if (!tools || typeof name !== 'string') return null;
  if (tools.has(name)) return { name, schema: tools.get(name) };
  const lower = name.toLowerCase();
  for (const [n, schema] of tools) {
    if (n.toLowerCase() === lower) return { name: n, schema };
  }
  return null;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function typesOf(prop) {
  const t = prop?.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter(x => typeof x === 'string');
  const alts = Array.isArray(prop?.anyOf) ? prop.anyOf : Array.isArray(prop?.oneOf) ? prop.oneOf : null;
  if (!alts || !alts.length) return [];
  const out = [];
  for (const a of alts) {
    if (typeof a?.type !== 'string' || a.$ref) return [];
    out.push(a.type);
  }
  return out;
}

function plainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function valueFits(v, prop) {
  const types = typesOf(prop);
  if (!types.length) return false;
  const ok = types.some(t => (
    (t === 'string' && typeof v === 'string')
    || (t === 'boolean' && typeof v === 'boolean')
    || (t === 'number' && typeof v === 'number' && Number.isFinite(v))
    || (t === 'integer' && Number.isInteger(v))
    || (t === 'object' && plainObject(v))
    || (t === 'array' && Array.isArray(v))
    || (t === 'null' && v === null)
  ));
  if (!ok) return false;
  if (Array.isArray(prop.enum) && !prop.enum.some(e => e === v)) return false;
  return true;
}

function fitsSchema(obj, schema) {
  if (!plainObject(obj)) return false;
  const props = plainObject(schema?.properties) ? schema.properties : {};
  for (const r of Array.isArray(schema?.required) ? schema.required : []) {
    if (!Object.hasOwn(obj, r)) return false;
  }
  for (const k of Object.keys(obj)) {
    if (UNSAFE_KEYS.has(k)) return false;
    if (!Object.hasOwn(props, k) || !valueFits(obj[k], props[k])) return false;
  }
  return true;
}

function jsonString(s) {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return undefined;
  try {
    const v = JSON.parse(s);
    return typeof v === 'string' ? v : undefined;
  } catch { return undefined; }
}

function convertLoose(raw, prop) {
  const types = typesOf(prop);
  if (!types.length) return undefined;
  const trimmed = raw.trim();
  if (types.includes('string')) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      return jsonString(trimmed);
    }
    if (types.length === 1) return trimmed;
  }
  if (types.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) return trimmed === 'true';
  if ((types.includes('number') || types.includes('integer')) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (types.includes('number') || Number.isInteger(n)) return n;
  }
  if (types.includes('object') || types.includes('array')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  if (types.includes('null') && trimmed === 'null') return null;
  if (types.includes('string')) return trimmed;
  return undefined;
}

function quotesBalanced(v) {
  const dq = (v.match(/(?<!\\)"/g) || []).length;
  const sq = (v.match(/(?<![A-Za-z0-9])'|'(?![A-Za-z0-9])/g) || []).length;
  return dq % 2 === 0 && sq % 2 === 0;
}

function bracesBalanced(v) {
  let depth = 0;
  for (const ch of v) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Parse `key:value,key:value` using only the schema's property names. */
export function parseLooseArgs(inner, schema) {
  const props = plainObject(schema?.properties) ? schema.properties : null;
  if (!props) return null;
  const names = Object.keys(props).filter(n => KEY_RE.test(n) && !UNSAFE_KEYS.has(n));
  if (!names.length) return null;
  if (inner.trim() === '') return fitsSchema({}, schema) ? {} : null;

  const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(inner);
  if (!first || !names.includes(first[1])) return null;

  const marks = [{ key: first[1], keyStart: 0, valueStart: first[0].length }];
  for (const name of names) {
    const re = new RegExp(`,(\\s*)${escapeRe(name)}:`, 'g');
    let m;
    while ((m = re.exec(inner)) !== null) {
      marks.push({ key: name, keyStart: m.index, valueStart: m.index + m[0].length, spaced: m[1].length > 0 });
    }
  }
  marks.sort((a, b) => a.keyStart - b.keyStart);
  const used = [marks[0]];
  for (const mk of marks.slice(1)) {
    if (mk.spaced) {
      const prev = used[used.length - 1];
      if (jsonString(inner.slice(prev.valueStart, mk.keyStart).trim()) === undefined) continue;
    }
    used.push(mk);
  }
  const seen = new Set();
  for (const mk of used) {
    if (seen.has(mk.key)) return null;
    seen.add(mk.key);
  }
  for (let i = 1; i < used.length; i++) {
    if (used[i].keyStart < used[i - 1].valueStart) return null;
  }

  const out = {};
  for (let i = 0; i < used.length; i++) {
    const end = i + 1 < used.length ? used[i + 1].keyStart : inner.length;
    const raw = inner.slice(used[i].valueStart, end);
    if (i + 1 < used.length && !quotesBalanced(raw)) return null;
    if (i + 1 === used.length && !bracesBalanced(raw)) return null;
    const v = convertLoose(raw, props[used[i].key]);
    if (v === undefined) return null;
    out[used[i].key] = v;
  }
  return fitsSchema(out, schema) ? out : null;
}

function parseArgonCall(t, tools) {
  if (!t.startsWith(MARK)) return null;
  if (t.indexOf(MARK, MARK.length) !== -1) return null;
  if (!t.endsWith('}')) return null;
  const head = HEAD_RE.exec(t);
  if (!head) return null;
  const found = lookupTool(tools, head[1]);
  if (!found) return null;
  const inner = t.slice(head[0].length, -1);
  if (/^\s*"/.test(inner)) {
    try {
      const obj = JSON.parse(`{${inner}}`);
      return fitsSchema(obj, found.schema) ? { name: found.name, input: obj } : null;
    } catch { return null; }
  }
  const input = parseLooseArgs(inner, found.schema);
  return input ? { name: found.name, input } : null;
}

function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return plainObject(obj) ? obj : null;
  } catch { return null; }
}

function tagInner(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = text.indexOf(close, from);
  if (end === -1) return null;
  return text.slice(from, end).trim();
}

function callIfFits(tools, name, input) {
  const found = lookupTool(tools, name);
  if (!found || !plainObject(input)) return null;
  return fitsSchema(input, found.schema) ? { name: found.name, input } : null;
}

function bashFallback(tools, args) {
  if (!plainObject(args) || typeof args.command !== 'string' || !args.command.trim()) return null;
  const input = { command: args.command };
  if (typeof args.description === 'string' && args.description.trim()) input.description = args.description;
  return callIfFits(tools, 'Bash', input);
}

function parseDotsCall(t, tools) {
  if (!t.includes('<dots_function_call')) return null;
  const inner = tagInner(t, '<dots_function_call>', '</dots_function_call>')
    ?? tagInner(t, '<dots_function_call>', '</dots_function_call>')
    ?? t;
  const name = tagInner(inner, '<name>', '</name>')
    || tagInner(inner, '<tool_name>', '</tool_name>')
    || (() => {
      const m = /invoke\s+tool\s+([A-Za-z0-9_.\-]+)/i.exec(inner);
      return m ? m[1] : null;
    })();
  if (!name) return null;
  const argsRaw = tagInner(inner, '<arguments>', '</arguments>')
    || tagInner(inner, '<parameters>', '</parameters>')
    || tagInner(inner, '<parameter>', '</parameter>');
  const input = parseJsonObject(argsRaw ?? '');
  if (!input) return null;
  return callIfFits(tools, name, input) || bashFallback(tools, input);
}

function parseInvokeCall(t, tools) {
  const head = /<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>/i.exec(t)
    || /<tool_call\b[^>]*\bname=["']([^"']+)["'][^>]*>/i.exec(t)
    || /<minimax:tool_call\b[^>]*\bname=["']([^"']+)["'][^>]*>/i.exec(t);
  if (!head) return null;
  const name = head[1];
  const input = {};
  const re = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(t)) !== null) {
    if (UNSAFE_KEYS.has(m[1])) return null;
    input[m[1]] = m[2].trim();
    n++;
  }
  if (!n) {
    const argsRaw = tagInner(t, '<arguments>', '</arguments>');
    const obj = parseJsonObject(argsRaw ?? '');
    if (!obj) return null;
    return callIfFits(tools, name, obj) || bashFallback(tools, obj);
  }
  return callIfFits(tools, name, input) || bashFallback(tools, input);
}

function parseCommandNameCall(t, tools) {
  const nameM = /<command-name>\s*([^<]+?)\s*<\/command-name>/i.exec(t);
  if (!nameM) return null;
  const rawName = nameM[1].trim();
  if (!rawName || rawName.startsWith('/')) return null; // slash commands, not tools
  const args = {};
  const re = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const k = m[1].trim();
    if (UNSAFE_KEYS.has(k)) return null;
    args[k] = m[2].trim();
  }
  const msg = tagInner(t, '<command-message>', '</command-message>');
  if (msg && args.description == null) args.description = msg;
  return callIfFits(tools, rawName, args) || bashFallback(tools, args);
}

function parseExactCall(t, tools) {
  if (t.startsWith(MARK)) return parseArgonCall(t, tools);
  if (t.startsWith('<dots_function_call')) return parseDotsCall(t, tools);
  if (t.startsWith('<invoke') || t.startsWith('<tool_call') || t.startsWith('<function_calls')
      || t.startsWith('<minimax:tool_call')) {
    return parseInvokeCall(t, tools);
  }
  if (t.startsWith('<command-name>')) return parseCommandNameCall(t, tools);
  return null;
}

function trailingXmlStart(t) {
  let idx = -1;
  for (const p of CALL_PREFIXES) {
    if (p === MARK) continue; // argon stays exact-match (prose+call is too easy to false-positive)
    const i = t.lastIndexOf(p);
    if (i > idx) idx = i;
  }
  return idx;
}

/**
 * Parse a text block that is exactly one text-form call, or (XML only) a call
 * glued to the end of optional prose.
 * Returns { name, input, prefix } or null. prefix is '' for a whole-block call.
 */
export function parseTextCall(text, tools) {
  if (typeof text !== 'string' || !tools) return null;
  const t = text.trim();
  if (!t) return null;
  const exact = parseExactCall(t, tools);
  if (exact) return { ...exact, prefix: '' };
  const idx = trailingXmlStart(t);
  if (idx <= 0) return null;
  const rest = t.slice(idx).trim();
  const call = parseExactCall(rest, tools);
  if (!call) return null;
  return { ...call, prefix: t.slice(0, idx).trimEnd() };
}

function hasToolUse(blocks) {
  return blocks.some(b => b && (b.type === 'tool_use' || b.type === 'server_tool_use'));
}

function applyCallToContent(content, call) {
  const id = newToolUseId();
  const tool = { type: 'tool_use', id, name: call.name, input: call.input };
  if (call.prefix) {
    content[content.length - 1] = { type: 'text', text: call.prefix };
    content.push(tool);
  } else {
    content[content.length - 1] = tool;
  }
}

/**
 * Non-streaming repair. Returns a new Buffer when the reply was rewritten,
 * otherwise the SAME buffer object (byte-identical).
 */
export function repairArgonTextCallBody(buf, tools) {
  if (!tools) return buf;
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return buf; }
  if (!msg || msg.type !== 'message' || msg.stop_reason !== 'end_turn') return buf;
  const content = msg.content;
  if (!Array.isArray(content) || !content.length || hasToolUse(content)) return buf;
  const last = content[content.length - 1];
  if (last?.type !== 'text' || typeof last.text !== 'string') return buf;
  const call = parseTextCall(last.text, tools);
  if (!call) return buf;
  applyCallToContent(content, call);
  msg.stop_reason = 'tool_use';
  msg.stop_sequence = null;
  return Buffer.from(JSON.stringify(msg), 'utf8');
}

export const repairPlaintextToolCallBody = repairArgonTextCallBody;

// ---------------------------------------------------------------- streaming

const NO_DATA = Symbol('no-data');

function eventData(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.startsWith('data:'));
  if (!lines.length) return NO_DATA;
  try {
    const v = JSON.parse(lines.map(l => l.slice(l.startsWith('data: ') ? 6 : 5)).join('\n'));
    return plainObject(v) ? v : undefined;
  } catch { return undefined; }
}

function eventEnd(buf) {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return lf + 2;
  return crlf + 4;
}

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function couldBecomeCall(t) {
  if (!t) return true;
  for (const p of CALL_PREFIXES) {
    if (p.startsWith(t) || t.startsWith(p)) return true;
  }
  return false;
}

/**
 * Streaming repair. Feed upstream chunks with push(); write whatever it
 * returns. Call end() once the upstream finished and write what it returns.
 *
 * Bytes pass straight through except while a text block that begins with a
 * known call marker (or could still begin with one) is being received; those
 * events are held. OpenRouter-free replies often glue XML after a sentence,
 * so `holdAllText` keeps the whole text block until it ends.
 */
export class ArgonTextCallStream {
  constructor(tools, { holdAllText = false } = {}) {
    this.tools = tools;
    this.holdAllText = !!holdAllText;
    this.pending = Buffer.alloc(0);
    this.mode = tools ? 'scan' : 'pass';
    this.held = [];
    this.probeIndex = -1;
    this.probeText = '';
    this.rewrote = false;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.mode === 'pass') return buf.length ? [buf] : [];
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    const out = [];
    while (this.mode !== 'pass') {
      const end = eventEnd(this.pending);
      if (end === -1) break;
      const raw = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end);
      this._event(raw, out);
    }
    if (this.mode === 'pass' && this.pending.length) {
      out.push(this.pending);
      this.pending = Buffer.alloc(0);
    }
    return out;
  }

  _flushHeld(out) {
    for (const h of this.held) out.push(h.raw);
    this.held = [];
  }

  _event(raw, out) {
    const data = eventData(raw.toString('utf8'));
    if (this.mode === 'scan') {
      if (data?.type === 'content_block_start'
        && (data.content_block?.type === 'tool_use' || data.content_block?.type === 'server_tool_use')) {
        this.mode = 'pass';
        out.push(raw);
        return;
      }
      if (data?.type === 'content_block_start' && data.content_block?.type === 'text') {
        this.mode = 'probe';
        this.probeIndex = data.index;
        this.probeText = data.content_block.text || '';
        this.held.push({ raw, data });
        this._checkProbe(out);
        return;
      }
      out.push(raw);
      return;
    }
    if (this.mode === 'hold') {
      this.held.push({ raw, data });
      if (data === undefined || data.type === 'content_block_start' || data.type === 'error'
        || (data.type === 'message_delta' && data.delta?.stop_reason !== 'end_turn')) {
        this._flushHeld(out);
        this.mode = 'pass';
      }
      return;
    }
    if (data?.type === 'content_block_delta' && data.index === this.probeIndex
      && data.delta?.type === 'text_delta') {
      this.held.push({ raw, data });
      this.probeText += data.delta.text || '';
      this._checkProbe(out);
    } else if (data === NO_DATA || data?.type === 'ping') {
      this.held.push({ raw, data });
    } else if (data?.type === 'content_block_stop' && data.index === this.probeIndex) {
      this.held.push({ raw, data });
      if (this.holdAllText) {
        this.mode = 'hold';
        return;
      }
      this._flushHeld(out);
      this.mode = 'scan';
    } else {
      this._flushHeld(out);
      this.mode = 'scan';
      this._event(raw, out);
    }
  }

  _checkProbe(out) {
    if (this.holdAllText) {
      this.mode = 'hold';
      return;
    }
    const t = this.probeText.trimStart();
    if (couldBecomeCall(t)) {
      if (CALL_PREFIXES.some(p => t.startsWith(p))) this.mode = 'hold';
      return;
    }
    this._flushHeld(out);
    this.mode = 'scan';
  }

  end() {
    const out = [];
    if (this.mode === 'hold' && this.pending.toString('utf8').trim()) {
      const raw = this.pending;
      this.pending = Buffer.alloc(0);
      this._event(raw, out);
    }
    if (this.mode === 'hold') {
      const rewritten = this._rewrite();
      if (rewritten) {
        out.push(Buffer.from(rewritten, 'utf8'));
        this.held = [];
        this.rewrote = true;
      }
    }
    this._flushHeld(out);
    if (this.pending.length) out.push(this.pending);
    this.pending = Buffer.alloc(0);
    this.mode = 'pass';
    return out;
  }

  _rewrite() {
    const idx = this.probeIndex;
    let text = '';
    let stopped = false;
    let stopReasonOk = false;
    let sawMessageStop = false;
    const before = [];
    const after = [];
    for (const { raw, data } of this.held) {
      if (data === undefined) return null;
      if (data === NO_DATA) {
        (stopped ? after : before).push({ raw, data });
        continue;
      }
      switch (data.type) {
        case 'content_block_start':
          if (data.index === idx && !stopped && text === '') {
            text = data.content_block?.text || '';
            break;
          }
          return null;
        case 'content_block_delta':
          if (data.index !== idx || stopped || data.delta?.type !== 'text_delta') return null;
          text += data.delta.text || '';
          break;
        case 'content_block_stop':
          if (data.index !== idx || stopped) return null;
          stopped = true;
          break;
        case 'ping':
          (stopped ? after : before).push({ raw, data });
          break;
        case 'message_delta':
          if (!stopped || data.delta?.stop_reason !== 'end_turn') return null;
          stopReasonOk = true;
          after.push({ raw, data });
          break;
        case 'message_stop':
          if (!stopReasonOk) return null;
          sawMessageStop = true;
          after.push({ raw, data });
          break;
        default:
          return null;
      }
    }
    if (!stopped || !stopReasonOk || !sawMessageStop) return null;
    const call = parseTextCall(text, this.tools);
    if (!call) return null;

    const id = newToolUseId();
    let s = before.map(e => e.raw.toString('utf8')).join('');
    let toolIdx = idx;
    if (call.prefix) {
      s += sse('content_block_start', {
        type: 'content_block_start', index: idx,
        content_block: { type: 'text', text: '' },
      });
      s += sse('content_block_delta', {
        type: 'content_block_delta', index: idx,
        delta: { type: 'text_delta', text: call.prefix },
      });
      s += sse('content_block_stop', { type: 'content_block_stop', index: idx });
      toolIdx = idx + 1;
    }
    s += sse('content_block_start', {
      type: 'content_block_start', index: toolIdx,
      content_block: { type: 'tool_use', id, name: call.name, input: {} },
    });
    s += sse('content_block_delta', {
      type: 'content_block_delta', index: toolIdx,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    s += sse('content_block_stop', { type: 'content_block_stop', index: toolIdx });
    for (const { raw, data } of after) {
      if (data?.type === 'message_delta') {
        const d = structuredClone(data);
        d.delta.stop_reason = 'tool_use';
        d.delta.stop_sequence = null;
        s += sse('message_delta', d);
      } else {
        s += raw.toString('utf8');
      }
    }
    return s;
  }
}

export const PlaintextToolCallStream = ArgonTextCallStream;

function looksLikeOpenRouter(model, accountName) {
  const m = typeof model === 'string' ? model : '';
  const a = typeof accountName === 'string' ? accountName : '';
  return /openrouter/i.test(m) || /op-free/i.test(m) || /op-free/i.test(a);
}

/**
 * Decide whether a response should go through the repair.
 * `model` is the upstream model id (after the account's model map).
 * Returns the tools map, or null to leave the stream untouched.
 */
export function argonTextCallTools({ model, native, pathClass, status, requestBody, accountName } = {}) {
  if (native || status !== 200 || pathClass !== 'messages') return null;
  const tools = toolsFromRequestBody(requestBody);
  if (!tools) return null;
  tools.holdAllText = looksLikeOpenRouter(model, accountName);
  return tools;
}

export const plaintextToolCallTools = argonTextCallTools;
