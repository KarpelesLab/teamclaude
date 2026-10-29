import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../src/services/normalize';
import { notificationsFor } from '../src/services/notification-rules';
import type { BackendState } from '../src/shared/types';
import { rawAccount, rawStatus } from './fixtures';

function state(patch: Partial<BackendState> = {}, raw: Record<string, unknown> | null = rawStatus()): BackendState {
  return {
    phase: 'running',
    ownership: 'owned',
    host: '127.0.0.1',
    port: 3456,
    endpoint: 'http://127.0.0.1:3456',
    childPid: 1,
    lastError: null,
    restartCount: 0,
    serviceInstalled: false,
    compatibility: { ok: true, message: null },
    status: raw ? normalizeStatus(raw) : null,
    statusAt: 1,
    configPath: '/x/teamclaude.json',
    configExists: true,
    ...patch,
  };
}

const kinds = (prev: BackendState | null, next: BackendState) => notificationsFor(prev, next).map(n => n.kind);

describe('notificationsFor', () => {
  it('says nothing on the first reading', () => {
    expect(kinds(null, state())).toEqual([]);
  });

  it('reports a crash of an owned proxy, not of an external one', () => {
    expect(kinds(state(), state({ phase: 'error', status: null }))).toEqual(['proxyCrashed']);
    expect(kinds(state({ ownership: 'external' }), state({ phase: 'error', status: null }))).toEqual([]);
  });

  it('reports recovery', () => {
    expect(kinds(state({ phase: 'unreachable', status: null }), state())).toEqual(['backendRecovered']);
  });

  it('reports newly expired auth and newly exhausted quota once', () => {
    const expired = rawStatus({ accounts: [rawAccount({ errorReason: { code: 'refresh_rejected' } })] });
    expect(kinds(state(), state({}, expired))).toEqual(['authExpired']);
    expect(kinds(state({}, expired), state({}, expired))).toEqual([]);

    const spent = rawStatus({ accounts: [rawAccount({ status: 'exhausted' }), rawAccount({ name: 'b' })] });
    expect(kinds(state(), state({}, spent))).toEqual(['quotaExhausted']);
  });

  it('does not treat a per-minute rate limit as quota exhaustion', () => {
    const throttled = rawStatus({ accounts: [rawAccount({ unavailable: 'throttled' }), rawAccount({ name: 'b' })] });
    expect(kinds(state(), state({}, throttled))).toEqual([]);
  });

  it('reports when every enabled account becomes unavailable', () => {
    const none = rawStatus({ accounts: [rawAccount({ unavailable: 'exhausted', status: 'exhausted' })] });
    expect(kinds(state(), state({}, none))).toEqual(['quotaExhausted', 'allUnavailable']);
  });

  it('reports a new update', () => {
    const update = rawStatus({ server: { version: '1.1.25', updateAvailable: '1.2.0' } });
    const out = notificationsFor(state(), state({}, update));
    expect(out.map(n => n.kind)).toEqual(['updateAvailable']);
    expect(out[0]?.body).toContain('1.2.0');
  });
});
