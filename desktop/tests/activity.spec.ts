import { describe, expect, it } from 'vitest';
import { normalizeStatus } from '../src/services/normalize';
import {
  ActivityLog, appendHistory, diffActivity, EMPTY_HISTORY, freshPart, MAX_ACTIVITY, mergeSnapshot, QUOTA_SAMPLE_MS,
  type ActivityEvent, type History,
} from '../src/shared/activity';
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

const event = (id: number): ActivityEvent => ({ id, at: id, kind: 'account', provider: null, account: null, detail: { type: 'appeared' } });

describe('diffActivity', () => {
  it('records nothing for the first reading', () => {
    expect(diffActivity(null, state())).toEqual([]);
  });

  it('keeps raw values so the renderer can word them in any language', () => {
    const crashed = state({ phase: 'error', lastError: 'exit code 1\nstack…' });
    expect(diffActivity(state(), crashed)).toEqual([
      { kind: 'error', provider: null, account: null, detail: { type: 'phase', from: 'running', to: 'error', error: 'exit code 1' } },
    ]);
  });

  it('sees a switch, a new account, an availability change and a removal', () => {
    const before = state({}, rawStatus({ accounts: [rawAccount(), rawAccount({ name: 'old@example.com' })] }));
    const after = state({}, rawStatus({
      accounts: [rawAccount({ unavailable: 'exhausted' }), rawAccount({ name: 'bob@example.com' })],
      currentAccounts: { anthropic: 'bob@example.com' },
    }));
    expect(diffActivity(before, after).map(e => [e.kind, e.detail.type, e.account])).toEqual([
      ['switch', 'switch', 'bob@example.com'],
      ['account', 'availability', 'alice@example.com'],
      ['account', 'appeared', 'bob@example.com'],
      ['account', 'removed', 'old@example.com'],
    ]);
  });
});

describe('ActivityLog', () => {
  it('numbers events, stamps them and samples only new status readings', () => {
    let now = 100;
    const log = new ActivityLog(() => now);
    expect(log.observe(state({ statusAt: 1 }))).toMatchObject({ events: [], sample: { at: 100, activeSessions: 1, requests: 12 } });
    now = 200;
    expect(log.observe(state({ statusAt: 1, phase: 'stopping' })).sample).toBeNull();
    now = 300;
    const delta = log.observe(state({ statusAt: 2, phase: 'stopped' }));
    expect(delta.events.map(e => [e.id, e.at])).toEqual([[2, 300]]);
    expect(log.history().activity.map(e => e.id)).toEqual([2, 1]);
    expect(log.history().samples.map(s => s.at)).toEqual([100, 300]);
  });

  it('records each account\'s quota at most once a minute, as reported', () => {
    let now = 0;
    const log = new ActivityLog(() => now);
    const first = log.observe(state({ statusAt: 1 }));
    expect(first.quota).toEqual({ at: 0, accounts: { 'anthropic/alice@example.com': { fiveHour: 0.42, weekly: 0.1 } } });
    now = QUOTA_SAMPLE_MS - 1;
    expect(log.observe(state({ statusAt: 2 })).quota).toBeNull();
    now = QUOTA_SAMPLE_MS;
    expect(log.observe(state({ statusAt: 3 })).quota?.at).toBe(QUOTA_SAMPLE_MS);
    // No status, no point: a gap stays a gap.
    now = QUOTA_SAMPLE_MS * 3;
    expect(log.observe(state({ statusAt: 4 }, null)).quota).toBeNull();
    expect(log.history().quota).toHaveLength(2);
  });
});

describe('history merging', () => {
  it('caps the timeline, newest first', () => {
    const many = Array.from({ length: MAX_ACTIVITY + 5 }, (_, i) => event(i + 1));
    const history = appendHistory(EMPTY_HISTORY, { events: many, sample: null, quota: null });
    expect(history.activity).toHaveLength(MAX_ACTIVITY);
    expect(history.activity[0]?.id).toBe(MAX_ACTIVITY + 5);
  });

  it('drops the part of a delta the snapshot already had', () => {
    const held: History = { activity: [event(2), event(1)], samples: [{ at: 10, activeSessions: 0, requests: null }], quota: [{ at: 10, accounts: {} }] };
    const fresh = freshPart(held, {
      events: [event(2), event(3)], sample: { at: 10, activeSessions: 0, requests: null }, quota: { at: 10, accounts: {} },
    });
    expect(fresh.events.map(e => e.id)).toEqual([3]);
    expect(fresh.sample).toBeNull();
    expect(fresh.quota).toBeNull();
  });

  it('keeps a delta that arrived before the initial snapshot was applied', () => {
    const snapshot: History = { activity: [event(2), event(1)], samples: [{ at: 10, activeSessions: 0, requests: null }], quota: [{ at: 10, accounts: {} }] };
    const held: History = { activity: [event(3)], samples: [{ at: 20, activeSessions: 1, requests: null }], quota: [{ at: 70_010, accounts: {} }] };
    const merged = mergeSnapshot(snapshot, held);
    expect(merged.activity.map(e => e.id)).toEqual([3, 2, 1]);
    expect(merged.samples.map(s => s.at)).toEqual([10, 20]);
    expect(merged.quota.map(q => q.at)).toEqual([10, 70_010]);
  });
});
