import { describe, expect, it } from 'vitest';
import { anonymizeAccounts, buildDiagnosticReport } from '../src/services/diagnostics';
import { normalizeStatus } from '../src/services/normalize';
import type { BackendState, SystemInfo } from '../src/shared/types';
import { rawAccount, rawStatus } from './fixtures';

const system: SystemInfo = {
  os: 'linux 6.8', arch: 'x64', desktopVersion: '0.1.0', electronVersion: '44.8.0', nodeVersion: '24.0.0',
  backendVersion: '1.1.25', bundledBackendVersion: '1.1.25', proxyPhase: 'running', lastError: null,
  configDir: '/x', userDataDir: '/y',
};

function state(raw: Record<string, unknown>): BackendState {
  return {
    phase: 'running', ownership: 'owned', host: '127.0.0.1', port: 3456, endpoint: 'http://127.0.0.1:3456',
    childPid: 1, lastError: 'refresh failed for bob@example.com', restartCount: 0, serviceInstalled: false,
    compatibility: { ok: true, message: null }, status: normalizeStatus(raw), statusAt: 1,
    configPath: '/x/teamclaude.json', configExists: true,
  };
}

describe('diagnostic report', () => {
  it('names no account, in the summary or in the backend log lines', () => {
    const raw = rawStatus({ accounts: [rawAccount(), rawAccount({ name: 'work' })] });
    const logs = [
      { at: 0, stream: 'stdout' as const, text: '[TeamClaude] Starting on account "alice@example.com" (priority 0)' },
      { at: 1, stream: 'stdout' as const, text: '  [2] work (apikey)' },
      { at: 2, stream: 'stdout' as const, text: 'network ok, worker started' },
    ];
    const report = buildDiagnosticReport(system, state(raw), logs, new Date(0));
    expect(report).not.toContain('alice@example.com');
    expect(report).not.toContain('bob@example.com');
    expect(report).toContain('Starting on account "#1"');
    expect(report).toContain('[2] #2 (apikey)');
    // A name inside another word is left alone.
    expect(report).toContain('network ok, worker started');
    expect(report).toContain('refresh failed for [email]');
  });

  it('says a window the plan does not meter is not metered, not unknown', () => {
    const raw = rawStatus({ accounts: [rawAccount({ quota: { unified5h: 0.3, weeklyWindowStated: false }, recentRequests: 4 })] });
    const report = buildDiagnosticReport(system, state(raw), [], new Date(0));
    expect(report).toContain('5h=30%, weekly=not metered, recent=4');
  });

  it('replaces the longer of two overlapping names whole', () => {
    expect(anonymizeAccounts('a work-2 b work', ['work', 'work-2'])).toBe('a #2 b #1');
  });
});
