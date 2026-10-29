import { describe, expect, it } from 'vitest';
import { BackendClient, looksLikeStatus, type Requester } from '../src/services/backend-client';
import { rawStatus } from './fixtures';

type Call = Parameters<Requester>[0];

function client(respond: (call: Call) => { status: number; body: string } | Error, apiKey: string | null = null) {
  const calls: Call[] = [];
  const requester: Requester = async call => {
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return { status: r.status, contentType: 'application/json', body: r.body };
  };
  return { c: new BackendClient({ host: '127.0.0.1', port: 3456, apiKey, requester }), calls };
}

describe('BackendClient.probe', () => {
  it('recognises a TeamClaude status answer', async () => {
    const { c, calls } = client(() => ({ status: 200, body: JSON.stringify(rawStatus()) }));
    expect((await c.probe()).kind).toBe('teamclaude');
    expect(calls[0]?.path).toBe('/teamclaude/status');
    expect(calls[0]?.headers.origin).toBeUndefined();
  });

  it('sends the proxy API key as x-api-key only when configured', async () => {
    const { c, calls } = client(() => ({ status: 200, body: JSON.stringify(rawStatus()) }), 'proxy-key');
    await c.probe();
    expect(calls[0]?.headers['x-api-key']).toBe('proxy-key');
  });

  it('classifies foreign servers, auth refusals and refused connections', async () => {
    expect((await client(() => ({ status: 200, body: '{"hello":1}' })).c.probe()).kind).toBe('foreign');
    expect((await client(() => ({ status: 404, body: '<html>' })).c.probe()).kind).toBe('foreign');
    expect((await client(() => ({ status: 401, body: '{"error":{"type":"auth"}}' })).c.probe()).kind).toBe('auth-required');
    const down = await client(() => Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).c.probe();
    expect(down).toEqual({ kind: 'down', detail: 'ECONNREFUSED' });
  });

  it('brackets IPv6 hosts in the base URL', () => {
    expect(new BackendClient({ host: '::1', port: 1, apiKey: null }).baseUrl).toBe('http://[::1]:1');
  });
});

describe('BackendClient.post', () => {
  it('sends JSON with a content length and reads ok/error', async () => {
    const { c, calls } = client(() => ({ status: 200, body: '{"ok":true}' }));
    expect(await c.post('/teamclaude/switch', { account: 'a' })).toMatchObject({ ok: true, error: null });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['content-length']).toBe(String(Buffer.byteLength('{"account":"a"}')));
  });

  it('surfaces server errors and transport errors without throwing', async () => {
    expect(await client(() => ({ status: 400, body: '{"error":"no such account"}' })).c.post('/teamclaude/switch', {}))
      .toMatchObject({ ok: false, status: 400, error: 'no such account' });
    expect(await client(() => ({ status: 200, body: '{"ok":false}' })).c.post('/teamclaude/reload'))
      .toMatchObject({ ok: false, error: 'HTTP 200' });
    expect(await client(() => new Error('socket hang up')).c.post('/teamclaude/reload'))
      .toMatchObject({ ok: false, status: 0, error: 'socket hang up' });
  });

  it('gives the probe action a long timeout', async () => {
    const { c, calls } = client(() => ({ status: 200, body: '{}' }));
    await c.post('/teamclaude/probe');
    expect(calls[0]?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('looksLikeStatus', () => {
  it('requires accounts plus a status-specific field', () => {
    expect(looksLikeStatus({ accounts: [], server: {} })).toBe(true);
    expect(looksLikeStatus({ accounts: [] })).toBe(false);
    expect(looksLikeStatus(null)).toBe(false);
  });
});
