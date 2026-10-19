// Off unless TEAMCLAUDE_LOG_BODY_SHAPE=1: one log line per forwarding stage
// with the body's byte length, messages[] count and tools[] count, so a
// request that loses its history or tools can be traced to the stage that
// dropped them. With the flag unset nothing is parsed and nothing is logged.
export const BODY_SHAPE_ENV = 'TEAMCLAUDE_LOG_BODY_SHAPE';

export function bodyShapeEnabled(env = process.env) {
  return env[BODY_SHAPE_ENV] === '1';
}

// { bytes, messages, tools } for a JSON body; messages/tools are null when the
// body is not JSON or the field is absent (never throws).
export function measureBodyShape(body) {
  const bytes = body ? body.length : 0;
  let parsed = null;
  try { parsed = bytes ? JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) : null; } catch { parsed = null; }
  const count = (v) => (Array.isArray(v) ? v.length : null);
  return { bytes, messages: count(parsed?.messages), tools: count(parsed?.tools) };
}

export function logBodyShape(stage, body, meta = {}, sink = console.log, env = process.env) {
  if (!bodyShapeEnabled(env)) return;
  const s = measureBodyShape(body);
  const who = [meta.reqId != null ? `req=${meta.reqId}` : '', meta.account ? `account=${meta.account}` : '',
    meta.model ? `model=${meta.model}` : ''].filter(Boolean).join(' ');
  sink(`[TeamClaude] body-shape stage=${stage} ${who} bytes=${s.bytes} messages=${s.messages ?? '-'} tools=${s.tools ?? '-'}`);
}
