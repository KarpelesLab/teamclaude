import type { BackendAccountInput, Methods } from '../shared/ipc';

export function validBackendUrl(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** No redirects with credentials, no response/error text returned to the UI. */
export async function testBackend(
  input: BackendAccountInput & { model: string }, request: typeof fetch = fetch,
): Promise<Methods['accounts.testBackend']['result']> {
  try {
    const response = await request(`${input.upstream.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: {
        'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        ...(input.auth === 'bearer' ? { authorization: `Bearer ${input.apiKey}` } : { 'x-api-key': input.apiKey }),
      },
      body: JSON.stringify({ model: input.model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: 'http', status: response.status };
    }
    // A gateway's HTML landing page with HTTP 200 is not a working Messages API.
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      return { ok: false, code: 'invalid' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, code: 'invalid' };
    let text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
        if (text.length > 65_536) return { ok: false, code: 'invalid' };
      }
    } finally { await reader.cancel(); }
    const body: unknown = JSON.parse(text);
    const valid = !!body && typeof body === 'object' && 'type' in body && body.type === 'message' && 'content' in body && Array.isArray(body.content);
    return { ok: valid, code: valid ? 'ok' : 'invalid' };
  } catch { return { ok: false, code: 'network' }; }
}
