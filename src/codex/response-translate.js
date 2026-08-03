import { shortenCallId, buildShortNameMap } from './request-translate.js';

// OpenAI Responses API SSE -> Anthropic Messages API SSE.
//
// Ported from CLIProxyAPI (internal/translator/codex/claude/codex_claude_response.go)
// and differential-tested against it; see test/fixtures/codex-streams.
//
// The two event models do not line up one-to-one. Anthropic requires content
// blocks to be opened and closed around a monotonically increasing index, while
// Codex emits output items that interleave reasoning, text and tool calls
// freely. This translator owns that block bookkeeping, which is why it is
// stateful across the whole stream rather than a pure per-event mapping.

const SUMMARY_PART_SEPARATOR = '\n\n';
const TOOL_ID_INVALID = /[^a-zA-Z0-9_-]/g;

/** Format one Anthropic SSE frame. */
function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Anthropic tool_use ids allow only [a-zA-Z0-9_-]; a Codex call_id can carry
 * other characters. An id that sanitizes to nothing gets a synthetic one, since
 * the client pairs tool results by this value.
 */
function sanitizeToolId(id, fallbackSeq) {
  const s = String(id ?? '').replace(TOOL_ID_INVALID, '_');
  return s === '' ? `toolu_codex_${fallbackSeq}` : s;
}

/**
 * Codex sees shortened tool names (the request translator truncates them to 64
 * chars); the client only knows the originals. Invert that mapping so tool_use
 * blocks name the tool the client actually declared.
 */
function buildShortToOriginal(originalRequest) {
  const names = Array.isArray(originalRequest?.tools)
    ? originalRequest.tools.map(t => t?.name).filter(Boolean)
    : [];
  const forward = buildShortNameMap(names);
  const reverse = new Map();
  for (const [original, short] of forward) reverse.set(short, original);
  return reverse;
}

function codexStopReason(response) {
  const stopSequence = response?.stop_sequence;
  const hasStopSequence = stopSequence !== undefined && stopSequence !== null && stopSequence !== '';

  if (response?.stop_reason) {
    if (response.stop_reason === 'stop' && hasStopSequence) return 'stop_sequence';
    return response.stop_reason;
  }
  if (response?.incomplete_details?.reason) return response.incomplete_details.reason;
  if (hasStopSequence) return 'stop_sequence';
  return '';
}

