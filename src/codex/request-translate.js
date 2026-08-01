import { createHash } from 'node:crypto';
import { compatibleGptSignature } from './signature.js';

// Anthropic Messages API request -> OpenAI Responses API request.
//
// Ported from CLIProxyAPI (internal/translator/codex/claude/codex_claude_request.go),
// which is the reference implementation this is differential-tested against; the
// fixtures in test/fixtures/codex-requests were generated from it.

// The Responses API caps tool names and call ids at 64 characters. Claude Code's
// MCP tool names routinely exceed that, so both are shortened deterministically.
const NAME_LIMIT = 64;
const CALL_ID_LIMIT = 64;

// Claude Code prefixes a billing header onto the system prompt. It is an
// artifact of the client, not instruction content, so it is dropped rather than
// forwarded as a developer message.
const ATTRIBUTION_PREFIX = 'x-anthropic-billing-header:';

const REMINDER_START = '<system-reminder>';
const REMINDER_END = '</system-reminder>';

// thinking.budget_tokens -> reasoning.effort. Upper bound of each band.
const BUDGET_MINIMAL = 512;
const BUDGET_LOW = 1024;
const BUDGET_MEDIUM = 8192;
const BUDGET_HIGH = 24576;

const WEB_SEARCH_TOOL_TYPES = new Set(['web_search_20250305', 'web_search_20260209']);

function isAttributionText(text) {
  return typeof text === 'string' && text.replace(/^\s+/, '').startsWith(ATTRIBUTION_PREFIX);
}

/**
 * Map a thinking budget onto a reasoning effort level. Returns null for values
 * that carry no level (negative below -1), leaving the caller's default.
 */
export function budgetToEffort(budget) {
  if (typeof budget !== 'number' || budget < -1) return null;
  if (budget === -1) return 'auto';
  if (budget === 0) return 'none';
  if (budget <= BUDGET_MINIMAL) return 'minimal';
  if (budget <= BUDGET_LOW) return 'low';
  if (budget <= BUDGET_MEDIUM) return 'medium';
  if (budget <= BUDGET_HIGH) return 'high';
  return 'xhigh';
}

/**
 * Shorten one name to the Responses API limit.
 *
 * MCP names (mcp__server__tool) keep their last segment, which is the part that
 * distinguishes them; everything else is truncated.
 */
export function shortenName(name) {
  if (name.length <= NAME_LIMIT) return name;
  if (name.startsWith('mcp__')) {
    const idx = name.lastIndexOf('__');
    if (idx > 0) {
      const cand = 'mcp__' + name.slice(idx + 2);
      return cand.length > NAME_LIMIT ? cand.slice(0, NAME_LIMIT) : cand;
    }
  }
  return name.slice(0, NAME_LIMIT);
}

/**
 * Build original -> shortened name map for a request's tools, guaranteeing the
 * shortened names stay unique. Two MCP tools whose names differ only past the
 * truncation point would otherwise collapse onto one name and the model would
 * be unable to address them separately.
 */
export function buildShortNameMap(names) {
  const used = new Set();
  const map = new Map();

  for (const name of names) {
    let cand = shortenName(name);
    if (used.has(cand)) {
      const base = cand;
      for (let i = 1; ; i++) {
        const suffix = '_' + i;
        const allowed = Math.max(0, NAME_LIMIT - suffix.length);
        const tmp = (base.length > allowed ? base.slice(0, allowed) : base) + suffix;
        if (!used.has(tmp)) { cand = tmp; break; }
      }
    }
    used.add(cand);
    map.set(name, cand);
  }
  return map;
}

/**
 * Shorten a tool-use id, keeping a stable low-collision mapping: a hash suffix
 * so two long ids sharing a prefix don't collapse onto the same call_id, which
 * would mis-pair tool results with their calls.
 */
export function shortenCallId(id) {
  if (id.length <= CALL_ID_LIMIT) return id;
  const suffix = '_' + createHash('sha256').update(id).digest('hex').slice(0, 16);
  const prefixLen = CALL_ID_LIMIT - suffix.length;
  if (prefixLen <= 0) return suffix.slice(suffix.length - CALL_ID_LIMIT);
  return id.slice(0, prefixLen) + suffix;
}

/**
 * Ensure a tool's JSON schema is shaped the way the Responses API expects:
 * an object schema always carries a properties map, even an empty one.
 */
export function normalizeToolParameters(schema) {
  if (schema === null || schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const out = { ...schema };
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && out.properties === undefined) out.properties = {};
  return out;
}

