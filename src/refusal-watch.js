// Refusal detection for the response path. A safety decline arrives as a 200
// with `stop_reason: "refusal"` (plus a `stop_details` category and
// explanation), mid-stream in a `message_delta` event or in the buffered body;
// a decline the server-side fallback chain rescued leaves a `fallback` content
// block behind. All of these pass through the relay as ordinary bytes, so an
// operator watching the log today learns about a ban before the refusals that
// led to it. The detectors here read the same events the usage accounting
// already parses and surface each decline as ONE log line naming the account —
// never the content, only the category and the explanation the API itself
// wrote for machines.

import { safeLine } from './safe-text.js';

/**
 * @typedef {Object} RefusalFinding
 * @property {boolean} rescued  true when a fallback model served the turn the
 *   first model declined, false when the decline reached the client.
 * @property {string|null} category  stop_details.category (cyber, bio, ...),
 *   or the declining model's name for a rescued turn.
 * @property {string|null} explanation  stop_details.explanation, or the
 *   rescue's "from → to" model pair.
 */

/**
 * The finding in one parsed SSE event, or null. Only Anthropic Messages
 * shapes are read here: a Responses-API in-band failure is already reported
 * (and failed over) by peekStreamFailure with its own log line.
 * @param {any} data
 * @returns {RefusalFinding|null}
 */
export function refusalFromSseEvent(data) {
  if (data?.type === 'message_delta' && data.delta?.stop_reason === 'refusal') {
    return {
      rescued: false,
      category: typeof data.delta.stop_details?.category === 'string' ? data.delta.stop_details.category : null,
      explanation: typeof data.delta.stop_details?.explanation === 'string' ? data.delta.stop_details.explanation : null,
    };
  }
  const block = data?.type === 'content_block_start' ? data.content_block : (data?.type === 'fallback' ? data : null);
  if (block?.type === 'fallback') {
    return {
      rescued: true,
      category: typeof block.from?.model === 'string' ? block.from.model : null,
      explanation: `${block.from?.model ?? '?'} → ${block.to?.model ?? '?'}`,
    };
  }
  return null;
}

/**
 * The finding(s) in a buffered message body, or an empty list. One body can
 * carry both a refusal verdict and fallback blocks when the whole chain
 * declined, so this returns every finding, the stop_reason one first.
 * @param {any} json
 * @returns {RefusalFinding[]}
 */
export function refusalFromBody(json) {
  const out = [];
  if (json?.stop_reason === 'refusal') {
    out.push({
      rescued: false,
      category: typeof json.stop_details?.category === 'string' ? json.stop_details.category : null,
      explanation: typeof json.stop_details?.explanation === 'string' ? json.stop_details.explanation : null,
    });
  }
  if (Array.isArray(json?.content)) {
    for (const block of json.content) {
      if (block?.type === 'fallback') {
        out.push({
          rescued: true,
          category: typeof block.from?.model === 'string' ? block.from.model : null,
          explanation: `${block.from?.model ?? '?'} → ${block.to?.model ?? '?'}`,
        });
      }
    }
  }
  return out;
}

/**
 * Render a finding as one log line, in the shape the request log's other
 * account-level notices use (`403 on "name"; ...`):
 *
 *   Refusal (cyber) on "dev@x" — refused for safety reasons
 *   Refusal on "dev@x" rescued by fallback (claude-fable-5-1 → claude-opus-5-5)
 *
 * The explanation is machine-written API text, bounded and stripped of
 * control characters like every other value that lands in the log.
 * @param {string} accountName
 * @param {RefusalFinding} finding
 * @param {(line: string) => void} [log]
 */
export function reportRefusal(accountName, finding, log = console.error) {
  const name = safeLine(accountName, 64);
  if (finding.rescued) {
    log(`[TeamClaude] Refusal on "${name}" rescued by fallback (${safeLine(finding.explanation ?? '?', 96)})`);
    return;
  }
  const category = finding.category ? ` (${safeLine(finding.category, 32)})` : '';
  const explanation = finding.explanation ? ` — ${safeLine(finding.explanation, 240)}` : '';
  log(`[TeamClaude] Refusal${category} on "${name}"${explanation}`);
}