function mapStopReason(stopReason, hasToolCall) {
  if (hasToolCall) return 'tool_use';
  switch (stopReason) {
    case '': case 'stop': case 'completed': return 'end_turn';
    case 'max_tokens': case 'max_output_tokens': return 'max_tokens';
    // A tool-call stop with no tool block actually emitted is not a tool turn.
    case 'tool_use': case 'tool_calls': case 'function_call': return 'end_turn';
    case 'end_turn': case 'stop_sequence': case 'pause_turn':
    case 'refusal': case 'model_context_window_exceeded': return stopReason;
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/**
 * Split Codex usage into Anthropic's shape. Codex reports cached tokens inside
 * the input total; Anthropic reports them alongside it, so the cached count is
 * subtracted out to avoid double-counting.
 */
function extractUsage(usage) {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  let input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const details = usage.input_tokens_details || {};
  const cached = details.cached_tokens ?? 0;
  // Tokens written INTO the cache on this turn. Anthropic reports these
  // separately as cache_creation_input_tokens; dropping them made a
  // cache-priming turn look cheaper than it was. Codex has used both spellings.
  const cacheWrite = details.cache_write_tokens ?? details.cache_creation_tokens ?? 0;
  if (cached > 0) input = input >= cached ? input - cached : 0;
  return { input, output, cached, cacheWrite };
}

function errorFrame(event) {
  const err = event?.error ?? {};
  let type = String(err.type ?? '').trim() || String(event?.error_type ?? '').trim() || 'api_error';
  const code = String(err.code ?? '').trim();
  const message = String(err.message ?? '').trim()
    || String(event?.message ?? '').trim()
    || code
    || type;
  if (code === 'cyber_policy' || type === 'invalid_request') type = 'invalid_request_error';
  return sse('error', { type: 'error', error: { type, message } });
}

// Events that must wait behind an in-flight tool call. Anthropic cannot
// interleave a second block into an open tool_use block, so anything that would
// open one is buffered until the active call closes.
function shouldDefer(type, event) {
  switch (type) {
    case 'error':
    case 'response.completed':
    case 'response.incomplete':
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
      return false;
    case 'response.output_item.added':
    case 'response.output_item.done':
      return event?.item?.type !== 'function_call';
    default:
      return true;
  }
}

class FunctionCall {
  constructor() {
    this.callId = '';
    this.name = '';
    this.blockIndex = -1;
    this.args = '';
    this.emittedLength = 0;
    this.hasArgsDelta = false;
    this.emitInitialEmptyDelta = false;
    this.started = false;
    this.done = false;
    this.closed = false;
  }
}

class CodexStreamTranslator {
  constructor(originalRequest = null) {
    this.shortToOriginal = buildShortToOriginal(originalRequest);
    this.blockIndex = 0;
    this.textBlockOpen = false;
    this.thinkingBlockOpen = false;
    this.thinkingSignature = '';
    this.thinkingSummarySeen = false;
    this.hasTextDelta = false;
    this.hasEmittedToolUse = false;
    this.calls = new Map();       // alias key -> FunctionCall
    this.queue = [];
    this.activeCall = null;
    this.lastCall = null;
    this.deferred = [];
    this.toolIdSeq = 0;
  }

  // ── content block lifecycle ───────────────────────────────

  #startText(out) {
    if (this.textBlockOpen) return;
    out.push(sse('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: { type: 'text', text: '' },
    }));
    this.textBlockOpen = true;
  }

  #stopText(out) {
    if (!this.textBlockOpen) return;
    out.push(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
    this.textBlockOpen = false;
    this.blockIndex++;
  }

  #startThinking(out) {
    if (this.thinkingBlockOpen) return;
    out.push(sse('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: { type: 'thinking', thinking: '' },
    }));
    this.thinkingBlockOpen = true;
  }

  #thinkingDelta(out, text) {
    if (!text) return;
    out.push(sse('content_block_delta', {
      type: 'content_block_delta', index: this.blockIndex,
      delta: { type: 'thinking_delta', thinking: text },
    }));
  }

  #finalizeThinking(out) {
    if (!this.thinkingBlockOpen) return;
    if (this.thinkingSignature) {
      out.push(sse('content_block_delta', {
        type: 'content_block_delta', index: this.blockIndex,
        delta: { type: 'signature_delta', signature: this.thinkingSignature },
      }));
    }
    out.push(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
    this.blockIndex++;
    this.thinkingBlockOpen = false;
  }

  // A reasoning item can finish having produced a signature but no summary
  // text. The signature still has to reach the client for the next turn to
  // replay it, so an empty thinking block is opened purely to carry it.
  #finalizeSignatureOnlyThinking(out) {
    if (!this.thinkingSignature) return;
    this.#startThinking(out);
    this.#finalizeThinking(out);
  }

  // ── function call bookkeeping ─────────────────────────────

  // Codex identifies a call inconsistently across its events — sometimes by
  // output_index, sometimes call_id, sometimes item_id — so every seen
  // identifier is registered as an alias for the same call object.
  #keysFor(event, item) {
    const keys = [];
    const add = k => { if (k && !keys.includes(k)) keys.push(k); };
    if (event?.output_index !== undefined) add(`output:${JSON.stringify(event.output_index)}`);
    if (item?.call_id) add(`call:${item.call_id}`);
    if (event?.call_id) add(`call:${event.call_id}`);
    if (item?.id) add(`item:${item.id}`);
    if (event?.item_id) add(`item:${event.item_id}`);
    return keys;
  }

  #callForKeys(keys) {
    for (const key of keys) {
      const call = this.calls.get(key);
      if (call) return call;
    }
    return null;
  }

  #callForEvent(event, item) {
    const keys = this.#keysFor(event, item);
    if (keys.length > 0) return this.#callForKeys(keys);
    return this.lastCall;
  }

  #addAliases(call, keys) {
    for (const key of keys) this.calls.set(key, call);
  }

  #recordCall(event, item) {
    const keys = this.#keysFor(event, item);
    let call = this.#callForKeys(keys);
    if (!call) {
      call = new FunctionCall();
      this.queue.push(call);
    }
    this.#addAliases(call, keys);
    this.lastCall = call;
    return call;
  }

  #updateIdentity(call, event, item) {
    if (!call) return;
    if (item?.call_id) call.callId = item.call_id;
    if (item?.name) call.name = item.name;
    this.#addAliases(call, this.#keysFor(event, item));
  }

  #updateArguments(call, args, isDelta) {
    if (!call || !args) return;
    if (isDelta) {
      call.args += args;
      call.hasArgsDelta = true;
      return;
    }
    if (!call.hasArgsDelta) { call.args = args; return; }
    // A terminal `arguments` that extends what the deltas already built is the
    // authoritative value; one that disagrees is stale and ignored.
    if (args.startsWith(call.args)) call.args = args;
  }

  #flushBufferedArguments(out, call) {
    if (!call || this.activeCall !== call || !call.started || call.closed) return;
    if (call.emittedLength >= call.args.length) return;
    out.push(sse('content_block_delta', {
      type: 'content_block_delta', index: call.blockIndex,
      delta: { type: 'input_json_delta', partial_json: call.args.slice(call.emittedLength) },
    }));
    call.emittedLength = call.args.length;
  }

  // Drain the queue: only one tool_use block may be open at a time, so calls
  // start in order and the next one waits for the previous to close.
  #pumpQueue(out) {
    for (;;) {
      const active = this.activeCall;
      if (active) {
        this.#flushBufferedArguments(out, active);
        if (!active.done) return;
        out.push(sse('content_block_stop', { type: 'content_block_stop', index: active.blockIndex }));
        if (this.blockIndex <= active.blockIndex) this.blockIndex = active.blockIndex + 1;
        active.closed = true;
        this.activeCall = null;
        const at = this.queue.indexOf(active);
        if (at >= 0) this.queue.splice(at, 1);
      }

      while (this.queue.length > 0 && this.queue[0].closed) this.queue.shift();
      if (this.queue.length === 0) return;

      const call = this.queue[0];
      // Without a name there is nothing to open a tool_use block with; wait for
      // the event that supplies it.
      if (!call.name) return;

      call.blockIndex = this.blockIndex;
      const name = this.shortToOriginal.get(call.name) ?? call.name;
      out.push(sse('content_block_start', {
        type: 'content_block_start', index: call.blockIndex,
        content_block: {
          type: 'tool_use',
          id: shortenCallId(sanitizeToolId(call.callId, ++this.toolIdSeq)),
          name,
          input: {},
        },
      }));
      if (call.emitInitialEmptyDelta) {
        out.push(sse('content_block_delta', {
          type: 'content_block_delta', index: call.blockIndex,
          delta: { type: 'input_json_delta', partial_json: '' },
        }));
      }
      call.started = true;
      this.activeCall = call;
      this.hasEmittedToolUse = true;
      this.#flushBufferedArguments(out, call);
    }
  }

  // Reconcile against the terminal response: any call the stream announced but
  // never completed is finished from the final output array, so a truncated
  // stream still produces well-formed tool_use blocks.
  #callsFromTerminal(out, response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    output.forEach((item, index) => {
      if (item?.type !== 'function_call') return;
      const keys = this.#keysFor(null, item);
      const add = k => { if (k && !keys.includes(k)) keys.push(k); };
      if (item.output_index !== undefined) add(`output:${JSON.stringify(item.output_index)}`);
      add(`output:${index}`);

      let call = this.#callForKeys(keys);
      if (!call) { call = new FunctionCall(); this.queue.push(call); }
      this.#addAliases(call, keys);
      this.#updateIdentity(call, null, item);
      this.#updateArguments(call, item.arguments, false);
      call.done = true;
    });

    this.queue = this.queue.filter(call => {
      if (call.closed) return false;
      if (!call.name) { call.closed = true; return false; }
      call.done = true;
      return true;
    });
    this.#pumpQueue(out);

    this.calls.clear();
    this.queue = [];
    this.activeCall = null;
    this.lastCall = null;
  }

  #drainDeferred(out) {
    if (this.deferred.length === 0) return;
    const events = this.deferred;
    this.deferred = [];
    for (const event of events) out.push(...this.#handle(event));
  }

  // ── event dispatch ────────────────────────────────────────

  #handle(event) {
    const out = [];
    const type = event?.type;

    if (this.activeCall && shouldDefer(type, event)) {
      this.deferred.push(event);
      return out;
    }

    switch (type) {
      case 'error':
        out.push(errorFrame(event));
        break;

      case 'response.created':
        out.push(sse('message_start', {
          type: 'message_start',
          message: {
            id: event.response?.id ?? '',
            type: 'message',
            role: 'assistant',
            model: event.response?.model ?? '',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [],
            stop_reason: null,
          },
        }));
        break;

      case 'response.reasoning_summary_part.added':
        this.#stopText(out);
        // Codex splits one reasoning item into several summary parts, but only
        // output_item.done carries the item's final encrypted_content. Keep a
        // single thinking block open across the parts, separated by a blank
        // line, so exactly one signature is ever emitted.
        if (this.thinkingBlockOpen) this.#thinkingDelta(out, SUMMARY_PART_SEPARATOR);
        else this.#startThinking(out);
        this.thinkingSummarySeen = true;
        break;

      case 'response.reasoning_summary_text.delta':
        this.#stopText(out);
        this.#startThinking(out);
        this.#thinkingDelta(out, event.delta ?? '');
        break;

      case 'response.reasoning_summary_part.done':
        // Deliberately does not close the block — see the comment above.
        break;

      case 'response.content_part.added':
        this.#finalizeThinking(out);
        if (event.part?.type === 'output_text') this.#startText(out);
        break;

      case 'response.output_text.delta':
        this.hasTextDelta = true;
        this.#finalizeThinking(out);
        this.#startText(out);
        out.push(sse('content_block_delta', {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'text_delta', text: event.delta ?? '' },
        }));
        break;

      case 'response.content_part.done':
        if (event.part?.type === 'output_text') this.#stopText(out);
        break;

      case 'response.web_search_call.searching':
      case 'response.web_search_call.completed':
      case 'response.web_search_call.in_progress':
        // Populated web_search_call items only arrive on output_item.done.
        break;

      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response ?? {};
        this.#finalizeThinking(out);
        this.#stopText(out);
        this.#callsFromTerminal(out, response);
        this.#drainDeferred(out);
        this.#finalizeThinking(out);
        this.#stopText(out);

        const { input, output, cached, cacheWrite } = extractUsage(response.usage);
        const delta = {
          stop_reason: mapStopReason(codexStopReason(response), this.hasEmittedToolUse),
          stop_sequence: null,
        };
        if (response.stop_sequence) delta.stop_sequence = response.stop_sequence;
        const usage = { input_tokens: input, output_tokens: output };
        if (cached > 0) usage.cache_read_input_tokens = cached;
        if (cacheWrite > 0) usage.cache_creation_input_tokens = cacheWrite;

        out.push(sse('message_delta', { type: 'message_delta', delta, usage }));
        out.push(sse('message_stop', { type: 'message_stop' }));
        break;
      }

      case 'response.output_item.added': {
        const item = event.item ?? {};
        if (item.type === 'function_call') {
          this.#finalizeThinking(out);
          this.#stopText(out);
          const call = this.#recordCall(event, item);
          this.#updateIdentity(call, event, item);
          if (call.name) call.emitInitialEmptyDelta = true;
          this.#pumpQueue(out);
        } else if (item.type === 'reasoning') {
          this.#stopText(out);
          // A previous reasoning item that never reported done must not leak
          // its still-open block into this one.
          this.#finalizeThinking(out);
          this.thinkingSummarySeen = false;
          // Pre-content snapshot, kept only as a fallback for streams whose
          // output_item.done omits encrypted_content.
          this.thinkingSignature = item.encrypted_content ?? '';
        }
        // web_search_call: deferred until output_item.done carries the query.
        break;
      }

      case 'response.output_item.done': {
        const item = event.item ?? {};
        if (item.type === 'message') {
          // Only synthesize text if none was streamed — otherwise this would
          // duplicate the whole message.
          if (this.hasTextDelta) break;
          if (!Array.isArray(item.content)) break;
          const text = item.content
            .filter(p => p?.type === 'output_text' && p.text)
            .map(p => p.text)
            .join('');
          if (!text) break;
          this.#finalizeThinking(out);
          this.#startText(out);
          out.push(sse('content_block_delta', {
            type: 'content_block_delta', index: this.blockIndex,
            delta: { type: 'text_delta', text },
          }));
          this.#stopText(out);
          this.hasTextDelta = true;
        } else if (item.type === 'function_call') {
          this.#finalizeThinking(out);
          this.#stopText(out);
          let call = this.#callForEvent(event, item);
          if (!call) call = this.#recordCall(event, item);
          this.#updateIdentity(call, event, item);
          this.#updateArguments(call, item.arguments, false);
          call.done = true;
          this.#pumpQueue(out);
        } else if (item.type === 'reasoning') {
          this.#stopText(out);
          if (item.encrypted_content) this.thinkingSignature = item.encrypted_content;
          if (this.thinkingSummarySeen) this.#finalizeThinking(out);
          else this.#finalizeSignatureOnlyThinking(out);
          this.thinkingSignature = '';
          this.thinkingSummarySeen = false;
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        let call = this.#callForEvent(event, null);
        if (!call) call = this.#recordCall(event, null);
        this.#updateArguments(call, event.delta ?? '', true);
        this.#flushBufferedArguments(out, call);
        break;
      }

      case 'response.function_call_arguments.done': {
        let call = this.#callForEvent(event, null);
        if (!call) call = this.#recordCall(event, null);
        this.#updateArguments(call, event.arguments ?? '', false);
        this.#flushBufferedArguments(out, call);
        break;
      }

      default:
        break;
    }

    if (this.queue.length === 0) this.#drainDeferred(out);
    return out;
  }

  /**
   * Feed one raw Codex SSE line ("data: {...}").
   * @returns {string[]} Anthropic SSE frames to forward, possibly empty.
   */
  push(line) {
    const text = Buffer.isBuffer(line) ? line.toString('utf-8') : String(line);
    if (!text.startsWith('data:')) return [];
    const payload = text.slice(5).trim();
    // The Responses API does not send [DONE], but tolerate it rather than
    // throwing on a sentinel some proxies add.
    if (payload === '' || payload === '[DONE]') return [];
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return [];
    }
    return this.#handle(event);
  }

  /**
   * Close out a stream that ended without a terminal event, so the client is
   * never left waiting on an unclosed block.
   */
  end() {
    const out = [];
    this.#finalizeThinking(out);
    this.#stopText(out);
    if (this.activeCall) {
      const active = this.activeCall;
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: active.blockIndex }));
      active.closed = true;
      this.activeCall = null;
    }
    return out;
  }
}

