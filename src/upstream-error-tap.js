// Upstream error body tap. A non-2xx from upstream is relayed to the client
// verbatim, and the request log line records only the status — "(400, 1.8s)".
// For a first-party 429 that is enough (the rate-limit headers say the rest),
// but a 400's reason lives in the body, and a third-party Anthropic-compatible
// upstream (Kimi, GLM, OpenCode Zen) rejects shapes its siblings accept, so
// one account can 400 a payload another serves. Measured on the IPM kimi pool:
// ten consecutive relayed 400s on one account, reason invisible without
// reading the body, while a sibling answered 200.
//
// The detectors here read the body the relay has already buffered and surface
// each relayed error as ONE log line naming the account, the status, and the
// upstream's own error type and message — bounded and stripped of control
// characters like every other value that lands in the log.

import { safeLine } from './safe-text.js';

/**
 * @typedef {Object} UpstreamErrorFinding
 * @property {string|null} type  error.type (invalid_request_error, ...)
 * @property {string|null} message  error.message, machine-written upstream
 *   text.
 */

/**
 * The finding in a buffered error body, or null when the body is not a JSON
 * error (an HTML error page from a middlebox, an empty body). Only the
 * machine-readable fields are read; a payload's own text never is.
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {UpstreamErrorFinding|null}
 */
export function upstreamErrorFromBody(buffer) {
  if (!buffer || !buffer.length) return null;
  try {
    const json = JSON.parse(Buffer.from(buffer).toString('utf8'));
    // The Anthropic shape is {type: "error", error: {type, message}}; some
    // backends flatten it to {message}. The envelope's own type ("error") is
    // never the finding.
    const err = json?.error && typeof json.error === 'object' ? json.error : null;
    const type = typeof err?.type === 'string' ? err.type : null;
    const message = typeof err?.message === 'string' ? err.message
      : typeof json?.message === 'string' ? json.message
      : null;
    if (!type && !message) return null;
    return { type, message };
  } catch {
    return null;
  }
}

/**
 * Render a relayed upstream error as one log line, in the shape the request
 * log's other account-level notices use (`403 on "name"; ...`):
 *
 *   Upstream 400 on "dev@x" — invalid_request_error: messages.0.content.1: ...
 *   Upstream 502 on "dev@x"
 *
 * @param {number} status
 * @param {string} accountName
 * @param {UpstreamErrorFinding|null} finding
 * @param {(line: string) => void} [log]
 */
export function reportUpstreamError(status, accountName, finding, log = console.error) {
  const name = safeLine(accountName, 64);
  const detail = finding?.type ? ` — ${safeLine(finding.type, 64)}` : '';
  const message = finding?.message ? `: ${safeLine(finding.message, 240)}` : '';
  log(`[TeamClaude] Upstream ${status} on "${name}"${detail}${message}`);
}
