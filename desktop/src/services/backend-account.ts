import type { Methods } from '../shared/ipc';

export function validBackendUrl(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** OpenAI-compatible model discovery only; never run inference or follow redirects. */
export async function testBackend(
  input: Methods['accounts.testBackend']['args'], request: typeof fetch = fetch,
): Promise<Methods['accounts.testBackend']['result']> {
  try {
    const base = input.upstream.replace(/\/+$/, '').replace(/\/v1$/, '');
    const response = await request(`${base}/v1/models`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiKey}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: 'http', status: response.status };
    }
    // A gateway's HTML landing page with HTTP 200 is not a model list.
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      return { ok: false, code: 'invalid' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, code: 'invalid' };
    let text = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        text += decoder.decode(part.value, { stream: true });
        if (text.length > 1_048_576) return { ok: false, code: 'invalid' };
      }
    } finally { await reader.cancel(); }
    let body: unknown;
    try { body = JSON.parse(text + decoder.decode()); } catch { return { ok: false, code: 'invalid' }; }
    if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) return { ok: false, code: 'invalid' };
    const models: string[] = [];
    for (const row of body.data) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
      const id: string = row.id;
      // Only model identifiers cross IPC. Ignore metadata and key echoes.
      if (!id || id.length > 200 || /[\s=]/.test(id) || /\p{C}/u.test(id) || id.includes(input.apiKey) || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
      if (!models.includes(id)) models.push(id);
      if (models.length >= 1000) break;
    }
    return { ok: true, code: 'ok', models };
  } catch { return { ok: false, code: 'network' }; }
}
