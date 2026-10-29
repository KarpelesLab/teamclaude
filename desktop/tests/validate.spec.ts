import { describe, expect, it } from 'vitest';
import { isAccountName, isApiKey, validateCall, validateSettingsPatch, VALIDATORS } from '../src/services/validate';

describe('validateCall', () => {
  it('refuses unknown and prototype method names', () => {
    expect(validateCall('shell.exec', undefined)).toEqual({ ok: false, error: 'unknown method' });
    expect(validateCall('__proto__', undefined).ok).toBe(false);
    expect(validateCall('toString', undefined).ok).toBe(false);
    expect(validateCall(42, undefined).ok).toBe(false);
  });

  it('refuses arguments on no-argument methods', () => {
    expect(validateCall('backend.start', undefined).ok).toBe(true);
    expect(validateCall('backend.start', { force: true }).ok).toBe(false);
  });

  it('requires exact keys on object methods', () => {
    expect(validateCall('accounts.switch', { account: 'a' }).ok).toBe(true);
    expect(validateCall('accounts.switch', {}).ok).toBe(false);
    expect(validateCall('accounts.switch', { account: 'a', extra: 1 }).ok).toBe(false);
    expect(validateCall('accounts.switch', ['a']).ok).toBe(false);
  });

  it('refuses objects with a foreign prototype', () => {
    const sneaky = Object.create({ polluted: true }) as Record<string, unknown>;
    sneaky.account = 'a';
    expect(validateCall('accounts.switch', sneaky).ok).toBe(false);
  });

  it('range-checks numbers', () => {
    expect(validateCall('accounts.setPriority', { account: 'a', priority: 5 }).ok).toBe(true);
    expect(validateCall('accounts.setPriority', { account: 'a', priority: 1.5 }).ok).toBe(false);
    expect(validateCall('accounts.setPriority', { account: 'a', priority: 5000 }).ok).toBe(false);
    expect(validateCall('routing.setThreshold', { percent: 95 }).ok).toBe(true);
    expect(validateCall('routing.setThreshold', { percent: 0 }).ok).toBe(false);
    expect(validateCall('routing.setThreshold', { percent: Number.NaN }).ok).toBe(false);
    expect(validateCall('routing.setProbe', { seconds: 0 }).ok).toBe(true);
    expect(validateCall('routing.setProbe', { seconds: 10 }).ok).toBe(false);
    expect(validateCall('routing.setWarmup', { seconds: 59 }).ok).toBe(false);
    expect(validateCall('routing.setWarmup', { seconds: 600 }).ok).toBe(true);
  });

  it('only accepts known enum values', () => {
    expect(validateCall('accounts.login', { provider: 'claude' }).ok).toBe(true);
    expect(validateCall('accounts.login', { provider: 'gemini' }).ok).toBe(false);
    expect(validateCall('routing.setDistribution', { mode: 'adaptive' }).ok).toBe(true);
    expect(validateCall('routing.setDistribution', { mode: 'load' }).ok).toBe(true);
    expect(validateCall('routing.setDistribution', { mode: 'even' }).ok).toBe(false);
    expect(validateCall('routing.setDistribution', { mode: 'random' }).ok).toBe(false);
    expect(validateCall('system.openExternal', { target: 'repository' }).ok).toBe(true);
    expect(validateCall('system.openExternal', { target: 'https://evil.example' }).ok).toBe(false);
  });

  it('has a validator for every method', () => {
    for (const validator of Object.values(VALIDATORS)) expect(typeof validator).toBe('function');
  });
});

describe('isAccountName', () => {
  it('refuses names that could be read as CLI flags or carry control characters', () => {
    expect(isAccountName('work@example.com')).toBe(true);
    expect(isAccountName('--help')).toBe(false);
    expect(isAccountName('  -x')).toBe(false);
    expect(isAccountName('a\nb')).toBe(false);
    expect(isAccountName('')).toBe(false);
    expect(isAccountName('x'.repeat(201))).toBe(false);
  });
});

describe('isApiKey', () => {
  it('requires a single token of reasonable length', () => {
    expect(isApiKey('sk-ant-api03-abcdefgh')).toBe(true);
    expect(isApiKey('short')).toBe(false);
    expect(isApiKey('has space inside')).toBe(false);
  });
});

describe('validateSettingsPatch', () => {
  it('accepts known settings and refuses others', () => {
    expect(validateSettingsPatch({ theme: 'light', minimizeToTray: false }).ok).toBe(true);
    expect(validateSettingsPatch({ language: 'ru' }).ok).toBe(true);
    expect(validateSettingsPatch({ language: 'xx' }).ok).toBe(false);
    expect(validateSettingsPatch({ theme: 'neon' }).ok).toBe(false);
    expect(validateSettingsPatch({ launchAtLogin: 'yes' }).ok).toBe(false);
    expect(validateSettingsPatch({ backendPath: '/tmp/x' }).ok).toBe(false);
    expect(validateSettingsPatch({ notifications: { proxyCrashed: false } }).ok).toBe(true);
    expect(validateSettingsPatch({ notifications: { other: false } }).ok).toBe(false);
  });
});