// Reasoning levels the Codex backend accepts. Reported verbatim by a live 400:
// "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol' model.
//  Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'."
const CODEX_SUPPORTED_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Anthropic's budget bands include levels Codex has no equivalent for. Map each
// onto the nearest level that preserves intent: `minimal` means "think a
// little", so it becomes `low` rather than `none`, which would switch reasoning
// off entirely. `auto` means "you decide", which is what `medium` (the API
// default) expresses.
const EFFORT_SUBSTITUTES = { minimal: 'low', auto: 'medium' };

/**
 * Force a translated request's reasoning effort onto a level Codex accepts.
 *
 * Kept OUT of claudeRequestToCodex on purpose. That function is held
 * byte-identical to CLIProxyAPI's translator and verified against it by
 * fixtures; CLIProxyAPI does its own clamping in a later pipeline stage
 * (ApplyThinking), which the fixtures do not capture. Folding the clamp into
 * the translator would make those fixtures disagree with ground truth for a
 * reason that has nothing to do with translation being wrong.
 *
 * Without this a thinking budget of 512 or less produced effort `minimal` and
 * the backend rejected the whole request with a 400.
 */
export function applyCodexEffortSupport(body) {
  const request = Buffer.isBuffer(body) ? JSON.parse(body.toString('utf-8')) : body;
  const effort = request?.reasoning?.effort;
  if (!effort || CODEX_SUPPORTED_EFFORTS.has(effort)) return body;

  request.reasoning.effort = EFFORT_SUBSTITUTES[effort] ?? 'medium';
  return Buffer.from(JSON.stringify(request), 'utf-8');
}

function dataUrlFromSource(source) {
  if (!source) return null;
  const data = source.data || source.base64;
  if (!data) return null;
  const mediaType = source.media_type || source.mime_type || 'application/octet-stream';
  return `data:${mediaType};base64,${data}`;
}

// Collect the text parts of a system-role message, dropping attribution noise.
function systemTextParts(content) {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') {
    return content === '' || isAttributionText(content) ? [] : [content];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter(item => item?.type === 'text' && item.text && !isAttributionText(item.text))
    .map(item => item.text);
}

function toolChoiceToCodex(toolChoice, nameMap, webSearchNames) {
  if (toolChoice === undefined || toolChoice === null) return 'auto';
  const type = typeof toolChoice === 'string' ? toolChoice : toolChoice.type;

  switch (type) {
    case 'auto':
    case undefined:
    case '':
      return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': {
      const raw = toolChoice.name;
      if (webSearchNames.has(raw)) return { type: 'web_search' };
      const name = nameMap.get(raw) ?? (raw ? shortenName(raw) : '');
      if (!name) return 'auto';
      return { type: 'function', name };
    }
    default: return 'auto';
  }
}

function webSearchToolToCodex(tool) {
  const out = { type: 'web_search' };
  if (Array.isArray(tool.allowed_domains)) out.filters = { allowed_domains: tool.allowed_domains };
  if (tool.user_location && typeof tool.user_location === 'object') out.user_location = tool.user_location;
  return out;
}

function normalizeServiceTier(request) {
  if (request.speed === 'fast') return 'priority';
  const tier = request.service_tier;
  if (typeof tier !== 'string') return null;
  return ['fast', 'priority'].includes(tier.trim().toLowerCase()) ? 'priority' : null;
}

function resolveReasoningEffort(request) {
  const thinking = request.thinking;
  if (!thinking || typeof thinking !== 'object') return 'medium';

  switch (thinking.type) {
    case 'enabled': {
      const effort = budgetToEffort(thinking.budget_tokens);
      return effort || 'medium';
    }
    case 'adaptive':
    case 'auto': {
      // Adaptive thinking can name an explicit effort; otherwise it means "as
      // much as the model wants", which maps to the top level.
      const explicit = request.output_config?.effort;
      if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().toLowerCase();
      return 'xhigh';
    }
    case 'disabled':
      return budgetToEffort(0) || 'medium';
    default:
      return 'medium';
  }
}

/**
 * Translate an Anthropic Messages request into an OpenAI Responses request.
 *
 * @param {Buffer|string|object} body - the Anthropic request
 * @param {string} model - upstream model name, already resolved through modelMap
 * @returns {Buffer} the Responses API request body
 */