export function createCodexStreamTranslator(originalRequest = null) {
  return new CodexStreamTranslator(originalRequest);
}

/**
 * Fold a translated Anthropic SSE sequence back into a single Messages
 * response.
 *
 * Needed because the request translator always asks Codex for a stream (the
 * Responses API is streaming-first here), while the client may have asked for a
 * plain JSON response. Rather than maintaining a second translator for that
 * case, the streamed frames are replayed into the object they describe.
 */
export function aggregateAnthropicStream(frames) {
  const message = {
    id: '', type: 'message', role: 'assistant', model: '',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const blocks = new Map();

  for (const frame of frames) {
    const dataLine = String(frame).split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) continue;
    let event;
    try { event = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

    switch (event.type) {
      case 'message_start':
        Object.assign(message, {
          id: event.message?.id ?? '',
          model: event.message?.model ?? '',
        });
        break;

      case 'content_block_start':
        blocks.set(event.index, { ...(event.content_block ?? {}) });
        break;

      case 'content_block_delta': {
        const block = blocks.get(event.index);
        if (!block) break;
        const d = event.delta ?? {};
        if (d.type === 'text_delta') block.text = (block.text ?? '') + d.text;
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta') block.signature = d.signature;
        else if (d.type === 'input_json_delta') block._json = (block._json ?? '') + d.partial_json;
        break;
      }

      case 'message_delta':
        if (event.delta?.stop_reason !== undefined) message.stop_reason = event.delta.stop_reason;
        if (event.delta?.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
        if (event.usage) Object.assign(message.usage, event.usage);
        break;

      case 'error':
        // An error frame replaces the response entirely; the caller forwards it
        // as the error body rather than a half-built message.
        return { error: event.error ?? { type: 'api_error', message: 'unknown error' } };

      default:
        break;
    }
  }

  message.content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => {
      if (block.type === 'tool_use') {
        // Arguments streamed as a JSON string; the non-streaming shape wants the
        // parsed object. A malformed fragment degrades to an empty input rather
        // than failing the whole response.
        let input = {};
        if (block._json) { try { input = JSON.parse(block._json); } catch { input = {}; } }
        return { type: 'tool_use', id: block.id, name: block.name, input };
      }
      return block;
    });

  return message;
}

export { mapStopReason, extractUsage, sanitizeToolId };
