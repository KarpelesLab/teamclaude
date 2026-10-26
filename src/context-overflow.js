// Classify custom-adapter overflow so Claude Code compact-retries like native
// Anthropic. CC 2.1.310 only recovers from:
//   ^prompt is too long: \d+ tokens > \d+ maximum$
// A gateway 502 rewrite is treated as overloaded 5xx → fallbackModel hop
// ("high demand"), not compact. Docs: model-config#correct-the-window-for-a-gateway-or-custom-model-id

const OVERFLOW_RE = /prompt is too long|context[_ ]length|maximum context|input is too long|context window|context limit|too many tokens|token limit exceeded|max_tokens_context_overflow/i;
const ANTHROPIC_TOO_LONG = /^prompt is too long: \d+ tokens > \d+ maximum$/;
const COUNTS_RE = /(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i;

export function isAnthropicPromptTooLong(message) {
  return typeof message === 'string' && ANTHROPIC_TOO_LONG.test(message.trim());
}

export function isContextOverflowText(text) {
  if (typeof text !== 'string' || !text) return false;
  return OVERFLOW_RE.test(text);
}

/** Peek status+body from a custom adapter. 413 is always overflow. */
export function isContextOverflowError(status, bodyText) {
  const code = Number(status);
  if (code === 413) return true;
  if (!isContextOverflowText(bodyText)) return false;
  return code === 400 || code >= 500;
}

function parseCounts(text) {
  const m = String(text || '').match(COUNTS_RE);
  if (!m) return { input: 0, maximum: 0 };
  return {
    input: Number(m[1].replace(/,/g, '')),
    maximum: Number(m[2].replace(/,/g, '')),
  };
}

/**
 * Anthropic-shaped 400 body whose message matches Claude Code's compact regex.
 * `windowTokens` is used when the upstream did not echo a maximum.
 */
export function anthropicPromptTooLongBody(bodyText, windowTokens = 258400) {
  const { input, maximum } = parseCounts(bodyText);
  const max = maximum > 0 ? maximum : Number(windowTokens) || 258400;
  const used = input > 0 ? input : max + 1;
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `prompt is too long: ${used} tokens > ${max} maximum`,
    },
  };
}
