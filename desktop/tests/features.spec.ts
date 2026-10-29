import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QuotaPoint } from '../src/shared/activity';
import { fiveHourRate, runoutAlerts, runouts, soonestRunout } from '../src/shared/forecast';
import type { AccountView } from '../src/shared/types';
import { cacheHitRate, nextAccount, usageCsv, usageRows, usageTotals } from '../src/shared/usage';
import { collectBackup, openBackup, restoreBackup, sealBackup, type BackupIO } from '../src/services/backup';
import { applyIde, listIdeTargets, parseJsonc, type IdeFiles } from '../src/services/ide-connect';
import { isAccelerator, validateSettingsPatch } from '../src/services/validate';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function account(over: Partial<AccountView> = {}): AccountView {
  return {
    index: 0, name: 'a', type: 'oauth', provider: 'anthropic', orgName: null, priority: 0, disabled: false, status: 'active',
    unavailable: null, error: null, isCurrent: false, sessions: 0, knownSessions: 0,
    fiveHour: { utilization: null, resetAt: null, seenAt: null }, sessionWindowStated: null,
    weekly: { utilization: null, resetAt: null, seenAt: null }, weeklyWindowStated: null,
    modelWindows: [], onExtraUsage: false, allowExtraUsage: false, rateLimitedUntil: null, pausedUntil: null,
    credentialRejectedUntil: null, totalRequests: null, recentRequests: null, usage: null, forecast: [],
    ...over,
  };
}

const points = (key: string, values: Array<[number, number | null]>): QuotaPoint[] =>
  values.map(([minutesAgo, u]) => ({ at: NOW - minutesAgo * MIN, accounts: { [key]: { fiveHour: u, weekly: null } } }));

describe('forecast', () => {
  it('extrapolates the 5-hour trend to 100% when that comes before the reset', () => {
    const pts = points('anthropic/a', [[30, 0.4], [20, 0.5], [0, 0.7]]);
    expect(fiveHourRate(pts, 'anthropic/a', NOW)).toBeCloseTo(0.3 / (30 * MIN));
    const a = account({ fiveHour: { utilization: 0.7, resetAt: NOW + 4 * 60 * MIN, seenAt: NOW } });
    const [r] = runouts(a, pts, NOW);
    expect(r).toMatchObject({ window: 'fiveHour', level: 1 });
    expect(r!.at - NOW).toBe(30 * MIN);
  });

  it('drops a run-out after the reset, a flat trend, and readings across a reset', () => {
    const pts = points('anthropic/a', [[30, 0.4], [0, 0.7]]);
    expect(runouts(account({ fiveHour: { utilization: 0.7, resetAt: NOW + 10 * MIN, seenAt: NOW } }), pts, NOW)).toEqual([]);
    expect(fiveHourRate(points('anthropic/a', [[30, 0.5], [0, 0.5]]), 'anthropic/a', NOW)).toBeNull();
    // 0.9 then 0.1: a reset happened; only the stretch after it counts, and it is too short.
    expect(fiveHourRate(points('anthropic/a', [[30, 0.9], [5, 0.1], [0, 0.2]]), 'anthropic/a', NOW)).toBeNull();
  });

  it('uses the server forecast for weekly windows and picks the soonest account', () => {
    const weekly = account({ name: 'w', forecast: [{ bucket: 'unified7d', family: null, ratePerHour: 0.01, threshold: 0.9, reachesThresholdAt: NOW + 50 * MIN, resetAt: NOW + 3 * 24 * 60 * MIN }] });
    const later = account({ name: 'l', forecast: [{ bucket: 'unified7dSonnet', family: 'Sonnet', ratePerHour: 0.01, threshold: 0.9, reachesThresholdAt: NOW + 5 * 60 * MIN, resetAt: null }] });
    const afterReset = account({ name: 'r', forecast: [{ bucket: 'unified7d', family: null, ratePerHour: 0.01, threshold: 0.9, reachesThresholdAt: NOW + 50 * MIN, resetAt: NOW + 10 * MIN }] });
    expect(soonestRunout([later, weekly, afterReset], [], NOW)?.account.name).toBe('w');
    const alerts = runoutAlerts([later, weekly], [], NOW);
    expect(alerts.map(a => a.account.name)).toEqual(['w']);
    expect(runoutAlerts([weekly], [], NOW)[0]!.key).toBe(alerts[0]!.key);
    expect(soonestRunout([{ ...weekly, unavailable: 'exhausted' }], [], NOW)).toBeNull();
  });
});

