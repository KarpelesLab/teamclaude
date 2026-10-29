/** One model ID per line, or the Claude Code ID = the service's model ID. */
export function parseBackendModels(text: string): Record<string, string> | null {
  const pairs = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => line.split('=').map(s => s.trim()));
  if (!pairs.length || pairs.length > 50) return null;
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (pair.length > 2 || pair.some(s => !s || s.length > 200 || /\s/.test(s) || ['__proto__', 'constructor', 'prototype'].includes(s))) return null;
    const source = pair[0]!;
    if (seen.has(source)) return null;
    seen.add(source);
  }
  return Object.fromEntries(pairs.map(([source, target]) => [source!, target ?? source!]));
}
