// What an activity line says about a non-2xx response: the upstream's error
// type, and nothing else from its body. An error body can quote the request
// (a rejected message, a model id, a tool name), and the activity log is
// shared, so only a short identifier is let through.

const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const MAX_LENGTH = 32;

/**
 * The structured `error.details.error_code` of an upstream error body, else its
 * `error.type`, or null when there is neither or it is not a plain identifier.
 * @param {Uint8Array|null} body
 * @returns {string|null}
 */
export function upstreamErrorType(body) {
  if (!body || body.byteLength === 0) return null;
  let error;
  try {
    error = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : Buffer.from(body).toString('utf8'))?.error;
  } catch {
    return null;
  }
  for (const candidate of [error?.details?.error_code, error?.type]) {
    if (typeof candidate === 'string' && IDENTIFIER.test(candidate)) return candidate.slice(0, MAX_LENGTH);
  }
  return null;
}

/**
 * The status as an activity line shows it: `404 thread_not_found`, or just `200`.
 * @param {unknown} status
 * @param {string|null|undefined} errorType
 */
export function statusLabel(status, errorType) {
  return errorType ? `${status} ${errorType}` : String(status);
}
