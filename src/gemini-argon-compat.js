// Argon rejects the Claude SDK's generated identity with RESOURCE_EXHAUSTED.
// Keep this scoped to the observed provider/model and exact generated block;
// never rewrite user instructions or conversation history.
const CLAUDE_SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export function normalizeGeminiArgonRequest(body, { model, native = false } = {}) {
  if (native || typeof model !== 'string' || !/^gemini-4-argon(?:$|[-\[])/.test(model)) return body;
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (typeof obj.system === 'string') {
      if (obj.system.trim() !== CLAUDE_SDK_IDENTITY) return body;
      delete obj.system;
    } else if (Array.isArray(obj.system)) {
      const kept = obj.system.filter(block => !(
        block?.type === 'text' && typeof block.text === 'string'
        && block.text.trim() === CLAUDE_SDK_IDENTITY
      ));
      if (kept.length === obj.system.length) return body;
      if (kept.length) obj.system = kept;
      else delete obj.system;
    } else return body;
    return Buffer.from(JSON.stringify(obj), 'utf8');
  } catch { return body; }
}
