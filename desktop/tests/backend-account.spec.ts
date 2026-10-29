import { describe, expect, it, vi } from 'vitest';
import { testBackend, validBackendUrl } from '../src/services/backend-account';
import { validateCall } from '../src/services/validate';
import { parseBackendModels } from '../src/shared/backend-models';
import { distributionLabel } from '../src/shared/distribution-label';
import { translator } from '../src/shared/i18n';

const input = { name: 'Demo', upstream: 'https://example.com/anthropic', apiKey: 'demo-not-a-real-key', auth: 'bearer' as const, modelMap: { sonnet: 'vendor/sonnet' }, model: 'vendor/sonnet' };

describe('third-party service', () => {
  it('accepts paths and local services but refuses credential-bearing or ambiguous URLs', () => {
    expect(validBackendUrl(input.upstream)).toBe(true);
    expect(validBackendUrl('http://127.0.0.1:1234')).toBe(true);
    for (const url of ['file:///key', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'https://exam\nple.com']) expect(validBackendUrl(url)).toBe(false);
  });
  it('validates every IPC field and the chosen test model', () => {
    expect(validateCall('accounts.testBackend', input).ok).toBe(true);
    for (const patch of [{ auth: 'none' }, { priority: NaN }, { model: 'another' }, { modelMap: {} }, { apiKey: 'abc\nsecret' }, { extra: true }]) {
      expect(validateCall('accounts.testBackend', { ...input, ...patch }).ok).toBe(false);
    }
  });
  it('parses identity models and aliases without silently overwriting duplicates', () => {
    expect(parseBackendModels('claude-a\nclaude-b = vendor/b')).toEqual({ 'claude-a': 'claude-a', 'claude-b': 'vendor/b' });
    for (const text of ['', 'a =', 'a=b=c', 'a\na=b', '__proto__ = a', 'with spaces']) expect(parseBackendModels(text)).toBeNull();
  });
  it.each(['bearer', 'x-api-key'] as const)('tests a real Messages response with %s auth, bounded output and redirects disabled', async auth => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ type: 'message', content: [] }), { headers: { 'content-type': 'application/json' } }));
    expect(await testBackend({ ...input, auth }, request)).toEqual({ ok: true, code: 'ok' });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://example.com/anthropic/v1/messages');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject(auth === 'bearer' ? { authorization: `Bearer ${input.apiKey}` } : { 'x-api-key': input.apiKey });
    expect(JSON.parse(options?.body as string)).toMatchObject({ model: input.model, max_tokens: 1 });
  });
  it('never returns upstream errors or secrets, and refuses HTML and invalid Messages data', async () => {
    for (const response of [new Response(input.apiKey, { status: 401 }), new Response('<html>OK</html>'), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      const result = await testBackend(input, vi.fn<typeof fetch>().mockResolvedValue(response));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(input.apiKey);
    }
    expect(await testBackend(input, vi.fn<typeof fetch>().mockRejectedValue(new Error(input.apiKey)))).toEqual({ ok: false, code: 'network' });
  });
  it('localizes distribution names including the status alias even', () => {
    const t = translator('ru');
    expect(distributionLabel('adaptive', t)).toBe('Адаптивно');
    expect(distributionLabel('on', t)).toBe(distributionLabel('even', t));
  });
});
