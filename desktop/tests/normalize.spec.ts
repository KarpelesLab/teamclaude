import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../src/services/normalize';
import { rawAccount, rawStatus } from './fixtures';

describe('normalizeStatus', () => {
  it('maps a full payload', () => {
    const s = normalizeStatus(rawStatus());
    expect(s.server.version).toBe('1.1.25');
    expect(s.accounts).toHaveLength(1);
    const a = s.accounts[0]!;
    expect(a.name).toBe('alice@example.com');
    expect(a.isCurrent).toBe(true);
    expect(a.fiveHour).toEqual({ utilization: 0.42, resetAt: 1_800_000_000_000, seenAt: 1_799_990_000_000 });
    expect(a.weekly.utilization).toBe(0.1);
    expect(a.weekly.seenAt).toBeNull();
    expect(a.totalRequests).toBe(12);
    expect(s.sessions.distribution).toBe('even');
    expect(s.sessions.items).toBeNull();
    expect(s.readOnly).toBe(false);
  });

  it('reads missing values as null, never as a number', () => {
    const s = normalizeStatus({ accounts: [{}] });
    const a = s.accounts[0]!;
    expect(a.name).toBe('account-1');
    expect(a.fiveHour).toEqual({ utilization: null, resetAt: null, seenAt: null });
    expect(a.totalRequests).toBeNull();
    expect(s.server.version).toBeNull();
    expect(s.switchThreshold).toBeNull();
    expect(s.sessions.distribution).toBeNull();
  });

  it('passes through whether the plan meters a 5-hour window', () => {
    const stated = (value: unknown) => normalizeStatus(rawStatus({ accounts: [rawAccount({ quota: { sessionWindowStated: value } })] })).accounts[0]!.sessionWindowStated;
    expect(stated(true)).toBe(true);
    expect(stated(false)).toBe(false);
    expect(stated(undefined)).toBeNull();
    expect(stated('yes')).toBeNull();
  });

  it('passes through whether the plan meters a shared weekly window', () => {
    const stated = (value: unknown) => normalizeStatus(rawStatus({ accounts: [rawAccount({ quota: { weeklyWindowStated: value } })] })).accounts[0]!.weeklyWindowStated;
    expect(stated(true)).toBe(true);
    expect(stated(false)).toBe(false);
    expect(stated(undefined)).toBeNull();
  });

  it('reads the recent request count the load mode places by, null when not reported', () => {
    const recent = (value: unknown) => normalizeStatus(rawStatus({ accounts: [rawAccount({ recentRequests: value })] })).accounts[0]!.recentRequests;
    expect(recent(7)).toBe(7);
    expect(recent(0)).toBe(0);
    expect(recent(undefined)).toBeNull();
    expect(normalizeStatus(rawStatus({ sessions: { active: 0, known: 0, mode: 'load' } })).sessions.distribution).toBe('load');
  });

  it('survives garbage of the wrong type', () => {
    const s = normalizeStatus({ accounts: 'nope', server: [1, 2], sessions: null, routes: {} } as Record<string, unknown>);
    expect(s.accounts).toEqual([]);
    expect(s.routes).toEqual([]);
    expect(s.server.pid).toBeNull();
  });

  it('falls back to a third-party backend window when no unified reading exists', () => {
    const s = normalizeStatus(rawStatus({
      accounts: [rawAccount({ quota: { backend: { at: 5, windows: { fiveHour: { utilization: 0.3, resetAt: 9 } } } } })],
    }));
    expect(s.accounts[0]!.fiveHour).toEqual({ utilization: 0.3, resetAt: 9, seenAt: 5 });
  });

  it('understands the legacy single currentAccount field and boolean distribute', () => {
    const s = normalizeStatus({
      accounts: [rawAccount({ name: 'old' })],
      currentAccount: 'old',
      sessions: { distribute: false },
    });
    expect(s.currentAccounts).toEqual({ anthropic: 'old' });
    expect(s.accounts[0]!.isCurrent).toBe(true);
    expect(s.sessions.distribution).toBe('off');
  });

  it('resolves session pins to account names and keeps only known indexes', () => {
    const s = normalizeStatus(rawStatus({
      accounts: [rawAccount({ name: 'a' }), rawAccount({ name: 'b' })],
      sessions: { active: 1, items: [{ id: 's1', active: true, pins: { weekly: 1, sonnet: 7 } }] },
    }));
    expect(s.sessions.items?.[0]?.accounts).toEqual({ weekly: 'b' });
  });

  it('keeps account errors and model windows', () => {
    const s = normalizeStatus(rawStatus({
      accounts: [rawAccount({
        errorReason: { code: 'refresh_rejected', detail: 'token refused', remedy: 'teamclaude login' },
        quota: { unified7dSonnet: 0.8 },
      })],
    }));
    const a = s.accounts[0]!;
    expect(a.error).toEqual({ code: 'refresh_rejected', detail: 'token refused', remedy: 'teamclaude login' });
    expect(a.modelWindows.map(w => [w.label, w.utilization])).toEqual([['Sonnet', 0.8]]);
  });

  it('marks a client-key caller as read-only and reads update info', () => {
    expect(normalizeStatus({ caller: { kind: 'client' } }).readOnly).toBe(true);
    expect(normalizeStatus({ server: { updateAvailable: { latest: '2.0.0' } } }).server.updateAvailable).toBe('2.0.0');
    expect(normalizeStatus({ server: { updateAvailable: true } }).server.updateAvailable).toBe('available');
  });
});