export function claudeRequestToCodex(body, model) {
  const request = typeof body === 'object' && !Buffer.isBuffer(body)
    ? body
    : JSON.parse(Buffer.isBuffer(body) ? body.toString('utf-8') : String(body));

  const toolNames = Array.isArray(request.tools)
    ? request.tools.map(t => t?.name).filter(Boolean)
    : [];
  const nameMap = buildShortNameMap(toolNames);
  const mapName = raw => nameMap.get(raw) ?? shortenName(raw ?? '');

  const input = [];

  // The system prompt becomes a developer-role message.
  const systemParts = systemTextParts(request.system);
  if (systemParts.length > 0) {
    input.push({
      type: 'message',
      role: 'developer',
      content: systemParts.map(text => ({ type: 'input_text', text })),
    });
  }

  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    const role = message?.role;

    // A system-role message mid-conversation is Claude Code's system-reminder
    // channel. Codex has no equivalent role, so it is replayed as a user
    // message wrapped in the same markers the model already knows.
    if (role === 'system') {
      const parts = systemTextParts(message.content);
      const text = parts.join('\n');
      if (parts.length > 0 && text.trim() !== '') {
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${REMINDER_START}\n${text}\n${REMINDER_END}` }],
        });
      }
      continue;
    }

    const content = message?.content;
    let pending = [];

    // Anthropic keeps tool calls inside a message's content array; the Responses
    // API hoists them to top-level input items. Flushing keeps the surrounding
    // text in the right order relative to the hoisted items.
    const flush = () => {
      if (pending.length === 0) return;
      input.push({ type: 'message', role, content: pending });
      pending = [];
    };

    const pushText = text => {
      pending.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text });
    };

    if (typeof content === 'string') {
      pushText(content);
      flush();
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      switch (part?.type) {
        case 'text':
          pushText(part.text ?? '');
          break;

        case 'thinking': {
          // Only an assistant turn can carry reasoning, and only reasoning this
          // backend itself issued can be replayed. A conversation that ran on a
          // Claude account carries Anthropic signatures; forwarding one makes
          // the backend reject the whole request, so drop the block instead.
          if (role !== 'assistant') break;
          const signature = compatibleGptSignature(part.signature);
          if (!signature) break;
          flush();
          input.push({ type: 'reasoning', summary: [], content: null, encrypted_content: signature });
          break;
        }

        case 'image': {
          const url = dataUrlFromSource(part.source);
          if (url) pending.push({ type: 'input_image', image_url: url });
          break;
        }

        case 'tool_use':
          flush();
          input.push({
            type: 'function_call',
            call_id: shortenCallId(part.id ?? ''),
            name: mapName(part.name),
            // Arguments cross the wire as a JSON string, not an object.
            arguments: JSON.stringify(part.input ?? {}),
          });
          break;

        case 'tool_result': {
          flush();
          const item = { type: 'function_call_output', call_id: shortenCallId(part.tool_use_id ?? '') };
          const rc = part.content;
          if (Array.isArray(rc)) {
            const parts = [];
            for (const c of rc) {
              if (c?.type === 'image') {
                const url = dataUrlFromSource(c.source);
                if (url) parts.push({ type: 'input_image', image_url: url });
              } else if (c?.type === 'text') {
                parts.push({ type: 'input_text', text: c.text ?? '' });
              }
            }
            item.output = parts.length > 0 ? parts : stringifyToolOutput(rc);
          } else {
            item.output = stringifyToolOutput(rc);
          }
          input.push(item);
          break;
        }

        default:
          break;
      }
    }
    flush();
  }

  const out = {
    model,
    instructions: '',
    input,
  };

  if (Array.isArray(request.tools)) {
    const webSearchNames = new Set(
      request.tools.filter(t => WEB_SEARCH_TOOL_TYPES.has(t?.type) && t.name).map(t => t.name)
    );
    out.tool_choice = toolChoiceToCodex(request.tool_choice, nameMap, webSearchNames);
    out.tools = request.tools.map(tool => {
      if (WEB_SEARCH_TOOL_TYPES.has(tool?.type)) return webSearchToolToCodex(tool);
      const { input_schema, cache_control, defer_loading, ...rest } = tool; // eslint-disable-line no-unused-vars
      const converted = {
        ...rest,
        type: 'function',
        parameters: normalizeToolParameters(input_schema),
        strict: false,
      };
      if (tool?.name) converted.name = mapName(tool.name);
      // $schema is a JSON Schema authoring artifact the Responses API rejects.
      if (converted.parameters && typeof converted.parameters === 'object') {
        delete converted.parameters.$schema;
      }
      return converted;
    });
  }

  out.parallel_tool_calls = request.tool_choice?.disable_parallel_tool_use === undefined
    ? true
    : !request.tool_choice.disable_parallel_tool_use;

  out.reasoning = { effort: resolveReasoningEffort(request) };

  const serviceTier = normalizeServiceTier(request);
  if (serviceTier) out.service_tier = serviceTier;

  out.stream = true;
  out.store = false;
  // Reasoning must come back encrypted so it can be replayed on the next turn.
  out.include = ['reasoning.encrypted_content'];

  return Buffer.from(JSON.stringify(out), 'utf-8');
}

// A non-array tool_result content is forwarded as a plain string. Objects are
// serialized rather than stringified to "[object Object]".
function stringifyToolOutput(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}