describe('usage', () => {
  const accounts = [
    account({ name: 'a', totalRequests: 3, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 80, cacheCreationTokens: 10 } }),
    account({ name: '=cmd', totalRequests: null, usage: null }),
  ];

  it('sums tokens and the cache hit rate', () => {
    const rows = usageRows(accounts);
    expect(rows[0]).toMatchObject({ requests: 3, total: 105 });
    expect(usageTotals(rows)).toMatchObject({ requests: 3, total: 105, cacheRead: 80 });
    expect(cacheHitRate(rows[0]!)).toBeCloseTo(0.8);
    expect(cacheHitRate(rows[1]!)).toBeNull();
  });

  it('writes CSV that a spreadsheet will not evaluate', () => {
    const csv = usageCsv(usageRows(accounts));
    expect(csv.split('\r\n')[0]).toBe('provider,account,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens');
    expect(csv).toContain("anthropic,'=cmd,0,");
  });

  it('finds the next account that can serve, wrapping around', () => {
    const pool = [account({ name: 'x' }), account({ name: 'y', disabled: true }), account({ name: 'z', unavailable: 'exhausted' }), account({ name: 'w' })];
    expect(nextAccount(pool, 'anthropic', 'x')?.name).toBe('w');
    expect(nextAccount(pool, 'anthropic', 'w')?.name).toBe('x');
    expect(nextAccount([account({ name: 'x' })], 'anthropic', 'x')).toBeNull();
  });
});

describe('backup', () => {
  function memory(initial: Record<string, string> = {}): BackupIO & { files: Record<string, string> } {
    const files = { ...initial };
    return {
      files,
      read: p => files[p] ?? null,
      write: (p, d) => { files[p] = d; },
      rename: (a, b) => { files[b] = files[a] as string; delete files[a]; },
      exists: p => p in files,
    };
  }
  const config = join('/cfg', 'teamclaude.json');
  const state = join('/cfg', 'teamclaude.state.json');
  const original = JSON.stringify({ accounts: [{ name: 'a', refreshToken: 'secret' }] });

  it('round-trips the config and state with the passphrase', () => {
    const io = memory({ [config]: original, [state]: '{"q":1}' });
    const sealed = sealBackup(collectBackup(config, '0.3.0', io), 'correct horse');
    expect(sealed).not.toContain('secret');
    const payload = openBackup(sealed, 'correct horse');
    expect(payload.files['teamclaude.json']).toBe(original);

    const target = memory({ [config]: '{"accounts":[]}' });
    const moved = restoreBackup(payload, config, target, new Date(NOW));
    expect(target.files[config]).toBe(original);
    expect(target.files[state]).toBe('{"q":1}');
    expect(moved).toHaveLength(1);
    expect(target.files[moved[0]!]).toBe('{"accounts":[]}');
  });

  it('refuses a wrong passphrase, a tampered file and absurd KDF parameters', () => {
    const sealed = sealBackup(collectBackup(config, '0.3.0', memory({ [config]: original })), 'correct horse');
    expect(() => openBackup(sealed, 'wrong horse')).toThrow(/passphrase/);
    const env = JSON.parse(sealed);
    expect(() => openBackup(JSON.stringify({ ...env, data: Buffer.from('x').toString('base64') }), 'correct horse')).toThrow(/passphrase|damaged/);
    expect(() => openBackup(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 2 ** 30 } }), 'correct horse')).toThrow(/parameters/);
    expect(() => openBackup('not json', 'x')).toThrow(/not a TeamClaude backup/);
  });

  it('will not restore a config without an accounts list', () => {
    expect(() => restoreBackup({ createdAt: '', desktopVersion: '', files: { 'teamclaude.json': '{}' } }, config, memory())).toThrow(/accounts/);
    expect(() => collectBackup(config, '0.3.0', memory())).toThrow(/no TeamClaude config/);
  });
});

