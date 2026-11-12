import { randomUUID } from 'node:crypto';

/** @typedef {Record<string, any>} AnyRecord */

const OPENAI_CHAT_ADAPTER = 'openai-chat';
const GEMINI_PREFIX = 'gemini-';
const MAX_SSE_LINE_CHARS = 1 << 20;
const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
});
const REQUEST_FIELDS = new Set([
  'model', 'messages', 'max_tokens', 'stream', 'system', 'temperature',
  'top_p', 'stop_sequences', 'output_config', 'metadata',
  'tools', 'thinking', 'context_management',
]);
const EFFORTS = new Set(['low', 'medium', 'high']);

export class OpenAIChatRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OpenAIChatRequestError';
    this.status = 400;
    this.code = 'TEAMCLAUDE_OPENAI_CHAT_REQUEST';
  }
}

export class OpenAIChatResponseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OpenAIChatResponseError';
    this.status = 502;
    this.code = 'TEAMCLAUDE_OPENAI_CHAT_RESPONSE';
  }
}

/** @param {AnyRecord|null|undefined} account */
export function isOpenAIChatAccount(account) {
  return account?.adapter === OPENAI_CHAT_ADAPTER;
}

/** @param {unknown} model @returns {model is string} */
function isGeminiModel(model) {
  return typeof model === 'string' && model.startsWith(GEMINI_PREFIX);
}

/** @param {AnyRecord|null|undefined} account @param {string|null|undefined} model */
export function accountSupportsModel(account, model) {
  if (model == null) return true;
  return isOpenAIChatAccount(account) ? isGeminiModel(model) : !isGeminiModel(model);
}

/** Resolve model IDs from the deserialized body, including duplicate-key last-value semantics.
 * The structural parse is the fallback for malformed JSON.
 * @param {Buffer} body @param {string|null} model @param {string|null} advisorModel
 */
export function effectiveRequestModels(body, model, advisorModel) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (typeof parsed?.model === 'string') model = parsed.model;
    if (Array.isArray(parsed?.tools)) {
      const advisor = parsed.tools.find((/** @type {AnyRecord} */ tool) => /^advisor/i.test(tool?.type) && typeof tool?.model === 'string');
      if (advisor) advisorModel = advisor.model;
    }
  } catch { /* the existing structural parse remains authoritative for malformed JSON */ }
  return { model, advisorModel };
}

/** @param {string} message @returns {never} */
function requestError(message) {
  throw new OpenAIChatRequestError(message);
}

/** Accept only Claude Code's no-op final-answer envelope, never real tools or context edits.
 * @param {AnyRecord} request
 */
function validateClaudeCodeEnvelope(request) {
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length !== 0)) {
    requestError('unsupported request fields: tools');
  }
  if (request.thinking !== undefined) {
    const thinking = request.thinking;
    if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)
      || thinking.type !== 'adaptive'
      || Object.keys(thinking).some(key => key !== 'type' && key !== 'display')
      || (thinking.display !== undefined && thinking.display !== 'omitted')) {
      requestError('thinking supports adaptive with display omitted only');
    }
  }
  if (request.context_management !== undefined) {
    const context = request.context_management;
    const edits = context?.edits;
    const edit = Array.isArray(edits) && edits.length === 1 ? edits[0] : null;
    if (!context || typeof context !== 'object' || Array.isArray(context)
      || Object.keys(context).some(key => key !== 'edits')
      || !edit || typeof edit !== 'object' || Array.isArray(edit)
      || Object.keys(edit).some(key => key !== 'type' && key !== 'keep')
      || edit.type !== 'clear_thinking_20251015' || edit.keep !== 'all') {
      requestError('context_management supports only clear_thinking_20251015 with keep all');
    }
  }
}

/** @param {unknown} content @param {string} where */
function textContent(content, where) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) requestError(`${where} must be a string or text blocks`);
  let text = '';
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string'
      || Object.keys(block).some(key => key !== 'type' && key !== 'text' && key !== 'cache_control')
      || (block.cache_control !== undefined && (!block.cache_control || typeof block.cache_control !== 'object'
        || Array.isArray(block.cache_control)
        || Object.keys(block.cache_control).some(key => key !== 'type')
        || block.cache_control.type !== 'ephemeral'))) {
      requestError(`${where} supports plain text blocks only`);
    }
    text += block.text;
  }
  return text;
}

