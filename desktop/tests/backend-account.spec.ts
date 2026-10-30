import { describe, expect, it, vi } from 'vitest';
import { testBackend, validBackendUrl } from '../src/services/backend-account';
import { validateCall } from '../src/services/validate';
import { parseBackendModels } from '../src/shared/backend-models';
import { distributionLabel } from '../src/shared/distribution-label';
import { translator } from '../src/shared/i18n';

const input = { upstream: 'https://example.com/anthropic', apiKey: 'demo-not-a-real-key' };

describe('third-party service', () => {
  it('accepts paths and local services but refuses credential-bearing or ambiguous URLs', () => {
    expect(validBackendUrl(input.upstream)).toBe(true);
    expect(validBackendUrl('http://127.0.0.1:1234')).toBe(true);
    for (const url of ['file:///key', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'https://exam\nple.com']) expect(validBackendUrl(url)).toBe(false);
  });
  it('requires only URL and key for discovery, rejecting extra fields', () => {
    expect(validateCall('accounts.testBackend', input).ok).toBe(true);
    for (const patch of [{ auth: 'none' }, { model: 'unnecessary' }, { apiKey: 'abc\nsecret' }, { extra: true }]) {
      expect(validateCall('accounts.testBackend', { ...input, ...patch }).ok).toBe(false);
    }
  });
  it('parses identity models and aliases without silently overwriting duplicates', () => {
    expect(parseBackendModels('claude-a\nclaude-b = vendor/b')).toEqual({ 'claude-a': 'claude-a', 'claude-b': 'vendor/b' });
    for (const text of ['', 'a =', 'a=b=c', 'a\na=b', '__proto__ = a', 'with spaces']) expect(parseBackendModels(text)).toBeNull();
  });
  it.each(['https://example.com/anthropic', 'https://example.com/anthropic/v1', 'https://example.com/anthropic/v1/'])('fetches a model list at %s without running inference', async upstream => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'vendor/sonnet', owner: 'ignored' }, { id: 'vendor/opus' }, { id: 'vendor/sonnet' }, { id: input.apiKey }, { id: 'invalid model' }, { unexpected: true }] }), { headers: { 'content-type': 'application/json' } }));
    expect(await testBackend({ ...input, upstream }, request)).toEqual({ ok: true, code: 'ok', models: ['vendor/sonnet', 'vendor/opus'] });
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://example.com/anthropic/v1/models');
    expect(options?.redirect).toBe('error');
    expect(options?.method).toBe('GET');
    expect(options?.headers).toMatchObject({ authorization: `Bearer ${input.apiKey}` });
    expect(options?.body).toBeUndefined();
  });
  it('never returns upstream errors or secrets, and refuses HTML and invalid Messages data', async () => {
    for (const response of [new Response(input.apiKey, { status: 401 }), new Response('<html>OK</html>'), new Response('{}', { headers: { 'content-type': 'application/json' } }), new Response('{', { headers: { 'content-type': 'application/json' } }), new Response('x'.repeat(1_048_577), { headers: { 'content-type': 'application/json' } })]) {
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