describe('settings validation', () => {
  it('accepts well-formed profiles and refuses the rest', () => {
    const p = { id: 'p-1', name: 'Night', threshold: 95, distribution: 'load' };
    expect(validateSettingsPatch({ profiles: [p] }).ok).toBe(true);
    expect(validateSettingsPatch({ profiles: [{ ...p, threshold: null, distribution: null }] }).ok).toBe(true);
    expect(validateSettingsPatch({ profiles: [p, p] }).ok).toBe(false);
    expect(validateSettingsPatch({ profiles: [{ ...p, threshold: 0 }] }).ok).toBe(false);
    expect(validateSettingsPatch({ profiles: [{ ...p, distribution: 'rm -rf' }] }).ok).toBe(false);
    expect(validateSettingsPatch({ profiles: [{ ...p, extra: 1 }] }).ok).toBe(false);
    expect(validateSettingsPatch({ profiles: Array.from({ length: 21 }, (_, i) => ({ ...p, id: `p-${i}` })) }).ok).toBe(false);
  });

  it('accepts accelerators with a modifier and one key', () => {
    expect(isAccelerator('CommandOrControl+Alt+Shift+N')).toBe(true);
    expect(isAccelerator('Alt+F12')).toBe(true);
    expect(isAccelerator('N')).toBe(false);
    expect(isAccelerator('Ctrl+Alt')).toBe(false);
    expect(isAccelerator('Ctrl+N; rm')).toBe(false);
    expect(validateSettingsPatch({ hotkey: 'Ctrl+Shift+K', hotkeyEnabled: true, widget: true }).ok).toBe(true);
  });
});

describe('editor connect: Zed and JetBrains', () => {
  const env = { platform: 'linux' as const, env: {}, home: '/home/u' };
  const zed = join('/home/u/.config', 'zed', 'settings.json');
  const claude = join('/home/u/.claude', 'settings.json');
  function files(initial: Record<string, string>, dirs: string[]): IdeFiles & { files: Record<string, string> } {
    const f = { ...initial };
    return { files: f, read: p => f[p] ?? null, write: (p, d) => { f[p] = d; }, exists: p => p in f || dirs.includes(p), copy: (a, b) => { f[b] = f[a] as string; } };
  }

  it('sets and removes agent_servers.claude.env in Zed, keeping other servers', () => {
    const fs = files({ [zed]: '{ // mine\n "theme": "One", "agent_servers": { "other": {} } }' }, [join('/home/u/.config', 'zed')]);
    const target = listIdeTargets(3456, { env, files: fs }).find(t => t.id === 'zed')!;
    expect(target).toMatchObject({ installed: true, status: 'not-connected' });
    applyIde(target, 'http://localhost:3456', fs);
    expect(parseJsonc(fs.files[zed]!)).toEqual({ theme: 'One', agent_servers: { other: {}, claude: { env: { ANTHROPIC_BASE_URL: 'http://localhost:3456' } } } });
    expect(fs.files[zed]).toContain('// mine');
    applyIde(target, null, fs);
    expect(parseJsonc(fs.files[zed]!)).toEqual({ theme: 'One', agent_servers: { other: {} } });
  });

  it('connects JetBrains through the Claude Code settings', () => {
    const fs = files({ [claude]: '{}' }, [join('/home/u/.config', 'JetBrains')]);
    const target = listIdeTargets(3456, { env, files: fs }).find(t => t.id === 'jetbrains')!;
    expect(target).toMatchObject({ installed: true, via: 'claude', settingsPath: claude });
    applyIde(target, 'http://localhost:3456', fs);
    expect(JSON.parse(fs.files[claude]!)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://localhost:3456' } });
    expect(listIdeTargets(3456, { env, files: fs }).find(t => t.id === 'jetbrains')!.status).toBe('connected');
  });
});