/** @param {AnyRecord|null|undefined} outputConfig @returns {string|null} */
function translateEffort(outputConfig) {
  if (outputConfig == null) return null;
  if (typeof outputConfig !== 'object' || Array.isArray(outputConfig)) {
    requestError('output_config must be an object');
  }
  const unsupported = Object.keys(outputConfig).filter(key => key !== 'effort');
  if (unsupported.length) requestError(`unsupported output_config: ${unsupported.join(', ')}`);
  const effort = outputConfig.effort;
  if (effort == null || effort === 'default' || effort === 'auto') return null;
  if (!EFFORTS.has(effort)) requestError(`unsupported effort: ${String(effort)}`);
  return effort;
}

/** @param {string} model @param {AnyRecord} account */
function wireModel(model, account) {
  let out = model;
  if (account.modelMap && Object.hasOwn(account.modelMap, model)) out = account.modelMap[model];
  if (typeof out !== 'string' || !out) requestError('modelMap must resolve to a model ID');
  const prefix = typeof account.modelPrefix === 'string' ? account.modelPrefix : '';
  if (prefix && !out.startsWith(prefix)) out = prefix + out;
  return out;
}

/** Translate an Anthropic Messages request to an OpenAI Chat Completions request.
 * @param {AnyRecord} request @param {AnyRecord} [account]
 */
export function translateOpenAIChatRequest(request, account = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    requestError('request body must be a JSON object');
  }
  const unsupported = Object.keys(request).filter(key => !REQUEST_FIELDS.has(key));
  if (unsupported.length) requestError(`unsupported request fields: ${unsupported.join(', ')}`);
  validateClaudeCodeEnvelope(request);
  if (!isGeminiModel(request.model)) requestError('openai-chat accounts accept gemini-* models only');
  if (!Array.isArray(request.messages)) requestError('messages must be an array');
  if (request.metadata != null && (typeof request.metadata !== 'object' || Array.isArray(request.metadata)
    || Object.keys(request.metadata).some(key => key !== 'user_id')
    || (request.metadata.user_id != null && typeof request.metadata.user_id !== 'string'))) {
    requestError('metadata supports user_id only');
  }

  const messages = [];
  if (request.system != null) {
    messages.push({ role: 'system', content: textContent(request.system, 'system') });
  }
  for (const [index, message] of request.messages.entries()) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      requestError(`messages[${index}].role must be user or assistant`);
    }
    messages.push({ role: message.role, content: textContent(message.content, `messages[${index}].content`) });
  }

  /** @type {AnyRecord} */
  const out = { model: wireModel(request.model, account), messages };
  if (request.max_tokens != null) {
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0) {
      requestError('max_tokens must be a positive integer');
    }
    out.max_tokens = request.max_tokens;
  }
  for (const field of ['temperature', 'top_p']) {
    if (request[field] == null) continue;
    if (typeof request[field] !== 'number' || !Number.isFinite(request[field])) requestError(`${field} must be a number`);
    out[field] = request[field];
  }
  if (request.stop_sequences != null) {
    if (!Array.isArray(request.stop_sequences) || request.stop_sequences.some(s => typeof s !== 'string')) {
      requestError('stop_sequences must be an array of strings');
    }
    out.stop = request.stop_sequences;
  }
  if (request.stream != null) {
    if (typeof request.stream !== 'boolean') requestError('stream must be a boolean');
    out.stream = request.stream;
    if (request.stream) out.stream_options = { include_usage: true };
  }
  const effort = translateEffort(request.output_config);
  if (effort) out.reasoning_effort = effort;
  return out;
}

/** @param {Buffer} body @param {AnyRecord} [account] */
export function rewriteOpenAIChatRequest(body, account = {}) {
  let request;
  try { request = JSON.parse(body.toString('utf8')); }
  catch { requestError('request body must be valid JSON'); }
  return Buffer.from(JSON.stringify(translateOpenAIChatRequest(request, account)), 'utf8');
}

/** @param {unknown} value @param {string} name */
function tokenCount(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OpenAIChatResponseError(`usage.${name} must be a non-negative integer`);
  }
  return /** @type {number} */ (value);
}

/** Normalize final cumulative usage. Agy input includes cache reads and is preserved directly.
 * Standard OpenAI prompt tokens are split into fresh input plus cached input for our counters.
 * @param {AnyRecord} usage
 */
export function normalizeOpenAIChatUsage(usage) {
  if (!usage || typeof usage !== 'object') throw new OpenAIChatResponseError('final usage is required');
  const agy = usage.input_tokens != null;
  const rawInput = tokenCount(agy ? usage.input_tokens : usage.prompt_tokens, 'input_tokens');
  const output = tokenCount(agy ? usage.output_tokens : usage.completion_tokens, 'output_tokens');
  const cacheRead = tokenCount(
    agy ? (usage.cache_read_tokens ?? 0) : (usage.prompt_tokens_details?.cached_tokens ?? 0),
    'cache_read_tokens',
  );
  const total = tokenCount(usage.total_tokens, 'total_tokens');
  if (total !== rawInput + output) {
    throw new OpenAIChatResponseError('usage.total_tokens must equal input_tokens + output_tokens');
  }
  if (cacheRead > rawInput) throw new OpenAIChatResponseError('cached tokens cannot exceed input tokens');
  return {
    input_tokens: agy ? rawInput : rawInput - cacheRead,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    output_tokens: output,
  };
}

/** @param {unknown} finishReason */
function stopReason(finishReason) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** @param {unknown} content */
function answerText(content) {
  if (content == null) return '';
  if (typeof content !== 'string') throw new OpenAIChatResponseError('upstream content must be plain text');
  return content;
}

/** Translate a buffered OpenAI Chat Completions response to an Anthropic message.
 * @param {AnyRecord} response @param {string} model
 */
export function translateOpenAIChatResponse(response, model) {
  if (!response || typeof response !== 'object') throw new OpenAIChatResponseError('invalid upstream response');
  const choice = response.choices?.[0];
  if (!choice || typeof choice !== 'object') throw new OpenAIChatResponseError('upstream response has no choice');
  const text = answerText(choice.message?.content);
  return {
    id: typeof response.id === 'string' ? response.id : `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    ...(response.usage == null ? {} : { usage: normalizeOpenAIChatUsage(response.usage) }),
  };
}

/** @param {string} type @param {AnyRecord} data */
function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @returns {AsyncGenerator<AnyRecord>} */
async function* upstreamEvents(reader) {
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_SSE_LINE_CHARS && !pending.includes('\n')) {
        throw new OpenAIChatResponseError('upstream SSE line is too long');
      }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); }
        catch { throw new OpenAIChatResponseError('upstream stream contains invalid JSON'); }
      }
    }
    pending += decoder.decode();
    if (pending.startsWith('data:')) {
      const data = pending.slice(5).trimStart().replace(/\r$/, '');
      if (data !== '[DONE]') {
        try { yield JSON.parse(data); }
        catch { throw new OpenAIChatResponseError('upstream stream contains invalid JSON'); }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Translate OpenAI chat SSE into Anthropic message SSE, retaining only final cumulative usage.
 * @param {ReadableStream<Uint8Array>} webStream @param {string} model
 * @param {{onUsage?: (usage: AnyRecord) => void, onMessage?: (id: string) => void}} [options]
 * @returns {ReadableStream<Uint8Array>}
 */
export function createOpenAIChatStream(webStream, model, options = {}) {
  const upstreamReader = webStream.getReader();
  const iterator = translateStream(upstreamReader, model);
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else if (value) controller.enqueue(value);
    },
    async cancel(reason) {
      // Interrupt a pending upstream read before waiting for the translator.
      await upstreamReader.cancel(reason).catch(() => {});
      await iterator.return(reason);
    },
  });

  /** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {string} requestedModel */
  async function* translateStream(reader, requestedModel) {
    let started = false;
    let textStarted = false;
    let id = `msg_${randomUUID()}`;
    let finishReason = null;
    let finalUsage = null;
    const emit = (/** @type {string} */ value) => Buffer.from(value, 'utf8');
    const start = () => {
      if (started) return '';
      started = true;
      options.onMessage?.(id);
      return sseEvent('message_start', {
        message: {
          id, type: 'message', role: 'assistant', model: requestedModel,
          content: [], stop_reason: null, stop_sequence: null, usage: { ...ZERO_USAGE },
        },
      });
    };

    for await (const event of upstreamEvents(reader)) {
      if (typeof event?.id === 'string' && !started) id = event.id;
      if (event?.error) throw new OpenAIChatResponseError('upstream stream returned an error');
      let output = start();
      const choice = event?.choices?.[0];
      const content = choice?.delta?.content;
      if (content != null) {
        const text = answerText(content);
        if (text) {
          if (!textStarted) {
            output += sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
            textStarted = true;
          }
          output += sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
        }
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (event?.usage != null) {
        finalUsage = normalizeOpenAIChatUsage(event.usage);
        options.onUsage?.(finalUsage);
      }
      if (output) yield emit(output);
    }

    let output = start();
    if (textStarted) output += sseEvent('content_block_stop', { index: 0 });
    output += sseEvent('message_delta', {
      delta: { stop_reason: stopReason(finishReason), stop_sequence: null },
      ...(finalUsage ? { usage: finalUsage } : {}),
    });
    output += sseEvent('message_stop', {});
    yield emit(output);
  }
}
